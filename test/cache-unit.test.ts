import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Cache } from "../src/cache.ts";
import type { DiagramGraph, RenderedDiagram } from "../src/diagram-graph.ts";
import { extractPackageDiagramGraph } from "../src/packages.ts";
import type { EditorGotoDefinition, PackageInfo } from "../src/types.ts";
import { createFixtureTracker } from "./support/fixtures.ts";

// These tests exercise `Cache` methods directly (writeDiscovery, generation
// lifecycle transitions, and read accessors) that are not already covered by
// the higher-level `Preprocessor` integration tests in preprocessor.test.ts.

const FIXTURE_PACKAGES: PackageInfo[] = [{ name: "root-package", path: "", dependencies: [] }];

function fixturePackagesGraph(): DiagramGraph {
  return extractPackageDiagramGraph(FIXTURE_PACKAGES);
}

function renderFixtureGraph(graph: DiagramGraph): RenderedDiagram {
  return {
    dsl: `${graph.kind}:${graph.scopePath}`,
    dsls: [`${graph.kind}:${graph.scopePath}`],
    packageNodes: [],
    definitions: [],
    externalUsers: [],
    localUsers: [],
  };
}

const fixtures = createFixtureTracker();
const { temporaryRoot } = fixtures;

afterEach(async () => {
  await fixtures.cleanup();
});

test("recover reports no active pointer for a freshly created cache", async () => {
  const root = await temporaryRoot("ts-explorer-cache-unit-");
  const dbPath = join(root, "fresh.db");
  const cache = new Cache(dbPath);
  try {
    expect(cache.recover()).toBeNull();
    expect(cache.getActiveGenerationId()).toBeNull();
  } finally {
    cache.close();
  }
});

test("writeDiscovery persists packages and the diagram response, and readTreeEntries/readDefinitions round-trip scope data", async () => {
  const root = await temporaryRoot("ts-explorer-cache-unit-");
  const dbPath = join(root, "discovery.db");
  const cache = new Cache(dbPath);
  try {
    const generationId = cache.beginGeneration("startup");
    const packages: PackageInfo[] = [{ name: "root-package", path: "", dependencies: [] }];
    const response = cache.writeDiscovery(
      generationId,
      packages,
      { graph: fixturePackagesGraph(), outcome: { status: "ready" } },
      renderFixtureGraph,
    );
    expect(response).toMatchObject({ kind: "packages", scopePath: "", status: "ready" });
    expect(cache.readPackages(generationId)).toEqual(packages);
    expect(cache.readDiagram(generationId, "packages", "")).toEqual(response);

    const definition: EditorGotoDefinition = {
      key: '["class","Widget",0,null,null]',
      kind: "class",
      name: "Widget",
      qualifiedName: "Widget",
      source: { path: "widget.ts", line: 1, column: 14 },
      displayFrom: 13,
      displayTo: 19,
      uml: { scopePath: "widget.ts", entityName: "Widget" },
    };
    cache.writeScope(generationId, {
      entries: [
        { name: "", path: "", kind: "directory" },
        { name: "widget.ts", path: "widget.ts", kind: "file", viewable: true },
      ],
      diagram: { graph: fixturePackagesGraph(), outcome: { status: "ready" } },
      file: {
        path: "widget.ts",
        rawContent: "export class Widget {}\n",
        displayContent: "export class Widget {}\n",
        sourceError: null,
        formatError: null,
      },
      definitions: [definition],
    }, renderFixtureGraph);

    const entries = cache.readTreeEntries(generationId);
    expect(entries).toEqual([
      { name: "", path: "", kind: "directory" },
      { name: "widget.ts", path: "widget.ts", kind: "file", viewable: true },
    ]);
  } finally {
    cache.close();
  }
});

