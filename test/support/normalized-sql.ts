import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CacheDiagramResponse } from "../../src/cache.ts";
import type { DiagramGraph, UmlDiagramGraph } from "../../src/diagram-graph.ts";
import type { DiagramKind, DiagramResponse } from "../../src/types.ts";

type SqlBoolean = 0 | 1;
type PackageDiagramGraph = Extract<DiagramGraph, { kind: "packages" }>;
type GraphIdentityRow = { generation_id: number; kind: DiagramKind; scope_path: string };
type UmlIdentityRow = GraphIdentityRow & { kind: "uml" };
type PackageIdentityRow = GraphIdentityRow & { kind: "packages"; scope_path: "" };
type SnakeCase<Name extends string> = Name extends `${infer Head}${infer Tail}`
  ? Head extends Lowercase<Head>
    ? `${Head}${SnakeCase<Tail>}`
    : `_${Lowercase<Head>}${SnakeCase<Tail>}`
  : Name;
type SqlValue<Value> = Value extends boolean ? SqlBoolean : Value;
type SqlFields<Row> = {
  [Key in keyof Row as Key extends string ? SnakeCase<Key> : never]: SqlValue<Row[Key]>;
};
type GraphRow<Row> = GraphIdentityRow & SqlFields<Row>;
type UmlRow<Row> = UmlIdentityRow & SqlFields<Row>;
type PackageRow<Row> = PackageIdentityRow & SqlFields<Row>;
type ExternalUserFields = Omit<
  SqlFields<UmlDiagramGraph["externalUsers"][number]>,
  "scope_path"
> & { user_scope_path: string };

type NormalizedRowByTable = {
  diagram_graphs: GraphRow<Pick<DiagramGraph, "formatVersion" | "renderMode">>;
  diagram_nodes: GraphRow<DiagramGraph["nodes"][number]>;
  diagram_node_aliases: GraphRow<DiagramGraph["aliases"][number]>;
  diagram_edges: GraphRow<DiagramGraph["edges"][number]>;
  diagram_edge_relations: GraphRow<DiagramGraph["relations"][number]>;
  package_graph_nodes: PackageRow<PackageDiagramGraph["packageNodes"][number]>;
  uml_settings: UmlRow<NonNullable<UmlDiagramGraph["settings"]>>;
  uml_setting_lines: UmlRow<UmlDiagramGraph["settingLines"][number]>;
  uml_declarations: UmlRow<UmlDiagramGraph["declarations"][number]>;
  uml_entities: UmlRow<UmlDiagramGraph["entities"][number]>;
  uml_properties: UmlRow<UmlDiagramGraph["properties"][number]>;
  uml_property_type_ids: UmlRow<UmlDiagramGraph["propertyTypeIds"][number]>;
  uml_methods: UmlRow<UmlDiagramGraph["methods"][number]>;
  uml_method_return_type_ids: UmlRow<UmlDiagramGraph["methodReturnTypeIds"][number]>;
  uml_enum_items: UmlRow<UmlDiagramGraph["enumItems"][number]>;
  uml_entity_heritage_clauses: UmlRow<UmlDiagramGraph["entityHeritageClauses"][number]>;
  uml_declaration_heritage_groups: UmlRow<UmlDiagramGraph["declarationHeritageGroups"][number]>;
  uml_declaration_heritage_clauses: UmlRow<UmlDiagramGraph["declarationHeritageClauses"][number]>;
  uml_member_associations: UmlRow<UmlDiagramGraph["memberAssociations"][number]>;
  uml_categories: UmlRow<UmlDiagramGraph["categories"][number]>;
  uml_method_return_dependencies: UmlRow<UmlDiagramGraph["methodReturnDependencies"][number]>;
  uml_usage_edges: UmlRow<UmlDiagramGraph["usageEdges"][number]>;
  uml_local_users: UmlRow<UmlDiagramGraph["localUsers"][number]>;
  uml_external_users: UmlIdentityRow & ExternalUserFields;
  uml_local_user_targets: UmlRow<UmlDiagramGraph["localUserTargets"][number]>;
  uml_external_user_targets: UmlRow<UmlDiagramGraph["externalUserTargets"][number]>;
  uml_definitions: UmlRow<UmlDiagramGraph["definitions"][number]>;
};

