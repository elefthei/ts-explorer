import { realpath } from "node:fs/promises";
import ts from "typescript";
import type { UmlDiagramGraph, UmlEntityKind } from "../../src/diagram-graph.ts";
import type { PackageInfo, UmlExternalUserKind } from "../../src/types.ts";
import { extractUmlDiagramGraph } from "../../src/uml.ts";

export type MemberContract = {
  name: string;
  type: string | null;
  optional?: boolean;
  modifiers: string[];
};

export type EntityContract = {
  file: string;
  kind: UmlEntityKind;
  name: string;
  properties: MemberContract[];
  methods: MemberContract[];
  enumItems: string[];
  heritage: { kind: "extends" | "implements"; clause: string; className: string }[];
};

export type UmlContract = {
  entities: EntityContract[];
  categories: { entityName: string; category: string; isTest: boolean }[];
  associations: {
    a: string;
    aMultiplicity: "0..*" | null;
    b: string;
    bMultiplicity: "0..*" | null;
    inherited: boolean;
  }[];
  methodReturns: { source: string; target: string }[];
  usage: { source: string; target: string }[];
  localUsers: {
    label: string;
    path: string;
    line: number;
    column: number;
    kind: UmlExternalUserKind;
    owner: string | null;
    targets: string[];
  }[];
  externalUsers: {
    label: string;
    scopePath: string;
    kind: UmlExternalUserKind;
    targets: string[];
  }[];
  definitions: UmlDiagramGraph["definitions"];
  nodes: { name: string; kind: string; community: number | null }[];
  edges: { a: string; b: string; weight: number }[];
  relations: { kind: string; source: string; target: string }[];
};

const MODIFIER_FLAGS = [
  ["export", ts.ModifierFlags.Export],
  ["ambient", ts.ModifierFlags.Ambient],
  ["public", ts.ModifierFlags.Public],
  ["private", ts.ModifierFlags.Private],
  ["protected", ts.ModifierFlags.Protected],
  ["abstract", ts.ModifierFlags.Abstract],
  ["static", ts.ModifierFlags.Static],
  ["readonly", ts.ModifierFlags.Readonly],
  ["accessor", ts.ModifierFlags.Accessor],
  ["async", ts.ModifierFlags.Async],
  ["default", ts.ModifierFlags.Default],
  ["const", ts.ModifierFlags.Const],
  ["override", ts.ModifierFlags.Override],
  ["in", ts.ModifierFlags.In],
  ["out", ts.ModifierFlags.Out],
  ["decorator", ts.ModifierFlags.Decorator],
  ["deprecated", ts.ModifierFlags.Deprecated],
] as const satisfies readonly (readonly [string, ts.ModifierFlags])[];

export function decodeModifierFlags(flags: number): string[] {
  const decoded: string[] = [];
  let residual = flags;
  for (const [name, flag] of MODIFIER_FLAGS) {
    if ((flags & flag) === flag) {
      decoded.push(name);
      residual &= ~flag;
    }
  }
  if (residual !== 0) decoded.push(`unknown:${residual}`);
  return decoded;
}

export async function normalizeRoot(
  sourceDir: string,
  graph: UmlDiagramGraph,
): Promise<UmlDiagramGraph> {
  const real = (await realpath(sourceDir)).replaceAll("\\", "/");
  const raw = sourceDir.replaceAll("\\", "/");
  return JSON.parse(
    JSON.stringify(graph).replaceAll(real, "<root>").replaceAll(raw, "<root>"),
  ) as UmlDiagramGraph;
}

type Occurrence = {
  declarationOrdinal: number;
  entityKind: UmlEntityKind;
  entityOrdinal: number;
};

function occurrenceKey(occurrence: Occurrence): string {
  return `${occurrence.declarationOrdinal}\0${occurrence.entityKind}\0${occurrence.entityOrdinal}`;
}

