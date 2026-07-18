import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import type {
  ExternalUserNode,
  LocalUserNode,
  MethodReturnDependency,
  UmlGraph,
  UmlGraphEdgeAttributes,
  UmlGraphNodeAttributes,
  UmlGraphRelation,
  UmlUsageEdge,
} from "./model.ts";

function addEntityNode(graph: UmlGraph, id: string, name: string): void {
  if (!graph.hasNode(id)) {
    graph.addNode(id, { kind: "entity", name });
    return;
  }
  const existing = graph.getNodeAttributes(id);
  if (existing.kind !== "entity" || existing.name !== name) {
    throw new Error(`Conflicting UML entity node: ${id}`);
  }
}

function registerEntity(
  graph: UmlGraph,
  entityIds: Map<string, string>,
  id: string,
  name: string,
): void {
  addEntityNode(graph, id, name);
  entityIds.set(id, id);
  const genericStart = name.indexOf("<");
  if (genericStart === -1 || !id.endsWith(name)) return;
  const alias = id.slice(0, -name.length) + name.slice(0, genericStart);
  const existing = entityIds.get(alias);
  if (existing && existing !== id) throw new Error(`Conflicting UML entity alias: ${alias}`);
  entityIds.set(alias, id);
}

function resolveEndpoint(
  graph: UmlGraph,
  entityIds: ReadonlyMap<string, string>,
  id: string,
  name: string,
): string {
  const entityId = entityIds.get(id);
  if (!entityId) {
    addBoundaryNode(graph, id, name);
    return id;
  }
  if (entityId !== id) {
    const attributes = graph.getNodeAttributes(entityId);
    if (!attributes.aliases?.includes(id)) {
      graph.setNodeAttribute(entityId, "aliases", [...(attributes.aliases ?? []), id]);
    }
  }
  return entityId;
}

function addBoundaryNode(graph: UmlGraph, id: string, name: string): void {
  if (!graph.hasNode(id)) {
    graph.addNode(id, { kind: "boundary", name });
    return;
  }
  const existing = graph.getNodeAttributes(id);
  if (existing.kind === "entity") return;
  if (existing.kind !== "boundary" || existing.name !== name) {
    throw new Error(`Conflicting UML boundary node: ${id}`);
  }
}

function addSyntheticNode(graph: UmlGraph, id: string, attributes: UmlGraphNodeAttributes): void {
  if (graph.hasNode(id)) throw new Error(`Conflicting UML synthetic node: ${id}`);
  graph.addNode(id, attributes);
}

function addRelation(graph: UmlGraph, relation: UmlGraphRelation): void {
  const { sourceId, targetId } = relation;
  if (sourceId === targetId || !graph.hasNode(sourceId) || !graph.hasNode(targetId)) return;
  graph.updateEdge(sourceId, targetId, (attributes) => {
    const relations = attributes.relations ?? [];
    relations.push(relation);
    return {
      weight: (attributes.weight ?? 0) + 1,
      relations,
    };
  });
}

function createLouvainRng(): () => number {
  let state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function buildUmlGraph(
  declarations: readonly FileDeclaration[],
  methodReturnDependencies: readonly MethodReturnDependency[],
  usageEdges: readonly UmlUsageEdge[],
  localUserNodes: readonly LocalUserNode[],
  externalUserNodes: readonly ExternalUserNode[],
): UmlGraph {
  const graph = new UndirectedGraph<UmlGraphNodeAttributes, UmlGraphEdgeAttributes>({
    allowSelfLoops: false,
  });
  const entityIds = new Map<string, string>();

  for (const declaration of declarations) {
    for (const entity of declaration.classes) registerEntity(graph, entityIds, entity.id, entity.name);
    for (const entity of declaration.interfaces) registerEntity(graph, entityIds, entity.id, entity.name);
    for (const entity of declaration.enums) registerEntity(graph, entityIds, entity.id, entity.name);
    for (const entity of declaration.types) registerEntity(graph, entityIds, entity.id, entity.name);
  }

  for (const local of localUserNodes) {
    addSyntheticNode(graph, `local-user:${local.navigation.nodeId}`, {
      kind: "local-user",
      name: local.navigation.label,
    });
  }
  for (const external of externalUserNodes) {
    addSyntheticNode(graph, `external-user:${external.navigation.nodeId}`, {
      kind: "external-user",
      name: external.navigation.label,
    });
  }

  for (const declaration of declarations) {
    for (const clauses of declaration.heritageClauses) {
      for (const clause of clauses) {
        const sourceId = resolveEndpoint(graph, entityIds, clause.classTypeId, clause.className);
        const targetId = resolveEndpoint(graph, entityIds, clause.clauseTypeId, clause.clause);
        addRelation(graph, { kind: "heritage", sourceId, targetId });
      }
    }
    for (const association of declaration.memberAssociations ?? []) {
      const sourceId = resolveEndpoint(graph, entityIds, association.a.typeId, association.a.name);
      const targetId = resolveEndpoint(graph, entityIds, association.b.typeId, association.b.name);
      addRelation(graph, { kind: "member-association", sourceId, targetId });
    }
  }
  for (const dependency of methodReturnDependencies) {
    addRelation(graph, {
      kind: "method-return",
      sourceId: dependency.sourceId,
      targetId: dependency.targetId,
    });
  }
  for (const edge of usageEdges) {
    addRelation(graph, {
      kind: "usage",
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    });
  }
  for (const local of localUserNodes) {
    const sourceId = `local-user:${local.navigation.nodeId}`;
    for (const target of local.targets) {
      addRelation(graph, { kind: "local-user", sourceId, targetId: target.id });
    }
  }
  for (const external of externalUserNodes) {
    const sourceId = `external-user:${external.navigation.nodeId}`;
    for (const target of external.targets) {
      addRelation(graph, { kind: "external-user", sourceId, targetId: target.id });
    }
  }

  return graph;
}

export function assignUmlCommunities(graph: UmlGraph): void {
  louvain.assign(graph, {
    nodeCommunityAttribute: "community",
    getEdgeWeight: "weight",
    randomWalk: false,
    rng: createLouvainRng(),
  });
}
