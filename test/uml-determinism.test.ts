import { afterEach, expect, test } from "bun:test";
import type { UmlDiagramGraph } from "../src/diagram-graph.ts";
import { FULL_UML_VISIBILITY } from "../src/uml/model.ts";
import { renderUmlDiagramGraph, validateUmlDiagramGraph } from "../src/uml/render.ts";
import { renderUmlView } from "../src/uml/view.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import {
  expectCachedRendering,
  expectNormalizedUmlRoundTrip,
  expectTopologyRoundTrip,
  materializeUmlGraph,
} from "./support/normalized-graph.ts";
import { extractNormalizedGraph } from "./support/uml-contract.ts";

const fixtures = createFixtureTracker();

const FIXTURES: Record<"baseline" | "usage" | "clusters" | "empty", Record<string, string>> = {
  baseline: {
    "src/model.ts": `export class Widget {
  label = "widget";
  size?: number;
  render(): string {
    return this.label;
  }
}
export interface Shape {
  area: number;
  scale(factor: number): void;
}
export enum Mode {
  Idle,
  Busy,
}
export type Options = { retries: number; onDone(): void };
export type Id = string;
export type Fn = (a: number) => void;
export class Box<T> {
  value!: T;
  read(): T {
    return this.value;
  }
}
export interface Container<T> {
  items: T[];
}
`,
  },
  usage: {
    "src/targets.ts": `export class ArgTarget {}
export class NewTarget {}
export class ParamTarget {}
export class ReturnTarget {}
export class PropTarget {}
export class GenericTarget {}
export class AssertTarget {}
export class TypeofTarget {}
export class ConstraintTarget {}
export class SatisfiesTarget {}
export class IndexedTarget {
  field!: string;
}
export class JsdocTarget {}
export class TypeOnlyTarget {}
export class Consumer {
  prop!: PropTarget;
  take(value: ParamTarget): ReturnTarget {
    return new ReturnTarget();
  }
  build(): void {
    accept(new ArgTarget());
    const made = new NewTarget();
    const box: Array<GenericTarget> = [];
    const cast = made as unknown as AssertTarget;
    const shape: typeof TypeofTarget = TypeofTarget;
    const idx: IndexedTarget["field"] = "";
    const sat = {} satisfies Partial<SatisfiesTarget>;
  }
  limit<T extends ConstraintTarget>(value: T): T {
    return value;
  }
  /** @param value {JsdocTarget} */
  documented(value: unknown): void {}
}
function accept(value: ArgTarget): void {}
`,
    "src/type-only.ts": `import type { TypeOnlyTarget } from "./targets.ts";
export class TypeOnlyUser {
  value!: TypeOnlyTarget;
}
`,
  },
  clusters: {
    "src/clusters.ts": `export class A1 {
  peer!: A2;
}
export class A2 {
  peer!: A3;
}
export class A3 {
  peer!: A1;
  link(): B1 {
    return new B1();
  }
}
export class B1 {
  peer!: B2;
}
export class B2 {
  peer!: B3;
}
export class B3 {
  peer!: B1;
}
`,
  },
  empty: {
    "src/value.ts": `export const value = 1;
`,
  },
};

afterEach(async () => {
  await fixtures.cleanup();
});

function expectContiguousOrdinals(
  rows: readonly { [key: string]: unknown }[],
  field: string,
  label: string,
): void {
  expect(rows.map((row) => row[field]), `${label}: ${field}`).toEqual(rows.map((_, index) => index));
}