test("readDefinition, readDefinitions and lookupDefinition resolve indexed definitions by generation and qualified name", async () => {
  const root = await temporaryRoot("ts-explorer-cache-unit-");
  const dbPath = join(root, "definitions.db");
  const cache = new Cache(dbPath);
  try {
    const generationId = cache.beginGeneration("startup");
    const definition: EditorGotoDefinition = {
      key: '["class","Widget",0,null,null]',
      kind: "class",
      name: "Widget",
      qualifiedName: "Widget",
      source: { path: "widget.ts", line: 1, column: 14 },
      displayFrom: 13,
      displayTo: 19,
      uml: { scopePath: "widget.ts", entityName: "Widget" },
    };
    cache.writeScope(generationId, {
      entries: [],
      diagram: { graph: fixturePackagesGraph(), outcome: { status: "ready" } },
      file: {
        path: "widget.ts",
        rawContent: "export class Widget {}\n",
        displayContent: "export class Widget {}\n",
        sourceError: null,
        formatError: null,
      },
      definitions: [definition],
    }, renderFixtureGraph);

    expect(cache.readDefinition(generationId, "widget.ts", 1, 14)).toEqual({
      key: definition.key,
      kind: definition.kind,
      name: definition.name,
      qualifiedName: definition.qualifiedName,
      source: definition.source,
      uml: definition.uml,
    });
    expect(cache.readDefinition(generationId, "widget.ts", 99, 99)).toBeNull();

    expect(cache.readDefinitions(generationId, "widget.ts")).toEqual([{
      key: definition.key,
      kind: definition.kind,
      name: definition.name,
      qualifiedName: definition.qualifiedName,
      source: definition.source,
      uml: definition.uml,
      displayFrom: definition.displayFrom,
      displayTo: definition.displayTo,
    }]);

    // Definition index lookups (used for UML member navigation) require an
    // explicit writeDefinitionIndex call and are keyed by (path, name, qualifiedName).
    expect(cache.lookupDefinition("widget.ts", "Widget", "Widget")).toBeNull();
    cache.writeDefinitionIndex(generationId, [{
      path: "widget.ts",
      name: "Widget",
      qualifiedName: "Widget",
      kind: "class",
      line: 1,
      column: 14,
    }]);
    expect(cache.lookupDefinition("widget.ts", "Widget", "Widget")).toEqual({
      path: "widget.ts",
      line: 1,
      column: 14,
    });
    expect(cache.lookupDefinition("widget.ts", "Widget", "Other.Widget")).toBeNull();
  } finally {
    cache.close();
  }
});

test("promoteGeneration activates a generation and discardGeneration refuses to discard the active one", async () => {
  const root = await temporaryRoot("ts-explorer-cache-unit-");
  const dbPath = join(root, "lifecycle.db");
  const cache = new Cache(dbPath);
  try {
    const firstGenerationId = cache.beginGeneration("startup");
    cache.writeDiscovery(
      firstGenerationId,
      [],
      { graph: fixturePackagesGraph(), outcome: { status: "ready" } },
      renderFixtureGraph,
    );
    cache.promoteGeneration(firstGenerationId);
    expect(cache.getActiveGenerationId()).toBe(firstGenerationId);

    // Discarding the currently-active generation must throw and leave it active.
    expect(() => cache.discardGeneration(firstGenerationId)).toThrow(
      `cannot discard active generation ${firstGenerationId}`,
    );
    expect(cache.getActiveGenerationId()).toBe(firstGenerationId);

    // A second, never-promoted generation can be discarded freely, removing
    // its rows so later reads of that generation fail.
    const secondGenerationId = cache.beginGeneration("watch");
    cache.writeDiscovery(
      secondGenerationId,
      [],
      { graph: fixturePackagesGraph(), outcome: { status: "ready" } },
      renderFixtureGraph,
    );
    expect(() => cache.discardGeneration(secondGenerationId)).not.toThrow();
    expect(() => cache.readPackages(secondGenerationId)).toThrow();

    // failGeneration marks a building generation as failed without promoting it.
    const thirdGenerationId = cache.beginGeneration("watch");
    cache.failGeneration(thirdGenerationId);
    expect(cache.getActiveGenerationId()).toBe(firstGenerationId);
  } finally {
    cache.close();
  }
});
