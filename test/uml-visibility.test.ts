import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { UmlTarget } from "../src/types.ts";
import { FULL_UML_VISIBILITY, type UmlVisibility } from "../src/uml/model.ts";
import { renderUmlView, type RenderedUmlFrame, type RenderedUmlView } from "../src/uml/view.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { umlLabel } from "./support/uml-contract.ts";
import { buildUmlProject, readCompleteUml, type UmlProject } from "./support/uml-project.ts";

const fixtures = createFixtureTracker();
const projects: UmlProject[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await fixtures.cleanup();
});

const FIXTURE_FILES = {
  "src/model.ts": `import { Bridge } from "../test/bridge.test";
export interface Output { code: number; }
export class ResultService {
  private cache?: Output;
  bridge: Bridge;
  execute(value: string): Output { return { code: value.length }; }
}
export const marker = 1;
`,
  "test/bridge.test.ts": `import { Leaf } from "../src/leaf";
export class Bridge { leaf: Leaf; }
export class SecondRoot {}
`,
  "src/leaf.ts": "export class Leaf {}\n",
  "src/empty.ts": "",
  "only-tests/thing.test.ts": "export class OnlyTest {}\n",
};

async function openFixture(prefix: string): Promise<UmlProject> {
  const root = await fixtures.fixtureRoot(prefix, FIXTURE_FILES);
  // A directory with no files at all; the tree still lists it as a selectable target.
  await mkdir(join(root, "nothing"), { recursive: true });
  const project = await buildUmlProject(root);
  projects.push(project);
  return project;
}

function render(
  project: UmlProject,
  target: UmlTarget,
  overrides: Partial<UmlVisibility> = {},
): RenderedUmlView {
  const diagram = readCompleteUml(project, target);
  return renderUmlView(diagram.view, { ...FULL_UML_VISIBILITY, ...overrides }, target);
}

/** The definitions a frame actually drew, by label, in emission order. */
function drawn(frame: RenderedUmlFrame | undefined): string[] {
  if (!frame) throw new Error("no frame rendered");
  return frame.definitionLinks.map((link) => umlLabel(link.definition));
}

test("Attributes and Methods hide compartments without touching the graph", async () => {
  const project = await openFixture("ts-explorer-uml-compartments-");
  const target: UmlTarget = {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "ResultService"),
  };

  const full = render(project, target).frames[0];
  const withoutAttributes = render(project, target, { attributes: false }).frames[0];
  const withoutMethods = render(project, target, { methods: false }).frames[0];

  const nodes = [
    "Leaf@src/leaf.ts",
    "Output@src/model.ts",
    "ResultService@src/model.ts",
    "Bridge@test/bridge.test.ts",
  ];
  expect(drawn(full)).toEqual(nodes);
  expect(drawn(withoutAttributes)).toEqual(nodes);
  expect(drawn(withoutMethods)).toEqual(nodes);
  expect(full?.title).toContain("ResultService");
  expect(full?.title).toContain("src/model.ts");

  expect(full?.dsl).toContain("cache");
  expect(full?.dsl).toContain("execute()");
  expect(withoutAttributes?.dsl).not.toContain("cache");
  expect(withoutAttributes?.dsl).toContain("execute()");
  expect(withoutMethods?.dsl).toContain("cache");
  expect(withoutMethods?.dsl).not.toContain("execute()");

  // Navigation rows follow the emitted compartments, and the root keeps its emphasis either way.
  const serviceLink = (frame: RenderedUmlFrame | undefined) =>
    frame?.definitionLinks.find((link) => link.definition.qualifiedName === "ResultService");
  expect(serviceLink(full)?.attributes.map(umlLabel)).toEqual([
    "ResultService.cache@src/model.ts",
    "ResultService.bridge@src/model.ts",
  ]);
  expect(serviceLink(full)?.methods.map(umlLabel)).toEqual(["ResultService.execute@src/model.ts"]);
  expect(serviceLink(withoutAttributes)?.attributes).toEqual([]);
  expect(serviceLink(withoutAttributes)?.methods.map(umlLabel)).toEqual([
    "ResultService.execute@src/model.ts",
  ]);
  expect(serviceLink(withoutMethods)?.methods).toEqual([]);
  const rootId = serviceLink(withoutMethods)?.nodeId;
  expect(withoutMethods?.dsl).toContain(`cssClass "${rootId}" rootNode`);
});

test("a selected member root survives its own compartment control being off", async () => {
  const project = await openFixture("ts-explorer-uml-member-root-");

  const property = render(project, {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "ResultService.cache"),
  }, { attributes: false }).frames[0];
  expect(property?.emptyMessage).toBeUndefined();
  expect(drawn(property)).toEqual([
    "Output@src/model.ts",
    "ResultService.cache@src/model.ts",
  ]);

  const method = render(project, {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "ResultService.execute"),
  }, { methods: false }).frames[0];
  expect(method?.emptyMessage).toBeUndefined();
  expect(drawn(method)).toEqual([
    "Output@src/model.ts",
    "ResultService.execute@src/model.ts",
  ]);
});

