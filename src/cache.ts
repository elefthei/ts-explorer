import { mkdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type DiagramGraph,
  type PackageDiagramGraph,
  type RenderedDiagram,
  type UmlDiagramGraph,
} from "./diagram-graph.ts";
import { normalizeRelativePath } from "./paths.ts";
import { buildSearchScopes } from "./search.ts";
import type {
  DiagramKind,
  DiagramResponse,
  EditorGotoDefinition,
  GotoDefinition,
  GotoDefinitionKind,
  PackageInfo,
  SearchResponse,
  TreeNode,
} from "./types.ts";
import { validateUmlDiagramGraph } from "./uml/render.ts";

const CACHE_SCHEMA_VERSION = 3;

export type CacheDiagramResponse = Omit<DiagramResponse, "version">;

type DiagramErrorOutcome = { status: "error"; error: string };

export type CacheDiagramInput =
  | {
    graph: DiagramGraph;
    outcome: { status: "ready" } | DiagramErrorOutcome;
  }
  | {
    fallbackSource: {
      sourceGenerationId: number;
      kind: DiagramKind;
      scopePath: string;
    };
    outcome: DiagramErrorOutcome;
  };

type DiagramRenderer = (graph: DiagramGraph) => RenderedDiagram;

export class DiagramMaterializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiagramMaterializationError";
  }
}

export type CacheFileWrite = {
  path: string;
  rawContent: string | null;
  displayContent: string | null;
  sourceError: string | null;
  formatError: string | null;
};


type CacheScopeWrite = {
  entries: readonly TreeNode[];
  diagram: CacheDiagramInput;
  file?: CacheFileWrite;
  definitions: readonly EditorGotoDefinition[];
};


type ActiveGenerationRow = { id: number };
type MetaRow = { value: string };
type PackageRow = { packages_json: string };
type TreeRow = {
  path: string;
  name: string;
  kind: "directory" | "file";
  viewable: number;
};
type DiagramRow = { response_json: string };
type FileRow = {
  path: string;
  raw_content: string | null;
  display_content: string | null;
  source_error: string | null;
  format_error: string | null;
};
type SearchCandidateRow = { path: string; raw_content: string };
type GotoDefinitionRow = {
  definition_key: string;
  kind: GotoDefinitionKind;
  name: string;
  qualified_name: string;
  source_path: string;
  source_line: number;
  source_column: number;
  display_from: number;
  display_to: number;
  uml_scope_path: string;
  uml_entity_name: string;
  uml_member_name: string | null;
  uml_member_occurrence: number | null;
};
type SchemaObjectRow = { name: string };
type GraphIdentity = [generationId: number, kind: DiagramKind, scopePath: string];
type GraphHeaderRow = {
  kind: DiagramKind;
  scopePath: string;
  formatVersion: number;
  renderMode: "normal" | "bare";
};
type SqlEdgeRow = Omit<DiagramGraph["edges"][number], "directed"> & { directed: number };
type SqlSettingsRow = Omit<
  NonNullable<UmlDiagramGraph["settings"]>,
  | "propertyTypes"
  | "modifiers"
  | "typeLinks"
  | "memberAssociations"
  | "exportedTypesOnly"
> & {
  propertyTypes: number;
  modifiers: number;
  typeLinks: number;
  memberAssociations: number;
  exportedTypesOnly: number;
};
type SqlDeclarationRow = Omit<
  UmlDiagramGraph["declarations"][number],
  "memberAssociationsPresent"
> & { memberAssociationsPresent: number };
type SqlPropertyRow = Omit<
  UmlDiagramGraph["properties"][number],
  "optional"
> & { optional: number };
type SqlMethodRow = Omit<
  UmlDiagramGraph["methods"][number],
  "returnTypeIdsPresent"
> & { returnTypeIdsPresent: number };
type SqlMemberAssociationRow = Omit<
  UmlDiagramGraph["memberAssociations"][number],
  "inherited"
> & { inherited: number };
type SqlCategoryRow = Omit<
  UmlDiagramGraph["categories"][number],
  "isTest"
> & { isTest: number };
type CacheStatements = {
  selectRawActiveGeneration: Statement<MetaRow, []>;
  selectActiveGeneration: Statement<ActiveGenerationRow, []>;
  deleteActivePointer: Statement<never, []>;
  deleteGotoDefsExceptGeneration: Statement<never, [number]>;
  deleteAllGotoDefs: Statement<never, []>;
  deleteFilesExceptGeneration: Statement<never, [number]>;
  deleteGenerationsExcept: Statement<never, [number]>;
  deleteAllFiles: Statement<never, []>;
  deleteAllGenerations: Statement<never, []>;
  insertGeneration: Statement<never, ["startup" | "watch", number]>;
  upsertPackages: Statement<never, [number, string]>;
  upsertTreeEntry: Statement<
    never,
    [number, string, string, string, "directory" | "file", number]
  >;
  upsertDiagram: Statement<
    never,
    [number, CacheDiagramResponse["kind"], string, string]
  >;
  upsertFile: Statement<
    never,
    [number, string, string | null, string | null, string | null, string | null]
  >;
  deleteScopeGotoDefs: Statement<never, [number, string]>;
  insertGotoDefinition: Statement<
    never,
    [
      number,
      string,
      GotoDefinitionKind,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      string,
      string,
      string | null,
      number | null,
    ]
  >;
  selectTreeEntries: Statement<TreeRow, [number]>;
  selectPackages: Statement<PackageRow, [number]>;
  selectDiagram: Statement<DiagramRow, [number, CacheDiagramResponse["kind"], string]>;
  selectFile: Statement<FileRow, [number, string]>;
  selectDefinition: Statement<GotoDefinitionRow, [number, string, number, number]>;
  selectDefinitions: Statement<GotoDefinitionRow, [number, string]>;
  selectIndexedSearchCandidates: Statement<SearchCandidateRow, [number, string]>;
  selectScanSearchCandidates: Statement<SearchCandidateRow, [number]>;
  selectIndexedDefinitionCandidates: Statement<GotoDefinitionRow, [number, string, string]>;
  selectScanDefinitionCandidates: Statement<GotoDefinitionRow, [number]>;
  markGenerationActive: Statement<never, [number, number]>;
  upsertActivePointer: Statement<never, [string]>;
  deleteGenerationFiles: Statement<never, [number]>;
  deleteGenerationGotoDefs: Statement<never, [number]>;
  deleteInactiveGeneration: Statement<never, [number]>;
  markGenerationFailed: Statement<never, [number, number]>;
  optimizeSearch: Statement<never, []>;
  optimizeGotoDefinitionSearch: Statement<never, []>;
};

type ImmediateTransaction<Args extends unknown[], Result = void> = {
  immediate(...args: Args): Result;
};

type CacheSchemaObject = {
  readonly name: string;
  readonly kind: "table" | "trigger";
  readonly createSql: string;
};

