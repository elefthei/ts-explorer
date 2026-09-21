import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type DiagramNodeKind,
  type DiagramRelationKind,
  type UmlDiagramGraph,
  type UmlRelationKind,
} from "../diagram-graph.ts";
import type { UmlReferenceEdge } from "./usage.ts";

const UML_NODE_KINDS: Record<string, true> = { entity: true, definition: true, boundary: true };
const UML_RELATION_KINDS: Record<string, true> = {
  extends: true,
  implements: true,
  references: true,
};

const RELATION_ORDER: readonly UmlRelationKind[] = ["extends", "implements", "references"];

export type UmlTopologyInput = {
  /** Every definition this file declares, plus nominal owners it contributes members to. */
  contributed: ReadonlyMap<string, { name: string; entity: boolean }>;
  /** Display names for referenced keys this file does not contribute. */
  boundaries: ReadonlyMap<string, string>;
  references: readonly UmlReferenceEdge[];
};

type Topology = Pick<UmlDiagramGraph, "nodes" | "edges" | "relations">;

/**
 * Deterministic directed serialization: nodes sorted by key, one edge per ordered endpoint pair,
 * relation kinds deduplicated inside that edge. Self references are retained; only the view hides
 * their arrows.
 */
export function extractUmlTopology(input: UmlTopologyInput): Topology {
  const nodeKinds = new Map<string, { name: string; nodeKind: DiagramNodeKind }>();
  for (const [key, node] of input.contributed) {
    nodeKinds.set(key, { name: node.name, nodeKind: node.entity ? "entity" : "definition" });
  }
  for (const [key, name] of input.boundaries) {
    if (nodeKinds.has(key)) continue;
    nodeKinds.set(key, { name, nodeKind: "boundary" });
  }
  const nodes: Topology["nodes"] = [...nodeKinds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, node], nodeOrdinal) => ({
      nodeId,
      nodeOrdinal,
      nodeKind: node.nodeKind,
      name: node.name,
    }));

  const byPair = new Map<string, Set<UmlRelationKind>>();
  for (const reference of input.references) {
    if (!nodeKinds.has(reference.ownerKey) || !nodeKinds.has(reference.targetKey)) continue;
    const pair = JSON.stringify([reference.ownerKey, reference.targetKey]);
    const kinds = byPair.get(pair);
    if (kinds) kinds.add(reference.kind);
    else byPair.set(pair, new Set([reference.kind]));
  }
  const edges: Topology["edges"] = [];
  const relations: Topology["relations"] = [];
  const pairs = [...byPair.keys()].sort((left, right) => left.localeCompare(right));
  for (const pair of pairs) {
    const [sourceNodeId, targetNodeId] = JSON.parse(pair) as [string, string];
    const kinds = RELATION_ORDER.filter((kind) => byPair.get(pair)?.has(kind));
    const edgeOrdinal = edges.length;
    edges.push({
      edgeOrdinal,
      sourceNodeId,
      targetNodeId,
      edgeKind: "uml-relation",
      directed: true,
      weight: kinds.length,
    });
    for (const [relationOrdinal, relationKind] of kinds.entries()) {
      relations.push({
        edgeOrdinal,
        relationOrdinal,
        relationKind,
        sourceNodeId,
        targetNodeId,
      });
    }
  }
  return { nodes, edges, relations };
}

function invalid(detail: string): never {
  throw new Error(`Invalid UML diagram graph: ${detail}`);
}

function assertNonEmpty(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || !value) invalid(description);
}