export type NormalizedTable = keyof NormalizedRowByTable;
type DataFields<Table extends NormalizedTable> = Omit<
  NormalizedRowByTable[Table],
  keyof GraphIdentityRow
>;
type ExpectedIdentity<Table extends NormalizedTable> = Pick<
  NormalizedRowByTable[Table],
  "kind" | "scope_path"
>;
type ExpectedRow<Table extends NormalizedTable> =
  ExpectedIdentity<Table> & DataFields<Table>;
type DataColumn<Table extends NormalizedTable> = keyof DataFields<Table> & string;
type NormalizedTableSpec<Table extends NormalizedTable> = {
  columns: readonly (keyof NormalizedRowByTable[Table] & string)[];
  orderBy: readonly (keyof NormalizedRowByTable[Table] & string)[];
  expectedRows(graph: DiagramGraph): ExpectedRow<Table>[];
};
type CompleteColumns<Fields, Columns extends readonly PropertyKey[]> =
  Exclude<keyof Fields, Columns[number]> extends never
    ? []
    : [missingColumns: Exclude<keyof Fields, Columns[number]>];

const IDENTITY_COLUMNS: readonly (keyof GraphIdentityRow & string)[] = [
  "generation_id",
  "kind",
  "scope_path",
];

function graphIdentity(graph: DiagramGraph): Pick<GraphIdentityRow, "kind" | "scope_path"> {
  return { kind: graph.kind, scope_path: graph.scopePath };
}

function umlIdentity(graph: UmlDiagramGraph): Pick<UmlIdentityRow, "kind" | "scope_path"> {
  return { kind: "uml", scope_path: graph.scopePath };
}

function packageIdentity(): Pick<PackageIdentityRow, "kind" | "scope_path"> {
  return { kind: "packages", scope_path: "" };
}

function sqlBoolean(value: boolean): SqlBoolean {
  return value ? 1 : 0;
}

function tableSpec<
  Table extends NormalizedTable,
  const Columns extends readonly DataColumn<Table>[],
>(
  _table: Table,
  columns: Columns,
  orderBy: readonly DataColumn<Table>[],
  expectedRows: (graph: DiagramGraph) => ExpectedRow<Table>[],
  ..._complete: CompleteColumns<DataFields<Table>, Columns>
): NormalizedTableSpec<Table> {
  return {
    columns: [...IDENTITY_COLUMNS, ...columns],
    orderBy: [...IDENTITY_COLUMNS, ...orderBy],
    expectedRows,
  };
}

