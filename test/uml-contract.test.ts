import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { UmlDiagramGraph } from "../src/diagram-graph.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { expectFileGraphRoundTrips } from "./support/normalized-graph.ts";
import {
  expectCatalogueRows,
  expectNormalizedGraphRows,
  readNormalizedGraphSnapshot,
} from "./support/normalized-sql.ts";
import { buildUmlProject, readCompleteUml, type UmlProject } from "./support/uml-project.ts";

const fixtures = createFixtureTracker();

/**
 * One source file's persisted UML graph is the unit the whole rooted design is built on: every
 * node is a catalogue definition key, every edge is directed, and the `diagrams` row carries only
 * a completion marker. These tests pin that per-file contract, not any assembled selection.
 */

const SCRIPT_FILES: Record<string, string> = {
  "base.ts": `export abstract class Base {
  id = 0;
}
export interface Marker {
  tag: string;
}
`,
  "root.ts": `import { Base, Marker } from "./base.ts";
export class Root extends Base implements Marker {
  tag = "root";
  peer?: Base;
  run(value: Marker): Base {
    return this;
  }
}
export function helper(value: Root): number {
  return value.id;
}
export const answer: number = 42;
export enum Mode {
  Idle,
  Busy,
}
export type Alias = Root;
`,
  // The generic bound and the heritage clause are two references from one owner to one target.
  "derived.ts": `import { Base } from "./base.ts";
export class Derived<T extends Base> extends Base {
  items: T[] = [];
}
`,
  // A second, unrelated `Base`: same name, different file, different category.
  "other.ts": `export interface Base {
  extra: string;
}
`,
  "empty.ts": "",
};

const RUST_FILES: Record<string, string> = {
  "lib.rs": `mod root;
mod contracts;
mod marker_impl;
mod methods;
mod leaf;
`,
  "root.rs": `pub struct Root;
`,
  "contracts.rs": `pub trait LocalTrait {}
`,
  "marker_impl.rs": `use crate::root::Root;
use crate::contracts::LocalTrait;
impl LocalTrait for Root {}
`,
  "methods.rs": `use crate::root::Root;
use crate::leaf::Leaf;
impl Root {
    pub fn make(&self) -> Leaf {
        Leaf
    }
}
`,
  "leaf.rs": `pub struct Leaf;
`,
};

afterEach(async () => {
  await fixtures.cleanup();
});

function nodeKinds(project: UmlProject, path: string): Record<string, string> {
  return Object.fromEntries(
    project.fileGraph(path).nodes.map((node) => [node.nodeId, node.nodeKind]),
  );
}

function ordinals(rows: readonly { [key: string]: unknown }[], field: string): unknown[] {
  return rows.map((row) => row[field]);
}

function contiguous(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

test("node kind records what the selected file contributes", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-nodes-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  try {
    expect(nodeKinds(project, "root.ts")).toEqual({
      // Nominal definitions declared here.
      [project.key("root.ts", "Root")]: "entity",
      [project.key("root.ts", "Mode")]: "entity",
      // Every other declaration of the file.
      [project.key("root.ts", "Root.tag")]: "definition",
      [project.key("root.ts", "Root.peer")]: "definition",
      [project.key("root.ts", "Root.run")]: "definition",
      [project.key("root.ts", "helper")]: "definition",
      [project.key("root.ts", "answer")]: "definition",
      [project.key("root.ts", "Mode.Idle")]: "definition",
      [project.key("root.ts", "Mode.Busy")]: "definition",
      [project.key("root.ts", "Alias")]: "definition",
      // Referenced targets this file contributes nothing to.
      [project.key("base.ts", "Base")]: "boundary",
      [project.key("base.ts", "Marker")]: "boundary",
    });

    const graph = project.fileGraph("root.ts");
    expect(ordinals(graph.nodes, "nodeOrdinal")).toEqual(contiguous(graph.nodes.length));
    // The same definition is an entity in its declaring file and a boundary in a referencing one.
    expect(nodeKinds(project, "base.ts")[project.key("base.ts", "Base")]).toBe("entity");
    expect(nodeKinds(project, "empty.ts")).toEqual({});
  } finally {
    project.close();
  }
}, 60_000);

test("edges are directed and deduplicate their relation kinds per pair", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-edges-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  try {
    const derived = project.fileGraph("derived.ts");
    const source = project.key("derived.ts", "Derived");
    const target = project.key("base.ts", "Base");

    expect(derived.edges).toEqual([{
      edgeOrdinal: 0,
      sourceNodeId: source,
      targetNodeId: target,
      edgeKind: "uml-relation",
      directed: true,
      weight: 2,
    }]);
    // `extends Base` and `<T extends Base>` are one directed pair carrying two relation kinds.
    expect(derived.relations).toEqual([
      {
        edgeOrdinal: 0,
        relationOrdinal: 0,
        relationKind: "extends",
        sourceNodeId: source,
        targetNodeId: target,
      },
      {
        edgeOrdinal: 0,
        relationOrdinal: 1,
        relationKind: "references",
        sourceNodeId: source,
        targetNodeId: target,
      },
    ]);
    // Direction is not symmetric: the referenced file records nothing about its users.
    expect(project.fileGraph("base.ts").edges).toEqual([]);
    expect(project.fileGraph("base.ts").relations).toEqual([]);
  } finally {
    project.close();
  }
}, 60_000);

