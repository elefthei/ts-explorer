import { afterEach, expect, test } from "bun:test";
import { createFixtureTracker } from "./support/fixtures.ts";
import { expectFileGraphRoundTrips } from "./support/normalized-graph.ts";
import { buildUmlProject, readCompleteUml, type UmlProject } from "./support/uml-project.ts";

const fixtures = createFixtureTracker();

/**
 * Extraction must be a pure function of the indexed sources: the same tree, indexed twice or under
 * a different root, has to produce byte-identical per-file graphs and identical selections. Cycles
 * and self references are the cases where a non-deterministic or de-duplicating writer would show.
 */

const FIXTURE_FILES: Record<string, string> = {
  "base.ts": `export abstract class Base {
  id = 0;
}
export interface Marker {
  tag: string;
}
`,
  "consumer.ts": `import { Base, Marker } from "./base.ts";
export class Consumer extends Base implements Marker {
  tag = "consumer";
  peer?: Base;
  run(value: Marker): Base {
    return this;
  }
}
export function accept(value: Consumer): Base {
  return value;
}
export const answer: number = 42;
export type Alias = Consumer;
`,
  // A <-> B: two files that reference each other through property types.
  "cycle-a.ts": `import { B } from "./cycle-b.ts";
export class A {
  peer!: B;
}
`,
  "cycle-b.ts": `import { A } from "./cycle-a.ts";
export class B {
  peer!: A;
}
`,
  // Direct recursion: a real self reference in SQL that the view must not draw.
  "recursive.ts": `export function loop(depth: number): number {
  return depth === 0 ? 0 : loop(depth - 1);
}
`,
  "empty.ts": "",
};

afterEach(async () => {
  await fixtures.cleanup();
});

function graphText(project: UmlProject): string {
  return JSON.stringify(project.sourcePaths.map((path) => project.fileGraph(path)));
}

function selectionText(project: UmlProject): string {
  return JSON.stringify(
    project.sourcePaths.map((path) => readCompleteUml(project, { kind: "file", path })),
  );
}

test("the same sources extract identically under two different roots", async () => {
  const firstRoot = await fixtures.fixtureRoot("ts-explorer-determinism-a-", FIXTURE_FILES);
  const secondRoot = await fixtures.fixtureRoot("ts-explorer-determinism-b-", FIXTURE_FILES);
  const first = await buildUmlProject(firstRoot);
  const second = await buildUmlProject(secondRoot);
  try {
    expect(second.sourcePaths).toEqual(first.sourcePaths);
    expect(graphText(second)).toBe(graphText(first));
    expect(selectionText(second)).toBe(selectionText(first));
    expectFileGraphRoundTrips(first);
  } finally {
    second.close();
    first.close();
  }
}, 120_000);

test("repeated reads of one selection return the identical payload", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-determinism-reread-", FIXTURE_FILES);
  const project = await buildUmlProject(root);
  try {
    const target = {
      kind: "definition",
      path: "consumer.ts",
      definitionKey: project.key("consumer.ts", "Consumer"),
    } as const;
    const first = readCompleteUml(project, target);
    const second = readCompleteUml(project, target);
    // Per-read memoization must not mutate the hydrated models it caches.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(readCompleteUml(project, { kind: "file", path: "consumer.ts" })))
      .toBe(JSON.stringify(readCompleteUml(project, { kind: "file", path: "consumer.ts" })));
  } finally {
    project.close();
  }
}, 60_000);

test("a mutual cycle keeps both directed edges, once each", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-determinism-cycle-", FIXTURE_FILES);
  const project = await buildUmlProject(root);
  try {
    const keyA = project.key("cycle-a.ts", "A");
    const keyB = project.key("cycle-b.ts", "B");

    // Each file records only its own outgoing half of the cycle.
    expect(project.fileGraph("cycle-a.ts").relations.map((row) =>
      [row.sourceNodeId, row.targetNodeId, row.relationKind]
    )).toEqual([[project.key("cycle-a.ts", "A.peer"), keyB, "references"]]);
    expect(project.fileGraph("cycle-b.ts").relations.map((row) =>
      [row.sourceNodeId, row.targetNodeId, row.relationKind]
    )).toEqual([[project.key("cycle-b.ts", "B.peer"), keyA, "references"]]);

    const diagram = readCompleteUml(project, { kind: "file", path: "cycle-a.ts" });
    if (diagram.view.kind !== "definitions") throw new Error("expected a definitions view");
    expect(diagram.view.nodes.map((node) => node.definition.key)).toEqual([keyA, keyB]);
    // The closure terminates on the cycle and draws each direction exactly once.
    expect(diagram.view.edges).toEqual([
      { sourceKey: keyA, targetKey: keyB, kind: "references" },
      { sourceKey: keyB, targetKey: keyA, kind: "references" },
    ]);
    expect(diagram.view.frames).toEqual([{ rootKey: keyA, nodeKeys: [keyA, keyB] }]);
  } finally {
    project.close();
  }
}, 60_000);

test("a self-recursive function keeps its SQL relation but shows no self edge", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-determinism-self-", FIXTURE_FILES);
  const project = await buildUmlProject(root);
  try {
    const loopKey = project.key("recursive.ts", "loop");
    expect(project.fileGraph("recursive.ts").relations).toEqual([{
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "references",
      sourceNodeId: loopKey,
      targetNodeId: loopKey,
    }]);

    const diagram = readCompleteUml(project, {
      kind: "definition",
      path: "recursive.ts",
      definitionKey: loopKey,
    });
    if (diagram.view.kind !== "definitions") throw new Error("expected a definitions view");
    expect(diagram.view.nodes.map((node) => node.definition.key)).toEqual([loopKey]);
    expect(diagram.view.edges).toEqual([]);
    expect(diagram.view.frames).toEqual([{ rootKey: loopKey, nodeKeys: [loopKey] }]);
  } finally {
    project.close();
  }
}, 60_000);