export const NORMALIZED_TABLE_SPECS = {
  diagram_graphs: tableSpec(
    "diagram_graphs",
    ["format_version", "render_mode"],
    [],
    (graph) => [{
      ...graphIdentity(graph),
      format_version: graph.formatVersion,
      render_mode: graph.renderMode,
    }],
  ),
  diagram_nodes: tableSpec(
    "diagram_nodes",
    ["node_id", "node_ordinal", "node_kind", "name", "community"],
    ["node_id"],
    (graph) => graph.nodes.map((row) => ({
      ...graphIdentity(graph),
      node_id: row.nodeId,
      node_ordinal: row.nodeOrdinal,
      node_kind: row.nodeKind,
      name: row.name,
      community: row.community,
    })),
  ),
  diagram_node_aliases: tableSpec(
    "diagram_node_aliases",
    ["node_id", "alias_ordinal", "alias"],
    ["node_id", "alias_ordinal"],
    (graph) => graph.aliases.map((row) => ({
      ...graphIdentity(graph),
      node_id: row.nodeId,
      alias_ordinal: row.aliasOrdinal,
      alias: row.alias,
    })),
  ),
  diagram_edges: tableSpec(
    "diagram_edges",
    ["edge_ordinal", "source_node_id", "target_node_id", "edge_kind", "directed", "weight"],
    ["edge_ordinal"],
    (graph) => graph.edges.map((row) => ({
      ...graphIdentity(graph),
      edge_ordinal: row.edgeOrdinal,
      source_node_id: row.sourceNodeId,
      target_node_id: row.targetNodeId,
      edge_kind: row.edgeKind,
      directed: sqlBoolean(row.directed),
      weight: row.weight,
    })),
  ),
  diagram_edge_relations: tableSpec(
    "diagram_edge_relations",
    ["edge_ordinal", "relation_ordinal", "relation_kind", "source_node_id", "target_node_id"],
    ["edge_ordinal", "relation_ordinal"],
    (graph) => graph.relations.map((row) => ({
      ...graphIdentity(graph),
      edge_ordinal: row.edgeOrdinal,
      relation_ordinal: row.relationOrdinal,
      relation_kind: row.relationKind,
      source_node_id: row.sourceNodeId,
      target_node_id: row.targetNodeId,
    })),
  ),
  package_graph_nodes: tableSpec(
    "package_graph_nodes",
    ["node_id", "package_path"],
    ["node_id"],
    (graph) => graph.kind === "packages"
      ? graph.packageNodes.map((row) => ({
          ...packageIdentity(),
          node_id: row.nodeId,
          package_path: row.packagePath,
        }))
      : [],
  ),
  uml_settings: tableSpec(
    "uml_settings",
    [
      "glob", "tsconfig", "out_file", "property_types", "modifiers", "type_links", "out_dsl",
      "out_mermaid_dsl", "member_associations", "exported_types_only",
    ],
    [],
    (graph) => graph.kind === "uml" && graph.settings !== null
      ? [{
          ...umlIdentity(graph),
          glob: graph.settings.glob,
          tsconfig: graph.settings.tsconfig,
          out_file: graph.settings.outFile,
          property_types: sqlBoolean(graph.settings.propertyTypes),
          modifiers: sqlBoolean(graph.settings.modifiers),
          type_links: sqlBoolean(graph.settings.typeLinks),
          out_dsl: graph.settings.outDsl,
          out_mermaid_dsl: graph.settings.outMermaidDsl,
          member_associations: sqlBoolean(graph.settings.memberAssociations),
          exported_types_only: sqlBoolean(graph.settings.exportedTypesOnly),
        }]
      : [],
  ),
  uml_setting_lines: tableSpec(
    "uml_setting_lines",
    ["setting_kind", "line_ordinal", "value"],
    ["setting_kind", "line_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.settingLines.map((row) => ({
          ...umlIdentity(graph),
          setting_kind: row.settingKind,
          line_ordinal: row.lineOrdinal,
          value: row.value,
        }))
      : [],
  ),
  uml_declarations: tableSpec(
    "uml_declarations",
    ["declaration_ordinal", "file_name", "member_associations_present"],
    ["declaration_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.declarations.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          file_name: row.fileName,
          member_associations_present: sqlBoolean(row.memberAssociationsPresent),
        }))
      : [],
  ),
  uml_entities: tableSpec(
    "uml_entities",
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "node_id"],
    ["declaration_ordinal", "entity_kind", "entity_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.entities.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          node_id: row.nodeId,
        }))
      : [],
  ),
  uml_properties: tableSpec(
    "uml_properties",
    [
      "declaration_ordinal", "entity_kind", "entity_ordinal", "property_ordinal",
      "modifier_flags", "name", "type", "optional",
    ],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "property_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.properties.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          property_ordinal: row.propertyOrdinal,
          modifier_flags: row.modifierFlags,
          name: row.name,
          type: row.type,
          optional: sqlBoolean(row.optional),
        }))
      : [],
  ),
  uml_property_type_ids: tableSpec(
    "uml_property_type_ids",
    [
      "declaration_ordinal", "entity_kind", "entity_ordinal", "property_ordinal",
      "type_id_ordinal", "type_id",
    ],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "property_ordinal", "type_id_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.propertyTypeIds.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          property_ordinal: row.propertyOrdinal,
          type_id_ordinal: row.typeIdOrdinal,
          type_id: row.typeId,
        }))
      : [],
  ),
  uml_methods: tableSpec(
    "uml_methods",
    [
      "declaration_ordinal", "entity_kind", "entity_ordinal", "method_ordinal", "modifier_flags",
      "name", "return_type", "return_type_ids_present",
    ],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "method_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.methods.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          method_ordinal: row.methodOrdinal,
          modifier_flags: row.modifierFlags,
          name: row.name,
          return_type: row.returnType,
          return_type_ids_present: sqlBoolean(row.returnTypeIdsPresent),
        }))
      : [],
  ),
  uml_method_return_type_ids: tableSpec(
    "uml_method_return_type_ids",
    [
      "declaration_ordinal", "entity_kind", "entity_ordinal", "method_ordinal",
      "type_id_ordinal", "type_id",
    ],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "method_ordinal", "type_id_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.methodReturnTypeIds.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          method_ordinal: row.methodOrdinal,
          type_id_ordinal: row.typeIdOrdinal,
          type_id: row.typeId,
        }))
      : [],
  ),
  uml_enum_items: tableSpec(
    "uml_enum_items",
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "item_ordinal", "value"],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "item_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.enumItems.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          item_ordinal: row.itemOrdinal,
          value: row.value,
        }))
      : [],
  ),
  uml_entity_heritage_clauses: tableSpec(
    "uml_entity_heritage_clauses",
    [
      "declaration_ordinal", "entity_kind", "entity_ordinal", "clause_ordinal", "clause",
      "clause_type_id", "class_name", "class_type_id", "clause_type",
    ],
    ["declaration_ordinal", "entity_kind", "entity_ordinal", "clause_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.entityHeritageClauses.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
          clause_ordinal: row.clauseOrdinal,
          clause: row.clause,
          clause_type_id: row.clauseTypeId,
          class_name: row.className,
          class_type_id: row.classTypeId,
          clause_type: row.clauseType,
        }))
      : [],
  ),
  uml_declaration_heritage_groups: tableSpec(
    "uml_declaration_heritage_groups",
    ["declaration_ordinal", "group_ordinal", "entity_kind", "entity_ordinal"],
    ["declaration_ordinal", "group_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.declarationHeritageGroups.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          group_ordinal: row.groupOrdinal,
          entity_kind: row.entityKind,
          entity_ordinal: row.entityOrdinal,
        }))
      : [],
  ),
  uml_declaration_heritage_clauses: tableSpec(
    "uml_declaration_heritage_clauses",
    [
      "declaration_ordinal", "group_ordinal", "clause_ordinal", "clause", "clause_type_id",
      "class_name", "class_type_id", "clause_type",
    ],
    ["declaration_ordinal", "group_ordinal", "clause_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.declarationHeritageClauses.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          group_ordinal: row.groupOrdinal,
          clause_ordinal: row.clauseOrdinal,
          clause: row.clause,
          clause_type_id: row.clauseTypeId,
          class_name: row.className,
          class_type_id: row.classTypeId,
          clause_type: row.clauseType,
        }))
      : [],
  ),
  uml_member_associations: tableSpec(
    "uml_member_associations",
    [
      "declaration_ordinal", "association_ordinal", "a_type_id", "a_name", "a_multiplicity",
      "b_type_id", "b_name", "b_multiplicity", "association_type", "inherited",
    ],
    ["declaration_ordinal", "association_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.memberAssociations.map((row) => ({
          ...umlIdentity(graph),
          declaration_ordinal: row.declarationOrdinal,
          association_ordinal: row.associationOrdinal,
          a_type_id: row.aTypeId,
          a_name: row.aName,
          a_multiplicity: row.aMultiplicity,
          b_type_id: row.bTypeId,
          b_name: row.bName,
          b_multiplicity: row.bMultiplicity,
          association_type: row.associationType,
          inherited: sqlBoolean(row.inherited),
        }))
      : [],
  ),
  uml_categories: tableSpec(
    "uml_categories",
    ["category_ordinal", "entity_name", "category", "is_test"],
    ["category_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.categories.map((row) => ({
          ...umlIdentity(graph),
          category_ordinal: row.categoryOrdinal,
          entity_name: row.entityName,
          category: row.category,
          is_test: sqlBoolean(row.isTest),
        }))
      : [],
  ),
  uml_method_return_dependencies: tableSpec(
    "uml_method_return_dependencies",
    ["dependency_ordinal", "source_id", "source_name", "target_id", "target_name"],
    ["dependency_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.methodReturnDependencies.map((row) => ({
          ...umlIdentity(graph),
          dependency_ordinal: row.dependencyOrdinal,
          source_id: row.sourceId,
          source_name: row.sourceName,
          target_id: row.targetId,
          target_name: row.targetName,
        }))
      : [],
  ),
  uml_usage_edges: tableSpec(
    "uml_usage_edges",
    ["dependency_ordinal", "source_id", "source_name", "target_id", "target_name"],
    ["dependency_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.usageEdges.map((row) => ({
          ...umlIdentity(graph),
          dependency_ordinal: row.dependencyOrdinal,
          source_id: row.sourceId,
          source_name: row.sourceName,
          target_id: row.targetId,
          target_name: row.targetName,
        }))
      : [],
  ),
  uml_local_users: tableSpec(
    "uml_local_users",
    [
      "user_ordinal", "node_id", "navigation_node_id", "label", "path", "line", "column",
      "user_kind", "owner_entity_id",
    ],
    ["user_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.localUsers.map((row) => ({
          ...umlIdentity(graph),
          user_ordinal: row.userOrdinal,
          node_id: row.nodeId,
          navigation_node_id: row.navigationNodeId,
          label: row.label,
          path: row.path,
          line: row.line,
          column: row.column,
          user_kind: row.userKind,
          owner_entity_id: row.ownerEntityId,
        }))
      : [],
  ),
  uml_external_users: tableSpec(
    "uml_external_users",
    [
      "user_ordinal", "node_id", "navigation_node_id", "label", "user_scope_path", "user_kind",
    ],
    ["user_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.externalUsers.map((row) => ({
          ...umlIdentity(graph),
          user_ordinal: row.userOrdinal,
          node_id: row.nodeId,
          navigation_node_id: row.navigationNodeId,
          label: row.label,
          user_scope_path: row.scopePath,
          user_kind: row.userKind,
        }))
      : [],
  ),
  uml_local_user_targets: tableSpec(
    "uml_local_user_targets",
    ["user_ordinal", "target_ordinal", "target_id", "target_name"],
    ["user_ordinal", "target_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.localUserTargets.map((row) => ({
          ...umlIdentity(graph),
          user_ordinal: row.userOrdinal,
          target_ordinal: row.targetOrdinal,
          target_id: row.targetId,
          target_name: row.targetName,
        }))
      : [],
  ),
  uml_external_user_targets: tableSpec(
    "uml_external_user_targets",
    ["user_ordinal", "target_ordinal", "target_id", "target_name"],
    ["user_ordinal", "target_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.externalUserTargets.map((row) => ({
          ...umlIdentity(graph),
          user_ordinal: row.userOrdinal,
          target_ordinal: row.targetOrdinal,
          target_id: row.targetId,
          target_name: row.targetName,
        }))
      : [],
  ),
  uml_definitions: tableSpec(
    "uml_definitions",
    [
      "definition_ordinal", "definition_key", "definition_kind", "name", "qualified_name",
      "source_path", "source_line", "source_column", "uml_scope_path", "uml_entity_name",
      "uml_member_name", "uml_member_occurrence",
    ],
    ["definition_ordinal"],
    (graph) => graph.kind === "uml"
      ? graph.definitions.map((row) => ({
          ...umlIdentity(graph),
          definition_ordinal: row.definitionOrdinal,
          definition_key: row.definitionKey,
          definition_kind: row.definitionKind,
          name: row.name,
          qualified_name: row.qualifiedName,
          source_path: row.sourcePath,
          source_line: row.sourceLine,
          source_column: row.sourceColumn,
          uml_scope_path: row.umlScopePath,
          uml_entity_name: row.umlEntityName,
          uml_member_name: row.umlMemberName,
          uml_member_occurrence: row.umlMemberOccurrence,
        }))
      : [],
  ),
} satisfies { [Table in NormalizedTable]: NormalizedTableSpec<Table> };

