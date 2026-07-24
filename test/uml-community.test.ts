import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UmlDiagramGraph } from "../src/diagram-graph.ts";
import { extractUmlDiagramGraph } from "../src/uml.ts";
import type { UmlGraph } from "../src/uml/graph.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import {
  expectCachedRendering,
  expectTopologyRoundTrip,
  materializeUmlGraph,
} from "./support/normalized-graph.ts";
type UmlGraphRelation = ReturnType<UmlGraph["getEdgeAttributes"]>["relations"][number];

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});


async function materializeUml(root: string, scopePath = "") {
  const extracted = await extractUmlDiagramGraph(root, scopePath, []);
  return materializeUmlGraph(root, extracted);
}

function namedRelations(record: UmlDiagramGraph, relationKind: string) {
  const nodeNames = new Map(record.nodes.map(({ nodeId, name }) => [nodeId, name]));
  return record.relations
    .filter((relation) => relation.relationKind === relationKind)
    .map((relation) => {
      const edge = record.edges[relation.edgeOrdinal];
      if (!edge) throw new Error(`Missing edge ${relation.edgeOrdinal}`);
      return {
        edgeOrdinal: relation.edgeOrdinal,
        relationOrdinal: relation.relationOrdinal,
        source: nodeNames.get(relation.sourceNodeId),
        target: nodeNames.get(relation.targetNodeId),
        weight: edge.weight,
      };
    });
}

function hydratedNamedRelations(
  record: UmlDiagramGraph,
  graph: UmlGraph,
  relationKind: string,
) {
  return record.relations
    .filter((relation) => relation.relationKind === relationKind)
    .map((relation) => {
      const edge = graph.getEdgeAttributes(relation.sourceNodeId, relation.targetNodeId);
      return {
        source: graph.getNodeAttribute(relation.sourceNodeId, "name"),
        target: graph.getNodeAttribute(relation.targetNodeId, "name"),
        weight: edge.weight,
        relations: edge.relations.map(({ kind, sourceId, targetId }) => ({
          kind,
          source: graph.getNodeAttribute(sourceId, "name"),
          target: graph.getNodeAttribute(targetId, "name"),
        })),
      };
    });
}

function classNames(dsl: string): string[] {
  return [...dsl.matchAll(/^class\s+([^\s{]+)\s*\{/gm)].map((match) => match[1]);
}

function cssAssignments(dsl: string): Array<{ name: string; style: string }> {
  return [...dsl.matchAll(/^cssClass\s+"([^"]+)"\s+(\S+)\s*$/gm)].map((match) => ({
    name: match[1],
    style: match[2],
  }));
}

function classDefNames(dsl: string): string[] {
  return [...dsl.matchAll(/^classDef\s+(\S+)\s+/gm)].map((match) => match[1]);
}

function lineCount(dsl: string, expected: string): number {
  return dsl.split(/\r?\n/).filter((line) => line === expected).length;
}

