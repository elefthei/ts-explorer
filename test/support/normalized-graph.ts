import { expect } from "bun:test";
import { join } from "node:path";
import {
  Cache,
  type CacheDiagramResponse,
} from "../../src/cache.ts";
import type {
  DiagramGraph,
  RenderedDiagram,
  UmlDiagramGraph,
} from "../../src/diagram-graph.ts";
import { renderPackageDiagramGraph } from "../../src/packages.ts";
import { hydrateUmlGraph } from "../../src/uml/graph.ts";
import { renderUmlDiagramGraph } from "../../src/uml/render.ts";

let cacheOrdinal = 0;

const UML_RECORD_ARRAY_FIELDS = [
  "nodes",
  "aliases",
  "edges",
  "relations",
  "settingLines",
  "declarations",
  "entities",
  "properties",
  "propertyTypeIds",
  "methods",
  "methodReturnTypeIds",
  "enumItems",
  "entityHeritageClauses",
  "declarationHeritageGroups",
  "declarationHeritageClauses",
  "memberAssociations",
  "categories",
  "methodReturnDependencies",
  "usageEdges",
  "localUsers",
  "externalUsers",
  "localUserTargets",
  "externalUserTargets",
  "definitions",
] as const satisfies readonly {
  [Field in keyof UmlDiagramGraph]:
    UmlDiagramGraph[Field] extends readonly unknown[] ? Field : never;
}[keyof UmlDiagramGraph][];

export function renderDiagramGraph(graph: DiagramGraph): RenderedDiagram {
  return graph.kind === "packages"
    ? renderPackageDiagramGraph(graph)
    : renderUmlDiagramGraph(graph);
}

export async function materializeUmlGraph(
  cacheDirectory: string,
  extracted: UmlDiagramGraph,
) {
  cacheOrdinal += 1;
  const cache = new Cache(join(cacheDirectory, `.uml-graph-${cacheOrdinal}.sqlite`));
  try {
    const generationId = cache.beginGeneration("startup");
    const cached = cache.writeScope(
      generationId,
      {
        entries: [],
        diagram: { graph: extracted, outcome: { status: "ready" } },
        definitions: [],
      },
      renderDiagramGraph,
    );
    const record = cache.readDiagramGraph(generationId, "uml", extracted.scopePath);
    if (record?.kind !== "uml") {
      throw new Error(`Expected reloaded UML graph for ${extracted.scopePath}`);
    }
    return {
      ...cached,
      cached,
      extracted,
      record,
      graph: hydrateUmlGraph(record.nodes, record.aliases, record.edges, record.relations),
    };
  } finally {
    cache.close();
  }
}

export function expectTopologyRoundTrip(actual: DiagramGraph, expected: DiagramGraph): void {
  expect({
    nodes: actual.nodes,
    aliases: actual.aliases,
    edges: actual.edges,
    relations: actual.relations,
  }).toEqual({
    nodes: expected.nodes,
    aliases: expected.aliases,
    edges: expected.edges,
    relations: expected.relations,
  });
}

export function expectNormalizedUmlRoundTrip(
  actual: UmlDiagramGraph,
  expected: UmlDiagramGraph,
): void {
  expect(actual.settings).toEqual(expected.settings);
  for (const field of UML_RECORD_ARRAY_FIELDS) {
    expect(actual[field], field).toEqual(expected[field]);
  }
}

type MaterializedRendering = RenderedDiagram & {
  cached: CacheDiagramResponse;
  record: DiagramGraph;
};

export function expectCachedRendering(materialized: MaterializedRendering): void {
  const rendered = {
    dsl: materialized.dsl,
    dsls: materialized.dsls,
    packageNodes: materialized.packageNodes,
    definitions: materialized.definitions,
    externalUsers: materialized.externalUsers,
    localUsers: materialized.localUsers,
  };
  expect(rendered).toEqual(renderDiagramGraph(materialized.record));
  expect(materialized.cached).toEqual({
    kind: materialized.record.kind,
    scopePath: materialized.record.scopePath,
    status: "ready",
    ...rendered,
  });
}