test("every persisted ordinal sequence is contiguous and matches its edge weight", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-ordinals-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  try {
    for (const path of project.sourcePaths) {
      const graph = project.fileGraph(path);
      expect(ordinals(graph.nodes, "nodeOrdinal"), `${path}: nodes`)
        .toEqual(contiguous(graph.nodes.length));
      expect(ordinals(graph.edges, "edgeOrdinal"), `${path}: edges`)
        .toEqual(contiguous(graph.edges.length));
      expect(ordinals(graph.entities, "entityOrdinal"), `${path}: entities`)
        .toEqual(contiguous(graph.entities.length));
      expect(ordinals(graph.categories, "categoryOrdinal"), `${path}: categories`)
        .toEqual(contiguous(graph.categories.length));

      for (const edge of graph.edges) {
        const rows = graph.relations.filter((row) => row.edgeOrdinal === edge.edgeOrdinal);
        expect(ordinals(rows, "relationOrdinal"), `${path}: edge ${edge.edgeOrdinal}`)
          .toEqual(contiguous(rows.length));
        expect(rows.length, `${path}: edge ${edge.edgeOrdinal} weight`).toBe(edge.weight);
      }
      // Relations may only mention nodes this graph declares.
      const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
      const dangling = graph.relations.filter((relation) =>
        !nodeIds.has(relation.sourceNodeId) || !nodeIds.has(relation.targetNodeId)
      );
      expect(dangling, `${path}: relation endpoints`).toEqual([]);

      for (const entity of graph.entities) {
        const owned = <Row extends { entityOrdinal: number }>(rows: readonly Row[]): Row[] =>
          rows.filter((row) => row.entityOrdinal === entity.entityOrdinal);
        for (
          const [rows, field] of [
            [owned(graph.properties), "propertyOrdinal"],
            [owned(graph.methods), "methodOrdinal"],
            [owned(graph.enumItems), "itemOrdinal"],
          ] as const
        ) {
          expect(ordinals(rows, field), `${path}: ${entity.name} ${field}`)
            .toEqual(contiguous(rows.length));
        }
      }
      // Every member row belongs to an entity this graph declares.
      const entityOrdinals = new Set(graph.entities.map((entity) => entity.entityOrdinal));
      const orphanMembers = [
        ...graph.properties,
        ...graph.methods,
        ...graph.enumItems,
        ...graph.memberModifiers,
      ].filter((row) => !entityOrdinals.has(row.entityOrdinal));
      expect(orphanMembers, `${path}: member owners`).toEqual([]);
    }
  } finally {
    project.close();
  }
}, 60_000);

test("member rows carry the definition key of the declaration they render", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-members-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  try {
    const graph = project.fileGraph("root.ts");
    const rootEntity = graph.entities.find((entity) =>
      entity.definitionKey === project.key("root.ts", "Root")
    );
    const modeEntity = graph.entities.find((entity) =>
      entity.definitionKey === project.key("root.ts", "Mode")
    );
    if (!rootEntity || !modeEntity) throw new Error("expected Root and Mode entities");

    expect(graph.properties.map((row) => [row.entityOrdinal, row.definitionKey, row.name]))
      .toEqual([
        [rootEntity.entityOrdinal, project.key("root.ts", "Root.tag"), "tag"],
        [rootEntity.entityOrdinal, project.key("root.ts", "Root.peer"), "peer"],
      ]);
    expect(graph.methods.map((row) => [row.entityOrdinal, row.definitionKey, row.name]))
      .toEqual([
        [rootEntity.entityOrdinal, project.key("root.ts", "Root.run"), "run"],
      ]);
    expect(graph.enumItems.map((row) => [row.entityOrdinal, row.definitionKey, row.value]))
      .toEqual([
        [modeEntity.entityOrdinal, project.key("root.ts", "Mode.Idle"), "Idle"],
        [modeEntity.entityOrdinal, project.key("root.ts", "Mode.Busy"), "Busy"],
      ]);

    // A compartment row addresses the exact outline declaration owned by that entity.
    const byKey = new Map(project.definitions("root.ts").map((row) => [row.key, row]));
    for (const row of [...graph.properties, ...graph.methods, ...graph.enumItems]) {
      const owner = graph.entities.find((entity) => entity.entityOrdinal === row.entityOrdinal);
      expect(byKey.get(row.definitionKey)?.parentKey, row.definitionKey)
        .toBe(owner?.definitionKey);
    }
  } finally {
    project.close();
  }
}, 60_000);