type NormalizedSnapshotRecordFor<Table extends NormalizedTable> =
  { table: Table } & Omit<NormalizedRowByTable[Table], "generation_id">;
export type NormalizedSnapshotRecord = {
  [Table in NormalizedTable]: NormalizedSnapshotRecordFor<Table>;
}[NormalizedTable];
export type NormalizedGraphSnapshot = {
  generationId: number;
  kind: DiagramKind;
  scopePath: string;
  header: { format_version: 1; render_mode: "normal" | "bare" };
  records: NormalizedSnapshotRecord[];
  response: CacheDiagramResponse;
};

const NORMALIZED_TABLES = Object.keys(NORMALIZED_TABLE_SPECS) as NormalizedTable[];
type IdentityBindings = [number, DiagramKind, string];

function allowlistedTable(table: NormalizedTable): NormalizedTable {
  const allowed = NORMALIZED_TABLES.find((candidate) => candidate === table);
  if (!allowed) throw new Error(`unknown normalized table: ${table}`);
  return allowed;
}

function identityRow<Row>(
  db: Database,
  sql: string,
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): Row | null {
  const statement = db.query<Row, IdentityBindings>(sql);
  try {
    return statement.get(generationId, kind, scopePath);
  } finally {
    statement.finalize();
  }
}