const CACHE_SCHEMA_OBJECTS = [
  {
    name: "cache_meta",
    kind: "table",
    createSql: `CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  },
  {
    name: "generations",
    kind: "table",
    createSql: `CREATE TABLE generations (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('building', 'active', 'failed')),
      cause TEXT NOT NULL CHECK (cause IN ('startup', 'watch')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
  },
  {
    name: "package_snapshots",
    kind: "table",
    createSql: `CREATE TABLE package_snapshots (
      generation_id INTEGER PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
      packages_json TEXT NOT NULL
    )`,
  },
  {
    name: "tree_entries",
    kind: "table",
    createSql: `CREATE TABLE tree_entries (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
      viewable INTEGER NOT NULL,
      PRIMARY KEY (generation_id, path)
    )`,
  },
  {
    name: "diagram_graphs",
    kind: "table",
    createSql: `CREATE TABLE diagram_graphs (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('packages', 'uml')),
      scope_path TEXT NOT NULL,
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      render_mode TEXT NOT NULL CHECK (render_mode IN ('normal', 'bare')),
      PRIMARY KEY (generation_id, kind, scope_path),
      CHECK ((kind = 'packages' AND scope_path = '') OR kind = 'uml')
    )`,
  },
  {
    name: "diagram_nodes",
    kind: "table",
    createSql: `CREATE TABLE diagram_nodes (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_ordinal INTEGER NOT NULL CHECK (node_ordinal >= 0),
      node_kind TEXT NOT NULL CHECK (
        node_kind IN ('package', 'placeholder', 'entity', 'boundary', 'local-user', 'external-user')
      ),
      name TEXT NOT NULL,
      community INTEGER CHECK (community >= 0),
      PRIMARY KEY (generation_id, kind, scope_path, node_id),
      UNIQUE (generation_id, kind, scope_path, node_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE,
      CHECK (
        (node_kind IN ('package', 'placeholder') AND community IS NULL)
        OR
        (node_kind IN ('entity', 'boundary', 'local-user', 'external-user')
          AND community IS NOT NULL)
      )
    )`,
  },
  {
    name: "diagram_node_aliases",
    kind: "table",
    createSql: `CREATE TABLE diagram_node_aliases (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      alias_ordinal INTEGER NOT NULL CHECK (alias_ordinal >= 0),
      alias TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, node_id, alias_ordinal),
      UNIQUE (generation_id, kind, scope_path, alias),
      FOREIGN KEY (generation_id, kind, scope_path, node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "diagram_edges",
    kind: "table",
    createSql: `CREATE TABLE diagram_edges (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_path TEXT NOT NULL,
      edge_ordinal INTEGER NOT NULL CHECK (edge_ordinal >= 0),
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      edge_kind TEXT NOT NULL CHECK (edge_kind IN ('package-dependency', 'uml-relation')),
      directed INTEGER NOT NULL CHECK (directed IN (0, 1)),
      weight INTEGER NOT NULL CHECK (weight > 0),
      PRIMARY KEY (generation_id, kind, scope_path, edge_ordinal),
      UNIQUE (
        generation_id,
        kind,
        scope_path,
        edge_kind,
        source_node_id,
        target_node_id
      ),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE,
      FOREIGN KEY (generation_id, kind, scope_path, source_node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id, kind, scope_path, target_node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "diagram_edge_relations",
    kind: "table",
    createSql: `CREATE TABLE diagram_edge_relations (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_path TEXT NOT NULL,
      edge_ordinal INTEGER NOT NULL CHECK (edge_ordinal >= 0),
      relation_ordinal INTEGER NOT NULL CHECK (relation_ordinal >= 0),
      relation_kind TEXT NOT NULL CHECK (
        relation_kind IN (
          'package-dependency',
          'heritage',
          'member-association',
          'method-return',
          'usage',
          'local-user',
          'external-user'
        )
      ),
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        edge_ordinal,
        relation_ordinal
      ),
      FOREIGN KEY (generation_id, kind, scope_path, edge_ordinal)
        REFERENCES diagram_edges(generation_id, kind, scope_path, edge_ordinal)
        ON DELETE CASCADE,
      FOREIGN KEY (generation_id, kind, scope_path, source_node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id, kind, scope_path, target_node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "package_graph_nodes",
    kind: "table",
    createSql: `CREATE TABLE package_graph_nodes (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'packages'),
      scope_path TEXT NOT NULL CHECK (scope_path = ''),
      node_id TEXT NOT NULL,
      package_path TEXT,
      PRIMARY KEY (generation_id, kind, scope_path, node_id),
      FOREIGN KEY (generation_id, kind, scope_path, node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_settings",
    kind: "table",
    createSql: `CREATE TABLE uml_settings (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      glob TEXT NOT NULL,
      tsconfig TEXT,
      out_file TEXT NOT NULL,
      property_types INTEGER NOT NULL CHECK (property_types IN (0, 1)),
      modifiers INTEGER NOT NULL CHECK (modifiers IN (0, 1)),
      type_links INTEGER NOT NULL CHECK (type_links IN (0, 1)),
      out_dsl TEXT NOT NULL,
      out_mermaid_dsl TEXT NOT NULL,
      member_associations INTEGER NOT NULL CHECK (member_associations IN (0, 1)),
      exported_types_only INTEGER NOT NULL CHECK (exported_types_only IN (0, 1)),
      PRIMARY KEY (generation_id, kind, scope_path),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_setting_lines",
    kind: "table",
    createSql: `CREATE TABLE uml_setting_lines (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      setting_kind TEXT NOT NULL CHECK (setting_kind IN ('nomnoml', 'mermaid')),
      line_ordinal INTEGER NOT NULL CHECK (line_ordinal >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, setting_kind, line_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES uml_settings(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_declarations",
    kind: "table",
    createSql: `CREATE TABLE uml_declarations (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      file_name TEXT NOT NULL,
      member_associations_present INTEGER NOT NULL CHECK (member_associations_present IN (0, 1)),
      PRIMARY KEY (generation_id, kind, scope_path, declaration_ordinal),
      UNIQUE (generation_id, kind, scope_path, file_name),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_entities",
    kind: "table",
    createSql: `CREATE TABLE uml_entities (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'enum', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      node_id TEXT NOT NULL,
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ),
      FOREIGN KEY (generation_id, kind, scope_path, declaration_ordinal)
        REFERENCES uml_declarations(generation_id, kind, scope_path, declaration_ordinal)
        ON DELETE CASCADE,
      FOREIGN KEY (generation_id, kind, scope_path, node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_properties",
    kind: "table",
    createSql: `CREATE TABLE uml_properties (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'enum', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      property_ordinal INTEGER NOT NULL CHECK (property_ordinal >= 0),
      modifier_flags INTEGER NOT NULL CHECK (modifier_flags >= 0),
      name TEXT NOT NULL,
      type TEXT,
      optional INTEGER NOT NULL CHECK (optional IN (0, 1)),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        property_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) REFERENCES uml_entities(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_property_type_ids",
    kind: "table",
    createSql: `CREATE TABLE uml_property_type_ids (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'enum', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      property_ordinal INTEGER NOT NULL CHECK (property_ordinal >= 0),
      type_id_ordinal INTEGER NOT NULL CHECK (type_id_ordinal >= 0),
      type_id TEXT NOT NULL,
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        property_ordinal,
        type_id_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        property_ordinal
      ) REFERENCES uml_properties(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        property_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_methods",
    kind: "table",
    createSql: `CREATE TABLE uml_methods (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'enum', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      method_ordinal INTEGER NOT NULL CHECK (method_ordinal >= 0),
      modifier_flags INTEGER NOT NULL CHECK (modifier_flags >= 0),
      name TEXT NOT NULL,
      return_type TEXT,
      return_type_ids_present INTEGER NOT NULL CHECK (return_type_ids_present IN (0, 1)),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        method_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) REFERENCES uml_entities(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_method_return_type_ids",
    kind: "table",
    createSql: `CREATE TABLE uml_method_return_type_ids (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'enum', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      method_ordinal INTEGER NOT NULL CHECK (method_ordinal >= 0),
      type_id_ordinal INTEGER NOT NULL CHECK (type_id_ordinal >= 0),
      type_id TEXT NOT NULL,
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        method_ordinal,
        type_id_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        method_ordinal
      ) REFERENCES uml_methods(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        method_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_enum_items",
    kind: "table",
    createSql: `CREATE TABLE uml_enum_items (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind = 'enum'),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      item_ordinal INTEGER NOT NULL CHECK (item_ordinal >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        item_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) REFERENCES uml_entities(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_entity_heritage_clauses",
    kind: "table",
    createSql: `CREATE TABLE uml_entity_heritage_clauses (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
      clause TEXT NOT NULL,
      clause_type_id TEXT NOT NULL,
      class_name TEXT NOT NULL,
      class_type_id TEXT NOT NULL,
      clause_type INTEGER NOT NULL CHECK (clause_type IN (0, 1)),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal,
        clause_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) REFERENCES uml_entities(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_declaration_heritage_groups",
    kind: "table",
    createSql: `CREATE TABLE uml_declaration_heritage_groups (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      group_ordinal INTEGER NOT NULL CHECK (group_ordinal >= 0),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('class', 'interface', 'type')),
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        group_ordinal
      ),
      UNIQUE (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) REFERENCES uml_entities(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        entity_kind,
        entity_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_declaration_heritage_clauses",
    kind: "table",
    createSql: `CREATE TABLE uml_declaration_heritage_clauses (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      group_ordinal INTEGER NOT NULL CHECK (group_ordinal >= 0),
      clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
      clause TEXT NOT NULL,
      clause_type_id TEXT NOT NULL,
      class_name TEXT NOT NULL,
      class_type_id TEXT NOT NULL,
      clause_type INTEGER NOT NULL CHECK (clause_type IN (0, 1)),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        group_ordinal,
        clause_ordinal
      ),
      FOREIGN KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        group_ordinal
      ) REFERENCES uml_declaration_heritage_groups(
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        group_ordinal
      ) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_member_associations",
    kind: "table",
    createSql: `CREATE TABLE uml_member_associations (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      declaration_ordinal INTEGER NOT NULL CHECK (declaration_ordinal >= 0),
      association_ordinal INTEGER NOT NULL CHECK (association_ordinal >= 0),
      a_type_id TEXT NOT NULL,
      a_name TEXT NOT NULL,
      a_multiplicity TEXT CHECK (a_multiplicity = '0..*'),
      b_type_id TEXT NOT NULL,
      b_name TEXT NOT NULL,
      b_multiplicity TEXT CHECK (b_multiplicity = '0..*'),
      association_type INTEGER NOT NULL CHECK (association_type = 0),
      inherited INTEGER NOT NULL CHECK (inherited IN (0, 1)),
      PRIMARY KEY (
        generation_id,
        kind,
        scope_path,
        declaration_ordinal,
        association_ordinal
      ),
      FOREIGN KEY (generation_id, kind, scope_path, declaration_ordinal)
        REFERENCES uml_declarations(generation_id, kind, scope_path, declaration_ordinal)
        ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_categories",
    kind: "table",
    createSql: `CREATE TABLE uml_categories (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      category_ordinal INTEGER NOT NULL CHECK (category_ordinal >= 0),
      entity_name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('interface', 'type', 'enum', 'abstract', 'concrete')
      ),
      is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
      PRIMARY KEY (generation_id, kind, scope_path, category_ordinal),
      UNIQUE (generation_id, kind, scope_path, entity_name),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_method_return_dependencies",
    kind: "table",
    createSql: `CREATE TABLE uml_method_return_dependencies (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      dependency_ordinal INTEGER NOT NULL CHECK (dependency_ordinal >= 0),
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, dependency_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_usage_edges",
    kind: "table",
    createSql: `CREATE TABLE uml_usage_edges (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      dependency_ordinal INTEGER NOT NULL CHECK (dependency_ordinal >= 0),
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, dependency_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_local_users",
    kind: "table",
    createSql: `CREATE TABLE uml_local_users (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      user_ordinal INTEGER NOT NULL CHECK (user_ordinal >= 0),
      node_id TEXT NOT NULL,
      navigation_node_id TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER NOT NULL CHECK (line > 0),
      column INTEGER NOT NULL CHECK (column > 0),
      user_kind TEXT NOT NULL CHECK (
        user_kind IN ('method', 'constructor', 'property', 'class', 'function', 'variable', 'type', 'export')
      ),
      owner_entity_id TEXT,
      PRIMARY KEY (generation_id, kind, scope_path, user_ordinal),
      UNIQUE (generation_id, kind, scope_path, node_id),
      UNIQUE (generation_id, kind, scope_path, navigation_node_id),
      FOREIGN KEY (generation_id, kind, scope_path, node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_external_users",
    kind: "table",
    createSql: `CREATE TABLE uml_external_users (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      user_ordinal INTEGER NOT NULL CHECK (user_ordinal >= 0),
      node_id TEXT NOT NULL,
      navigation_node_id TEXT NOT NULL,
      label TEXT NOT NULL,
      user_scope_path TEXT NOT NULL,
      user_kind TEXT NOT NULL CHECK (
        user_kind IN ('method', 'constructor', 'property', 'class', 'function', 'variable', 'type', 'export')
      ),
      PRIMARY KEY (generation_id, kind, scope_path, user_ordinal),
      UNIQUE (generation_id, kind, scope_path, node_id),
      UNIQUE (generation_id, kind, scope_path, navigation_node_id),
      FOREIGN KEY (generation_id, kind, scope_path, node_id)
        REFERENCES diagram_nodes(generation_id, kind, scope_path, node_id) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_local_user_targets",
    kind: "table",
    createSql: `CREATE TABLE uml_local_user_targets (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      user_ordinal INTEGER NOT NULL CHECK (user_ordinal >= 0),
      target_ordinal INTEGER NOT NULL CHECK (target_ordinal >= 0),
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, user_ordinal, target_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path, user_ordinal)
        REFERENCES uml_local_users(generation_id, kind, scope_path, user_ordinal)
        ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_external_user_targets",
    kind: "table",
    createSql: `CREATE TABLE uml_external_user_targets (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      user_ordinal INTEGER NOT NULL CHECK (user_ordinal >= 0),
      target_ordinal INTEGER NOT NULL CHECK (target_ordinal >= 0),
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, user_ordinal, target_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path, user_ordinal)
        REFERENCES uml_external_users(generation_id, kind, scope_path, user_ordinal)
        ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_definitions",
    kind: "table",
    createSql: `CREATE TABLE uml_definitions (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      definition_ordinal INTEGER NOT NULL CHECK (definition_ordinal >= 0),
      definition_key TEXT NOT NULL,
      definition_kind TEXT NOT NULL CHECK (
        definition_kind IN ('class', 'interface', 'enum', 'type', 'method')
      ),
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_line INTEGER NOT NULL CHECK (source_line > 0),
      source_column INTEGER NOT NULL CHECK (source_column > 0),
      uml_scope_path TEXT NOT NULL,
      uml_entity_name TEXT NOT NULL,
      uml_member_name TEXT,
      uml_member_occurrence INTEGER,
      PRIMARY KEY (generation_id, kind, scope_path, definition_ordinal),
      UNIQUE (generation_id, kind, scope_path, source_path, definition_key),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE,
      CHECK (
        (definition_kind = 'method'
          AND uml_member_name IS NOT NULL
          AND uml_member_occurrence IS NOT NULL
          AND uml_member_occurrence >= 0)
        OR
        (definition_kind <> 'method'
          AND uml_member_name IS NULL
          AND uml_member_occurrence IS NULL)
      )
    )`,
  },
  {
    name: "diagrams",
    kind: "table",
    createSql: `CREATE TABLE diagrams (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_path TEXT NOT NULL,
      response_json TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
    )`,
  },
  {
    name: "files",
    kind: "table",
    createSql: `CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      raw_content TEXT,
      display_content TEXT,
      source_error TEXT,
      format_error TEXT,
      UNIQUE (generation_id, path)
    )`,
  },
  {
    name: "file_search",
    kind: "table",
    createSql: `CREATE VIRTUAL TABLE file_search USING fts5(
      raw_content,
      content='files',
      content_rowid='id',
      tokenize='trigram'
    )`,
  },
  {
    name: "files_ai",
    kind: "trigger",
    createSql: `CREATE TRIGGER files_ai AFTER INSERT ON files
    WHEN NEW.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(rowid, raw_content) VALUES (NEW.id, NEW.raw_content);
    END`,
  },
  {
    name: "files_bd",
    kind: "trigger",
    createSql: `CREATE TRIGGER files_bd BEFORE DELETE ON files
    WHEN OLD.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(file_search, rowid, raw_content)
      VALUES ('delete', OLD.id, OLD.raw_content);
    END`,
  },
  {
    name: "files_bu",
    kind: "trigger",
    createSql: `CREATE TRIGGER files_bu BEFORE UPDATE OF raw_content ON files
    WHEN OLD.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(file_search, rowid, raw_content)
      VALUES ('delete', OLD.id, OLD.raw_content);
    END`,
  },
  {
    name: "files_au",
    kind: "trigger",
    createSql: `CREATE TRIGGER files_au AFTER UPDATE OF raw_content ON files
    WHEN NEW.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(rowid, raw_content) VALUES (NEW.id, NEW.raw_content);
    END`,
  },
  {
    name: "GotoDef",
    kind: "table",
    createSql: `CREATE TABLE GotoDef (
      id INTEGER PRIMARY KEY,
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      definition_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('class','interface','enum','type','method')),
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_line INTEGER NOT NULL CHECK (source_line > 0),
      source_column INTEGER NOT NULL CHECK (source_column > 0),
      display_from INTEGER NOT NULL CHECK (display_from >= 0),
      display_to INTEGER NOT NULL CHECK (display_to > display_from),
      uml_scope_path TEXT NOT NULL,
      uml_entity_name TEXT NOT NULL,
      uml_member_name TEXT,
      uml_member_occurrence INTEGER,
      UNIQUE(generation_id, source_path, definition_key),
      CHECK (
        (kind = 'method' AND uml_member_name IS NOT NULL AND uml_member_occurrence IS NOT NULL
          AND uml_member_occurrence >= 0)
        OR
        (kind <> 'method' AND uml_member_name IS NULL AND uml_member_occurrence IS NULL)
      )
    )`,
  },
  {
    name: "goto_def_search",
    kind: "table",
    createSql: `CREATE VIRTUAL TABLE goto_def_search USING fts5(
      name,
      qualified_name,
      content='GotoDef',
      content_rowid='id',
      tokenize='trigram'
    )`,
  },
  {
    name: "goto_def_ai",
    kind: "trigger",
    createSql: `CREATE TRIGGER goto_def_ai AFTER INSERT ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(rowid, name, qualified_name)
      VALUES (NEW.id, NEW.name, NEW.qualified_name);
    END`,
  },
  {
    name: "goto_def_bd",
    kind: "trigger",
    createSql: `CREATE TRIGGER goto_def_bd BEFORE DELETE ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(goto_def_search, rowid, name, qualified_name)
      VALUES ('delete', OLD.id, OLD.name, OLD.qualified_name);
    END`,
  },
  {
    name: "goto_def_bu",
    kind: "trigger",
    createSql: `CREATE TRIGGER goto_def_bu BEFORE UPDATE OF name, qualified_name ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(goto_def_search, rowid, name, qualified_name)
      VALUES ('delete', OLD.id, OLD.name, OLD.qualified_name);
    END`,
  },
  {
    name: "goto_def_au",
    kind: "trigger",
    createSql: `CREATE TRIGGER goto_def_au AFTER UPDATE OF name, qualified_name ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(rowid, name, qualified_name)
      VALUES (NEW.id, NEW.name, NEW.qualified_name);
    END`,
  },
] as const satisfies readonly CacheSchemaObject[];

type CacheSchemaObjectDefinition = (typeof CACHE_SCHEMA_OBJECTS)[number];
type CacheSchemaObjectName = CacheSchemaObjectDefinition["name"];
type CacheTableName = Extract<
  CacheSchemaObjectDefinition,
  { readonly kind: "table" }
>["name"];

const CACHE_SCHEMA_BY_NAME = new Map<
  CacheSchemaObjectName,
  CacheSchemaObjectDefinition
>(
  CACHE_SCHEMA_OBJECTS.map((definition) => [definition.name, definition] as const),
);

const CACHE_TABLE_BY_LOWER_NAME = new Map<string, CacheTableName>(
  CACHE_SCHEMA_OBJECTS.flatMap((definition) =>
    definition.kind === "table"
      ? [[definition.name.toLowerCase(), definition.name] as const]
      : []
  ),
);

const CACHE_TABLE_RECOVERY_GROUPS = {
  files: ["files", "file_search", "files_ai", "files_bd", "files_bu", "files_au"],
  GotoDef: [
    "GotoDef",
    "goto_def_search",
    "goto_def_ai",
    "goto_def_bd",
    "goto_def_bu",
    "goto_def_au",
  ],
} as const satisfies Partial<
  Record<CacheTableName, readonly CacheSchemaObjectName[]>
>;

function cacheTableFromSchemaError(error: unknown): CacheTableName | null {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const match =
      /\bno such table:\s*(?:(?:main|temp)\.)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        current.message,
      )
      ?? /\btable\s+(?:(?:main|temp)\.)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+has no column named\b/i.exec(
        current.message,
      );
    const table = match?.[1]
      ? CACHE_TABLE_BY_LOWER_NAME.get(match[1].toLowerCase())
      : undefined;
    if (table) return table;
    current = current.cause;
  }
  return null;
}

function parentPath(path: string): string {
  if (!path) return "";
  const parent = posix.dirname(path);
  return parent === "." ? "" : parent;
}

function parseJson<T>(json: string, description: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new Error(`invalid cached ${description}`, { cause: error });
  }
}

function hasAtLeastThreeCodePoints(value: string): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count === 3) return true;
  }
  return false;
}

function includesSearch(
  candidate: string,
  comparisonQuery: string,
  caseInsensitive: boolean,
): boolean {
  return (caseInsensitive ? candidate.toLowerCase() : candidate).includes(comparisonQuery);
}

function toGotoDefinition(row: GotoDefinitionRow): GotoDefinition {
  const uml: GotoDefinition["uml"] = {
    scopePath: row.uml_scope_path,
    entityName: row.uml_entity_name,
  };
  if (row.uml_member_name !== null && row.uml_member_occurrence !== null) {
    uml.memberName = row.uml_member_name;
    uml.memberOccurrence = row.uml_member_occurrence;
  }
  return {
    key: row.definition_key,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    source: {
      path: row.source_path,
      line: row.source_line,
      column: row.source_column,
    },
    uml,
  };
}

function toEditorGotoDefinition(row: GotoDefinitionRow): EditorGotoDefinition {
  return {
    ...toGotoDefinition(row),
    displayFrom: row.display_from,
    displayTo: row.display_to,
  };
}

type PreparedGraphStore = {
  statements: Array<{ finalize(): void }>;
  deleteGraph(generationId: number, kind: DiagramKind, scopePath: string): void;
  insertGraph(generationId: number, graph: DiagramGraph): void;
  readGraph(generationId: number, kind: DiagramKind, scopePath: string): DiagramGraph | null;
};

function sqliteBoolean(value: unknown, description: string): number {
  if (typeof value !== "boolean") {
    throw invalidMaterialization(`invalid ${description}`);
  }
  return value ? 1 : 0;
}

function prepareGraphStore(db: Database): PreparedGraphStore {
  const deleteGraphHeader = db.query<never, GraphIdentity>(`
    DELETE FROM diagram_graphs
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
  `);
  const insertGraphHeader = db.query<
    never,
    [number, DiagramKind, string, number, "normal" | "bare"]
  >(`
    INSERT INTO diagram_graphs(
      generation_id, kind, scope_path, format_version, render_mode
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertNode = db.query<
    never,
    [
      number,
      DiagramKind,
      string,
      string,
      number,
      DiagramGraph["nodes"][number]["nodeKind"],
      string,
      number | null,
    ]
  >(`
    INSERT INTO diagram_nodes(
      generation_id, kind, scope_path, node_id, node_ordinal, node_kind, name, community
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.query<
    never,
    [number, DiagramKind, string, string, number, string]
  >(`
    INSERT INTO diagram_node_aliases(
      generation_id, kind, scope_path, node_id, alias_ordinal, alias
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.query<
    never,
    [
      number,
      DiagramKind,
      string,
      number,
      string,
      string,
      DiagramGraph["edges"][number]["edgeKind"],
      number,
      number,
    ]
  >(`
    INSERT INTO diagram_edges(
      generation_id, kind, scope_path, edge_ordinal, source_node_id,
      target_node_id, edge_kind, directed, weight
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRelation = db.query<
    never,
    [
      number,
      DiagramKind,
      string,
      number,
      number,
      DiagramGraph["relations"][number]["relationKind"],
      string,
      string,
    ]
  >(`
    INSERT INTO diagram_edge_relations(
      generation_id, kind, scope_path, edge_ordinal, relation_ordinal,
      relation_kind, source_node_id, target_node_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPackageNode = db.query<
    never,
    [number, "packages", string, string, string | null]
  >(`
    INSERT INTO package_graph_nodes(
      generation_id, kind, scope_path, node_id, package_path
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertUmlSettings = db.query<
    never,
    [
      number,
      "uml",
      string,
      string,
      string | null,
      string,
      number,
      number,
      number,
      string,
      string,
      number,
      number,
    ]
  >(`
    INSERT INTO uml_settings(
      generation_id, kind, scope_path, glob, tsconfig, out_file, property_types,
      modifiers, type_links, out_dsl, out_mermaid_dsl, member_associations,
      exported_types_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlSettingLine = db.query<
    never,
    [
      number,
      "uml",
      string,
      UmlDiagramGraph["settingLines"][number]["settingKind"],
      number,
      string,
    ]
  >(`
    INSERT INTO uml_setting_lines(
      generation_id, kind, scope_path, setting_kind, line_ordinal, value
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertUmlDeclaration = db.query<
    never,
    [number, "uml", string, number, string, number]
  >(`
    INSERT INTO uml_declarations(
      generation_id, kind, scope_path, declaration_ordinal, file_name,
      member_associations_present
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertUmlEntity = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["entities"][number]["entityKind"],
      number,
      string,
    ]
  >(`
    INSERT INTO uml_entities(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, node_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlProperty = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["properties"][number]["entityKind"],
      number,
      number,
      number,
      string,
      string | null,
      number,
    ]
  >(`
    INSERT INTO uml_properties(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, property_ordinal, modifier_flags, name, type, optional
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlPropertyTypeId = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["propertyTypeIds"][number]["entityKind"],
      number,
      number,
      number,
      string,
    ]
  >(`
    INSERT INTO uml_property_type_ids(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, property_ordinal, type_id_ordinal, type_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMethod = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["methods"][number]["entityKind"],
      number,
      number,
      number,
      string,
      string | null,
      number,
    ]
  >(`
    INSERT INTO uml_methods(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, method_ordinal, modifier_flags, name, return_type,
      return_type_ids_present
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMethodReturnTypeId = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["methodReturnTypeIds"][number]["entityKind"],
      number,
      number,
      number,
      string,
    ]
  >(`
    INSERT INTO uml_method_return_type_ids(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, method_ordinal, type_id_ordinal, type_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlEnumItem = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["enumItems"][number]["entityKind"],
      number,
      number,
      string,
    ]
  >(`
    INSERT INTO uml_enum_items(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, item_ordinal, value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlEntityHeritage = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["entityHeritageClauses"][number]["entityKind"],
      number,
      number,
      string,
      string,
      string,
      string,
      number,
    ]
  >(`
    INSERT INTO uml_entity_heritage_clauses(
      generation_id, kind, scope_path, declaration_ordinal, entity_kind,
      entity_ordinal, clause_ordinal, clause, clause_type_id, class_name,
      class_type_id, clause_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlDeclarationHeritageGroup = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      number,
      UmlDiagramGraph["declarationHeritageGroups"][number]["entityKind"],
      number,
    ]
  >(`
    INSERT INTO uml_declaration_heritage_groups(
      generation_id, kind, scope_path, declaration_ordinal, group_ordinal,
      entity_kind, entity_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlDeclarationHeritageClause = db.query<
    never,
    [number, "uml", string, number, number, number, string, string, string, string, number]
  >(`
    INSERT INTO uml_declaration_heritage_clauses(
      generation_id, kind, scope_path, declaration_ordinal, group_ordinal,
      clause_ordinal, clause, clause_type_id, class_name, class_type_id, clause_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMemberAssociation = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      number,
      string,
      string,
      "0..*" | null,
      string,
      string,
      "0..*" | null,
      number,
      number,
    ]
  >(`
    INSERT INTO uml_member_associations(
      generation_id, kind, scope_path, declaration_ordinal, association_ordinal,
      a_type_id, a_name, a_multiplicity, b_type_id, b_name, b_multiplicity,
      association_type, inherited
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlCategory = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      string,
      UmlDiagramGraph["categories"][number]["category"],
      number,
    ]
  >(`
    INSERT INTO uml_categories(
      generation_id, kind, scope_path, category_ordinal, entity_name, category, is_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMethodReturnDependency = db.query<
    never,
    [number, "uml", string, number, string, string, string, string]
  >(`
    INSERT INTO uml_method_return_dependencies(
      generation_id, kind, scope_path, dependency_ordinal, source_id,
      source_name, target_id, target_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlUsageEdge = db.query<
    never,
    [number, "uml", string, number, string, string, string, string]
  >(`
    INSERT INTO uml_usage_edges(
      generation_id, kind, scope_path, dependency_ordinal, source_id,
      source_name, target_id, target_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlLocalUser = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      string,
      string,
      string,
      string,
      number,
      number,
      UmlDiagramGraph["localUsers"][number]["userKind"],
      string | null,
    ]
  >(`
    INSERT INTO uml_local_users(
      generation_id, kind, scope_path, user_ordinal, node_id, navigation_node_id,
      label, path, line, column, user_kind, owner_entity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlExternalUser = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      string,
      string,
      string,
      string,
      UmlDiagramGraph["externalUsers"][number]["userKind"],
    ]
  >(`
    INSERT INTO uml_external_users(
      generation_id, kind, scope_path, user_ordinal, node_id, navigation_node_id,
      label, user_scope_path, user_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlLocalUserTarget = db.query<
    never,
    [number, "uml", string, number, number, string, string]
  >(`
    INSERT INTO uml_local_user_targets(
      generation_id, kind, scope_path, user_ordinal, target_ordinal, target_id, target_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlExternalUserTarget = db.query<
    never,
    [number, "uml", string, number, number, string, string]
  >(`
    INSERT INTO uml_external_user_targets(
      generation_id, kind, scope_path, user_ordinal, target_ordinal, target_id, target_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlDefinition = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      string,
      GotoDefinitionKind,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      string | null,
      number | null,
    ]
  >(`
    INSERT INTO uml_definitions(
      generation_id, kind, scope_path, definition_ordinal, definition_key,
      definition_kind, name, qualified_name, source_path, source_line,
      source_column, uml_scope_path, uml_entity_name, uml_member_name,
      uml_member_occurrence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectGraphHeader = db.query<GraphHeaderRow, GraphIdentity>(`
    SELECT
      kind,
      scope_path AS scopePath,
      format_version AS formatVersion,
      render_mode AS renderMode
    FROM diagram_graphs
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
  `);
  const selectNodes = db.query<DiagramGraph["nodes"][number], GraphIdentity>(`
    SELECT
      node_id AS nodeId,
      node_ordinal AS nodeOrdinal,
      node_kind AS nodeKind,
      name,
      community
    FROM diagram_nodes
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY node_ordinal
  `);
  const selectAliases = db.query<DiagramGraph["aliases"][number], GraphIdentity>(`
    SELECT
      aliases.node_id AS nodeId,
      aliases.alias_ordinal AS aliasOrdinal,
      aliases.alias
    FROM diagram_node_aliases AS aliases
    JOIN diagram_nodes AS nodes
      ON nodes.generation_id = aliases.generation_id
      AND nodes.kind = aliases.kind
      AND nodes.scope_path = aliases.scope_path
      AND nodes.node_id = aliases.node_id
    WHERE aliases.generation_id = ? AND aliases.kind = ? AND aliases.scope_path = ?
    ORDER BY nodes.node_ordinal, aliases.alias_ordinal
  `);
  const selectEdges = db.query<SqlEdgeRow, GraphIdentity>(`
    SELECT
      edge_ordinal AS edgeOrdinal,
      source_node_id AS sourceNodeId,
      target_node_id AS targetNodeId,
      edge_kind AS edgeKind,
      directed,
      weight
    FROM diagram_edges
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY edge_ordinal
  `);
  const selectRelations = db.query<DiagramGraph["relations"][number], GraphIdentity>(`
    SELECT
      edge_ordinal AS edgeOrdinal,
      relation_ordinal AS relationOrdinal,
      relation_kind AS relationKind,
      source_node_id AS sourceNodeId,
      target_node_id AS targetNodeId
    FROM diagram_edge_relations
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY edge_ordinal, relation_ordinal
  `);
  const selectPackageNodes = db.query<
    PackageDiagramGraph["packageNodes"][number],
    GraphIdentity
  >(`
    SELECT packages.node_id AS nodeId, packages.package_path AS packagePath
    FROM package_graph_nodes AS packages
    JOIN diagram_nodes AS nodes
      ON nodes.generation_id = packages.generation_id
      AND nodes.kind = packages.kind
      AND nodes.scope_path = packages.scope_path
      AND nodes.node_id = packages.node_id
    WHERE packages.generation_id = ? AND packages.kind = ? AND packages.scope_path = ?
    ORDER BY nodes.node_ordinal
  `);
  const selectUmlSettings = db.query<SqlSettingsRow, GraphIdentity>(`
    SELECT
      glob,
      tsconfig,
      out_file AS outFile,
      property_types AS propertyTypes,
      modifiers,
      type_links AS typeLinks,
      out_dsl AS outDsl,
      out_mermaid_dsl AS outMermaidDsl,
      member_associations AS memberAssociations,
      exported_types_only AS exportedTypesOnly
    FROM uml_settings
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
  `);
  const selectUmlSettingLines = db.query<
    UmlDiagramGraph["settingLines"][number],
    GraphIdentity
  >(`
    SELECT setting_kind AS settingKind, line_ordinal AS lineOrdinal, value
    FROM uml_setting_lines
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY CASE setting_kind WHEN 'nomnoml' THEN 0 ELSE 1 END, line_ordinal
  `);
  const selectUmlDeclarations = db.query<SqlDeclarationRow, GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      file_name AS fileName,
      member_associations_present AS memberAssociationsPresent
    FROM uml_declarations
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal
  `);
  const selectUmlEntities = db.query<UmlDiagramGraph["entities"][number], GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      node_id AS nodeId
    FROM uml_entities
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind
        WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'enum' THEN 2 ELSE 3
      END,
      entity_ordinal
  `);
  const selectUmlProperties = db.query<SqlPropertyRow, GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      property_ordinal AS propertyOrdinal,
      modifier_flags AS modifierFlags,
      name,
      type,
      optional
    FROM uml_properties
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind
        WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'enum' THEN 2 ELSE 3
      END,
      entity_ordinal,
      property_ordinal
  `);
  const selectUmlPropertyTypeIds = db.query<
    UmlDiagramGraph["propertyTypeIds"][number],
    GraphIdentity
  >(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      property_ordinal AS propertyOrdinal,
      type_id_ordinal AS typeIdOrdinal,
      type_id AS typeId
    FROM uml_property_type_ids
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind
        WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'enum' THEN 2 ELSE 3
      END,
      entity_ordinal,
      property_ordinal,
      type_id_ordinal
  `);
  const selectUmlMethods = db.query<SqlMethodRow, GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      method_ordinal AS methodOrdinal,
      modifier_flags AS modifierFlags,
      name,
      return_type AS returnType,
      return_type_ids_present AS returnTypeIdsPresent
    FROM uml_methods
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind
        WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'enum' THEN 2 ELSE 3
      END,
      entity_ordinal,
      method_ordinal
  `);
  const selectUmlMethodReturnTypeIds = db.query<
    UmlDiagramGraph["methodReturnTypeIds"][number],
    GraphIdentity
  >(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      method_ordinal AS methodOrdinal,
      type_id_ordinal AS typeIdOrdinal,
      type_id AS typeId
    FROM uml_method_return_type_ids
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind
        WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'enum' THEN 2 ELSE 3
      END,
      entity_ordinal,
      method_ordinal,
      type_id_ordinal
  `);
  const selectUmlEnumItems = db.query<UmlDiagramGraph["enumItems"][number], GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      item_ordinal AS itemOrdinal,
      value
    FROM uml_enum_items
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal, entity_ordinal, item_ordinal
  `);
  const selectUmlEntityHeritage = db.query<
    UmlDiagramGraph["entityHeritageClauses"][number],
    GraphIdentity
  >(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal,
      clause_ordinal AS clauseOrdinal,
      clause,
      clause_type_id AS clauseTypeId,
      class_name AS className,
      class_type_id AS classTypeId,
      clause_type AS clauseType
    FROM uml_entity_heritage_clauses
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal,
      CASE entity_kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 ELSE 2 END,
      entity_ordinal,
      clause_ordinal
  `);
  const selectUmlDeclarationHeritageGroups = db.query<
    UmlDiagramGraph["declarationHeritageGroups"][number],
    GraphIdentity
  >(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      group_ordinal AS groupOrdinal,
      entity_kind AS entityKind,
      entity_ordinal AS entityOrdinal
    FROM uml_declaration_heritage_groups
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal, group_ordinal
  `);
  const selectUmlDeclarationHeritageClauses = db.query<
    UmlDiagramGraph["declarationHeritageClauses"][number],
    GraphIdentity
  >(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      group_ordinal AS groupOrdinal,
      clause_ordinal AS clauseOrdinal,
      clause,
      clause_type_id AS clauseTypeId,
      class_name AS className,
      class_type_id AS classTypeId,
      clause_type AS clauseType
    FROM uml_declaration_heritage_clauses
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal, group_ordinal, clause_ordinal
  `);
  const selectUmlMemberAssociations = db.query<SqlMemberAssociationRow, GraphIdentity>(`
    SELECT
      declaration_ordinal AS declarationOrdinal,
      association_ordinal AS associationOrdinal,
      a_type_id AS aTypeId,
      a_name AS aName,
      a_multiplicity AS aMultiplicity,
      b_type_id AS bTypeId,
      b_name AS bName,
      b_multiplicity AS bMultiplicity,
      association_type AS associationType,
      inherited
    FROM uml_member_associations
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY declaration_ordinal, association_ordinal
  `);
  const selectUmlCategories = db.query<SqlCategoryRow, GraphIdentity>(`
    SELECT
      category_ordinal AS categoryOrdinal,
      entity_name AS entityName,
      category,
      is_test AS isTest
    FROM uml_categories
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY category_ordinal
  `);
  const selectUmlMethodReturnDependencies = db.query<
    UmlDiagramGraph["methodReturnDependencies"][number],
    GraphIdentity
  >(`
    SELECT
      dependency_ordinal AS dependencyOrdinal,
      source_id AS sourceId,
      source_name AS sourceName,
      target_id AS targetId,
      target_name AS targetName
    FROM uml_method_return_dependencies
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY dependency_ordinal
  `);
  const selectUmlUsageEdges = db.query<
    UmlDiagramGraph["usageEdges"][number],
    GraphIdentity
  >(`
    SELECT
      dependency_ordinal AS dependencyOrdinal,
      source_id AS sourceId,
      source_name AS sourceName,
      target_id AS targetId,
      target_name AS targetName
    FROM uml_usage_edges
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY dependency_ordinal
  `);
  const selectUmlLocalUsers = db.query<
    UmlDiagramGraph["localUsers"][number],
    GraphIdentity
  >(`
    SELECT
      user_ordinal AS userOrdinal,
      node_id AS nodeId,
      navigation_node_id AS navigationNodeId,
      label,
      path,
      line,
      column,
      user_kind AS userKind,
      owner_entity_id AS ownerEntityId
    FROM uml_local_users
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY user_ordinal
  `);
  const selectUmlExternalUsers = db.query<
    UmlDiagramGraph["externalUsers"][number],
    GraphIdentity
  >(`
    SELECT
      user_ordinal AS userOrdinal,
      node_id AS nodeId,
      navigation_node_id AS navigationNodeId,
      label,
      user_scope_path AS scopePath,
      user_kind AS userKind
    FROM uml_external_users
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY user_ordinal
  `);
  const selectUmlLocalUserTargets = db.query<
    UmlDiagramGraph["localUserTargets"][number],
    GraphIdentity
  >(`
    SELECT
      user_ordinal AS userOrdinal,
      target_ordinal AS targetOrdinal,
      target_id AS targetId,
      target_name AS targetName
    FROM uml_local_user_targets
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY user_ordinal, target_ordinal
  `);
  const selectUmlExternalUserTargets = db.query<
    UmlDiagramGraph["externalUserTargets"][number],
    GraphIdentity
  >(`
    SELECT
      user_ordinal AS userOrdinal,
      target_ordinal AS targetOrdinal,
      target_id AS targetId,
      target_name AS targetName
    FROM uml_external_user_targets
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY user_ordinal, target_ordinal
  `);
  const selectUmlDefinitions = db.query<
    UmlDiagramGraph["definitions"][number],
    GraphIdentity
  >(`
    SELECT
      definition_ordinal AS definitionOrdinal,
      definition_key AS definitionKey,
      definition_kind AS definitionKind,
      name,
      qualified_name AS qualifiedName,
      source_path AS sourcePath,
      source_line AS sourceLine,
      source_column AS sourceColumn,
      uml_scope_path AS umlScopePath,
      uml_entity_name AS umlEntityName,
      uml_member_name AS umlMemberName,
      uml_member_occurrence AS umlMemberOccurrence
    FROM uml_definitions
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY definition_ordinal
  `);
  const selectPackageRowsPresent = db.query<{ present: number }, GraphIdentity>(`
    WITH identity(generation_id, kind, scope_path) AS (VALUES (?, ?, ?))
    SELECT EXISTS(
      SELECT 1
      FROM package_graph_nodes AS rows
      JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind
        AND identity.scope_path = rows.scope_path
    ) AS present
  `);
  const selectUmlRowsPresent = db.query<{ present: number }, GraphIdentity>(`
    WITH identity(generation_id, kind, scope_path) AS (VALUES (?, ?, ?))
    SELECT (
      EXISTS(SELECT 1 FROM uml_settings AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_setting_lines AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_declarations AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_entities AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_properties AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_property_type_ids AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_methods AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_method_return_type_ids AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_enum_items AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_entity_heritage_clauses AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_declaration_heritage_groups AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_declaration_heritage_clauses AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_member_associations AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_categories AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_method_return_dependencies AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_usage_edges AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_local_users AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_external_users AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_local_user_targets AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_external_user_targets AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_definitions AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
    ) AS present
  `);

  const statements: Array<{ finalize(): void }> = [
    deleteGraphHeader,
    insertGraphHeader,
    insertNode,
    insertAlias,
    insertEdge,
    insertRelation,
    insertPackageNode,
    insertUmlSettings,
    insertUmlSettingLine,
    insertUmlDeclaration,
    insertUmlEntity,
    insertUmlProperty,
    insertUmlPropertyTypeId,
    insertUmlMethod,
    insertUmlMethodReturnTypeId,
    insertUmlEnumItem,
    insertUmlEntityHeritage,
    insertUmlDeclarationHeritageGroup,
    insertUmlDeclarationHeritageClause,
    insertUmlMemberAssociation,
    insertUmlCategory,
    insertUmlMethodReturnDependency,
    insertUmlUsageEdge,
    insertUmlLocalUser,
    insertUmlExternalUser,
    insertUmlLocalUserTarget,
    insertUmlExternalUserTarget,
    insertUmlDefinition,
    selectGraphHeader,
    selectNodes,
    selectAliases,
    selectEdges,
    selectRelations,
    selectPackageNodes,
    selectUmlSettings,
    selectUmlSettingLines,
    selectUmlDeclarations,
    selectUmlEntities,
    selectUmlProperties,
    selectUmlPropertyTypeIds,
    selectUmlMethods,
    selectUmlMethodReturnTypeIds,
    selectUmlEnumItems,
    selectUmlEntityHeritage,
    selectUmlDeclarationHeritageGroups,
    selectUmlDeclarationHeritageClauses,
    selectUmlMemberAssociations,
    selectUmlCategories,
    selectUmlMethodReturnDependencies,
    selectUmlUsageEdges,
    selectUmlLocalUsers,
    selectUmlExternalUsers,
    selectUmlLocalUserTargets,
    selectUmlExternalUserTargets,
    selectUmlDefinitions,
    selectPackageRowsPresent,
    selectUmlRowsPresent,
  ];

  return {
    statements,
    deleteGraph(generationId, kind, scopePath) {
      deleteGraphHeader.run(generationId, kind, scopePath);
    },
    insertGraph(generationId, graph) {
      const identity = [generationId, graph.kind, graph.scopePath] as const;
      insertGraphHeader.run(...identity, graph.formatVersion, graph.renderMode);
      for (const node of graph.nodes) {
        insertNode.run(
          ...identity,
          node.nodeId,
          node.nodeOrdinal,
          node.nodeKind,
          node.name,
          node.community,
        );
      }
      for (const alias of graph.aliases) {
        insertAlias.run(...identity, alias.nodeId, alias.aliasOrdinal, alias.alias);
      }
      for (const edge of graph.edges) {
        insertEdge.run(
          ...identity,
          edge.edgeOrdinal,
          edge.sourceNodeId,
          edge.targetNodeId,
          edge.edgeKind,
          sqliteBoolean(edge.directed, "diagram edge direction"),
          edge.weight,
        );
      }
      for (const relation of graph.relations) {
        insertRelation.run(
          ...identity,
          relation.edgeOrdinal,
          relation.relationOrdinal,
          relation.relationKind,
          relation.sourceNodeId,
          relation.targetNodeId,
        );
      }
      if (graph.kind === "packages") {
        for (const node of graph.packageNodes) {
          insertPackageNode.run(
            generationId,
            graph.kind,
            graph.scopePath,
            node.nodeId,
            node.packagePath,
          );
        }
        return;
      }
      const umlIdentity = [generationId, graph.kind, graph.scopePath] as const;
      if (graph.settings) {
        insertUmlSettings.run(
          ...umlIdentity,
          graph.settings.glob,
          graph.settings.tsconfig,
          graph.settings.outFile,
          sqliteBoolean(graph.settings.propertyTypes, "UML property-types setting"),
          sqliteBoolean(graph.settings.modifiers, "UML modifiers setting"),
          sqliteBoolean(graph.settings.typeLinks, "UML type-links setting"),
          graph.settings.outDsl,
          graph.settings.outMermaidDsl,
          sqliteBoolean(graph.settings.memberAssociations, "UML member-associations setting"),
          sqliteBoolean(graph.settings.exportedTypesOnly, "UML exported-types setting"),
        );
      }
      for (const line of graph.settingLines) {
        insertUmlSettingLine.run(...umlIdentity, line.settingKind, line.lineOrdinal, line.value);
      }
      for (const declaration of graph.declarations) {
        insertUmlDeclaration.run(
          ...umlIdentity,
          declaration.declarationOrdinal,
          declaration.fileName,
          sqliteBoolean(
            declaration.memberAssociationsPresent,
            "UML member-associations presence flag",
          ),
        );
      }
      for (const entity of graph.entities) {
        insertUmlEntity.run(
          ...umlIdentity,
          entity.declarationOrdinal,
          entity.entityKind,
          entity.entityOrdinal,
          entity.nodeId,
        );
      }
      for (const property of graph.properties) {
        insertUmlProperty.run(
          ...umlIdentity,
          property.declarationOrdinal,
          property.entityKind,
          property.entityOrdinal,
          property.propertyOrdinal,
          property.modifierFlags,
          property.name,
          property.type,
          sqliteBoolean(property.optional, "UML property optional flag"),
        );
      }
      for (const typeId of graph.propertyTypeIds) {
        insertUmlPropertyTypeId.run(
          ...umlIdentity,
          typeId.declarationOrdinal,
          typeId.entityKind,
          typeId.entityOrdinal,
          typeId.propertyOrdinal,
          typeId.typeIdOrdinal,
          typeId.typeId,
        );
      }
      for (const method of graph.methods) {
        insertUmlMethod.run(
          ...umlIdentity,
          method.declarationOrdinal,
          method.entityKind,
          method.entityOrdinal,
          method.methodOrdinal,
          method.modifierFlags,
          method.name,
          method.returnType,
          sqliteBoolean(method.returnTypeIdsPresent, "UML return-type-IDs presence flag"),
        );
      }
      for (const typeId of graph.methodReturnTypeIds) {
        insertUmlMethodReturnTypeId.run(
          ...umlIdentity,
          typeId.declarationOrdinal,
          typeId.entityKind,
          typeId.entityOrdinal,
          typeId.methodOrdinal,
          typeId.typeIdOrdinal,
          typeId.typeId,
        );
      }
      for (const item of graph.enumItems) {
        insertUmlEnumItem.run(
          ...umlIdentity,
          item.declarationOrdinal,
          item.entityKind,
          item.entityOrdinal,
          item.itemOrdinal,
          item.value,
        );
      }
      for (const clause of graph.entityHeritageClauses) {
        insertUmlEntityHeritage.run(
          ...umlIdentity,
          clause.declarationOrdinal,
          clause.entityKind,
          clause.entityOrdinal,
          clause.clauseOrdinal,
          clause.clause,
          clause.clauseTypeId,
          clause.className,
          clause.classTypeId,
          clause.clauseType,
        );
      }
      for (const group of graph.declarationHeritageGroups) {
        insertUmlDeclarationHeritageGroup.run(
          ...umlIdentity,
          group.declarationOrdinal,
          group.groupOrdinal,
          group.entityKind,
          group.entityOrdinal,
        );
      }
      for (const clause of graph.declarationHeritageClauses) {
        insertUmlDeclarationHeritageClause.run(
          ...umlIdentity,
          clause.declarationOrdinal,
          clause.groupOrdinal,
          clause.clauseOrdinal,
          clause.clause,
          clause.clauseTypeId,
          clause.className,
          clause.classTypeId,
          clause.clauseType,
        );
      }
      for (const association of graph.memberAssociations) {
        insertUmlMemberAssociation.run(
          ...umlIdentity,
          association.declarationOrdinal,
          association.associationOrdinal,
          association.aTypeId,
          association.aName,
          association.aMultiplicity,
          association.bTypeId,
          association.bName,
          association.bMultiplicity,
          association.associationType,
          sqliteBoolean(association.inherited, "UML association inherited flag"),
        );
      }
      for (const category of graph.categories) {
        insertUmlCategory.run(
          ...umlIdentity,
          category.categoryOrdinal,
          category.entityName,
          category.category,
          sqliteBoolean(category.isTest, "UML category test flag"),
        );
      }
      for (const dependency of graph.methodReturnDependencies) {
        insertUmlMethodReturnDependency.run(
          ...umlIdentity,
          dependency.dependencyOrdinal,
          dependency.sourceId,
          dependency.sourceName,
          dependency.targetId,
          dependency.targetName,
        );
      }
      for (const edge of graph.usageEdges) {
        insertUmlUsageEdge.run(
          ...umlIdentity,
          edge.dependencyOrdinal,
          edge.sourceId,
          edge.sourceName,
          edge.targetId,
          edge.targetName,
        );
      }
      for (const user of graph.localUsers) {
        insertUmlLocalUser.run(
          ...umlIdentity,
          user.userOrdinal,
          user.nodeId,
          user.navigationNodeId,
          user.label,
          user.path,
          user.line,
          user.column,
          user.userKind,
          user.ownerEntityId,
        );
      }
      for (const user of graph.externalUsers) {
        insertUmlExternalUser.run(
          ...umlIdentity,
          user.userOrdinal,
          user.nodeId,
          user.navigationNodeId,
          user.label,
          user.scopePath,
          user.userKind,
        );
      }
      for (const target of graph.localUserTargets) {
        insertUmlLocalUserTarget.run(
          ...umlIdentity,
          target.userOrdinal,
          target.targetOrdinal,
          target.targetId,
          target.targetName,
        );
      }
      for (const target of graph.externalUserTargets) {
        insertUmlExternalUserTarget.run(
          ...umlIdentity,
          target.userOrdinal,
          target.targetOrdinal,
          target.targetId,
          target.targetName,
        );
      }
      for (const definition of graph.definitions) {
        insertUmlDefinition.run(
          ...umlIdentity,
          definition.definitionOrdinal,
          definition.definitionKey,
          definition.definitionKind,
          definition.name,
          definition.qualifiedName,
          definition.sourcePath,
          definition.sourceLine,
          definition.sourceColumn,
          definition.umlScopePath,
          definition.umlEntityName,
          definition.umlMemberName,
          definition.umlMemberOccurrence,
        );
      }
    },
    readGraph(generationId, kind, scopePath) {
      const identity: GraphIdentity = [generationId, kind, scopePath];
      const header = selectGraphHeader.get(...identity);
      if (!header) return null;
      if (
        header.kind === "packages"
          ? selectUmlRowsPresent.get(...identity)?.present
          : selectPackageRowsPresent.get(...identity)?.present
      ) {
        throw invalidMaterialization("diagram graph contains cross-kind model rows");
      }
      const nodes = selectNodes.all(...identity);
      const aliases = selectAliases.all(...identity);
      const edges = selectEdges.all(...identity).map((edge) => ({
        ...edge,
        directed: edge.directed !== 0,
      }));
      const relations = selectRelations.all(...identity);
      const base = {
        scopePath: header.scopePath,
        renderMode: header.renderMode,
        nodes,
        aliases,
        edges,
        relations,
      };
      if (header.kind === "packages") {
        return {
          ...base,
          kind: "packages",
          formatVersion: header.formatVersion as typeof DIAGRAM_GRAPH_FORMAT_VERSION,
          packageNodes: selectPackageNodes.all(...identity),
        };
      }
      const settingsRow = selectUmlSettings.get(...identity);
      const settings = settingsRow
        ? {
          ...settingsRow,
          propertyTypes: settingsRow.propertyTypes !== 0,
          modifiers: settingsRow.modifiers !== 0,
          typeLinks: settingsRow.typeLinks !== 0,
          memberAssociations: settingsRow.memberAssociations !== 0,
          exportedTypesOnly: settingsRow.exportedTypesOnly !== 0,
        }
        : null;
      return {
        ...base,
        kind: "uml",
        formatVersion: header.formatVersion as typeof DIAGRAM_GRAPH_FORMAT_VERSION,
        settings,
        settingLines: selectUmlSettingLines.all(...identity),
        declarations: selectUmlDeclarations.all(...identity).map((row) => ({
          ...row,
          memberAssociationsPresent: row.memberAssociationsPresent !== 0,
        })),
        entities: selectUmlEntities.all(...identity),
        properties: selectUmlProperties.all(...identity).map((row) => ({
          ...row,
          optional: row.optional !== 0,
        })),
        propertyTypeIds: selectUmlPropertyTypeIds.all(...identity),
        methods: selectUmlMethods.all(...identity).map((row) => ({
          ...row,
          returnTypeIdsPresent: row.returnTypeIdsPresent !== 0,
        })),
        methodReturnTypeIds: selectUmlMethodReturnTypeIds.all(...identity),
        enumItems: selectUmlEnumItems.all(...identity),
        entityHeritageClauses: selectUmlEntityHeritage.all(...identity),
        declarationHeritageGroups: selectUmlDeclarationHeritageGroups.all(...identity),
        declarationHeritageClauses: selectUmlDeclarationHeritageClauses.all(...identity),
        memberAssociations: selectUmlMemberAssociations.all(...identity).map((row) => ({
          ...row,
          inherited: row.inherited !== 0,
        })),
        categories: selectUmlCategories.all(...identity).map((row) => ({
          ...row,
          isTest: row.isTest !== 0,
        })),
        methodReturnDependencies: selectUmlMethodReturnDependencies.all(...identity),
        usageEdges: selectUmlUsageEdges.all(...identity),
        localUsers: selectUmlLocalUsers.all(...identity),
        externalUsers: selectUmlExternalUsers.all(...identity),
        localUserTargets: selectUmlLocalUserTargets.all(...identity),
        externalUserTargets: selectUmlExternalUserTargets.all(...identity),
        definitions: selectUmlDefinitions.all(...identity),
      };
    },
  };
}

function invalidMaterialization(message: string, cause?: unknown): DiagramMaterializationError {
  return new DiagramMaterializationError(message, cause === undefined ? undefined : { cause });
}

function assertGraphIdentity(
  graph: DiagramGraph,
  kind: DiagramKind,
  scopePath: string,
): void {
  if (
    (graph.kind !== "packages" && graph.kind !== "uml")
    || graph.kind !== kind
    || typeof graph.scopePath !== "string"
    || graph.scopePath !== scopePath
    || normalizeRelativePath(graph.scopePath) !== graph.scopePath
    || graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION
    || (graph.renderMode !== "normal" && graph.renderMode !== "bare")
  ) {
    throw invalidMaterialization("invalid diagram graph identity");
  }
  if (kind === "packages" && scopePath !== "") {
    throw invalidMaterialization("package diagram graph scope must be empty");
  }
  const candidate = graph as unknown as Record<string, unknown>;
  const arrayFields = graph.kind === "packages"
    ? ["nodes", "aliases", "edges", "relations", "packageNodes"]
    : [
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
    ];
  if (
    (graph.kind === "packages" && (
      "settings" in candidate
      || "settingLines" in candidate
      || "declarations" in candidate
      || "entities" in candidate
      || "properties" in candidate
      || "propertyTypeIds" in candidate
      || "methods" in candidate
      || "methodReturnTypeIds" in candidate
      || "enumItems" in candidate
      || "entityHeritageClauses" in candidate
      || "declarationHeritageGroups" in candidate
      || "declarationHeritageClauses" in candidate
      || "memberAssociations" in candidate
      || "categories" in candidate
      || "methodReturnDependencies" in candidate
      || "usageEdges" in candidate
      || "localUsers" in candidate
      || "externalUsers" in candidate
      || "localUserTargets" in candidate
      || "externalUserTargets" in candidate
      || "definitions" in candidate
    ))
    || (graph.kind === "uml" && "packageNodes" in candidate)
  ) {
    throw invalidMaterialization("diagram graph contains cross-kind model rows");
  }
  if (arrayFields.some((field) => !Array.isArray(candidate[field]))) {
    throw invalidMaterialization("invalid diagram graph row collections");
  }
  if (
    graph.kind === "uml"
    && graph.settings !== null
    && (typeof graph.settings !== "object" || Array.isArray(graph.settings))
  ) {
    throw invalidMaterialization("invalid UML settings record");
  }
}

function recordKey(...parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

function assertString(value: unknown, description: string, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid ${description}`);
  }
}


function validatePackageGraph(graph: PackageDiagramGraph): void {
  if (graph.aliases.length) throw new Error("Package graphs cannot contain aliases");
  const nodes = new Map<string, PackageDiagramGraph["nodes"][number]>();
  for (const [ordinal, node] of graph.nodes.entries()) {
    if (node.nodeOrdinal !== ordinal || nodes.has(node.nodeId)) {
      throw new Error("Invalid package node ordering or identity");
    }
    if (
      (node.nodeKind !== "package" && node.nodeKind !== "placeholder")
      || node.community !== null
    ) {
      throw new Error(`Invalid package node: ${node.nodeId}`);
    }
    assertString(node.nodeId, "package node ID");
    assertString(node.name, "package node name");
    nodes.set(node.nodeId, node);
  }
  const packageRows = new Map<string, string | null>();
  for (const row of graph.packageNodes) {
    if (!nodes.has(row.nodeId) || packageRows.has(row.nodeId)) {
      throw new Error(`Invalid package model node: ${row.nodeId}`);
    }
    if (
      row.packagePath !== null
      && normalizeRelativePath(row.packagePath) !== row.packagePath
    ) {
      throw new Error(`Package graph path is not normalized: ${row.packagePath}`);
    }
    packageRows.set(row.nodeId, row.packagePath);
  }
  if (packageRows.size !== nodes.size) throw new Error("Missing package model node");
  if (graph.renderMode === "bare") {
    if (nodes.size || graph.edges.length || graph.relations.length || packageRows.size) {
      throw new Error("Bare package graph contains rows");
    }
    return;
  }
  if (!nodes.size) throw new Error("Normal package graph is empty");
  const placeholders = [...nodes.values()].filter((node) => node.nodeKind === "placeholder");
  if (placeholders.length) {
    const placeholder = placeholders[0];
    if (!placeholder) throw new Error("Invalid package placeholder graph");
    if (
      placeholders.length !== 1
      || nodes.size !== 1
      || placeholder.nodeId !== "source"
      || placeholder.name !== "No workspace packages"
      || packageRows.get("source") !== null
      || graph.edges.length
      || graph.relations.length
    ) {
      throw new Error("Invalid package placeholder graph");
    }
    return;
  }
  for (const [nodeId, path] of packageRows) {
    if (nodes.get(nodeId)?.nodeKind !== "package" || path === null) {
      throw new Error(`Invalid package path for node: ${nodeId}`);
    }
  }
  const edges = new Map<number, PackageDiagramGraph["edges"][number]>();
  const endpointPairs = new Set<string>();
  for (const [ordinal, edge] of graph.edges.entries()) {
    const pair = recordKey(edge.sourceNodeId, edge.targetNodeId);
    if (
      edge.edgeOrdinal !== ordinal
      || edge.edgeKind !== "package-dependency"
      || !edge.directed
      || edge.weight !== 1
      || !nodes.has(edge.sourceNodeId)
      || !nodes.has(edge.targetNodeId)
      || endpointPairs.has(pair)
    ) {
      throw new Error(`Invalid package edge: ${edge.edgeOrdinal}`);
    }
    endpointPairs.add(pair);
    edges.set(edge.edgeOrdinal, edge);
  }
  if (graph.relations.length !== graph.edges.length) {
    throw new Error("Package edge relation count mismatch");
  }
  const related = new Set<number>();
  for (const relation of graph.relations) {
    const edge = edges.get(relation.edgeOrdinal);
    if (
      !edge
      || relation.relationOrdinal !== 0
      || relation.relationKind !== "package-dependency"
      || relation.sourceNodeId !== edge.sourceNodeId
      || relation.targetNodeId !== edge.targetNodeId
      || related.has(relation.edgeOrdinal)
    ) {
      throw new Error(`Invalid package relation: ${relation.edgeOrdinal}`);
    }
    related.add(relation.edgeOrdinal);
  }
}

function validateUmlGraph(graph: UmlDiagramGraph): void {
  validateUmlDiagramGraph(graph);

  const navigationIds = new Set(graph.localUsers.map(({ navigationNodeId }) => navigationNodeId));
  for (const user of graph.externalUsers) {
    if (navigationIds.has(user.navigationNodeId)) {
      throw new Error(`Invalid UML external user: ${user.nodeId}`);
    }
    navigationIds.add(user.navigationNodeId);
    if (normalizeRelativePath(user.scopePath) !== user.scopePath) {
      throw new Error(`UML external user scope is not normalized: ${user.scopePath}`);
    }
  }
}

function validateLoadedGraph(graph: DiagramGraph): void {
  assertGraphIdentity(graph, graph.kind, graph.scopePath);
  if (graph.kind === "packages") validatePackageGraph(graph);
  else validateUmlGraph(graph);
}

function validateRenderedDiagram(value: RenderedDiagram): RenderedDiagram {
  if (
    !value
    || typeof value !== "object"
    || typeof value.dsl !== "string"
    || !Array.isArray(value.dsls)
    || value.dsls.some((dsl) => typeof dsl !== "string")
    || !Array.isArray(value.packageNodes)
    || !Array.isArray(value.definitions)
    || !Array.isArray(value.externalUsers)
    || !Array.isArray(value.localUsers)
  ) {
    throw new Error("renderer returned an invalid diagram");
  }
  return value;
}


export class Cache {
private static createSchema(
  db: Database,
  selectedObjects?: ReadonlySet<CacheSchemaObjectName>,
): void {
  for (const definition of CACHE_SCHEMA_OBJECTS) {
    if (!selectedObjects || selectedObjects.has(definition.name)) db.run(definition.createSql);
  }
}

private static recreateSchema(db: Database): void {
  for (let index = CACHE_SCHEMA_OBJECTS.length - 1; index >= 0; index -= 1) {
    const definition = CACHE_SCHEMA_OBJECTS[index];
    const objectKind = definition.kind === "trigger" ? "TRIGGER" : "TABLE";
    db.run(`DROP ${objectKind} IF EXISTS "${definition.name}"`);
  }
  Cache.createSchema(db);
  db.run(`PRAGMA user_version=${CACHE_SCHEMA_VERSION}`);
}


private readonly db!: Database;
private readonly graphStore!: PreparedGraphStore;
private readonly selectRawActiveGeneration!: CacheStatements["selectRawActiveGeneration"];
private readonly selectActiveGeneration!: CacheStatements["selectActiveGeneration"];
private readonly deleteActivePointer!: CacheStatements["deleteActivePointer"];
private readonly deleteGotoDefsExceptGeneration!: CacheStatements["deleteGotoDefsExceptGeneration"];
private readonly deleteAllGotoDefs!: CacheStatements["deleteAllGotoDefs"];
private readonly deleteFilesExceptGeneration!: CacheStatements["deleteFilesExceptGeneration"];
private readonly deleteGenerationsExcept!: CacheStatements["deleteGenerationsExcept"];
private readonly deleteAllFiles!: CacheStatements["deleteAllFiles"];
private readonly deleteAllGenerations!: CacheStatements["deleteAllGenerations"];
private readonly insertGeneration!: CacheStatements["insertGeneration"];
private readonly upsertPackages!: CacheStatements["upsertPackages"];
private readonly upsertTreeEntry!: CacheStatements["upsertTreeEntry"];
private readonly upsertDiagram!: CacheStatements["upsertDiagram"];
private readonly upsertFile!: CacheStatements["upsertFile"];
private readonly deleteScopeGotoDefs!: CacheStatements["deleteScopeGotoDefs"];
private readonly insertGotoDefinition!: CacheStatements["insertGotoDefinition"];
private readonly selectTreeEntries!: CacheStatements["selectTreeEntries"];
private readonly selectPackages!: CacheStatements["selectPackages"];
private readonly selectDiagram!: CacheStatements["selectDiagram"];
private readonly selectFile!: CacheStatements["selectFile"];
private readonly selectDefinition!: CacheStatements["selectDefinition"];
private readonly selectDefinitions!: CacheStatements["selectDefinitions"];
private readonly selectIndexedSearchCandidates!: CacheStatements["selectIndexedSearchCandidates"];
private readonly selectScanSearchCandidates!: CacheStatements["selectScanSearchCandidates"];
private readonly selectIndexedDefinitionCandidates!: CacheStatements["selectIndexedDefinitionCandidates"];
private readonly selectScanDefinitionCandidates!: CacheStatements["selectScanDefinitionCandidates"];
private readonly markGenerationActive!: CacheStatements["markGenerationActive"];
private readonly upsertActivePointer!: CacheStatements["upsertActivePointer"];
private readonly deleteGenerationFiles!: CacheStatements["deleteGenerationFiles"];
private readonly deleteGenerationGotoDefs!: CacheStatements["deleteGenerationGotoDefs"];
private readonly deleteInactiveGeneration!: CacheStatements["deleteInactiveGeneration"];
private readonly markGenerationFailed!: CacheStatements["markGenerationFailed"];
private readonly optimizeSearch!: CacheStatements["optimizeSearch"];
private readonly optimizeGotoDefinitionSearch!: CacheStatements["optimizeGotoDefinitionSearch"];
private readonly statements!: Array<{ finalize(): void }>;
private readonly recoveryTransaction!: ImmediateTransaction<[number | null]>;
private readonly discoveryTransaction!: ImmediateTransaction<
  [number, readonly PackageInfo[], CacheDiagramInput, DiagramRenderer],
  CacheDiagramResponse
>;
private readonly scopeTransaction!: ImmediateTransaction<
  [number, CacheScopeWrite, DiagramRenderer],
  CacheDiagramResponse
>;
private readonly promotionTransaction!: ImmediateTransaction<[number]>;
private readonly cleanupTransaction!: ImmediateTransaction<[number]>;
private readonly discardTransaction!: ImmediateTransaction<[number]>;
private closed = false;

constructor(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });
  this.db = db;

  try {
    const journalStatement = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL");
    try {
      journalStatement.get();
    } finally {
      journalStatement.finalize();
    }
    db.run("PRAGMA synchronous=NORMAL");
    db.run("PRAGMA foreign_keys=ON");
    db.run("PRAGMA busy_timeout=5000");

    const versionStatement = db.query<{ user_version: number }, []>("PRAGMA user_version");
    let version: number | undefined;
    try {
      version = versionStatement.get()?.user_version;
    } finally {
      versionStatement.finalize();
    }
    if (version !== CACHE_SCHEMA_VERSION) db.transaction(() => Cache.recreateSchema(db)).immediate();

    const schemaStatement = db.query<SchemaObjectRow, []>(`
      SELECT name FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
    `);
    let schemaObjects: SchemaObjectRow[];
    try {
      schemaObjects = schemaStatement.all();
    } finally {
      schemaStatement.finalize();
    }
    const presentObjects = new Set(schemaObjects.map(({ name }) => name));
    const missingObjects = CACHE_SCHEMA_OBJECTS
      .map(({ name }) => name)
      .filter((name) => !presentObjects.has(name));
    if (missingObjects.length) {
      throw new Error(`cache schema is incomplete: missing ${missingObjects.join(", ")}`);
    }

  const selectRawActiveGeneration = db.query<MetaRow, []>(`
    SELECT value
    FROM cache_meta
    WHERE key = 'active_generation'
  `);
  const selectActiveGeneration = db.query<ActiveGenerationRow, []>(`
    SELECT generations.id AS id
    FROM cache_meta
    JOIN generations
      ON generations.id = CAST(cache_meta.value AS INTEGER)
      AND generations.state = 'active'
    WHERE cache_meta.key = 'active_generation'
  `);
  const deleteActivePointer = db.query<never, []>(`
    DELETE FROM cache_meta WHERE key = 'active_generation'
  `);
  const deleteGotoDefsExceptGeneration = db.query<never, [number]>(`
    DELETE FROM GotoDef WHERE generation_id <> ?
  `);
  const deleteAllGotoDefs = db.query<never, []>("DELETE FROM GotoDef");
  const deleteFilesExceptGeneration = db.query<never, [number]>(`
    DELETE FROM files WHERE generation_id <> ?
  `);
  const deleteGenerationsExcept = db.query<never, [number]>(`
    DELETE FROM generations WHERE id <> ?
  `);
  const deleteAllFiles = db.query<never, []>("DELETE FROM files");
  const deleteAllGenerations = db.query<never, []>("DELETE FROM generations");
  const insertGeneration = db.query<never, ["startup" | "watch", number]>(`
    INSERT INTO generations(state, cause, started_at)
    VALUES ('building', ?, ?)
  `);
  const upsertPackages = db.query<never, [number, string]>(`
    INSERT INTO package_snapshots(generation_id, packages_json)
    VALUES (?, ?)
    ON CONFLICT(generation_id) DO UPDATE SET packages_json = excluded.packages_json
  `);
  const upsertTreeEntry = db.query<never, [number, string, string, string, "directory" | "file", number]>(`
    INSERT INTO tree_entries(generation_id, path, parent_path, name, kind, viewable)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id, path) DO UPDATE SET
      parent_path = excluded.parent_path,
      name = excluded.name,
      kind = excluded.kind,
      viewable = excluded.viewable
  `);
  const upsertDiagram = db.query<never, [number, CacheDiagramResponse["kind"], string, string]>(`
    INSERT INTO diagrams(generation_id, kind, scope_path, response_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(generation_id, kind, scope_path) DO UPDATE SET
      response_json = excluded.response_json
  `);
  const upsertFile = db.query<never, [number, string, string | null, string | null, string | null, string | null]>(`
    INSERT INTO files(
      generation_id,
      path,
      raw_content,
      display_content,
      source_error,
      format_error
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id, path) DO UPDATE SET
      raw_content = excluded.raw_content,
      display_content = excluded.display_content,
      source_error = excluded.source_error,
      format_error = excluded.format_error
  `);
  const deleteScopeGotoDefs = db.query<never, [number, string]>(`
    DELETE FROM GotoDef WHERE generation_id = ? AND source_path = ?
  `);
  const insertGotoDefinition = db.query<never, [
    number,
    string,
    GotoDefinitionKind,
    string,
    string,
    string,
    number,
    number,
    number,
    number,
    string,
    string,
    string | null,
    number | null,
  ]>(`
    INSERT INTO GotoDef(
      generation_id,
      definition_key,
      kind,
      name,
      qualified_name,
      source_path,
      source_line,
      source_column,
      display_from,
      display_to,
      uml_scope_path,
      uml_entity_name,
      uml_member_name,
      uml_member_occurrence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectTreeEntries = db.query<TreeRow, [number]>(`
    SELECT path, name, kind, viewable
    FROM tree_entries
    WHERE generation_id = ?
    ORDER BY path
  `);
  const selectPackages = db.query<PackageRow, [number]>(`
    SELECT packages_json
    FROM package_snapshots
    WHERE generation_id = ?
  `);
  const selectDiagram = db.query<DiagramRow, [number, CacheDiagramResponse["kind"], string]>(`
    SELECT response_json
    FROM diagrams
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
  `);
  const selectFile = db.query<FileRow, [number, string]>(`
    SELECT path, raw_content, display_content, source_error, format_error
    FROM files
    WHERE generation_id = ? AND path = ?
  `);
  const selectDefinition = db.query<GotoDefinitionRow, [number, string, number, number]>(`
    SELECT
      definition_key,
      kind,
      name,
      qualified_name,
      source_path,
      source_line,
      source_column,
      display_from,
      display_to,
      uml_scope_path,
      uml_entity_name,
      uml_member_name,
      uml_member_occurrence
    FROM GotoDef
    WHERE generation_id = ?
      AND source_path = ?
      AND source_line = ?
      AND source_column = ?
    ORDER BY definition_key
    LIMIT 1
  `);
  const selectDefinitions = db.query<GotoDefinitionRow, [number, string]>(`
    SELECT
      definition_key,
      kind,
      name,
      qualified_name,
      source_path,
      source_line,
      source_column,
      display_from,
      display_to,
      uml_scope_path,
      uml_entity_name,
      uml_member_name,
      uml_member_occurrence
    FROM GotoDef
    WHERE generation_id = ? AND source_path = ?
    ORDER BY source_line, source_column, definition_key
  `);
  const selectIndexedSearchCandidates = db.query<SearchCandidateRow, [number, string]>(`
    SELECT files.path AS path, files.raw_content AS raw_content
    FROM file_search
    JOIN files ON file_search.rowid = files.id
    WHERE files.generation_id = ? AND file_search.raw_content LIKE ?
  `);
  const selectScanSearchCandidates = db.query<SearchCandidateRow, [number]>(`
    SELECT path, raw_content
    FROM files
    WHERE generation_id = ? AND raw_content IS NOT NULL
  `);
  const selectIndexedDefinitionCandidates = db.query<GotoDefinitionRow, [number, string, string]>(`
    SELECT
      GotoDef.definition_key,
      GotoDef.kind,
      GotoDef.name,
      GotoDef.qualified_name,
      GotoDef.source_path,
      GotoDef.source_line,
      GotoDef.source_column,
      GotoDef.display_from,
      GotoDef.display_to,
      GotoDef.uml_scope_path,
      GotoDef.uml_entity_name,
      GotoDef.uml_member_name,
      GotoDef.uml_member_occurrence
    FROM goto_def_search
    JOIN GotoDef ON goto_def_search.rowid = GotoDef.id
    WHERE GotoDef.generation_id = ?
      AND (
        goto_def_search.name LIKE ?
        OR goto_def_search.qualified_name LIKE ?
      )
  `);
  const selectScanDefinitionCandidates = db.query<GotoDefinitionRow, [number]>(`
    SELECT
      definition_key,
      kind,
      name,
      qualified_name,
      source_path,
      source_line,
      source_column,
      display_from,
      display_to,
      uml_scope_path,
      uml_entity_name,
      uml_member_name,
      uml_member_occurrence
    FROM GotoDef
    WHERE generation_id = ?
  `);
  const markGenerationActive = db.query<never, [number, number]>(`
    UPDATE generations
    SET state = 'active', completed_at = ?
    WHERE id = ? AND state IN ('building', 'active')
  `);
  const upsertActivePointer = db.query<never, [string]>(`
    INSERT INTO cache_meta(key, value)
    VALUES ('active_generation', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const deleteGenerationFiles = db.query<never, [number]>(`
    DELETE FROM files WHERE generation_id = ?
  `);
  const deleteGenerationGotoDefs = db.query<never, [number]>(`
    DELETE FROM GotoDef WHERE generation_id = ?
  `);
  const deleteInactiveGeneration = db.query<never, [number]>(`
    DELETE FROM generations WHERE id = ? AND state <> 'active'
  `);
  const markGenerationFailed = db.query<never, [number, number]>(`
    UPDATE generations
    SET state = 'failed', completed_at = ?
    WHERE id = ? AND state = 'building'
  `);
  const optimizeSearch = db.query<never, []>(`
    INSERT INTO file_search(file_search) VALUES ('optimize')
  `);
  const optimizeGotoDefinitionSearch = db.query<never, []>(`
    INSERT INTO goto_def_search(goto_def_search) VALUES ('optimize')
  `);
  const graphStore = prepareGraphStore(db);

  const statements: Array<{ finalize(): void }> = [
    selectRawActiveGeneration,
    selectActiveGeneration,
    deleteActivePointer,
    deleteGotoDefsExceptGeneration,
    deleteFilesExceptGeneration,
    deleteGenerationsExcept,
    deleteAllGotoDefs,
    deleteAllFiles,
    deleteAllGenerations,
    insertGeneration,
    upsertPackages,
    upsertTreeEntry,
    upsertDiagram,
    upsertFile,
    deleteScopeGotoDefs,
    insertGotoDefinition,
    selectTreeEntries,
    selectPackages,
    selectDiagram,
    selectFile,
    selectDefinition,
    selectDefinitions,
    selectIndexedSearchCandidates,
    selectScanSearchCandidates,
    selectIndexedDefinitionCandidates,
    selectScanDefinitionCandidates,
    markGenerationActive,
    upsertActivePointer,
    deleteGenerationGotoDefs,
    deleteGenerationFiles,
    deleteInactiveGeneration,
    markGenerationFailed,
    optimizeSearch,
    optimizeGotoDefinitionSearch,
    ...graphStore.statements,
  ];
  this.selectRawActiveGeneration = selectRawActiveGeneration;
  this.selectActiveGeneration = selectActiveGeneration;
  this.deleteActivePointer = deleteActivePointer;
  this.deleteGotoDefsExceptGeneration = deleteGotoDefsExceptGeneration;
  this.deleteAllGotoDefs = deleteAllGotoDefs;
  this.deleteFilesExceptGeneration = deleteFilesExceptGeneration;
  this.deleteGenerationsExcept = deleteGenerationsExcept;
  this.deleteAllFiles = deleteAllFiles;
  this.deleteAllGenerations = deleteAllGenerations;
  this.insertGeneration = insertGeneration;
  this.upsertPackages = upsertPackages;
  this.upsertTreeEntry = upsertTreeEntry;
  this.upsertDiagram = upsertDiagram;
  this.upsertFile = upsertFile;
  this.deleteScopeGotoDefs = deleteScopeGotoDefs;
  this.insertGotoDefinition = insertGotoDefinition;
  this.selectTreeEntries = selectTreeEntries;
  this.selectPackages = selectPackages;
  this.selectDiagram = selectDiagram;
  this.selectFile = selectFile;
  this.selectDefinition = selectDefinition;
  this.selectDefinitions = selectDefinitions;
  this.selectIndexedSearchCandidates = selectIndexedSearchCandidates;
  this.selectScanSearchCandidates = selectScanSearchCandidates;
  this.selectIndexedDefinitionCandidates = selectIndexedDefinitionCandidates;
  this.selectScanDefinitionCandidates = selectScanDefinitionCandidates;
  this.markGenerationActive = markGenerationActive;
  this.upsertActivePointer = upsertActivePointer;
  this.deleteGenerationFiles = deleteGenerationFiles;
  this.deleteGenerationGotoDefs = deleteGenerationGotoDefs;
  this.deleteInactiveGeneration = deleteInactiveGeneration;
  this.markGenerationFailed = markGenerationFailed;
  this.optimizeSearch = optimizeSearch;
  this.optimizeGotoDefinitionSearch = optimizeGotoDefinitionSearch;
  this.graphStore = graphStore;
  this.statements = statements;


  this.recoveryTransaction = db.transaction((activeGenerationId: number | null) => {
    if (activeGenerationId === null) {
      this.deleteActivePointer.run();
      this.deleteAllGotoDefs.run();
      this.deleteAllFiles.run();
      this.deleteAllGenerations.run();
      return;
    }
    this.deleteGotoDefsExceptGeneration.run(activeGenerationId);
    this.deleteFilesExceptGeneration.run(activeGenerationId);
    this.deleteGenerationsExcept.run(activeGenerationId);
  });
  const materializeDiagram = (
    generationId: number,
    input: CacheDiagramInput,
    renderer: DiagramRenderer,
    expectedKind?: DiagramKind,
    expectedScopePath?: string,
  ): CacheDiagramResponse => {
    let graph: DiagramGraph | null = null;
    let kind: DiagramKind;
    let scopePath: string;
    let fallbackSource:
      | Extract<CacheDiagramInput, { fallbackSource: unknown }>["fallbackSource"]
      | null = null;
    let fallbackRendered: RenderedDiagram | null = null;
    try {
      if (!input || typeof input !== "object" || !("outcome" in input)) {
        throw new Error("missing diagram input");
      }
      if (
        (input.outcome.status === "ready"
          && "error" in input.outcome
          && input.outcome.error !== undefined)
        || (
          input.outcome.status !== "ready"
          && (
            input.outcome.status !== "error"
            || typeof input.outcome.error !== "string"
          )
        )
      ) {
        throw new Error("invalid diagram outcome");
      }
      if ("graph" in input && "fallbackSource" in input) {
        throw new Error("diagram input cannot contain both graph and fallback source");
      }
      if ("graph" in input) {
        graph = input.graph;
        if (!graph || typeof graph !== "object") throw new Error("missing direct graph");
        kind = graph.kind;
        scopePath = graph.scopePath;
        assertGraphIdentity(graph, kind, scopePath);
        if (input.outcome.status === "error" && graph.renderMode !== "bare") {
          throw new Error("an error outcome requires a bare direct graph");
        }
      } else if ("fallbackSource" in input) {
        const source = input.fallbackSource;
        if (
          input.outcome.status !== "error"
          || !source
          || !Number.isInteger(source.sourceGenerationId)
          || source.sourceGenerationId <= 0
          || source.sourceGenerationId === generationId
          || (source.kind !== "packages" && source.kind !== "uml")
          || typeof source.scopePath !== "string"
          || normalizeRelativePath(source.scopePath) !== source.scopePath
          || (source.kind === "packages" && source.scopePath !== "")
        ) {
          throw new Error("invalid fallback source");
        }
        fallbackSource = source;
        kind = source.kind;
        scopePath = source.scopePath;
      } else {
        throw new Error("invalid diagram input");
      }
      if (
        (expectedKind !== undefined && kind !== expectedKind)
        || (expectedScopePath !== undefined && scopePath !== expectedScopePath)
      ) {
        throw new Error("diagram input does not match the target identity");
      }
    } catch (error) {
      if (error instanceof DiagramMaterializationError) throw error;
      throw invalidMaterialization("invalid diagram materialization input", error);
    }

    if (fallbackSource) {
      const sourceGraph = graphStore.readGraph(
        fallbackSource.sourceGenerationId,
        fallbackSource.kind,
        fallbackSource.scopePath,
      );
      if (!sourceGraph) {
        throw invalidMaterialization("fallback source graph not found");
      }
      const sourceResponseRow = this.selectDiagram.get(
        fallbackSource.sourceGenerationId,
        fallbackSource.kind,
        fallbackSource.scopePath,
      );
      if (!sourceResponseRow) {
        throw invalidMaterialization("fallback source response not found");
      }
      try {
        validateLoadedGraph(sourceGraph);
        const sourceResponse = parseJson<CacheDiagramResponse>(
          sourceResponseRow.response_json,
          "fallback diagram",
        );
        if (
          sourceResponse.kind !== fallbackSource.kind
          || sourceResponse.scopePath !== fallbackSource.scopePath
          || (sourceResponse.status !== "ready" && sourceResponse.status !== "error")
          || (sourceResponse.status === "error" && typeof sourceResponse.error !== "string")
          || (sourceResponse.status === "ready" && sourceResponse.error !== undefined)
        ) {
          throw new Error("fallback source graph and response identity disagree");
        }
        fallbackRendered = validateRenderedDiagram(sourceResponse);
      } catch (error) {
        throw invalidMaterialization("invalid fallback source", error);
      }
      graph = sourceGraph;
    }
    if (!graph) {
      throw invalidMaterialization("diagram graph was not resolved");
    }

    graphStore.deleteGraph(generationId, kind, scopePath);
    graphStore.insertGraph(generationId, graph);
    const reloaded = graphStore.readGraph(generationId, kind, scopePath);
    if (!reloaded) {
      throw invalidMaterialization("persisted diagram graph header was not found");
    }
    try {
      validateLoadedGraph(reloaded);
    } catch (error) {
      throw invalidMaterialization("invalid hydrated diagram graph", error);
    }

    let rendered: RenderedDiagram;
    try {
      rendered = validateRenderedDiagram(renderer(reloaded));
    } catch (error) {
      if (fallbackSource === null || fallbackRendered === null) {
        throw invalidMaterialization("diagram rendering failed", error);
      }
      rendered = fallbackRendered;
    }
    let response: CacheDiagramResponse;
    let responseJson: string;
    try {
      response = {
        kind,
        scopePath,
        status: input.outcome.status,
        dsl: rendered.dsl,
        dsls: rendered.dsls,
        packageNodes: rendered.packageNodes,
        definitions: rendered.definitions,
        externalUsers: rendered.externalUsers,
        localUsers: rendered.localUsers,
        ...(input.outcome.status === "error" ? { error: input.outcome.error } : {}),
      };
      const serialized = JSON.stringify(response);
      if (serialized === undefined) throw new Error("diagram response is not serializable");
      responseJson = serialized;
    } catch (error) {
      throw invalidMaterialization("diagram response materialization failed", error);
    }
    this.upsertDiagram.run(generationId, kind, scopePath, responseJson);
    return response;
  };

  this.discoveryTransaction = db.transaction((
    generationId: number,
    packages: readonly PackageInfo[],
    diagram: CacheDiagramInput,
    renderer: DiagramRenderer,
  ) => {
    const response = materializeDiagram(
      generationId,
      diagram,
      renderer,
      "packages",
      "",
    );
    this.upsertPackages.run(generationId, JSON.stringify(packages));
    return response;
  });
  this.scopeTransaction = db.transaction((
    generationId: number,
    scope: CacheScopeWrite,
    renderer: DiagramRenderer,
  ) => {
    const response = materializeDiagram(generationId, scope.diagram, renderer);
    for (const entry of scope.entries) {
      const viewable = (entry as TreeNode & { viewable?: boolean }).viewable === true ? 1 : 0;
      this.upsertTreeEntry.run(
        generationId,
        entry.path,
        parentPath(entry.path),
        entry.name,
        entry.kind,
        viewable,
      );
    }
    if (scope.file) {
      const file = scope.file;
      this.deleteScopeGotoDefs.run(generationId, file.path);
      this.upsertFile.run(
        generationId,
        file.path,
        file.rawContent,
        file.displayContent,
        file.sourceError,
        file.formatError,
      );
      for (const definition of scope.definitions) {
        this.insertGotoDefinition.run(
          generationId,
          definition.key,
          definition.kind,
          definition.name,
          definition.qualifiedName,
          definition.source.path,
          definition.source.line,
          definition.source.column,
          definition.displayFrom,
          definition.displayTo,
          definition.uml.scopePath,
          definition.uml.entityName,
          definition.uml.memberName ?? null,
          definition.uml.memberOccurrence ?? null,
        );
      }
    }
    return response;
  });
  this.promotionTransaction = db.transaction((generationId: number) => {
    const result = this.markGenerationActive.run(Date.now(), generationId);
    if (result.changes !== 1) throw new Error(`cannot promote generation ${generationId}`);
    this.upsertActivePointer.run(String(generationId));
  });
  this.cleanupTransaction = db.transaction((generationId: number) => {
    this.deleteGotoDefsExceptGeneration.run(generationId);
    this.deleteFilesExceptGeneration.run(generationId);
    this.deleteGenerationsExcept.run(generationId);
  });
  this.discardTransaction = db.transaction((generationId: number) => {
    this.deleteGenerationGotoDefs.run(generationId);
    this.deleteGenerationFiles.run(generationId);
    this.deleteInactiveGeneration.run(generationId);
  });

  } catch (error) {
    try {
      db.close(true);
    } catch {
      db.close();
    }
    throw error;
  }
}

recover(): number | null {
  const hasPointer = this.selectRawActiveGeneration.get() !== null;
  const activeGenerationId = this.selectActiveGeneration.get()?.id ?? null;
  this.recoveryTransaction.immediate(activeGenerationId);
  return hasPointer ? activeGenerationId : null;
}

getActiveGenerationId(): number | null {
  return this.selectActiveGeneration.get()?.id ?? null;
}

repairTableForSchemaError(error: unknown): CacheTableName | null {
  const tableName = cacheTableFromSchemaError(error);
  if (!tableName) return null;
  const tableDefinition = CACHE_SCHEMA_BY_NAME.get(tableName);
  if (tableDefinition?.kind !== "table") return null;
  const table = tableDefinition.name;
  const schemaObjects: readonly CacheSchemaObjectName[] =
    table === "files" || table === "GotoDef"
      ? CACHE_TABLE_RECOVERY_GROUPS[table]
      : [table];
  const definitions = schemaObjects.map((name) => {
    const definition = CACHE_SCHEMA_BY_NAME.get(name);
    if (!definition) throw new Error(`cache schema descriptor not found: ${name}`);
    return definition;
  });
  const selectedObjects = new Set(schemaObjects);
  this.db.transaction(() => {
    for (let index = definitions.length - 1; index >= 0; index -= 1) {
      const definition = definitions[index];
      const objectKind = definition.kind === "trigger" ? "TRIGGER" : "TABLE";
      this.db.run(`DROP ${objectKind} IF EXISTS "${definition.name}"`);
    }
    Cache.createSchema(this.db, selectedObjects);
  }).immediate();
  return table;
}

beginGeneration(cause: "startup" | "watch"): number {
  return Number(this.insertGeneration.run(cause, Date.now()).lastInsertRowid);
}

writeDiscovery(
  generationId: number,
  packages: readonly PackageInfo[],
  diagram: CacheDiagramInput,
  render: DiagramRenderer,
): CacheDiagramResponse {
  return this.discoveryTransaction.immediate(generationId, packages, diagram, render);
}

writeScope(
  generationId: number,
  scope: CacheScopeWrite,
  render: DiagramRenderer,
): CacheDiagramResponse {
  return this.scopeTransaction.immediate(generationId, scope, render);
}

readTreeEntries(generationId: number): TreeNode[] {
  return this.selectTreeEntries.all(generationId).map((row): TreeNode => {
    if (row.kind === "file") {
      return {
        name: row.name,
        path: row.path,
        kind: "file",
        viewable: row.viewable !== 0,
      };
    }
    return {
      name: row.name,
      path: row.path,
      kind: "directory",
    };
  });
}

readPackages(generationId: number): PackageInfo[] {
  const row = this.selectPackages.get(generationId);
  if (!row) throw new Error(`cache package snapshot not found for generation ${generationId}`);
  return parseJson<PackageInfo[]>(row.packages_json, "package snapshot");
}

readDiagramGraph(
  generationId: number,
  kind: DiagramKind,
  scopePath: string,
): DiagramGraph | null {
  const graph = this.graphStore.readGraph(generationId, kind, scopePath);
  if (!graph) return null;
  try {
    validateLoadedGraph(graph);
    return graph;
  } catch (error) {
    throw invalidMaterialization("invalid hydrated diagram graph", error);
  }
}

readDiagram(
  generationId: number,
  kind: CacheDiagramResponse["kind"],
  scopePath: string,
): CacheDiagramResponse | null {
  const row = this.selectDiagram.get(generationId, kind, scopePath);
  return row ? parseJson<CacheDiagramResponse>(row.response_json, "diagram") : null;
}

readFile(generationId: number, path: string): CacheFileWrite | null {
  const row = this.selectFile.get(generationId, path);
  if (!row) return null;
  return {
    path: row.path,
    rawContent: row.raw_content,
    displayContent: row.display_content,
    sourceError: row.source_error,
    formatError: row.format_error,
  };
}

readDefinition(
  generationId: number,
  path: string,
  line: number,
  column: number,
): GotoDefinition | null {
  const row = this.selectDefinition.get(
    generationId,
    normalizeRelativePath(path),
    line,
    column,
  );
  return row ? toGotoDefinition(row) : null;
}

readDefinitions(generationId: number, path: string): EditorGotoDefinition[] {
  return this.selectDefinitions
    .all(generationId, normalizeRelativePath(path))
    .map(toEditorGotoDefinition);
}

searchFiles(
  generationId: number,
  query: string,
  caseInsensitive: boolean,
): Omit<SearchResponse, "version"> {
  const indexed = !caseInsensitive
    && hasAtLeastThreeCodePoints(query)
    && !query.includes("%")
    && !query.includes("_");
  const likeQuery = `%${query}%`;
  const fileCandidates = indexed
    ? this.selectIndexedSearchCandidates.all(generationId, likeQuery)
    : this.selectScanSearchCandidates.all(generationId);
  const definitionCandidates = indexed
    ? this.selectIndexedDefinitionCandidates.all(generationId, likeQuery, likeQuery)
    : this.selectScanDefinitionCandidates.all(generationId);
  const comparisonQuery = caseInsensitive ? query.toLowerCase() : query;
  const paths = new Set<string>();
  for (const candidate of fileCandidates) {
    if (includesSearch(candidate.raw_content, comparisonQuery, caseInsensitive)) {
      paths.add(candidate.path);
    }
  }
  const retainedDefinitions = new Map<string, GotoDefinitionRow>();
  for (const candidate of definitionCandidates) {
    if (
      !includesSearch(candidate.name, comparisonQuery, caseInsensitive)
      && !includesSearch(candidate.qualified_name, comparisonQuery, caseInsensitive)
    ) {
      continue;
    }
    retainedDefinitions.set(`${candidate.source_path}\0${candidate.definition_key}`, candidate);
    paths.add(candidate.source_path);
  }
  const definitionRows = [...retainedDefinitions.values()].sort((left, right) =>
    left.source_path.localeCompare(right.source_path)
    || left.source_line - right.source_line
    || left.source_column - right.source_column
    || left.definition_key.localeCompare(right.definition_key)
  );
  const definitions = definitionRows.map(toGotoDefinition);
  const files = [...paths].sort((left, right) => left.localeCompare(right));
  return {
    query,
    caseInsensitive,
    files,
    definitions,
    ...buildSearchScopes(files, this.readPackages(generationId)),
  };
}

promoteGeneration(generationId: number): void {
  this.promotionTransaction.immediate(generationId);
  this.cleanupTransaction.immediate(generationId);
  this.optimizeSearch.run();
  this.optimizeGotoDefinitionSearch.run();
}

discardGeneration(generationId: number): void {
  if (this.selectActiveGeneration.get()?.id === generationId) {
    throw new Error(`cannot discard active generation ${generationId}`);
  }
  this.discardTransaction.immediate(generationId);
}

failGeneration(generationId: number): void {
  this.markGenerationFailed.run(Date.now(), generationId);
}

close(): void {
  if (this.closed) return;
  for (const statement of this.statements) statement.finalize();
  this.db.close(true);
  this.closed = true;
}
}