function groupByOccurrence<Row extends Occurrence>(rows: readonly Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = occurrenceKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function contractFile(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  return normalized.startsWith("<root>/") ? normalized.slice("<root>/".length) : normalized;
}

export function toContract(graph: UmlDiagramGraph): UmlContract {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.name)) {
      throw new Error(`ambiguous node names in contract projection: ${node.name}`);
    }
    seen.add(node.name);
    names.set(node.nodeId, node.name);
  }
  const nameOf = (id: string): string => names.get(id) ?? `<unmapped:${id}>`;

  const files = new Map(
    graph.declarations.map((declaration) => [declaration.declarationOrdinal, declaration.fileName]),
  );
  const properties = groupByOccurrence(graph.properties);
  const methods = groupByOccurrence(graph.methods);
  const enumItems = groupByOccurrence(graph.enumItems);
  const heritage = groupByOccurrence(graph.entityHeritageClauses);

  const entities = graph.entities.map((entity): EntityContract => {
    const key = occurrenceKey(entity);
    const fileName = files.get(entity.declarationOrdinal);
    if (fileName === undefined) {
      throw new Error(`missing declaration ${entity.declarationOrdinal} for entity ${entity.nodeId}`);
    }
    return {
      file: contractFile(fileName),
      kind: entity.entityKind,
      name: nameOf(entity.nodeId),
      properties: (properties.get(key) ?? []).map((property) => ({
        name: property.name,
        type: property.type,
        optional: property.optional,
        modifiers: decodeModifierFlags(property.modifierFlags),
      })),
      methods: (methods.get(key) ?? []).map((method) => ({
        name: method.name,
        type: method.returnType,
        modifiers: decodeModifierFlags(method.modifierFlags),
      })),
      enumItems: (enumItems.get(key) ?? []).map((item) => item.value),
      heritage: (heritage.get(key) ?? []).map((clause) => ({
        kind: clause.clauseType === 0 ? "extends" as const : "implements" as const,
        clause: clause.clause,
        className: clause.className,
      })),
    };
  });

  const localTargets = new Map<number, string[]>();
  for (const target of graph.localUserTargets) {
    const targets = localTargets.get(target.userOrdinal) ?? [];
    targets.push(nameOf(target.targetId));
    localTargets.set(target.userOrdinal, targets);
  }
  const externalTargets = new Map<number, string[]>();
  for (const target of graph.externalUserTargets) {
    const targets = externalTargets.get(target.userOrdinal) ?? [];
    targets.push(nameOf(target.targetId));
    externalTargets.set(target.userOrdinal, targets);
  }

  return {
    entities,
    categories: graph.categories.map(({ entityName, category, isTest }) => ({
      entityName,
      category,
      isTest,
    })),
    associations: graph.memberAssociations.map((association) => ({
      a: nameOf(association.aTypeId),
      aMultiplicity: association.aMultiplicity,
      b: nameOf(association.bTypeId),
      bMultiplicity: association.bMultiplicity,
      inherited: association.inherited,
    })),
    methodReturns: graph.methodReturnDependencies.map((dependency) => ({
      source: nameOf(dependency.sourceId),
      target: nameOf(dependency.targetId),
    })),
    usage: graph.usageEdges.map((dependency) => ({
      source: nameOf(dependency.sourceId),
      target: nameOf(dependency.targetId),
    })),
    localUsers: graph.localUsers.map((user) => ({
      label: user.label,
      path: user.path,
      line: user.line,
      column: user.column,
      kind: user.userKind,
      owner: user.ownerEntityId === null ? null : nameOf(user.ownerEntityId),
      targets: localTargets.get(user.userOrdinal) ?? [],
    })),
    externalUsers: graph.externalUsers.map((user) => ({
      label: user.label,
      scopePath: user.scopePath,
      kind: user.userKind,
      targets: externalTargets.get(user.userOrdinal) ?? [],
    })),
    definitions: graph.definitions,
    nodes: graph.nodes.map((node) => ({
      name: node.name,
      kind: node.nodeKind,
      community: node.community,
    })),
    edges: graph.edges.map((edge) => ({
      a: nameOf(edge.sourceNodeId),
      b: nameOf(edge.targetNodeId),
      weight: edge.weight,
    })),
    relations: graph.relations.map((relation) => ({
      kind: relation.relationKind,
      source: nameOf(relation.sourceNodeId),
      target: nameOf(relation.targetNodeId),
    })),
  };
}

export async function extractContract(
  sourceDir: string,
  scopePath = "",
  packages: readonly PackageInfo[] = [],
): Promise<{ graph: UmlDiagramGraph; contract: UmlContract }> {
  const extracted = await extractUmlDiagramGraph(sourceDir, scopePath, packages);
  const graph = await normalizeRoot(sourceDir, extracted);
  return { graph, contract: toContract(graph) };
}
