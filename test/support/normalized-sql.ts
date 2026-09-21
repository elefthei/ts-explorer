import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type DiagramGraph,
  type UmlDiagramGraph,
  type UmlFileOutcome,
} from "../../src/diagram-graph.ts";
import type {
  DiagramKind,
  DiagramResponse,
  FileDefinitionKind,
  PackageDiagramPayload,
} from "../../src/types.ts";
import type { DefinitionIndexSnapshot } from "../../src/uml/model.ts";

/**
 * Schema version 9. Every persisted graph and every catalogue snapshot is projected here to the
 * exact rows it must produce, so a writer that silently drops, reorders or renames a column fails
 * loudly instead of surviving behind a lenient hydrator.
 */

type SqlBoolean = 0 | 1;
type PackageDiagramGraph = Extract<DiagramGraph, { kind: "packages" }>;
type GraphIdentityRow = { generation_id: number; kind: DiagramKind; scope_path: string };
type UmlIdentityRow = GraphIdentityRow & { kind: "uml" };
type PackageIdentityRow = GraphIdentityRow & { kind: "packages"; scope_path: "" };
type SnakeCase<Name extends string> = Name extends `${infer Head}${infer Tail}`
  ? Head extends Lowercase<Head> ? `${Head}${SnakeCase<Tail>}`
  : `_${Lowercase<Head>}${SnakeCase<Tail>}`
  : Name;
type SqlValue<Value> = Value extends boolean ? SqlBoolean : Value;
type SqlFields<Row> = {
  [Key in keyof Row as Key extends string ? SnakeCase<Key> : never]: SqlValue<Row[Key]>;
};
type GraphRow<Row> = GraphIdentityRow & SqlFields<Row>;
type UmlRow<Row> = UmlIdentityRow & SqlFields<Row>;
type PackageRow<Row> = PackageIdentityRow & SqlFields<Row>;