test("partitions UML into ordered self-contained communities", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-community-");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    'import { B } from "./b";\nexport class A extends B {}\nexport interface I {}\n',
  );
  await writeFile(join(root, "src", "b.ts"), "export class B {}\nexport class C {}\n");
  await writeFile(
    join(root, "src", "d.ts"),
    'import { E } from "./e";\nexport class D { ref!: E; }\n',
  );
  await writeFile(join(root, "src", "e.ts"), "export class E {}\n");
  await writeFile(join(root, "tests", "example.test.ts"), "export class ExampleTest {}\n");

  const bundle = await materializeUml(root);
  const expectedCommunities = [["A", "B"], ["I"], ["C"], ["D", "E"], ["ExampleTest"]];
  expect(
    bundle.record.nodes.map(({ nodeOrdinal, nodeKind, name, community }) => ({
      nodeOrdinal,
      nodeKind,
      name,
      community,
    })),
  ).toEqual([
    { nodeOrdinal: 0, nodeKind: "entity", name: "A", community: 0 },
    { nodeOrdinal: 1, nodeKind: "entity", name: "I", community: 1 },
    { nodeOrdinal: 2, nodeKind: "entity", name: "B", community: 0 },
    { nodeOrdinal: 3, nodeKind: "entity", name: "C", community: 2 },
    { nodeOrdinal: 4, nodeKind: "entity", name: "D", community: 3 },
    { nodeOrdinal: 5, nodeKind: "entity", name: "E", community: 3 },
    { nodeOrdinal: 6, nodeKind: "entity", name: "ExampleTest", community: 4 },
  ]);
  expect(bundle.graph.nodes()).toEqual(bundle.record.nodes.map(({ nodeId }) => nodeId));
  expectTopologyRoundTrip(bundle.record, bundle.extracted);
  expect(namedRelations(bundle.record, "heritage")).toEqual([
    {
      edgeOrdinal: 0,
      relationOrdinal: 0,
      source: "A",
      target: "B",
      weight: 1,
    },
  ]);
  expect(namedRelations(bundle.record, "member-association")).toEqual([
    {
      edgeOrdinal: 1,
      relationOrdinal: 0,
      source: "D",
      target: "E",
      weight: 2,
    },
  ]);
  expect(namedRelations(bundle.record, "usage")).toEqual([
    {
      edgeOrdinal: 1,
      relationOrdinal: 1,
      source: "D",
      target: "E",
      weight: 2,
    },
  ]);
  expectCachedRendering(bundle);

  expect(bundle.dsls).toHaveLength(5);
  expect(
    bundle.dsls.map((dsl) => cssAssignments(dsl).map(({ name }) => name).sort()),
  ).toEqual(expectedCommunities);

  for (const [index, dsl] of bundle.dsls.entries()) {
    expect(dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);

    const declarations = classNames(dsl);
    const assignments = cssAssignments(dsl);
    const styles = classDefNames(dsl);
    expect(declarations.sort()).toEqual([...expectedCommunities[index]].sort());
    expect(assignments.filter(({ name }) => !declarations.includes(name))).toEqual([]);
    expect(assignments.filter(({ style }) => !styles.includes(style))).toEqual([]);
  }

  const inheritanceDsl = bundle.dsls[0];
  expect(inheritanceDsl).toContain("B<|--A");

  const associationDsl = bundle.dsls[3];
  expect(classNames(associationDsl).sort()).toEqual(["D", "E"]);
  expect(associationDsl).toMatch(/D\s+--\s+E/);

  const testAssignment = cssAssignments(bundle.dsls[4]).find(({ name }) => name === "ExampleTest");
  expect(testAssignment?.style).toBe("testConcrete");

});

test("keeps method-return-connected entities in one community frame", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-return-community-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "f.ts"),
    'import { G } from "./g";\nexport class F { make(): G { return new G(); } }\n',
  );
  await writeFile(join(root, "src", "g.ts"), "export class G {}\n");
  await writeFile(
    join(root, "src", "h.ts"),
    "export class H { self(): H { return this; } value(): number { return 1; } }\n",
  );

  const bundle = await materializeUml(root);

  expect(bundle.dsls.map((dsl) => classNames(dsl).sort())).toEqual([["F", "G"], ["H"]]);
  expect(
    namedRelations(bundle.record, "method-return").map(
      ({ relationOrdinal, source, target, weight }) => ({
        relationOrdinal,
        source,
        target,
        weight,
      }),
    ),
  ).toEqual([
    {
      relationOrdinal: 0,
      source: "F",
      target: "G",
      weight: 1,
    },
  ]);

  const methodReturnDsl = bundle.dsls[0];
  expect(classNames(methodReturnDsl).sort()).toEqual(["F", "G"]);
  expect(methodReturnDsl).toMatch(/^[ \t]*F[ \t]*-->[ \t]*G[ \t]*\r?$/m);

  const selfDsl = bundle.dsls[1];
  expect(classNames(selfDsl)).toEqual(["H"]);
  expect(selfDsl).not.toMatch(/-->/);

  expect(bundle.dsl).toMatch(/^[ \t]*F[ \t]*-->[ \t]*G[ \t]*\r?$/m);
});

