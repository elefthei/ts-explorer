import { expect } from "bun:test";
import { join } from "node:path";
import { Cache, type CachePackageDiagramInput } from "../../src/cache.ts";
import type {
  PackageDiagramGraph,
  RenderedPackageDiagram,
  UmlDiagramGraph,
} from "../../src/diagram-graph.ts";
import { renderPackageDiagramGraph } from "../../src/packages.ts";
import type { PackageDiagramPayload } from "../../src/types.ts";
import type { UmlProject } from "./uml-project.ts";

let cacheOrdinal = 0;

/**
 * Every array a persisted UML file graph carries. A reload that silently drops one of these has to
 * fail the round-trip check instead of passing because the hydrator happened to default it.
 */
const UML_RECORD_ARRAY_FIELDS = [
  "nodes",
  "edges",
  "relations",
  "entities",
  "properties",
  "methods",
  "memberModifiers",
  "enumItems",
  "categories",
] as const satisfies readonly {
  [Field in keyof UmlDiagramGraph]: UmlDiagramGraph[Field] extends readonly unknown[] ? Field
    : never;
}[keyof UmlDiagramGraph][];

function expectUmlGraphsEqual(actual: UmlDiagramGraph, expected: UmlDiagramGraph): void {
  expect({
    kind: actual.kind,
    scopePath: actual.scopePath,
    formatVersion: actual.formatVersion,
    renderMode: actual.renderMode,
  }).toEqual({
    kind: expected.kind,
    scopePath: expected.scopePath,
    formatVersion: expected.formatVersion,
    renderMode: expected.renderMode,
  });
  for (const field of UML_RECORD_ARRAY_FIELDS) {
    expect(actual[field], `${expected.scopePath}: ${field}`).toEqual(expected[field]);
  }
}

/**
 * Reloads one file's persisted graph through `Cache.readDiagramGraph` and asserts it equals what
 * `extractFileUmlGraph` produced, field by field. This is the normalized-table contract: what the
 * writer accepted is exactly what a later selection read will see.
 */
export function expectUmlGraphRoundTrip(project: UmlProject, path: string): UmlDiagramGraph {
  const extracted = project.fileGraph(path);
  const reloaded = project.cache.readDiagramGraph(project.generationId, "uml", path);
  if (reloaded?.kind !== "uml") throw new Error(`no persisted UML graph for ${path}`);
  expectUmlGraphsEqual(reloaded, extracted);
  return reloaded;
}

/** The same round-trip over every source file the project indexed. */
export function expectFileGraphRoundTrips(project: UmlProject): void {
  for (const path of project.sourcePaths) expectUmlGraphRoundTrip(project, path);
}

export type MaterializedPackageGraph = {
  extracted: PackageDiagramGraph;
  reloaded: PackageDiagramGraph;
  rendered: RenderedPackageDiagram;
  cached: PackageDiagramPayload;
};

/**
 * Writes a package graph through the real discovery transaction and reads it back. Packages are
 * the one diagram whose `diagrams` row is still the complete public payload.
 */
export function materializePackageGraph(
  cacheDirectory: string,
  extracted: PackageDiagramGraph,
  outcome: CachePackageDiagramInput["outcome"] = { status: "ready" },
): MaterializedPackageGraph {
  cacheOrdinal += 1;
  const cache = new Cache(join(cacheDirectory, `.package-graph-${cacheOrdinal}.sqlite`));
  try {
    const generationId = cache.beginGeneration("startup", "");
    const cached = cache.writeDiscovery(
      generationId,
      [],
      { graph: extracted, outcome },
      renderPackageDiagramGraph,
    );
    const reloaded = cache.readDiagramGraph(generationId, "packages", "");
    if (reloaded?.kind !== "packages") throw new Error("no persisted package graph");
    expect(reloaded).toEqual(extracted);
    const rendered = renderPackageDiagramGraph(reloaded);
    expect(cached).toEqual({
      ...rendered,
      scopePath: "",
      status: outcome.status,
      ...(outcome.status === "error" ? { error: outcome.error } : {}),
    });
    return { extracted, reloaded, rendered, cached };
  } finally {
    cache.close();
  }
}