/** Tables keyed by one `(generation_id, kind, scope_path)` diagram graph. */
type NormalizedRowByTable = {
  diagram_graphs: GraphRow<Pick<DiagramGraph, "formatVersion" | "renderMode">>;
  diagram_nodes: GraphRow<DiagramGraph["nodes"][number]>;
  diagram_edges: GraphRow<DiagramGraph["edges"][number]>;
  diagram_edge_relations: GraphRow<DiagramGraph["relations"][number]>;
  package_graph_nodes: PackageRow<PackageDiagramGraph["packageNodes"][number]>;
  uml_entities: UmlRow<UmlDiagramGraph["entities"][number]>;
  uml_properties: UmlRow<UmlDiagramGraph["properties"][number]>;
  uml_methods: UmlRow<UmlDiagramGraph["methods"][number]>;
  uml_member_modifiers: UmlRow<UmlDiagramGraph["memberModifiers"][number]>;
  uml_enum_items: UmlRow<UmlDiagramGraph["enumItems"][number]>;
  uml_categories: UmlRow<UmlDiagramGraph["categories"][number]>;
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
type ExpectedRow<Table extends NormalizedTable> = ExpectedIdentity<Table> & DataFields<Table>;
type DataColumn<Table extends NormalizedTable> = keyof DataFields<Table> & string;
type NormalizedTableSpec<Table extends NormalizedTable> = {
  columns: readonly (keyof NormalizedRowByTable[Table] & string)[];
  orderBy: readonly (keyof NormalizedRowByTable[Table] & string)[];
  expectedRows(graph: DiagramGraph): ExpectedRow<Table>[];
};
type CompleteColumns<Fields, Columns extends readonly PropertyKey[]> =
  Exclude<keyof Fields, Columns[number]> extends never ? []
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
    ["node_id", "node_ordinal", "node_kind", "name"],
    ["node_ordinal"],
    (graph) =>
      graph.nodes.map((row) => ({
        ...graphIdentity(graph),
        node_id: row.nodeId,
        node_ordinal: row.nodeOrdinal,
        node_kind: row.nodeKind,
        name: row.name,
      })),
  ),
  diagram_edges: tableSpec(
    "diagram_edges",
    ["edge_ordinal", "source_node_id", "target_node_id", "edge_kind", "directed", "weight"],
    ["edge_ordinal"],
    (graph) =>
      graph.edges.map((row) => ({
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
    (graph) =>
      graph.relations.map((row) => ({
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
    (graph) =>
      graph.kind === "packages"
        ? graph.packageNodes.map((row) => ({
          kind: "packages",
          scope_path: "",
          node_id: row.nodeId,
          package_path: row.packagePath,
        }))
        : [],
  ),
  uml_entities: tableSpec(
    "uml_entities",
    ["entity_ordinal", "definition_key", "entity_kind", "name"],
    ["entity_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.entities.map((row) => ({
          ...umlIdentity(graph),
          entity_ordinal: row.entityOrdinal,
          definition_key: row.definitionKey,
          entity_kind: row.entityKind,
          name: row.name,
        }))
        : [],
  ),
  uml_properties: tableSpec(
    "uml_properties",
    ["entity_ordinal", "property_ordinal", "definition_key", "name", "type", "optional"],
    ["entity_ordinal", "property_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.properties.map((row) => ({
          ...umlIdentity(graph),
          entity_ordinal: row.entityOrdinal,
          property_ordinal: row.propertyOrdinal,
          definition_key: row.definitionKey,
          name: row.name,
          type: row.type,
          optional: sqlBoolean(row.optional),
        }))
        : [],
  ),
  uml_methods: tableSpec(
    "uml_methods",
    ["entity_ordinal", "method_ordinal", "definition_key", "name", "return_type"],
    ["entity_ordinal", "method_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.methods.map((row) => ({
          ...umlIdentity(graph),
          entity_ordinal: row.entityOrdinal,
          method_ordinal: row.methodOrdinal,
          definition_key: row.definitionKey,
          name: row.name,
          return_type: row.returnType,
        }))
        : [],
  ),
  uml_member_modifiers: tableSpec(
    "uml_member_modifiers",
    ["entity_ordinal", "member_kind", "member_ordinal", "modifier_ordinal", "modifier"],
    ["entity_ordinal", "member_kind", "member_ordinal", "modifier_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.memberModifiers.map((row) => ({
          ...umlIdentity(graph),
          entity_ordinal: row.entityOrdinal,
          member_kind: row.memberKind,
          member_ordinal: row.memberOrdinal,
          modifier_ordinal: row.modifierOrdinal,
          modifier: row.modifier,
        }))
        : [],
  ),
  uml_enum_items: tableSpec(
    "uml_enum_items",
    ["entity_ordinal", "item_ordinal", "definition_key", "value"],
    ["entity_ordinal", "item_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.enumItems.map((row) => ({
          ...umlIdentity(graph),
          entity_ordinal: row.entityOrdinal,
          item_ordinal: row.itemOrdinal,
          definition_key: row.definitionKey,
          value: row.value,
        }))
        : [],
  ),
  uml_categories: tableSpec(
    "uml_categories",
    ["category_ordinal", "definition_key", "category", "is_test"],
    ["category_ordinal"],
    (graph) =>
      graph.kind === "uml"
        ? graph.categories.map((row) => ({
          ...umlIdentity(graph),
          category_ordinal: row.categoryOrdinal,
          definition_key: row.definitionKey,
          category: row.category,
          is_test: sqlBoolean(row.isTest),
        }))
        : [],
  ),
} satisfies { [Table in NormalizedTable]: NormalizedTableSpec<Table> };

/** Tables keyed by generation alone: the project catalogue one index transaction publishes. */
type CatalogueRowByTable = {
  DefinitionIndex: {
    generation_id: number;
    definition_key: string;
    parent_key: string | null;
    is_top_level: SqlBoolean;
    has_body: SqlBoolean;
    source_path: string;
    name: string;
    qualified_name: string;
    kind: FileDefinitionKind;
    type_text: string | null;
    source_line: number;
    source_column: number;
  };
  definition_bindings: {
    generation_id: number;
    source_path: string;
    scope_key: string;
    name: string;
    space: "type" | "value";
    binding_kind: "local" | "import" | "export";
    ordinal: number;
    target_key: string | null;
    target_module_path: string | null;
  };
  file_imports: {
    generation_id: number;
    source_path: string;
    target_path: string;
  };
  definition_contributors: {
    generation_id: number;
    definition_key: string;
    source_path: string;
    contribution_kind: "declaration" | "implementation" | "module";
  };
};

type CatalogueTable = keyof CatalogueRowByTable;
type CatalogueDataFields<Table extends CatalogueTable> = Omit<
  CatalogueRowByTable[Table],
  "generation_id"
>;
type CatalogueColumn<Table extends CatalogueTable> = keyof CatalogueDataFields<Table> & string;
type CatalogueTableSpec<Table extends CatalogueTable> = {
  columns: readonly (keyof CatalogueRowByTable[Table] & string)[];
  orderBy: readonly (keyof CatalogueRowByTable[Table] & string)[];
  expectedRows(snapshot: DefinitionIndexSnapshot): CatalogueDataFields<Table>[];
};