test("keeps external-user fan-out targets in one community frame", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-external-community-");
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "lib", "first-target.ts"), "export class FirstTarget {}\n");
  await writeFile(join(root, "src", "lib", "second-target.ts"), "export class SecondTarget {}\n");
  await writeFile(
    join(root, "src", "app", "consumer.ts"),
    [
      'import { FirstTarget } from "../lib/first-target";',
      'import { SecondTarget } from "../lib/second-target";',
      "export class Consumer {",
      "  build(): void {",
      "    new FirstTarget();",
      "    new SecondTarget();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await materializeUml(root, "src/lib");
  const externalDeclaration =
    'class extern0["extern: src/app/consumer.ts<br/>Consumer.build()"]';
  const firstEdge = "extern0 --> FirstTarget";
  const secondEdge = "extern0 --> SecondTarget";

  expect(bundle.dsls.map((dsl) => classNames(dsl).sort())).toEqual([
    ["FirstTarget", "SecondTarget"],
  ]);
  expect(bundle.dsls.map((dsl) => lineCount(dsl, externalDeclaration))).toEqual([1]);
  expect(
    namedRelations(bundle.record, "external-user").map(
      ({ relationOrdinal, source, target, weight }) => ({
        relationOrdinal,
        source,
        target,
        weight,
      }),
    ),
  ).toEqual([
    {
      relationOrdinal: 0,
      source: "extern: src/app/consumer.ts: Consumer.build()",
      target: "FirstTarget",
      weight: 1,
    },
    {
      relationOrdinal: 0,
      source: "extern: src/app/consumer.ts: Consumer.build()",
      target: "SecondTarget",
      weight: 1,
    },
  ]);
  expect(hydratedNamedRelations(bundle.record, bundle.graph, "external-user")).toEqual([
    {
      source: "extern: src/app/consumer.ts: Consumer.build()",
      target: "FirstTarget",
      weight: 1,
      relations: [{
        kind: "external-user",
        source: "extern: src/app/consumer.ts: Consumer.build()",
        target: "FirstTarget",
      }],
    },
    {
      source: "extern: src/app/consumer.ts: Consumer.build()",
      target: "SecondTarget",
      weight: 1,
      relations: [{
        kind: "external-user",
        source: "extern: src/app/consumer.ts: Consumer.build()",
        target: "SecondTarget",
      }],
    },
  ]);

  const fanOutFrame = bundle.dsls[0];
  expect(lineCount(fanOutFrame, firstEdge)).toBe(1);
  expect(lineCount(fanOutFrame, secondEdge)).toBe(1);

  expect(lineCount(bundle.dsl, externalDeclaration)).toBe(1);
  expect(lineCount(bundle.dsl, firstEdge)).toBe(1);
  expect(lineCount(bundle.dsl, secondEdge)).toBe(1);
});

test("keeps an empty UML scope as one renderable frame", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-empty-");

  const bundle = await materializeUml(root);

  expect(bundle.dsls).toEqual([bundle.dsl]);
  expect(bundle.dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);
  expect(bundle.graph.order).toBe(0);
  expect(bundle.graph.size).toBe(0);
  expect({
    nodes: bundle.record.nodes,
    aliases: bundle.record.aliases,
    edges: bundle.record.edges,
    relations: bundle.record.relations,
  }).toEqual({ nodes: [], aliases: [], edges: [], relations: [] });
  expect(bundle.record.nodes).toEqual(bundle.extracted.nodes);
});