function expectPersistedRecordContract(graph: UmlDiagramGraph, label: string): void {
  expect(() => validateUmlDiagramGraph(graph), label).not.toThrow();

  expectContiguousOrdinals(graph.nodes, "nodeOrdinal", label);
  expectContiguousOrdinals(graph.edges, "edgeOrdinal", label);
  expectContiguousOrdinals(graph.declarations, "declarationOrdinal", label);
  expectContiguousOrdinals(graph.methodReturnDependencies, "dependencyOrdinal", label);
  expectContiguousOrdinals(graph.usageEdges, "dependencyOrdinal", label);
  expectContiguousOrdinals(graph.localUsers, "userOrdinal", label);
  expectContiguousOrdinals(graph.externalUsers, "userOrdinal", label);
  expectContiguousOrdinals(graph.definitions, "definitionOrdinal", label);
  expectContiguousOrdinals(graph.categories, "categoryOrdinal", label);

  const relationsByEdge = new Map<number, UmlDiagramGraph["relations"]>();
  for (const relation of graph.relations) {
    const rows = relationsByEdge.get(relation.edgeOrdinal) ?? [];
    rows.push(relation);
    relationsByEdge.set(relation.edgeOrdinal, rows);
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  const danglingEndpoints = graph.relations.filter((relation) =>
    !nodeIds.has(relation.sourceNodeId) || !nodeIds.has(relation.targetNodeId)
  );
  expect(danglingEndpoints, `${label}: relation endpoints`).toEqual([]);
  for (const edge of graph.edges) {
    const rows = relationsByEdge.get(edge.edgeOrdinal) ?? [];
    expect(rows.map((relation) => relation.relationOrdinal), `${label}: edge ${edge.edgeOrdinal}`)
      .toEqual(rows.map((_, index) => index));
    expect(rows.length, `${label}: edge ${edge.edgeOrdinal} weight`).toBe(edge.weight);
  }
  expect(
    [...relationsByEdge.keys()].filter((edgeOrdinal) => edgeOrdinal >= graph.edges.length),
    `${label}: orphan relations`,
  ).toEqual([]);
}

test("repeated extraction of one tree is identical", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-determinism-repeat-", FIXTURES.usage);

  const first = await extractNormalizedGraph(root);
  const second = await extractNormalizedGraph(root);

  expect(second).toEqual(first);
  const firstRendering = renderUmlView(renderUmlDiagramGraph(first).view, FULL_UML_VISIBILITY);
  const secondRendering = renderUmlView(renderUmlDiagramGraph(second).view, FULL_UML_VISIBILITY);
  expect(secondRendering.dsl).toEqual(firstRendering.dsl);
  expect(secondRendering.dsls).toEqual(firstRendering.dsls);
}, 60_000);

test("two roots with identical content extract identically", async () => {
  const firstRoot = await fixtures.fixtureRoot("ts-explorer-determinism-root-a-", FIXTURES.usage);
  const secondRoot = await fixtures.fixtureRoot("ts-explorer-determinism-root-b-", FIXTURES.usage);

  const first = await extractNormalizedGraph(firstRoot);
  const second = await extractNormalizedGraph(secondRoot);

  expect(second).toEqual(first);
}, 60_000);

test("every fixture satisfies the persisted-record contract", async () => {
  for (const [name, files] of Object.entries(FIXTURES)) {
    const root = await fixtures.fixtureRoot(`ts-explorer-determinism-${name}-`, files);
    const graph = await extractNormalizedGraph(root);

    expectPersistedRecordContract(graph, name);

    const materialized = await materializeUmlGraph(root, graph);
    if (materialized.record.kind !== "uml") throw new Error(`expected a UML record for ${name}`);
    expectNormalizedUmlRoundTrip(materialized.record, graph);
    expectTopologyRoundTrip(materialized.record, graph);
    expectCachedRendering(materialized);
  }
}, 120_000);

test("community assignment and frame rendering are reproducible", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-determinism-clusters-", FIXTURES.clusters);

  const first = await extractNormalizedGraph(root);
  const second = await extractNormalizedGraph(root);

  // characterizes: the seeded Louvain pass splits the two property-linked clusters the same way on
  // every run, keeping the method-return edge A3 -> B1 as the only cross-community relation
  expect(second.nodes.map((node) => [node.name, node.community])).toEqual([
    ["A1", 0],
    ["A2", 0],
    ["A3", 0],
    ["B1", 1],
    ["B2", 1],
    ["B3", 1],
  ]);
  expect(second.nodes.map((node) => [node.name, node.community]))
    .toEqual(first.nodes.map((node) => [node.name, node.community]));

  const firstRendering = renderUmlView(renderUmlDiagramGraph(first).view, FULL_UML_VISIBILITY);
  const secondRendering = renderUmlView(renderUmlDiagramGraph(second).view, FULL_UML_VISIBILITY);
  expect(secondRendering.dsls).toEqual(firstRendering.dsls);
  expect(secondRendering.dsls.length).toBe(2);
  // characterizes: every community frame opens with a leading newline before `classDiagram`
  for (const [index, frame] of secondRendering.dsls.entries()) {
    expect(frame.startsWith("\nclassDiagram\n"), `frame ${index}`).toBe(true);
  }
}, 60_000);