function catalogueSpec<
  Table extends CatalogueTable,
  const Columns extends readonly CatalogueColumn<Table>[],
>(
  _table: Table,
  columns: Columns,
  orderBy: readonly CatalogueColumn<Table>[],
  expectedRows: (snapshot: DefinitionIndexSnapshot) => CatalogueDataFields<Table>[],
  ..._complete: CompleteColumns<CatalogueDataFields<Table>, Columns>
): CatalogueTableSpec<Table> {
  return {
    columns: ["generation_id", ...columns],
    orderBy: [...orderBy],
    expectedRows,
  };
}

const CATALOGUE_TABLE_SPECS = {
  DefinitionIndex: catalogueSpec(
    "DefinitionIndex",
    [
      "definition_key",
      "parent_key",
      "is_top_level",
      "has_body",
      "source_path",
      "name",
      "qualified_name",
      "kind",
      "type_text",
      "source_line",
      "source_column",
    ],
    ["definition_key"],
    (snapshot) =>
      snapshot.definitions.map((definition) => ({
        definition_key: definition.key,
        parent_key: definition.parentKey,
        is_top_level: sqlBoolean(definition.isTopLevel),
        has_body: sqlBoolean(definition.hasBody),
        source_path: definition.source.path,
        name: definition.name,
        qualified_name: definition.qualifiedName,
        kind: definition.kind,
        type_text: definition.type,
        source_line: definition.source.line,
        source_column: definition.source.column,
      })),
  ),
  definition_bindings: catalogueSpec(
    "definition_bindings",
    [
      "source_path",
      "scope_key",
      "name",
      "space",
      "binding_kind",
      "ordinal",
      "target_key",
      "target_module_path",
    ],
    ["source_path", "scope_key", "name", "space", "binding_kind", "ordinal"],
    (snapshot) =>
      snapshot.bindings.map((binding) => ({
        source_path: binding.sourcePath,
        scope_key: binding.scopeKey,
        name: binding.name,
        space: binding.space,
        binding_kind: binding.bindingKind,
        ordinal: binding.ordinal,
        target_key: binding.target.kind === "definition" ? binding.target.key : null,
        target_module_path: binding.target.kind === "module" ? binding.target.path : null,
      })),
  ),
  file_imports: catalogueSpec(
    "file_imports",
    ["source_path", "target_path"],
    ["source_path", "target_path"],
    (snapshot) =>
      snapshot.imports.map((edge) => ({
        source_path: edge.sourcePath,
        target_path: edge.targetPath,
      })),
  ),
  definition_contributors: catalogueSpec(
    "definition_contributors",
    ["definition_key", "source_path", "contribution_kind"],
    ["definition_key", "source_path", "contribution_kind"],
    (snapshot) =>
      snapshot.contributors.map((contributor) => ({
        definition_key: contributor.definitionKey,
        source_path: contributor.sourcePath,
        contribution_kind: contributor.kind,
      })),
  ),
} satisfies { [Table in CatalogueTable]: CatalogueTableSpec<Table> };

type NormalizedSnapshotRecordFor<Table extends NormalizedTable> =
  & { table: Table }
  & Omit<NormalizedRowByTable[Table], "generation_id">;
export type NormalizedSnapshotRecord = {
  [Table in NormalizedTable]: NormalizedSnapshotRecordFor<Table>;
}[NormalizedTable];

/**
 * `diagrams.response_json` holds a `PackageDiagramPayload` for the package graph and only the
 * `UmlFileOutcome` completion marker for a source file; the UML display model lives in the
 * normalized tables and is assembled per selection.
 */
export type NormalizedGraphSnapshot = {
  generationId: number;
  kind: DiagramKind;
  scopePath: string;
  header: {
    format_version: typeof DIAGRAM_GRAPH_FORMAT_VERSION;
    render_mode: "normal" | "bare";
  };
  records: NormalizedSnapshotRecord[];
  response: PackageDiagramPayload | UmlFileOutcome;
};

const NORMALIZED_TABLES = Object.keys(NORMALIZED_TABLE_SPECS) as NormalizedTable[];
const CATALOGUE_TABLES = Object.keys(CATALOGUE_TABLE_SPECS) as CatalogueTable[];
const GENERATION_SCOPED_TABLES: readonly (NormalizedTable | CatalogueTable)[] = [
  ...NORMALIZED_TABLES,
  ...CATALOGUE_TABLES,
];
type IdentityBindings = [number, DiagramKind, string];

/**
 * Canonical ordering applied to both sides of a comparison. SQLite's BINARY collation and
 * JavaScript string order disagree on non-ASCII identifiers; sorting both arrays the same way in
 * JavaScript keeps the projection about content rather than collation.
 */
