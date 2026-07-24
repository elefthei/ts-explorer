import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import type { UmlDiagramGraph } from "../diagram-graph.ts";
import type {
  ExternalUserNode,
  LocalUserNode,
  UmlDependency,
} from "./model.ts";

type UmlGraphNodeKind = "entity" | "boundary" | "local-user" | "external-user";

type UmlGraphRelationKind =
  | "heritage"
  | "member-association"
  | "method-return"
  | "usage"
  | "local-user"
  | "external-user";

type UmlGraphNodeAttributes = {
  kind: UmlGraphNodeKind;
  name: string;
  aliases?: string[];
  community?: number;
};

type UmlGraphRelation = {
  kind: UmlGraphRelationKind;
  sourceId: string;
  targetId: string;
};

type UmlGraphEdgeAttributes = {
  weight: number;
  relations: UmlGraphRelation[];
};

export type UmlGraph = UndirectedGraph<UmlGraphNodeAttributes, UmlGraphEdgeAttributes>;

type StoredNode = UmlDiagramGraph["nodes"][number];
type StoredAlias = UmlDiagramGraph["aliases"][number];
type StoredEdge = UmlDiagramGraph["edges"][number];
type StoredRelation = UmlDiagramGraph["relations"][number];

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

function createUmlGraph(
  declarations: readonly FileDeclaration[],
  methodReturnDependencies: readonly UmlDependency[],
  usageEdges: readonly UmlDependency[],
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

function assignCommunities(graph: UmlGraph): void {
  louvain.assign(graph, {
    nodeCommunityAttribute: "community",
    getEdgeWeight: "weight",
    randomWalk: false,
    rng: createLouvainRng(),
  });
}

const UML_NODE_KINDS = new Set(["entity", "boundary", "local-user", "external-user"]);
const UML_RELATION_KINDS = new Set([
  "heritage",
  "member-association",
  "method-return",
  "usage",
  "local-user",
  "external-user",
]);

function isUmlNodeKind(value: string): value is UmlGraphNodeKind {
  return UML_NODE_KINDS.has(value);
}

function isUmlRelationKind(value: string): value is UmlGraphRelationKind {
  return UML_RELATION_KINDS.has(value);
}

function canonicalEndpoints(sourceId: string, targetId: string): [string, string] {
  return sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
}

function assertNonEmptyString(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${description}`);
  }
}

function assertOrdinal(actual: number, expected: number, description: string): void {
  if (!Number.isInteger(actual) || actual !== expected) {
    throw new Error(`Invalid ${description} ordinal: expected ${expected}, received ${actual}`);
  }
}

function assertCommunity(value: unknown, nodeId: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid UML graph community for node: ${nodeId}`);
  }
}

function assertParentEndpoints(
  sourceId: string,
  targetId: string,
  parentSourceId: string,
  parentTargetId: string,
  description: string,
): void {
  const [source, target] = canonicalEndpoints(sourceId, targetId);
  if (source !== parentSourceId || target !== parentTargetId) {
    throw new Error(`Mismatched ${description} endpoints`);
  }
}

type NodeFields = Pick<StoredNode, "nodeId" | "nodeKind" | "name" | "community">;

function validateNode(
  node: NodeFields,
  nodeIds: Set<string>,
  storedOrdinal?: readonly [actual: number, expected: number],
): asserts node is NodeFields & { nodeKind: UmlGraphNodeKind; community: number } {
  if (storedOrdinal) assertOrdinal(storedOrdinal[0], storedOrdinal[1], "UML node");
  assertNonEmptyString(node.nodeId, "UML node ID");
  if (storedOrdinal) assertNonEmptyString(node.name, `UML node name for ${node.nodeId}`);
  if (nodeIds.has(node.nodeId)) throw new Error(`Duplicate UML node ID: ${node.nodeId}`);
  if (!storedOrdinal) nodeIds.add(node.nodeId);
  if (!isUmlNodeKind(node.nodeKind)) {
    throw new Error(`Invalid UML node kind: ${String(node.nodeKind)}`);
  }
  if (!storedOrdinal) assertNonEmptyString(node.name, `UML node name for ${node.nodeId}`);
  assertCommunity(node.community, node.nodeId);
}

