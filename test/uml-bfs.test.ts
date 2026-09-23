import { afterEach, expect, test } from "bun:test";
import type { UmlTarget } from "../src/types.ts";
import type { UmlVisibility } from "../src/uml/model.ts";
import type { RenderedUmlFrame } from "../src/uml/view.ts";
import {
  definitionsView,
  edgeRows,
  frameRows,
  qualifiedNameLabel,
} from "./support/uml-contract.ts";
import {
  createUmlProjectTracker,
  readCompleteUml,
  renderSelection,
  type UmlProject,
} from "./support/uml-project.ts";

const { openProject, cleanup } = createUmlProjectTracker();

afterEach(cleanup);

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

/** `N0 → N1 → … → N7`: one hop per level, so a depth bound is visible as a node count. */
const CHAIN_FILES: Record<string, string> = { "src/n7.ts": "export class N7 {}\n" };
for (let index = 0; index < 7; index += 1) {
  CHAIN_FILES[`src/n${index}.ts`] = `import { N${index + 1} } from "./n${index + 1}.ts";
export class N${index} { next: N${index + 1}; }
`;
}

/** `Root → Long1 → Long2 → Shared → Leaf` plus the direct `Root → Shared` shortcut. */
const SHORTCUT_FILES = {
  "src/leaf.ts": "export class Leaf {}\n",
  "src/shared.ts": `import { Leaf } from "./leaf.ts";
export class Shared { leaf: Leaf; }
`,
  "src/long2.ts": `import { Shared } from "./shared.ts";
export class Long2 { shared: Shared; }
`,
  "src/long1.ts": `import { Long2 } from "./long2.ts";
export class Long1 { next: Long2; }
`,
  "src/root.ts": `import { Long1 } from "./long1.ts";
import { Shared } from "./shared.ts";
export class Root { long: Long1; shared: Shared; }
`,
};

function openFixture(prefix: string): Promise<UmlProject> {
  return openProject(prefix, FIXTURE_FILES);
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
  depth?: number,
): RenderedUmlFrame {
  const frame = renderSelection(project, target, overrides, depth).frames[0];
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

test("the default depth bounds a chain and a deeper read expands the same extraction", async () => {
  const project = await openProject("ts-explorer-uml-bfs-depth-", CHAIN_FILES);
  const target: UmlTarget = {
    kind: "definition",
    path: "src/n0.ts",
    definitionKey: project.key("src/n0.ts", "N0"),
  };

  const bounded = definitionsView(readCompleteUml(project, target));
  expect(frameRows(bounded, qualifiedNameLabel)).toEqual([
    { root: "N0", nodes: ["N0", "N1", "N2", "N3", "N4", "N5"] },
  ]);
  expect(edgeRows(bounded, qualifiedNameLabel)).toEqual([
    "N0 -references-> N1",
    "N1 -references-> N2",
    "N2 -references-> N3",
    "N3 -references-> N4",
    "N4 -references-> N5",
  ]);
  // The rendered frame is bounded too: N5's `next: N6` row is text, not a sixth-level node.
  expect(names(render(project, target))).toEqual(["N0", "N1", "N2", "N3", "N4", "N5"]);

  const deep = definitionsView(readCompleteUml(project, target, 7));
  expect(frameRows(deep, qualifiedNameLabel)).toEqual([
    { root: "N0", nodes: ["N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7"] },
  ]);

  // Expanding never consumed the shared extraction: the default is bounded again afterwards.
  expect(names(render(project, target))).toEqual(["N0", "N1", "N2", "N3", "N4", "N5"]);
});

test("depth 0 isolates every root and depth 1 keeps both cycle directions", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-frontier-");

  const roots = renderSelection(project, { kind: "file", path: "src/cycle.ts" }, {}, 0).frames;
  expect(roots.map(names)).toEqual([["Ping"], ["Pong"]]);
  expect(roots.map((frame) => relationRows(frame.dsl))).toEqual([[], []]);

  const ping = render(project, {
    kind: "definition",
    path: "src/cycle.ts",
    definitionKey: project.key("src/cycle.ts", "Ping"),
  }, {}, 1);
  expect(names(ping)).toEqual(["Ping", "Pong"]);
  // Pong is the frontier, yet its back edge to the admitted Ping survives, drawn once.
  const rows = relationRows(ping.dsl);
  expect(rows.length).toBe(2);
  expect(new Set(rows).size).toBe(2);
});

test("a depth 1 diamond stops before the node both branches share", async () => {
  const project = await openFixture("ts-explorer-uml-bfs-diamond-depth-");
  const view = definitionsView(readCompleteUml(project, {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  }, 1));

  expect(frameRows(view, qualifiedNameLabel)).toEqual([
    { root: "Root", nodes: ["Left", "Right", "Root"] },
  ]);
  expect(edgeRows(view, qualifiedNameLabel)).toEqual([
    "Root -references-> Left",
    "Root -references-> Right",
  ]);
});

test("a shorter direct path admits a node an earlier long path would defer", async () => {
  const project = await openProject("ts-explorer-uml-bfs-shortcut-", SHORTCUT_FILES);
  const target: UmlTarget = {
    kind: "definition",
    path: "src/root.ts",
    definitionKey: project.key("src/root.ts", "Root"),
  };

  // Shared sits three hops down the long chain but one hop along the shortcut, so its own
  // dependency Leaf is still inside a depth of 2.
  const view = definitionsView(readCompleteUml(project, target, 2));
  expect(frameRows(view, qualifiedNameLabel)).toEqual([
    { root: "Root", nodes: ["Leaf", "Long1", "Long2", "Root", "Shared"] },
  ]);
  expect(edgeRows(view, qualifiedNameLabel)).toEqual([
    "Long1 -references-> Long2",
    "Long2 -references-> Shared",
    "Root -references-> Long1",
    "Root -references-> Shared",
    "Shared -references-> Leaf",
  ]);

  const shallow = definitionsView(readCompleteUml(project, target, 1));
  expect(frameRows(shallow, qualifiedNameLabel)).toEqual([
    { root: "Root", nodes: ["Long1", "Root", "Shared"] },
  ]);
});