test("keeps local-user fan-out targets in one community frame", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-local-community-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "first-target.ts"), "export class FirstTarget {}\n");
  await writeFile(join(root, "src", "second-target.ts"), "export class SecondTarget {}\n");
  await writeFile(join(root, "src", "unrelated.ts"), "export class Unrelated {}\n");
  await writeFile(
    join(root, "src", "target-union.ts"),
    [
      'import { FirstTarget } from "./first-target";',
      'import { SecondTarget } from "./second-target";',
      "",
      "export type TargetUnion = FirstTarget | SecondTarget;",
      "",
    ].join("\n"),
  );

  const bundle = await materializeUml(root);
  const localDeclaration = 'class local0["local: src/target-union.ts<br/>TargetUnion"]';
  const firstEdge = "local0 --> FirstTarget";
  const secondEdge = "local0 --> SecondTarget";

  expect(
    bundle.localUsers.map(({ nodeId, label, kind, path }) => ({ nodeId, label, kind, path })),
  ).toEqual([
    {
      nodeId: "local0",
      label: "local: src/target-union.ts: TargetUnion",
      kind: "type",
      path: "src/target-union.ts",
    },
  ]);
  expect(bundle.dsls).toHaveLength(2);
  expect(
    namedRelations(bundle.record, "local-user").map(
      ({ relationOrdinal, source, target, weight }) => ({
        relationOrdinal,
        source,
        target,
        weight,
      }),
    ),
  ).toEqual([
    {
      relationOrdinal: 0,
      source: "local: src/target-union.ts: TargetUnion",
      target: "FirstTarget",
      weight: 1,
    },
    {
      relationOrdinal: 0,
      source: "local: src/target-union.ts: TargetUnion",
      target: "SecondTarget",
      weight: 1,
    },
  ]);
  expect(hydratedNamedRelations(bundle.record, bundle.graph, "local-user")).toEqual([
    {
      source: "local: src/target-union.ts: TargetUnion",
      target: "FirstTarget",
      weight: 1,
      relations: [{
        kind: "local-user",
        source: "local: src/target-union.ts: TargetUnion",
        target: "FirstTarget",
      }],
    },
    {
      source: "local: src/target-union.ts: TargetUnion",
      target: "SecondTarget",
      weight: 1,
      relations: [{
        kind: "local-user",
        source: "local: src/target-union.ts: TargetUnion",
        target: "SecondTarget",
      }],
    },
  ]);

  const fanOutFrames = bundle.dsls.filter((dsl) => classNames(dsl).includes("FirstTarget"));
  expect(fanOutFrames).toHaveLength(1);
  const fanOutFrame = fanOutFrames[0];
  if (fanOutFrame === undefined) {
    throw new Error("Expected one local-user fan-out frame");
  }
  expect(classNames(fanOutFrame).sort()).toEqual(["FirstTarget", "SecondTarget"]);
  expect(lineCount(fanOutFrame, localDeclaration)).toBe(1);
  expect(lineCount(fanOutFrame, firstEdge)).toBe(1);
  expect(lineCount(fanOutFrame, secondEdge)).toBe(1);

  const unrelatedFrame = bundle.dsls.find((dsl) => classNames(dsl).includes("Unrelated"));
  expect(unrelatedFrame).toBeDefined();
  if (unrelatedFrame === undefined) {
    throw new Error("Expected the unrelated community frame");
  }
  expect(classNames(unrelatedFrame).sort()).toEqual(["Unrelated"]);
  expect(lineCount(unrelatedFrame, localDeclaration)).toBe(0);
  expect(lineCount(unrelatedFrame, firstEdge)).toBe(0);
  expect(lineCount(unrelatedFrame, secondEdge)).toBe(0);

  expect(bundle.dsls.reduce((count, dsl) => count + lineCount(dsl, localDeclaration), 0)).toBe(1);
  expect(lineCount(bundle.dsl, localDeclaration)).toBe(1);
  expect(lineCount(bundle.dsl, firstEdge)).toBe(1);
  expect(lineCount(bundle.dsl, secondEdge)).toBe(1);
});