function sortRows<Row extends Record<string, unknown>>(
  rows: Row[],
  orderBy: readonly string[],
): Row[] {
  return rows.sort((left, right) => {
    for (const column of orderBy) {
      const a = left[column];
      const b = right[column];
      if (a === b) continue;
      if (a === null || a === undefined) return -1;
      if (b === null || b === undefined) return 1;
      if (typeof a === "number" && typeof b === "number") return a - b;
      const [textA, textB] = [String(a), String(b)];
      if (textA !== textB) return textA < textB ? -1 : 1;
    }
    return 0;
  });
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

function graphRows<Table extends NormalizedTable>(
  db: Database,
  table: Table,
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): NormalizedRowByTable[Table][] {
  const spec = NORMALIZED_TABLE_SPECS[table];
  const statement = db.query<NormalizedRowByTable[Table], IdentityBindings>(`
    SELECT ${spec.columns.join(", ")}
    FROM ${table}
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY ${spec.orderBy.join(", ")}
  `);
  try {
    return sortRows(statement.all(generationId, kind, scopePath), spec.orderBy);
  } finally {
    statement.finalize();
  }
}

function catalogueRows<Table extends CatalogueTable>(
  db: Database,
  table: Table,
  generationId: number,
): CatalogueRowByTable[Table][] {
  const spec = CATALOGUE_TABLE_SPECS[table];
  const statement = db.query<CatalogueRowByTable[Table], [number]>(`
    SELECT ${spec.columns.join(", ")}
    FROM ${table}
    WHERE generation_id = ?
    ORDER BY ${spec.orderBy.join(", ")}
  `);
  try {
    return sortRows(statement.all(generationId), spec.orderBy);
  } finally {
    statement.finalize();
  }
}

function withoutGeneration<Row extends { generation_id: number }>(
  rows: Row[],
): Omit<Row, "generation_id">[] {
  return rows.map(({ generation_id: _generationId, ...record }) => record);
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
  const records = NORMALIZED_TABLES.flatMap((table) =>
    table === "diagram_graphs" ? [] : withoutGeneration(
      graphRows(db, table, generationId, kind, scopePath),
    ).map((record) => ({ table, ...record } as NormalizedSnapshotRecord))
  );
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
    response: JSON.parse(responseRow.response_json) as NormalizedGraphSnapshot["response"],
  };
}

/** Asserts the persisted rows of one diagram graph are exactly the projection of `graph`. */
export function expectNormalizedGraphRows(
  db: Database,
  generationId: number,
  graph: DiagramGraph,
): void {
  for (const table of NORMALIZED_TABLES) {
    const spec = NORMALIZED_TABLE_SPECS[table];
    const actual: unknown[] = withoutGeneration(
      graphRows(db, table, generationId, graph.kind, graph.scopePath),
    );
    const expected: unknown[] = sortRows(
      spec.expectedRows(graph) as Record<string, unknown>[],
      spec.orderBy,
    );
    expect(actual, `${table} of ${graph.kind}:${graph.scopePath}`).toEqual(expected);
  }
}

/** Asserts the catalogue tables hold exactly the rows `writeDefinitionIndex` was handed. */
export function expectCatalogueRows(
  db: Database,
  generationId: number,
  snapshot: DefinitionIndexSnapshot,
): void {
  for (const table of CATALOGUE_TABLES) {
    const spec = CATALOGUE_TABLE_SPECS[table];
    const actual: unknown[] = withoutGeneration(catalogueRows(db, table, generationId));
    const expected: unknown[] = sortRows(
      spec.expectedRows(snapshot) as Record<string, unknown>[],
      spec.orderBy,
    );
    expect(actual, table).toEqual(expected);
  }
}

export function normalizedGenerationIds(
  db: Database,
  table: NormalizedTable | CatalogueTable,
): number[] {
  // The table name is interpolated, so only a known schema object may reach the statement.
  const allowed = GENERATION_SCOPED_TABLES.find((candidate) => candidate === table);
  if (!allowed) throw new Error(`unknown normalized table: ${table}`);
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
  for (const table of GENERATION_SCOPED_TABLES) {
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

/** The package graph's `diagrams` row is still the full public payload, minus its version. */
export function expectSnapshotResponse(
  snapshot: NormalizedGraphSnapshot,
  response: Extract<DiagramResponse, { kind: "packages" }>,
): void {
  const { version: _version, ...withoutVersion } = response;
  expect(snapshot.response).toEqual(withoutVersion);
}