/** Structural validation of a persisted or freshly extracted per-file UML graph. */
export function validateUmlDiagramGraph(graph: UmlDiagramGraph): void {
  if (graph.kind !== "uml") invalid(`unexpected kind ${String(graph.kind)}`);
  if (graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION) {
    invalid(`unsupported format version ${String(graph.formatVersion)}`);
  }
  if (graph.renderMode !== "normal" && graph.renderMode !== "bare") {
    invalid(`unexpected render mode ${String(graph.renderMode)}`);
  }
  const nodes = new Map<string, DiagramNodeKind>();
  for (const [index, node] of graph.nodes.entries()) {
    if (node.nodeOrdinal !== index) invalid("node ordinals must be contiguous and ordered");
    assertNonEmpty(node.nodeId, "node ID must be nonempty");
    assertNonEmpty(node.name, `node ${node.nodeId} has an empty name`);
    if (!UML_NODE_KINDS[node.nodeKind]) invalid(`unexpected node kind ${String(node.nodeKind)}`);
    if (nodes.has(node.nodeId)) invalid(`duplicate node ${node.nodeId}`);
    nodes.set(node.nodeId, node.nodeKind);
  }
  if (graph.renderMode === "bare") {
    if (
      nodes.size
      || graph.edges.length
      || graph.relations.length
      || graph.entities.length
      || graph.categories.length
    ) invalid("bare graph must be empty");
    return;
  }

  const edges = new Map<number, UmlDiagramGraph["edges"][number]>();
  const pairs = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    if (edge.edgeOrdinal !== index) invalid("edge ordinals must be contiguous and ordered");
    if (edge.edgeKind !== "uml-relation" || !edge.directed) invalid(`invalid edge ${edge.edgeOrdinal}`);
    if (!Number.isInteger(edge.weight) || edge.weight <= 0) invalid(`invalid edge weight ${edge.edgeOrdinal}`);
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
      invalid(`edge ${edge.edgeOrdinal} has a missing endpoint`);
    }
    const pair = JSON.stringify([edge.sourceNodeId, edge.targetNodeId]);
    if (pairs.has(pair)) invalid(`duplicate edge ${edge.edgeOrdinal}`);
    pairs.add(pair);
    edges.set(edge.edgeOrdinal, edge);
  }
  const relationCounts = new Map<number, number>();
  const seenRelations = new Set<string>();
  for (const relation of graph.relations) {
    const edge = edges.get(relation.edgeOrdinal);
    if (!edge) invalid(`relation references missing edge ${relation.edgeOrdinal}`);
    if (relation.sourceNodeId !== edge.sourceNodeId || relation.targetNodeId !== edge.targetNodeId) {
      invalid(`relation ${relation.edgeOrdinal} endpoints disagree with its edge`);
    }
    if (!UML_RELATION_KINDS[relation.relationKind]) {
      invalid(`unexpected relation kind ${String(relation.relationKind)}`);
    }
    const expected = relationCounts.get(relation.edgeOrdinal) ?? 0;
    if (relation.relationOrdinal !== expected) {
      invalid(`relation ordinals must be contiguous for edge ${relation.edgeOrdinal}`);
    }
    relationCounts.set(relation.edgeOrdinal, expected + 1);
    const key = `${relation.edgeOrdinal}\u0000${relation.relationKind}`;
    if (seenRelations.has(key)) invalid(`duplicate relation kind on edge ${relation.edgeOrdinal}`);
    seenRelations.add(key);
  }
  for (const edge of graph.edges) {
    if ((relationCounts.get(edge.edgeOrdinal) ?? 0) !== edge.weight) {
      invalid(`edge ${edge.edgeOrdinal} weight does not match its relation count`);
    }
  }

  const entities = new Map<string, number>();
  for (const [index, entity] of graph.entities.entries()) {
    if (entity.entityOrdinal !== index) invalid("entity ordinals must be contiguous and ordered");
    assertNonEmpty(entity.definitionKey, "entity definition key must be nonempty");
    assertNonEmpty(entity.name, `entity ${entity.definitionKey} has an empty name`);
    if (nodes.get(entity.definitionKey) !== "entity") {
      invalid(`entity ${entity.definitionKey} has no entity node`);
    }
    if (entities.has(entity.definitionKey)) invalid(`duplicate entity ${entity.definitionKey}`);
    entities.set(entity.definitionKey, entity.entityOrdinal);
  }
  const memberOrdinals = new Map<string, number>();
  const assertMember = (
    entityOrdinal: number,
    ordinal: number,
    definitionKey: string,
    bucket: string,
  ): void => {
    if (!graph.entities[entityOrdinal]) invalid(`${bucket} references missing entity ${entityOrdinal}`);
    assertNonEmpty(definitionKey, `${bucket} definition key must be nonempty`);
    if (!nodes.has(definitionKey)) invalid(`${bucket} ${definitionKey} has no node`);
    const counter = `${bucket}\u0000${entityOrdinal}`;
    const expected = memberOrdinals.get(counter) ?? 0;
    if (ordinal !== expected) invalid(`${bucket} ordinals must be contiguous for entity ${entityOrdinal}`);
    memberOrdinals.set(counter, expected + 1);
  };
  for (const property of graph.properties) {
    assertMember(property.entityOrdinal, property.propertyOrdinal, property.definitionKey, "property");
  }
  for (const method of graph.methods) {
    assertMember(method.entityOrdinal, method.methodOrdinal, method.definitionKey, "method");
  }
  for (const item of graph.enumItems) {
    assertMember(item.entityOrdinal, item.itemOrdinal, item.definitionKey, "enum item");
  }
  const modifierOrdinals = new Map<string, number>();
  for (const modifier of graph.memberModifiers) {
    if (!graph.entities[modifier.entityOrdinal]) {
      invalid(`member modifier references missing entity ${modifier.entityOrdinal}`);
    }
    const counter = `${modifier.entityOrdinal}\u0000${modifier.memberKind}\u0000${modifier.memberOrdinal}`;
    const expected = modifierOrdinals.get(counter) ?? 0;
    if (modifier.modifierOrdinal !== expected) invalid("member modifier ordinals must be contiguous");
    modifierOrdinals.set(counter, expected + 1);
  }
  const categoryKeys = new Set<string>();
  for (const [index, category] of graph.categories.entries()) {
    if (category.categoryOrdinal !== index) invalid("category ordinals must be contiguous and ordered");
    assertNonEmpty(category.definitionKey, "category definition key must be nonempty");
    if (!nodes.has(category.definitionKey)) invalid(`category ${category.definitionKey} has no node`);
    if (categoryKeys.has(category.definitionKey)) invalid(`duplicate category ${category.definitionKey}`);
    categoryKeys.add(category.definitionKey);
  }
}

export type { DiagramRelationKind };