test("keeps a weak bridge visible across deterministic dense Louvain communities", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-uml-louvain-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "clusters.ts"),
    [
      "export class A1<T> { a2!: A2; a3!: A3; bridge!: B1; }",
      "export class A2 extends A1<string> { a3!: A3; }",
      "export class A3 { a1!: A1<string>; a2!: A2; }",
      "export class B1 { b2!: B2; b3!: B3; }",
      "export class B2 { b1!: B1; b3!: B3; }",
      "export class B3 { b1!: B1; b2!: B2; }",
      "",
    ].join("\n"),
  );

  const bundle = await materializeUml(root);
  const entityCommunities = new Map(
    bundle.graph
      .nodes()
      .filter((id) => bundle.graph.getNodeAttribute(id, "kind") === "entity")
      .map((id) => [
        bundle.graph.getNodeAttribute(id, "name").replace(/<.*$/, ""),
        bundle.graph.getNodeAttribute(id, "community"),
      ]),
  );
  const communityOf = (name: string): number => {
    const community = entityCommunities.get(name);
    if (typeof community !== "number" || !Number.isInteger(community)) {
      throw new Error(`Expected an integer community for ${name}`);
    }
    return community;
  };
  const clusterA = ["A1", "A2", "A3"];
  const clusterB = ["B1", "B2", "B3"];
  const communityA = communityOf("A1");
  const communityB = communityOf("B1");
  expect(
    bundle.record.nodes.map(({ nodeOrdinal, name, community }) => ({
      nodeOrdinal,
      name: name.replace(/<.*$/, ""),
      community,
    })),
  ).toEqual([
    { nodeOrdinal: 0, name: "A1", community: 0 },
    { nodeOrdinal: 1, name: "A2", community: 0 },
    { nodeOrdinal: 2, name: "A3", community: 0 },
    { nodeOrdinal: 3, name: "B1", community: 1 },
    { nodeOrdinal: 4, name: "B2", community: 1 },
    { nodeOrdinal: 5, name: "B3", community: 1 },
  ]);
  expect(
    bundle.record.nodes.map(({ nodeId, community }) => ({ nodeId, community })),
  ).toEqual(
    bundle.extracted.nodes.map(({ nodeId, community }) => ({ nodeId, community })),
  );
  const genericBaseId = bundle.graph.nodes().find(
    (id) => bundle.graph.getNodeAttribute(id, "name").replace(/<.*$/, "") === "A1",
  );
  const genericChildId = bundle.graph.nodes().find(
    (id) => bundle.graph.getNodeAttribute(id, "name") === "A2",
  );
  if (genericBaseId === undefined || genericChildId === undefined) {
    throw new Error("Expected declared generic base and child graph nodes");
  }
  const genericHeritage = bundle.graph.edges().flatMap(
    (edge) => bundle.graph.getEdgeAttribute(edge, "relations"),
  ).find(({ kind, sourceId, targetId }) =>
    kind === "heritage" && sourceId === genericChildId && targetId === genericBaseId
  );
  const storedGenericHeritage = bundle.record.relations.find(
    ({ relationKind, sourceNodeId, targetNodeId }) =>
      relationKind === "heritage"
      && sourceNodeId === genericChildId
      && targetNodeId === genericBaseId,
  );
  if (!storedGenericHeritage) throw new Error("Expected stored generic heritage relation");
  const storedGenericEdge = bundle.record.edges[storedGenericHeritage.edgeOrdinal];
  if (!storedGenericEdge) throw new Error("Expected stored generic heritage edge");
  const storedGenericRelations = bundle.record.relations.filter(
    ({ edgeOrdinal }) => edgeOrdinal === storedGenericHeritage.edgeOrdinal,
  );
  const genericClause = bundle.record.entityHeritageClauses.find(
    ({ className, clause }) => className === "A2" && clause.replace(/<.*$/, "") === "A1",
  );
  if (!genericClause) throw new Error("Expected normalized generic heritage clause");

  expect(genericHeritage).toEqual({
    kind: "heritage",
    sourceId: genericChildId,
    targetId: genericBaseId,
  });
  expect(storedGenericHeritage).toEqual({
    edgeOrdinal: storedGenericHeritage.edgeOrdinal,
    relationOrdinal: storedGenericHeritage.relationOrdinal,
    relationKind: "heritage",
    sourceNodeId: genericChildId,
    targetNodeId: genericBaseId,
  });
  expect(storedGenericEdge.weight).toBe(storedGenericRelations.length);
  expect(bundle.graph.getEdgeAttributes(genericChildId, genericBaseId)).toEqual({
    weight: storedGenericRelations.length,
    relations: storedGenericRelations.map(
      ({ relationKind, sourceNodeId, targetNodeId }): UmlGraphRelation => {
        if (relationKind === "package-dependency") {
          throw new Error("Expected only UML relations on the hydrated UML edge");
        }
        return {
          kind: relationKind,
          sourceId: sourceNodeId,
          targetId: targetNodeId,
        };
      },
    ),
  });
  expect(bundle.record.aliases).toEqual([
    {
      nodeId: genericBaseId,
      aliasOrdinal: 0,
      alias: genericClause.clauseTypeId,
    },
  ]);
  expect(bundle.graph.getNodeAttribute(genericBaseId, "aliases")).toEqual([
    genericClause.clauseTypeId,
  ]);
  expect(
    namedRelations(bundle.record, "member-association")
      .filter(({ source, target }) =>
        source?.replace(/<.*$/, "") === "A1" && target === "B1"
      ),
  ).toEqual([
    {
      edgeOrdinal: 2,
      relationOrdinal: 0,
      source: "A1<T>",
      target: "B1",
      weight: 2,
    },
  ]);
  expect(
    namedRelations(bundle.record, "usage")
      .filter(({ source, target }) =>
        source?.replace(/<.*$/, "") === "A1" && target === "B1"
      ),
  ).toEqual([
    {
      edgeOrdinal: 2,
      relationOrdinal: 1,
      source: "A1<T>",
      target: "B1",
      weight: 2,
    },
  ]);
  expect(new Set(entityCommunities.values())).toHaveLength(2);
  expect(new Set(clusterA.map(communityOf))).toEqual(new Set([communityA]));
  expect(new Set(clusterB.map(communityOf))).toEqual(new Set([communityB]));
  expect(communityA).not.toBe(communityB);
  expect(bundle.dsls.map((dsl) => classNames(dsl).sort())).toEqual([
    ["A1", "A2", "A3", "B1"],
    ["A1", "B1", "B2", "B3"],
  ]);

  const genericAlias = 'class A1["A1⟨T⟩"]';
  const bridge = /^[ \t]*(?:A1[ \t]*--[ \t]*B1|B1[ \t]*--[ \t]*A1)[ \t]*\r?$/m;
  const genericInheritance = /^[ \t]*A1<\|--A2[ \t]*\r?$/m;
  for (const dsl of bundle.dsls) {
    expect(dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);
    expect(dsl.match(/^[ \t]*classDiagram[ \t]*$/gm) ?? []).toHaveLength(1);
    expect(dsl).toContain(genericAlias);
    expect(dsl).toMatch(bridge);
    expect(dsl).not.toContain("~");
  }
  expect(classNames(bundle.dsl).sort()).toEqual([...clusterA, ...clusterB].sort());
  expect(bundle.dsl).toContain(genericAlias);
  expect(bundle.dsl).toMatch(bridge);
  expect(bundle.dsl).toMatch(genericInheritance);
  expect(bundle.dsls.filter((dsl) => genericInheritance.test(dsl))).toHaveLength(1);

  const rebuilt = await materializeUml(root);
  expect(rebuilt.record).toEqual(bundle.record);
  expect({
    dsl: rebuilt.dsl,
    dsls: rebuilt.dsls,
    packageNodes: rebuilt.packageNodes,
    definitions: rebuilt.definitions,
    externalUsers: rebuilt.externalUsers,
    localUsers: rebuilt.localUsers,
  }).toEqual({
    dsl: bundle.dsl,
    dsls: bundle.dsls,
    packageNodes: bundle.packageNodes,
    definitions: bundle.definitions,
    externalUsers: bundle.externalUsers,
    localUsers: bundle.localUsers,
  });
  expect(rebuilt.cached).toEqual(bundle.cached);

  const forcedCommunity = 17;
  const replayed = await materializeUmlGraph(root, {
    ...bundle.record,
    nodes: bundle.record.nodes.map((node) => ({ ...node, community: forcedCommunity })),
  });
  const storedCommunities = replayed.record.nodes.map(({ community }) => community);
  expect(storedCommunities).toEqual(replayed.record.nodes.map(() => forcedCommunity));
  expect(replayed.dsls).toEqual([replayed.dsl]);

  expectCachedRendering(replayed);
  expect(replayed.record.nodes.map(({ community }) => community)).toEqual(storedCommunities);
});