function snapshotRecords(
  db: Database,
  table: NormalizedTable,
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): NormalizedSnapshotRecord[];
function snapshotRecords<Table extends NormalizedTable>(
  db: Database,
  table: Table,
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): NormalizedSnapshotRecordFor<Table>[] {
  const spec = NORMALIZED_TABLE_SPECS[table];
  const statement = db.query<NormalizedRowByTable[Table], IdentityBindings>(`
    SELECT ${spec.columns.join(", ")}
    FROM ${table}
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY ${spec.orderBy.join(", ")}
  `);
  try {
    return statement.all(generationId, kind, scopePath).map((row) => {
      const { generation_id: _generationId, ...record } = row;
      return { table, ...record };
    });
  } finally {
    statement.finalize();
  }
}

export function readNormalizedGraphSnapshot(
  db: Database,
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): NormalizedGraphSnapshot {
  const header = identityRow<NormalizedGraphSnapshot["header"]>(
    db,
    `SELECT format_version, render_mode FROM diagram_graphs
     WHERE generation_id = ? AND kind = ? AND scope_path = ?`,
    generationId,
    kind,
    scopePath,
  );
  if (!header) throw new Error(`normalized ${kind} graph is missing: ${scopePath}`);
  const records = NORMALIZED_TABLES.flatMap((table) => table === "diagram_graphs"
    ? []
    : snapshotRecords(db, table, generationId, kind, scopePath));
  const responseRow = identityRow<{ response_json: string }>(
    db,
    `SELECT response_json FROM diagrams
     WHERE generation_id = ? AND kind = ? AND scope_path = ?`,
    generationId,
    kind,
    scopePath,
  );
  if (!responseRow) throw new Error(`normalized ${kind} response is missing: ${scopePath}`);
  return {
    generationId,
    kind,
    scopePath,
    header,
    records,
    response: JSON.parse(responseRow.response_json) as CacheDiagramResponse,
  };
}