test("Types hides declared type text but never a type node", async () => {
  const project = await openFixture("ts-explorer-uml-types-");
  const service: UmlTarget = {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "ResultService"),
  };

  const full = render(project, service).frames[0];
  const withoutTypes = render(project, service, { types: false }).frames[0];
  expect(full?.dsl).toContain(": Output");
  expect(withoutTypes?.dsl).not.toContain(": Output");
  // `Output` is still a node of the graph, and still carries the property row that referenced it.
  expect(drawn(withoutTypes)).toEqual(drawn(full));
  expect(withoutTypes?.dsl).toContain("cache");

  const marker: UmlTarget = {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "marker"),
  };
  // An unannotated value shows an em dash rather than an invented inferred type.
  expect(render(project, marker).frames[0]?.dsl).toContain("—");
  expect(render(project, marker, { types: false }).frames[0]?.dsl).not.toContain("—");
});

test("Tests hides test nodes and drops what only they reached", async () => {
  const project = await openFixture("ts-explorer-uml-tests-filter-");
  const service: UmlTarget = {
    kind: "definition",
    path: "src/model.ts",
    definitionKey: project.key("src/model.ts", "ResultService"),
  };

  expect(drawn(render(project, service).frames[0])).toContain("Bridge@test/bridge.test.ts");

  const withoutTests = render(project, service, { tests: false }).frames[0];
  // `Leaf` is production code, but the only path to it ran through the hidden test class.
  expect(drawn(withoutTests)).toEqual(["Output@src/model.ts", "ResultService@src/model.ts"]);
  expect(withoutTests?.dsl).not.toContain("Leaf");
});

test("a hidden definition root says so while a file selection just omits its frames", async () => {
  const project = await openFixture("ts-explorer-uml-hidden-root-");
  const bridgeKey = project.key("test/bridge.test.ts", "Bridge");

  const definition = render(project, {
    kind: "definition",
    path: "test/bridge.test.ts",
    definitionKey: bridgeKey,
  }, { tests: false });
  expect(definition.frames).toHaveLength(1);
  expect(definition.frames[0]?.emptyMessage).toBe(
    "Selected definition is hidden by the Tests filter.",
  );
  expect(definition.frames[0]?.rootKey).toBe(bridgeKey);
  expect(definition.frames[0]?.dsl).toBe("");

  // The same file selected whole reports that nothing is left, without naming a root.
  const file = render(project, { kind: "file", path: "test/bridge.test.ts" }, { tests: false });
  expect(file.frames).toHaveLength(1);
  expect(file.frames[0]?.emptyMessage).toBe("No visible definitions");
  expect(file.frames[0]?.rootKey).toBeNull();

  // Unfiltered, that file really does have two roots.
  expect(render(project, { kind: "file", path: "test/bridge.test.ts" }).frames.map((frame) =>
    frame.rootKey
  )).toEqual([bridgeKey, project.key("test/bridge.test.ts", "SecondRoot")]);
});

test("empty selections name the kind of thing that is missing", async () => {
  const project = await openFixture("ts-explorer-uml-empty-states-");

  const emptyFile = render(project, { kind: "file", path: "src/empty.ts" });
  expect(emptyFile.frames[0]?.emptyMessage).toBe("No definitions");
  expect(emptyFile.dsl).toBe("");

  const emptyDirectory = render(project, { kind: "directory", path: "nothing" });
  expect(emptyDirectory.frames[0]?.emptyMessage).toBe("No files");
  expect(emptyDirectory.dsl).toBe("");

  // A directory whose every file is hidden by the Tests filter is empty for the same reason.
  const onlyTests = render(project, { kind: "directory", path: "only-tests" }, { tests: false });
  expect(onlyTests.frames[0]?.emptyMessage).toBe("No files");
});

test("a directory view ignores the compartment controls but obeys Tests", async () => {
  const project = await openFixture("ts-explorer-uml-directory-visibility-");
  const target: UmlTarget = { kind: "directory", path: "src" };

  const full = render(project, target);
  const withoutDetail = render(project, target, {
    attributes: false,
    methods: false,
    types: false,
  });
  expect(withoutDetail.dsl).toBe(full.dsl);
  expect(full.frames[0]?.fileLinks.map((link) => link.path)).toEqual([
    "src/empty.ts",
    "src/leaf.ts",
    "src/model.ts",
    "test/bridge.test.ts",
  ]);

  // The test file is an outside boundary leaf here; hiding tests removes it and its import arrow.
  const withoutTests = render(project, target, { tests: false });
  expect(withoutTests.frames[0]?.fileLinks.map((link) => link.path)).toEqual([
    "src/empty.ts",
    "src/leaf.ts",
    "src/model.ts",
  ]);
  expect(withoutTests.dsl).not.toContain("bridge.test.ts");
});