function validateAlias(
  alias: StoredAlias,
  graph: UmlGraph,
  nodeIds: ReadonlySet<string>,
  graphAliases: Set<string>,
  aliasOrdinals?: Map<string, number>,
): void {
  if (aliasOrdinals) {
    assertNonEmptyString(alias.nodeId, "UML alias node ID");
    assertNonEmptyString(alias.alias, `UML alias for ${alias.nodeId}`);
    if (!nodeIds.has(alias.nodeId)) throw new Error(`Missing UML alias node: ${alias.nodeId}`);
  }
  if (graph.getNodeAttribute(alias.nodeId, "kind") !== "entity") {
    throw new Error(`UML aliases require an entity node: ${alias.nodeId}`);
  }
  if (aliasOrdinals) {
    const expectedOrdinal = aliasOrdinals.get(alias.nodeId) ?? 0;
    assertOrdinal(alias.aliasOrdinal, expectedOrdinal, `UML alias for ${alias.nodeId}`);
    aliasOrdinals.set(alias.nodeId, expectedOrdinal + 1);
    if (nodeIds.has(alias.alias) || graphAliases.has(alias.alias)) {
      throw new Error(`Conflicting UML alias: ${alias.alias}`);
    }
  } else {
    assertNonEmptyString(alias.alias, `UML alias for ${alias.nodeId}`);
    if (
      alias.alias === alias.nodeId
      || nodeIds.has(alias.alias)
      || graph.hasNode(alias.alias)
      || graphAliases.has(alias.alias)
    ) {
      throw new Error(`Conflicting UML alias: ${alias.alias}`);
    }
  }
  graphAliases.add(alias.alias);
}

function validateEdge(
  edge: StoredEdge,
  edgeRelations: unknown,
  nodeIds: ReadonlySet<string>,
  endpointPairs: Set<string>,
  expectedOrdinal?: number,
): void {
  if (expectedOrdinal !== undefined) {
    assertOrdinal(edge.edgeOrdinal, expectedOrdinal, "UML edge");
    assertNonEmptyString(edge.sourceNodeId, "UML edge source");
    assertNonEmptyString(edge.targetNodeId, "UML edge target");
    if (edge.edgeKind !== "uml-relation" || edge.directed) {
      throw new Error(`Invalid UML edge kind or direction at ordinal ${edge.edgeOrdinal}`);
    }
    if (edge.sourceNodeId === edge.targetNodeId || edge.sourceNodeId > edge.targetNodeId) {
      throw new Error(`Noncanonical UML edge endpoints at ordinal ${edge.edgeOrdinal}`);
    }
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new Error(`Missing UML edge endpoint at ordinal ${edge.edgeOrdinal}`);
    }
  }
  const pairKey = JSON.stringify([edge.sourceNodeId, edge.targetNodeId]);
  if (endpointPairs.has(pairKey)) {
    throw new Error(`Duplicate UML edge endpoints: ${edge.sourceNodeId}, ${edge.targetNodeId}`);
  }
  endpointPairs.add(pairKey);
  if (expectedOrdinal === undefined && (!Array.isArray(edgeRelations) || edgeRelations.length === 0)) {
    throw new Error(`Invalid UML edge relations: ${edge.sourceNodeId}, ${edge.targetNodeId}`);
  }
  const relationCount = Array.isArray(edgeRelations) ? edgeRelations.length : 0;
  if (!Number.isInteger(edge.weight) || edge.weight <= 0 || edge.weight !== relationCount) {
    if (expectedOrdinal !== undefined) {
      throw new Error(`Invalid UML edge weight at ordinal ${edge.edgeOrdinal}`);
    }
    throw new Error(`Invalid UML edge weight: ${edge.sourceNodeId}, ${edge.targetNodeId}`);
  }
}