test("categories are keyed by definition key, not by entity name", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-categories-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  try {
    expect(project.fileGraph("base.ts").categories).toEqual([
      {
        categoryOrdinal: 0,
        definitionKey: project.key("base.ts", "Base"),
        category: "abstract",
        isTest: false,
      },
      {
        categoryOrdinal: 1,
        definitionKey: project.key("base.ts", "Marker"),
        category: "interface",
        isTest: false,
      },
    ]);
    // A different file's `Base` is a separate key and keeps its own category.
    expect(project.fileGraph("other.ts").categories).toEqual([{
      categoryOrdinal: 0,
      definitionKey: project.key("other.ts", "Base"),
      category: "interface",
      isTest: false,
    }]);
    expect(project.key("other.ts", "Base")).not.toBe(project.key("base.ts", "Base"));
  } finally {
    project.close();
  }
}, 60_000);

test("a completed file persists its projected rows and only a readiness marker", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-rows-", SCRIPT_FILES);
  const project = await buildUmlProject(root);
  const db = new Database(project.dbPath, { readonly: true, strict: true });
  try {
    expectFileGraphRoundTrips(project);
    expectCatalogueRows(db, project.generationId, project.snapshot);

    for (const path of project.sourcePaths) {
      expectNormalizedGraphRows(db, project.generationId, project.fileGraph(path));
      const snapshot = readNormalizedGraphSnapshot(db, project.generationId, "uml", path);
      expect(snapshot.response, path).toEqual({ status: "ready" });
      expect(snapshot.header, path).toEqual({ format_version: 2, render_mode: "normal" });
    }

    // A syntactically valid file with no declarations still completes, with no rows at all.
    const empty = project.fileGraph("empty.ts");
    expect({ nodes: empty.nodes, edges: empty.edges, entities: empty.entities }).toEqual({
      nodes: [],
      edges: [],
      entities: [],
    });
    expect(readCompleteUml(project, { kind: "file", path: "empty.ts" })).toEqual({
      kind: "uml",
      scopePath: "empty.ts",
      target: { kind: "file", path: "empty.ts" },
      status: "ready",
      view: { kind: "definitions", nodes: [], edges: [], frames: [] },
    });
  } finally {
    db.close();
    project.close();
  }
}, 60_000);

test("a cross-file Rust impl contributes a fragment owned by the declaring type", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-rust-impl-", RUST_FILES);
  const project = await buildUmlProject(root);
  try {
    const rootKey = project.key("root.rs", "Root");
    const methods = project.fileGraph("methods.rs");

    // The fragment carries the implemented type's canonical identity, not a synthetic impl node.
    expect(methods.entities).toEqual([{
      entityOrdinal: 0,
      definitionKey: rootKey,
      entityKind: "struct",
      name: "Root",
    }]);
    expect(methods.methods).toEqual([{
      entityOrdinal: 0,
      methodOrdinal: 0,
      definitionKey: project.key("methods.rs", "Root.make"),
      name: "make",
      returnType: "Leaf",
    }]);
    expect(methods.memberModifiers).toEqual([{
      entityOrdinal: 0,
      memberKind: "method",
      memberOrdinal: 0,
      modifierOrdinal: 0,
      modifier: "public",
    }]);
    // The header/category stays with the declaring file; a fragment must not restyle the type.
    expect(methods.categories).toEqual([]);
    expect(project.fileGraph("root.rs").categories).toEqual([{
      categoryOrdinal: 0,
      definitionKey: rootKey,
      category: "concrete",
      isTest: false,
    }]);

    expect(nodeKinds(project, "methods.rs")).toEqual({
      [rootKey]: "entity",
      [project.key("methods.rs", "Root.make")]: "definition",
      [project.key("leaf.rs", "Leaf")]: "boundary",
    });
    // The method owns its own outgoing reference; the type does not duplicate it.
    expect(methods.relations).toEqual([{
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "references",
      sourceNodeId: project.key("methods.rs", "Root.make"),
      targetNodeId: project.key("leaf.rs", "Leaf"),
    }]);
  } finally {
    project.close();
  }
}, 60_000);

test("a file that declares nothing records only boundary nodes", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-rust-marker-", RUST_FILES);
  const project = await buildUmlProject(root);
  try {
    const rootKey = project.key("root.rs", "Root");
    const traitKey = project.key("contracts.rs", "LocalTrait");
    const marker = project.fileGraph("marker_impl.rs");

    expect(project.definitions("marker_impl.rs")).toEqual([]);
    expect(nodeKinds(project, "marker_impl.rs")).toEqual({
      [rootKey]: "boundary",
      [traitKey]: "boundary",
    });
    // An empty `impl Trait for Type {}` still has to publish its trait relation.
    expect(marker.relations).toEqual([{
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "implements",
      sourceNodeId: rootKey,
      targetNodeId: traitKey,
    }]);
    const detail: Pick<UmlDiagramGraph, "entities" | "properties" | "methods" | "categories"> = {
      entities: marker.entities,
      properties: marker.properties,
      methods: marker.methods,
      categories: marker.categories,
    };
    expect(detail).toEqual({ entities: [], properties: [], methods: [], categories: [] });
  } finally {
    project.close();
  }
}, 60_000);
