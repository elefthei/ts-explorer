import { expect } from "bun:test";
import type { UmlDiagramGraph } from "../../src/diagram-graph.ts";
import type { UmlProject } from "./uml-project.ts";

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