function validateRelation(
  relation: StoredRelation,
  nodeIds: ReadonlySet<string>,
  parentEdge: Pick<StoredEdge, "sourceNodeId" | "targetNodeId">,
  expectedOrdinal?: number,
): asserts relation is StoredRelation & { relationKind: UmlGraphRelationKind } {
  if (expectedOrdinal !== undefined) {
    assertOrdinal(
      relation.relationOrdinal,
      expectedOrdinal,
      `UML relation for edge ${relation.edgeOrdinal}`,
    );
  }
  if (!isUmlRelationKind(relation.relationKind)) {
    throw new Error(`Invalid UML relation kind: ${String(relation.relationKind)}`);
  }
  if (expectedOrdinal !== undefined) {
    if (
      !nodeIds.has(relation.sourceNodeId)
      || !nodeIds.has(relation.targetNodeId)
      || relation.sourceNodeId === relation.targetNodeId
    ) {
      throw new Error(`Invalid UML relation endpoint at edge ${relation.edgeOrdinal}`);
    }
  } else {
    assertNonEmptyString(relation.sourceNodeId, "UML relation source");
    assertNonEmptyString(relation.targetNodeId, "UML relation target");
    if (!nodeIds.has(relation.sourceNodeId) || !nodeIds.has(relation.targetNodeId)) {
      throw new Error("Missing UML relation endpoint");
    }
  }
  assertParentEndpoints(
    relation.sourceNodeId,
    relation.targetNodeId,
    parentEdge.sourceNodeId,
    parentEdge.targetNodeId,
    "UML relation",
  );
}

function serializeUmlTopology(
  graph: UmlGraph,
): Pick<UmlDiagramGraph, "nodes" | "aliases" | "edges" | "relations"> {
  if (graph.type !== "undirected" || graph.multi || graph.allowSelfLoops) {
    throw new Error("Invalid transient UML graph topology");
  }

  const nodes: StoredNode[] = [];
  const aliases: StoredAlias[] = [];
  const nodeIds = new Set<string>();
  const graphAliases = new Set<string>();
  for (const [nodeOrdinal, nodeId] of graph.nodes().entries()) {
    const attributes = graph.getNodeAttributes(nodeId);
    assertCommunity(attributes.community, nodeId);
    const node: StoredNode = {
      nodeId,
      nodeOrdinal,
      nodeKind: attributes.kind,
      name: attributes.name,
      community: attributes.community,
    };
    validateNode(node, nodeIds);
    if (attributes.aliases !== undefined && !Array.isArray(attributes.aliases)) {
      throw new Error(`Invalid UML aliases for node: ${nodeId}`);
    }
    nodes.push(node);
    for (const [aliasOrdinal, value] of (attributes.aliases ?? []).entries()) {
      const alias = { nodeId, aliasOrdinal, alias: value };
      validateAlias(alias, graph, nodeIds, graphAliases);
      aliases.push(alias);
    }
  }

  const edges: StoredEdge[] = [];
  const relations: StoredRelation[] = [];
  const endpointPairs = new Set<string>();
  for (const [edgeOrdinal, graphEdge] of graph.edges().entries()) {
    const [rawSourceId, rawTargetId] = graph.extremities(graphEdge);
    if (rawSourceId === rawTargetId) throw new Error(`Invalid UML self edge: ${rawSourceId}`);
    const [sourceNodeId, targetNodeId] = canonicalEndpoints(rawSourceId, rawTargetId);
    const attributes = graph.getEdgeAttributes(graphEdge);
    const edge: StoredEdge = {
      edgeOrdinal,
      sourceNodeId,
      targetNodeId,
      edgeKind: "uml-relation",
      directed: false,
      weight: attributes.weight,
    };
    validateEdge(edge, attributes.relations, nodeIds, endpointPairs);
    edges.push(edge);
    for (const [relationOrdinal, value] of attributes.relations.entries()) {
      const relation: StoredRelation = {
        edgeOrdinal,
        relationOrdinal,
        relationKind: value.kind,
        sourceNodeId: value.sourceId,
        targetNodeId: value.targetId,
      };
      validateRelation(relation, nodeIds, edge);
      relations.push(relation);
    }
  }

  return { nodes, aliases, edges, relations };
}