export function normalizedGenerationIds(db: Database, table: NormalizedTable): number[] {
  const allowed = allowlistedTable(table);
  const statement = db.query<{ generation_id: number }, []>(`
    SELECT DISTINCT generation_id FROM ${allowed} ORDER BY generation_id
  `);
  try {
    return statement.all().map(({ generation_id }) => generation_id);
  } finally {
    statement.finalize();
  }
}

export function expectOnlyNormalizedGeneration(db: Database, generationId: number): void {
  for (const table of NORMALIZED_TABLES) {
    const ids = normalizedGenerationIds(db, table);
    expect(ids, table).toEqual(ids.length === 0 ? [] : [generationId]);
  }
  const statement = db.query<{ diagram_count: number; graph_count: number }, [number, number]>(`
    SELECT
      (SELECT COUNT(*) FROM diagrams WHERE generation_id = ?) AS diagram_count,
      (SELECT COUNT(*) FROM diagram_graphs WHERE generation_id = ?) AS graph_count
  `);
  try {
    const counts = statement.get(generationId, generationId);
    if (!counts) throw new Error(`normalized generation ${generationId} is missing`);
    expect(counts.graph_count).toBeGreaterThan(0);
    expect(counts.diagram_count).toBe(counts.graph_count);
  } finally {
    statement.finalize();
  }
}

export function expectSnapshotResponse(
  snapshot: NormalizedGraphSnapshot,
  response: DiagramResponse,
): void {
  const { version: _version, ...withoutVersion } = response;
  expect(snapshot.response).toEqual(withoutVersion);
}
