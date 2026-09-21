import { afterEach, expect, test } from "bun:test";
import type { UmlTarget } from "../src/types.ts";
import { FULL_UML_VISIBILITY, type UmlVisibility } from "../src/uml/model.ts";
import { renderUmlView, type RenderedUmlFrame } from "../src/uml/view.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { buildUmlProject, readCompleteUml, type UmlProject } from "./support/uml-project.ts";

const fixtures = createFixtureTracker();
const projects: UmlProject[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await fixtures.cleanup();
});

const FIXTURE_FILES = {
  "src/shared.ts": "export class Shared {}\n",
  "src/left.ts": `import { Shared } from "./shared.ts";
export class Left { shared: Shared; }
`,
  "src/right.ts": `import { Shared } from "./shared.ts";
export class Right { shared: Shared; }
`,
  "src/root.ts": `import { Left } from "./left.ts";
import { Right } from "./right.ts";
export class Root { left: Left; right: Right; }
`,
  "src/cycle.ts": `export class Ping { pong?: Pong; }
export class Pong { ping?: Ping; }
`,
  "test/probe.test.ts": `import { Shared } from "../src/shared.ts";
export class Probe { shared: Shared; }
`,
};

async function openFixture(prefix: string): Promise<UmlProject> {
  const root = await fixtures.fixtureRoot(prefix, FIXTURE_FILES);
  const project = await buildUmlProject(root);
  projects.push(project);
  return project;
}

/** Relation rows as `source>target` node-id pairs, direction normalized to point at the target. */
function relationRows(dsl: string): string[] {
  const rows: string[] = [];
  for (const line of dsl.split("\n").map((entry) => entry.trim())) {
    const reference = /^(d\d+) --> (d\d+)$/.exec(line);
    if (reference) {
      rows.push(`${reference[1]}>${reference[2]}`);
      continue;
    }
    const inheritance = /^(d\d+) <\|(?:--|\.\.) (d\d+)$/.exec(line);
    if (inheritance) rows.push(`${inheritance[2]}>${inheritance[1]}`);
  }
  return rows;
}

function render(
  project: UmlProject,
  target: UmlTarget,
  overrides: Partial<UmlVisibility> = {},
): RenderedUmlFrame {
  const diagram = readCompleteUml(project, target);
  const frame = renderUmlView(diagram.view, { ...FULL_UML_VISIBILITY, ...overrides }, target).frames[0];
  if (!frame) throw new Error("no frame rendered");
  return frame;
}

function names(frame: RenderedUmlFrame): string[] {
  return frame.definitionLinks.map((link) => link.definition.qualifiedName).sort();
}

test("a rooted selection reaches every referenced definition", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-");
  const frame = render(project, {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  });
  expect(names(frame)).toEqual(["Left", "Right", "Root", "Shared"]);
});

test("a node reached by two paths keeps both incoming edges", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-diamond-");
  const frame = render(project, {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  });

  const rows = relationRows(frame.dsl);
  // Root->Left, Root->Right, Left->Shared, Right->Shared: the diamond is not collapsed.
  expect(rows.length).toBe(4);
  const incoming = new Map<string, number>();
  for (const row of rows) {
    const child = row.split(">")[1] as string;
    incoming.set(child, (incoming.get(child) ?? 0) + 1);
  }
  expect([...incoming.values()].sort()).toEqual([1, 1, 2]);
});

test("a reference cycle keeps its back edge and is drawn once", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-cycle-");
  const frame = render(project, {
    kind: "definition",
    path: "src/cycle.ts",
    definitionKey: project.key("src/cycle.ts", "Ping"),
  });

  expect(names(frame)).toEqual(["Ping", "Pong"]);
  const rows = relationRows(frame.dsl);
  // Both directions survive; neither box is emitted twice.
  expect(rows.length).toBe(2);
  expect(new Set(rows).size).toBe(2);
  expect(frame.definitionLinks.length).toBe(2);
});

test("rendering the same model twice produces identical DSL", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-stable-");
  const target: UmlTarget = {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  };
  expect(render(project, target).dsl).toBe(render(project, target).dsl);
});

test("a rooted selection is laid out top-down", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-direction-");
  const frame = render(project, {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  });
  expect(frame.dsl.split("\n").slice(0, 2).map((line) => line.trim()))
    .toEqual(["classDiagram", "direction TB"]);
});

test("Attributes, Methods and Types change compartments, never the graph", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-compartments-");
  const target: UmlTarget = {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  };

  const full = render(project, target);
  const shape = relationRows(full.dsl);
  for (const overrides of [{ attributes: false }, { methods: false }, { types: false }]) {
    const label = JSON.stringify(overrides);
    const frame = render(project, target, overrides);
    expect(relationRows(frame.dsl), label).toEqual(shape);
    expect(names(frame), label).toEqual(names(full));
  }

  // Attributes off really did drop the rows it owns.
  expect(full.definitionLinks.some((link) => link.attributes.length > 0)).toBe(true);
  expect(
    render(project, target, { attributes: false })
      .definitionLinks.every((link) => link.attributes.length === 0),
  ).toBe(true);
});

test("the Tests checkbox removes test nodes and explains a hidden root", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-tests-");

  const probeTarget: UmlTarget = {
    kind: "definition",
    path: "test/probe.test.ts",
    definitionKey: project.key("test/probe.test.ts", "Probe"),
  };
  expect(names(render(project, probeTarget))).toEqual(["Probe", "Shared"]);

  const hidden = render(project, probeTarget, { tests: false });
  expect(hidden.emptyMessage).toBe("Selected definition is hidden by the Tests filter.");
  expect(hidden.dsl).toBe("");

  // A non-test root is untouched by the same switch.
  const rootTarget: UmlTarget = {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  };
  expect(relationRows(render(project, rootTarget, { tests: false }).dsl))
    .toEqual(relationRows(render(project, rootTarget).dsl));
});