export function extractUmlTopology(
  declarations: readonly FileDeclaration[],
  methodReturnDependencies: readonly UmlDependency[],
  usageEdges: readonly UmlDependency[],
  localUserNodes: readonly LocalUserNode[],
  externalUserNodes: readonly ExternalUserNode[],
): Pick<UmlDiagramGraph, "nodes" | "aliases" | "edges" | "relations"> {
  const graph = createUmlGraph(
    declarations,
    methodReturnDependencies,
    usageEdges,
    localUserNodes,
    externalUserNodes,
  );
  assignCommunities(graph);
  return serializeUmlTopology(graph);
}

export function hydrateUmlGraph(
  nodes: readonly StoredNode[],
  aliases: readonly StoredAlias[],
  edges: readonly StoredEdge[],
  relations: readonly StoredRelation[],
): UmlGraph {
  const graph = new UndirectedGraph<UmlGraphNodeAttributes, UmlGraphEdgeAttributes>({
    allowSelfLoops: false,
  });
  const nodeIds = new Set<string>();
  for (const [expectedOrdinal, node] of nodes.entries()) {
    validateNode(node, nodeIds, [node.nodeOrdinal, expectedOrdinal]);
    nodeIds.add(node.nodeId);
    graph.addNode(node.nodeId, {
      kind: node.nodeKind,
      name: node.name,
      community: node.community,
    });
  }

  const aliasOrdinals = new Map<string, number>();
  const graphAliases = new Set<string>();
  for (const alias of aliases) {
    validateAlias(alias, graph, nodeIds, graphAliases, aliasOrdinals);
    const current = graph.getNodeAttribute(alias.nodeId, "aliases") ?? [];
    graph.setNodeAttribute(alias.nodeId, "aliases", [...current, alias.alias]);
  }

  const relationGroups = new Map<number, StoredRelation[]>();
  for (const relation of relations) {
    if (!Number.isInteger(relation.edgeOrdinal) || relation.edgeOrdinal < 0) {
      throw new Error(`Invalid UML relation edge ordinal: ${relation.edgeOrdinal}`);
    }
    const group = relationGroups.get(relation.edgeOrdinal);
    if (group) group.push(relation);
    else relationGroups.set(relation.edgeOrdinal, [relation]);
  }

  const endpointPairs = new Set<string>();
  for (const [expectedOrdinal, edge] of edges.entries()) {
    const group = relationGroups.get(edge.edgeOrdinal) ?? [];
    validateEdge(edge, group, nodeIds, endpointPairs, expectedOrdinal);
    const hydratedRelations: UmlGraphRelation[] = [];
    for (const [expectedRelationOrdinal, relation] of group.entries()) {
      validateRelation(relation, nodeIds, edge, expectedRelationOrdinal);
      hydratedRelations.push({
        kind: relation.relationKind,
        sourceId: relation.sourceNodeId,
        targetId: relation.targetNodeId,
      });
    }
    graph.addEdge(edge.sourceNodeId, edge.targetNodeId, {
      weight: edge.weight,
      relations: hydratedRelations,
    });
    relationGroups.delete(edge.edgeOrdinal);
  }
  if (relationGroups.size) {
    throw new Error(`UML relations reference missing edge ordinal: ${relationGroups.keys().next().value}`);
  }

  return graph;
}
