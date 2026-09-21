import { mkdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Database } from "bun:sqlite";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type DiagramGraph,
  type DiagramNodeKind,
  type DiagramRelationKind,
  type PackageDiagramGraph,
  type RenderedPackageDiagram,
  type UmlCategoryKind,
  type UmlDiagramGraph,
  type UmlFileOutcome,
  type UmlRelationKind,
} from "./diagram-graph.ts";
import type { LanguageId } from "./lang/registry.ts";
import { normalizeRelativePath, PathError } from "./paths.ts";
import { validatePackageDiagramGraph } from "./packages.ts";
import { buildSearchScopes } from "./search.ts";
import { isSourcePath } from "./source.ts";
import {
  FILE_DEFINITION_KINDS,
  type DiagramKind,
  type EditorGotoDefinition,
  type FileDefinition,
  type FileDefinitionKind,
  type GotoDefinition,
  type GotoDefinitionKind,
  type PackageDiagramPayload,
  type PackageInfo,
  type SearchResponse,
  type TreeNode,
  type UmlDiagramPayload,
  type UmlSourceLocation,
  type UmlTarget,
} from "./types.ts";
import { isTestPath } from "./uml/keys.ts";
import type {
  DefinitionBindingSpace,
  DefinitionBindingTarget,
  DefinitionIndexSnapshot,
  DefinitionResolutionIndex,
  IndexedFileDefinition,
  UmlEntityModel,
} from "./uml/model.ts";
import { type HydratedFileNominalModel, hydrateUmlNominalModel } from "./uml/render.ts";
import { validateUmlDiagramGraph } from "./uml/graph.ts";
import type {
  UmlDefinitionEdge,
  UmlDefinitionNode,
  UmlViewModel,
} from "./uml/view.ts";

const CACHE_SCHEMA_VERSION = 9;

type DiagramErrorOutcome = { status: "error"; error: string };

export type CachePackageDiagramInput =
  | {
    graph: PackageDiagramGraph;
    outcome: { status: "ready" } | DiagramErrorOutcome;
  }
  | {
    fallbackSource: { sourceGenerationId: number };
    outcome: DiagramErrorOutcome;
  };

type PackageDiagramRenderer = (graph: PackageDiagramGraph) => RenderedPackageDiagram;

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
  language: LanguageId | null;
};

export type CacheScopeWrite = {
  /** Present only for source-file scopes; directories never manufacture a UML completion row. */
  diagram?: { graph: UmlDiagramGraph; outcome: UmlFileOutcome };
  file?: CacheFileWrite;
  definitions: readonly EditorGotoDefinition[];
};

export type UmlDiagramRead =
  | { state: "pending"; files: string[] }
  | { state: "complete"; diagram: UmlDiagramPayload };

type ActiveGenerationRow = { id: number; source_fingerprint: string };
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
  language: LanguageId | null;
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
type DefinitionIndexRow = {
  definition_key: string;
  parent_key: string | null;
  is_top_level: number;
  has_body: number;
  name: string;
  qualified_name: string;
  kind: FileDefinitionKind;
  type_text: string | null;
  source_path: string;
  source_line: number;
  source_column: number;
};
type DefinitionLocationRow = {
  source_path: string;
  source_line: number;
  source_column: number;
};
type BindingRow = { target_key: string | null; target_module_path: string | null };
type ContributorRow = { source_path: string; contribution_kind: "declaration" | "implementation" | "module" };
type RelationRow = { target_node_id: string; relation_kind: UmlRelationKind };
type SchemaObjectRow = { name: string };
type GraphIdentity = [generationId: number, kind: DiagramKind, scopePath: string];
type GraphHeaderRow = {
  kind: DiagramKind;
  scopePath: string;
  formatVersion: number;
  renderMode: "normal" | "bare";
};
type SqlBooleanRow<Row, Key extends keyof Row> = Omit<Row, Key> & Record<Key, number>;

type ImmediateTransaction<Args extends unknown[], Result = void> = {
  immediate(...args: Args): Result;
};

type CacheSchemaObject = {
  readonly name: string;
  readonly kind: "table" | "trigger" | "index";
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
      completed_at INTEGER,
      source_fingerprint TEXT NOT NULL
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
    name: "tree_entries_by_parent",
    kind: "index",
    createSql: `CREATE INDEX tree_entries_by_parent
      ON tree_entries(generation_id, parent_path, path)`,
  },
  {
    name: "diagram_graphs",
    kind: "table",
    createSql: `CREATE TABLE diagram_graphs (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('packages', 'uml')),
      scope_path TEXT NOT NULL,
      format_version INTEGER NOT NULL CHECK (format_version = 2),
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
        node_kind IN ('package', 'placeholder', 'entity', 'definition', 'boundary')
      ),
      name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, node_id),
      UNIQUE (generation_id, kind, scope_path, node_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
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
        relation_kind IN ('package-dependency', 'extends', 'implements', 'references')
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
    name: "diagram_relations_by_source",
    kind: "index",
    createSql: `CREATE INDEX diagram_relations_by_source
      ON diagram_edge_relations(
        generation_id, source_node_id, scope_path, target_node_id, relation_kind
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
    name: "uml_entities",
    kind: "table",
    createSql: `CREATE TABLE uml_entities (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      definition_key TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN (${
      FILE_DEFINITION_KINDS.map((kind) => `'${kind}'`).join(",")
    })),
      name TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, entity_ordinal),
      UNIQUE (generation_id, kind, scope_path, definition_key),
      FOREIGN KEY (generation_id, kind, scope_path, definition_key)
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
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      property_ordinal INTEGER NOT NULL CHECK (property_ordinal >= 0),
      definition_key TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      optional INTEGER NOT NULL CHECK (optional IN (0, 1)),
      PRIMARY KEY (generation_id, kind, scope_path, entity_ordinal, property_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path, entity_ordinal)
        REFERENCES uml_entities(generation_id, kind, scope_path, entity_ordinal) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_methods",
    kind: "table",
    createSql: `CREATE TABLE uml_methods (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      method_ordinal INTEGER NOT NULL CHECK (method_ordinal >= 0),
      definition_key TEXT NOT NULL,
      name TEXT NOT NULL,
      return_type TEXT,
      PRIMARY KEY (generation_id, kind, scope_path, entity_ordinal, method_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path, entity_ordinal)
        REFERENCES uml_entities(generation_id, kind, scope_path, entity_ordinal) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_member_modifiers",
    kind: "table",
    createSql: `CREATE TABLE uml_member_modifiers (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      member_kind TEXT NOT NULL CHECK (member_kind IN ('property', 'method')),
      member_ordinal INTEGER NOT NULL CHECK (member_ordinal >= 0),
      modifier_ordinal INTEGER NOT NULL CHECK (modifier_ordinal >= 0),
      modifier TEXT NOT NULL CHECK (
        modifier IN (
          'ambient', 'public', 'private', 'protected', 'abstract', 'static',
          'readonly', 'accessor', 'async', 'const', 'override', 'unsafe', 'mutable'
        )
      ),
      PRIMARY KEY (
        generation_id, kind, scope_path, entity_ordinal,
        member_kind, member_ordinal, modifier_ordinal
      ),
      FOREIGN KEY (generation_id, kind, scope_path, entity_ordinal)
        REFERENCES uml_entities(generation_id, kind, scope_path, entity_ordinal) ON DELETE CASCADE
    )`,
  },
  {
    name: "uml_enum_items",
    kind: "table",
    createSql: `CREATE TABLE uml_enum_items (
      generation_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'uml'),
      scope_path TEXT NOT NULL,
      entity_ordinal INTEGER NOT NULL CHECK (entity_ordinal >= 0),
      item_ordinal INTEGER NOT NULL CHECK (item_ordinal >= 0),
      definition_key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path, entity_ordinal, item_ordinal),
      FOREIGN KEY (generation_id, kind, scope_path, entity_ordinal)
        REFERENCES uml_entities(generation_id, kind, scope_path, entity_ordinal) ON DELETE CASCADE
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
      definition_key TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('interface', 'type', 'enum', 'abstract', 'concrete')
      ),
      is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
      PRIMARY KEY (generation_id, kind, scope_path, category_ordinal),
      UNIQUE (generation_id, kind, scope_path, definition_key),
      FOREIGN KEY (generation_id, kind, scope_path)
        REFERENCES diagram_graphs(generation_id, kind, scope_path) ON DELETE CASCADE
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
      language TEXT CHECK (
        language IS NULL OR language IN ('typescript', 'tsx', 'javascript', 'rust')
      ),
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
  {
    name: "DefinitionIndex",
    kind: "table",
    createSql: `CREATE TABLE DefinitionIndex (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      definition_key TEXT NOT NULL,
      parent_key TEXT,
      is_top_level INTEGER NOT NULL CHECK (is_top_level IN (0, 1)),
      has_body INTEGER NOT NULL CHECK (has_body IN (0, 1)),
      source_path TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${
      FILE_DEFINITION_KINDS.map((kind) => `'${kind}'`).join(",")
    })),
      type_text TEXT,
      source_line INTEGER NOT NULL CHECK (source_line > 0),
      source_column INTEGER NOT NULL CHECK (source_column > 0),
      PRIMARY KEY (generation_id, definition_key),
      FOREIGN KEY (generation_id, parent_key)
        REFERENCES DefinitionIndex(generation_id, definition_key)
        DEFERRABLE INITIALLY DEFERRED
    )`,
  },
  {
    name: "definition_index_by_source",
    kind: "index",
    createSql: `CREATE INDEX definition_index_by_source
      ON DefinitionIndex(generation_id, source_path, source_line, source_column)`,
  },
  {
    name: "definition_index_by_parent",
    kind: "index",
    createSql: `CREATE INDEX definition_index_by_parent
      ON DefinitionIndex(generation_id, parent_key)`,
  },
  {
    name: "definition_bindings",
    kind: "table",
    createSql: `CREATE TABLE definition_bindings (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      name TEXT NOT NULL,
      space TEXT NOT NULL CHECK (space IN ('type', 'value')),
      binding_kind TEXT NOT NULL CHECK (binding_kind IN ('local', 'import', 'export')),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      target_key TEXT,
      target_module_path TEXT,
      PRIMARY KEY (generation_id, source_path, scope_key, name, space, binding_kind, ordinal),
      CHECK (
        (target_key IS NOT NULL AND target_module_path IS NULL)
        OR (target_key IS NULL AND target_module_path IS NOT NULL)
      ),
      FOREIGN KEY (generation_id, target_key)
        REFERENCES DefinitionIndex(generation_id, definition_key)
        DEFERRABLE INITIALLY DEFERRED
    )`,
  },
  {
    name: "file_imports",
    kind: "table",
    createSql: `CREATE TABLE file_imports (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      PRIMARY KEY (generation_id, source_path, target_path)
    )`,
  },
  {
    name: "definition_contributors",
    kind: "table",
    createSql: `CREATE TABLE definition_contributors (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      definition_key TEXT NOT NULL,
      source_path TEXT NOT NULL,
      contribution_kind TEXT NOT NULL CHECK (
        contribution_kind IN ('declaration', 'implementation', 'module')
      ),
      PRIMARY KEY (generation_id, definition_key, source_path, contribution_kind),
      FOREIGN KEY (generation_id, definition_key)
        REFERENCES DefinitionIndex(generation_id, definition_key)
        DEFERRABLE INITIALLY DEFERRED
    )`,
  },
] as const satisfies readonly CacheSchemaObject[];

/** Version-8 tables the rooted redesign removed; dropped child-before-parent on schema reset. */
const REMOVED_CACHE_TABLES: readonly string[] = [
  "uml_local_user_targets",
  "uml_external_user_targets",
  "uml_local_users",
  "uml_external_users",
  "uml_declaration_heritage_clauses",
  "uml_declaration_heritage_groups",
  "uml_entity_heritage_clauses",
  "uml_property_type_ids",
  "uml_method_return_type_ids",
  "uml_member_associations",
  "uml_method_return_dependencies",
  "uml_usage_edges",
  "uml_definitions",
  "uml_declarations",
  "diagram_node_aliases",
];

type CacheSchemaObjectDefinition = (typeof CACHE_SCHEMA_OBJECTS)[number];
type CacheSchemaObjectName = CacheSchemaObjectDefinition["name"];
type CacheTableName = Extract<
  CacheSchemaObjectDefinition,
  { readonly kind: "table" }
>["name"];

const CACHE_SCHEMA_BY_NAME = new Map<CacheSchemaObjectName, CacheSchemaObjectDefinition>(
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
  tree_entries: ["tree_entries", "tree_entries_by_parent"],
  diagram_edge_relations: ["diagram_edge_relations", "diagram_relations_by_source"],
  DefinitionIndex: [
    "DefinitionIndex",
    "definition_index_by_source",
    "definition_index_by_parent",
  ],
} as const satisfies Partial<Record<CacheTableName, readonly CacheSchemaObjectName[]>>;

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

function toIndexedDefinition(row: DefinitionIndexRow): IndexedFileDefinition {
  return {
    key: row.definition_key,
    parentKey: row.parent_key,
    isTopLevel: row.is_top_level !== 0,
    hasBody: row.has_body !== 0,
    name: row.name,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    type: row.type_text,
    source: {
      path: row.source_path,
      line: row.source_line,
      column: row.source_column,
    },
  };
}

function invalidMaterialization(message: string, cause?: unknown): DiagramMaterializationError {
  return new DiagramMaterializationError(message, cause === undefined ? undefined : { cause });
}

function sqliteBoolean(value: unknown, description: string): number {
  if (typeof value !== "boolean") throw invalidMaterialization(`invalid ${description}`);
  return value ? 1 : 0;
}

const NOMINAL_DEFINITION_KINDS: Record<string, true> = {
  class: true,
  interface: true,
  trait: true,
  struct: true,
  union: true,
  enum: true,
  type: true,
};

type PreparedGraphStore = {
  statements: Array<{ finalize(): void }>;
  deleteGraph(generationId: number, kind: DiagramKind, scopePath: string): void;
  insertGraph(generationId: number, graph: DiagramGraph): void;
  readGraph(generationId: number, kind: DiagramKind, scopePath: string): DiagramGraph | null;
};

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
    [number, DiagramKind, string, string, number, DiagramNodeKind, string]
  >(`
    INSERT INTO diagram_nodes(
      generation_id, kind, scope_path, node_id, node_ordinal, node_kind, name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    [number, DiagramKind, string, number, number, DiagramRelationKind, string, string]
  >(`
    INSERT INTO diagram_edge_relations(
      generation_id, kind, scope_path, edge_ordinal, relation_ordinal,
      relation_kind, source_node_id, target_node_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPackageNode = db.query<never, [number, "packages", string, string, string | null]>(`
    INSERT INTO package_graph_nodes(
      generation_id, kind, scope_path, node_id, package_path
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertUmlEntity = db.query<
    never,
    [number, "uml", string, number, string, FileDefinitionKind, string]
  >(`
    INSERT INTO uml_entities(
      generation_id, kind, scope_path, entity_ordinal, definition_key, entity_kind, name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlProperty = db.query<
    never,
    [number, "uml", string, number, number, string, string, string | null, number]
  >(`
    INSERT INTO uml_properties(
      generation_id, kind, scope_path, entity_ordinal, property_ordinal,
      definition_key, name, type, optional
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMethod = db.query<
    never,
    [number, "uml", string, number, number, string, string, string | null]
  >(`
    INSERT INTO uml_methods(
      generation_id, kind, scope_path, entity_ordinal, method_ordinal,
      definition_key, name, return_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlMemberModifier = db.query<
    never,
    [
      number,
      "uml",
      string,
      number,
      UmlDiagramGraph["memberModifiers"][number]["memberKind"],
      number,
      number,
      UmlDiagramGraph["memberModifiers"][number]["modifier"],
    ]
  >(`
    INSERT INTO uml_member_modifiers(
      generation_id, kind, scope_path, entity_ordinal, member_kind,
      member_ordinal, modifier_ordinal, modifier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlEnumItem = db.query<
    never,
    [number, "uml", string, number, number, string, string]
  >(`
    INSERT INTO uml_enum_items(
      generation_id, kind, scope_path, entity_ordinal, item_ordinal, definition_key, value
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUmlCategory = db.query<
    never,
    [number, "uml", string, number, string, UmlCategoryKind, number]
  >(`
    INSERT INTO uml_categories(
      generation_id, kind, scope_path, category_ordinal, definition_key, category, is_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    SELECT node_id AS nodeId, node_ordinal AS nodeOrdinal, node_kind AS nodeKind, name
    FROM diagram_nodes
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY node_ordinal
  `);
  const selectEdges = db.query<
    SqlBooleanRow<DiagramGraph["edges"][number], "directed">,
    GraphIdentity
  >(`
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
  const selectUmlEntities = db.query<UmlDiagramGraph["entities"][number], GraphIdentity>(`
    SELECT
      entity_ordinal AS entityOrdinal,
      definition_key AS definitionKey,
      entity_kind AS entityKind,
      name
    FROM uml_entities
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY entity_ordinal
  `);
  const selectUmlProperties = db.query<
    SqlBooleanRow<UmlDiagramGraph["properties"][number], "optional">,
    GraphIdentity
  >(`
    SELECT
      entity_ordinal AS entityOrdinal,
      property_ordinal AS propertyOrdinal,
      definition_key AS definitionKey,
      name,
      type,
      optional
    FROM uml_properties
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY entity_ordinal, property_ordinal
  `);
  const selectUmlMethods = db.query<UmlDiagramGraph["methods"][number], GraphIdentity>(`
    SELECT
      entity_ordinal AS entityOrdinal,
      method_ordinal AS methodOrdinal,
      definition_key AS definitionKey,
      name,
      return_type AS returnType
    FROM uml_methods
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY entity_ordinal, method_ordinal
  `);
  const selectUmlMemberModifiers = db.query<
    UmlDiagramGraph["memberModifiers"][number],
    GraphIdentity
  >(`
    SELECT
      entity_ordinal AS entityOrdinal,
      member_kind AS memberKind,
      member_ordinal AS memberOrdinal,
      modifier_ordinal AS modifierOrdinal,
      modifier
    FROM uml_member_modifiers
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY entity_ordinal,
      CASE member_kind WHEN 'property' THEN 0 ELSE 1 END,
      member_ordinal,
      modifier_ordinal
  `);
  const selectUmlEnumItems = db.query<UmlDiagramGraph["enumItems"][number], GraphIdentity>(`
    SELECT
      entity_ordinal AS entityOrdinal,
      item_ordinal AS itemOrdinal,
      definition_key AS definitionKey,
      value
    FROM uml_enum_items
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY entity_ordinal, item_ordinal
  `);
  const selectUmlCategories = db.query<
    SqlBooleanRow<UmlDiagramGraph["categories"][number], "isTest">,
    GraphIdentity
  >(`
    SELECT
      category_ordinal AS categoryOrdinal,
      definition_key AS definitionKey,
      category,
      is_test AS isTest
    FROM uml_categories
    WHERE generation_id = ? AND kind = ? AND scope_path = ?
    ORDER BY category_ordinal
  `);
  const selectPackageRowsPresent = db.query<{ present: number }, GraphIdentity>(`
    WITH identity(generation_id, kind, scope_path) AS (VALUES (?, ?, ?))
    SELECT EXISTS(
      SELECT 1 FROM package_graph_nodes AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path
    ) AS present
  `);
  const selectUmlRowsPresent = db.query<{ present: number }, GraphIdentity>(`
    WITH identity(generation_id, kind, scope_path) AS (VALUES (?, ?, ?))
    SELECT (
      EXISTS(SELECT 1 FROM uml_entities AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_properties AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_methods AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_member_modifiers AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_enum_items AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
      OR EXISTS(SELECT 1 FROM uml_categories AS rows JOIN identity
        ON identity.generation_id = rows.generation_id
        AND identity.kind = rows.kind AND identity.scope_path = rows.scope_path)
    ) AS present
  `);

  const statements: Array<{ finalize(): void }> = [
    deleteGraphHeader,
    insertGraphHeader,
    insertNode,
    insertEdge,
    insertRelation,
    insertPackageNode,
    insertUmlEntity,
    insertUmlProperty,
    insertUmlMethod,
    insertUmlMemberModifier,
    insertUmlEnumItem,
    insertUmlCategory,
    selectGraphHeader,
    selectNodes,
    selectEdges,
    selectRelations,
    selectPackageNodes,
    selectUmlEntities,
    selectUmlProperties,
    selectUmlMethods,
    selectUmlMemberModifiers,
    selectUmlEnumItems,
    selectUmlCategories,
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
        insertNode.run(...identity, node.nodeId, node.nodeOrdinal, node.nodeKind, node.name);
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
      for (const entity of graph.entities) {
        insertUmlEntity.run(
          ...umlIdentity,
          entity.entityOrdinal,
          entity.definitionKey,
          entity.entityKind,
          entity.name,
        );
      }
      for (const property of graph.properties) {
        insertUmlProperty.run(
          ...umlIdentity,
          property.entityOrdinal,
          property.propertyOrdinal,
          property.definitionKey,
          property.name,
          property.type,
          sqliteBoolean(property.optional, "UML property optional flag"),
        );
      }
      for (const method of graph.methods) {
        insertUmlMethod.run(
          ...umlIdentity,
          method.entityOrdinal,
          method.methodOrdinal,
          method.definitionKey,
          method.name,
          method.returnType,
        );
      }
      for (const modifier of graph.memberModifiers) {
        insertUmlMemberModifier.run(
          ...umlIdentity,
          modifier.entityOrdinal,
          modifier.memberKind,
          modifier.memberOrdinal,
          modifier.modifierOrdinal,
          modifier.modifier,
        );
      }
      for (const item of graph.enumItems) {
        insertUmlEnumItem.run(
          ...umlIdentity,
          item.entityOrdinal,
          item.itemOrdinal,
          item.definitionKey,
          item.value,
        );
      }
      for (const category of graph.categories) {
        insertUmlCategory.run(
          ...umlIdentity,
          category.categoryOrdinal,
          category.definitionKey,
          category.category,
          sqliteBoolean(category.isTest, "UML category test flag"),
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
      const base = {
        scopePath: header.scopePath,
        renderMode: header.renderMode,
        formatVersion: header.formatVersion as typeof DIAGRAM_GRAPH_FORMAT_VERSION,
        nodes: selectNodes.all(...identity),
        edges: selectEdges.all(...identity).map((edge) => ({
          ...edge,
          directed: edge.directed !== 0,
        })),
        relations: selectRelations.all(...identity),
      };
      if (header.kind === "packages") {
        return { ...base, kind: "packages", packageNodes: selectPackageNodes.all(...identity) };
      }
      return {
        ...base,
        kind: "uml",
        entities: selectUmlEntities.all(...identity),
        properties: selectUmlProperties.all(...identity).map((row) => ({
          ...row,
          optional: row.optional !== 0,
        })),
        methods: selectUmlMethods.all(...identity),
        memberModifiers: selectUmlMemberModifiers.all(...identity),
        enumItems: selectUmlEnumItems.all(...identity),
        categories: selectUmlCategories.all(...identity).map((row) => ({
          ...row,
          isTest: row.isTest !== 0,
        })),
      };
    },
  };
}

function assertPackageGraphIdentity(graph: PackageDiagramGraph): void {
  if (
    graph.kind !== "packages"
    || graph.scopePath !== ""
    || graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION
    || (graph.renderMode !== "normal" && graph.renderMode !== "bare")
    || !Array.isArray(graph.nodes)
    || !Array.isArray(graph.edges)
    || !Array.isArray(graph.relations)
    || !Array.isArray(graph.packageNodes)
  ) {
    throw invalidMaterialization("invalid package diagram graph identity");
  }
}

function assertUmlGraphIdentity(graph: UmlDiagramGraph, scopePath: string): void {
  if (
    graph.kind !== "uml"
    || typeof graph.scopePath !== "string"
    || graph.scopePath !== scopePath
    || normalizeRelativePath(graph.scopePath) !== graph.scopePath
    || graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION
  ) {
    throw invalidMaterialization("invalid UML diagram graph identity");
  }
}

function validateRenderedPackageDiagram(value: RenderedPackageDiagram): RenderedPackageDiagram {
  if (
    !value
    || typeof value !== "object"
    || value.kind !== "packages"
    || typeof value.dsl !== "string"
    || !Array.isArray(value.dsls)
    || value.dsls.some((dsl) => typeof dsl !== "string")
    || !Array.isArray(value.packageNodes)
  ) {
    throw new Error("renderer returned an invalid diagram");
  }
  return value;
}

/** Literal directory-membership predicate; percent, underscore and glob characters are inert. */
function directoryRange(path: string): { from: string; to: string } | null {
  if (!path) return null;
  return { from: `${path}/`, to: `${path}0` };
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
    // Descriptors no longer list the version-8 UML tables, so they are dropped by name first.
    for (const name of REMOVED_CACHE_TABLES) db.run(`DROP TABLE IF EXISTS "${name}"`);
    for (let index = CACHE_SCHEMA_OBJECTS.length - 1; index >= 0; index -= 1) {
      const definition = CACHE_SCHEMA_OBJECTS[index];
      if (!definition) continue;
      const objectKind = definition.kind === "trigger"
        ? "TRIGGER"
        : definition.kind === "index"
          ? "INDEX"
          : "TABLE";
      db.run(`DROP ${objectKind} IF EXISTS "${definition.name}"`);
    }
    Cache.createSchema(db);
    db.run(`PRAGMA user_version=${CACHE_SCHEMA_VERSION}`);
  }

  private readonly db!: Database;
  private readonly graphStore!: PreparedGraphStore;
  private readonly statements!: Array<{ finalize(): void }>;
  private readonly query!: ReturnType<typeof prepareQueries>;
  private readonly recoveryTransaction!: ImmediateTransaction<[number | null]>;
  private readonly discoveryTransaction!: ImmediateTransaction<
    [number, readonly PackageInfo[], CachePackageDiagramInput, PackageDiagramRenderer],
    PackageDiagramPayload
  >;
  private readonly scopeTransaction!: ImmediateTransaction<[number, CacheScopeWrite]>;
  private readonly definitionIndexTransaction!: ImmediateTransaction<
    [number, DefinitionIndexSnapshot]
  >;
  private readonly sourceSnapshotTransaction!: ImmediateTransaction<
    [number, readonly CacheFileWrite[]]
  >;
  private readonly promotionTransaction!: ImmediateTransaction<[number]>;
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
      if (version !== CACHE_SCHEMA_VERSION) {
        db.transaction(() => Cache.recreateSchema(db)).immediate();
      }

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

      this.query = prepareQueries(db);
      this.graphStore = prepareGraphStore(db);
      this.statements = [...Object.values(this.query), ...this.graphStore.statements];

      this.recoveryTransaction = db.transaction((activeGenerationId: number | null) => {
        if (activeGenerationId === null) {
          this.query.deleteActivePointer.run();
          this.query.deleteAllGenerations.run();
          return;
        }
        this.query.deleteGenerationsExcept.run(activeGenerationId);
      });

      this.discoveryTransaction = db.transaction((
        generationId: number,
        packages: readonly PackageInfo[],
        diagram: CachePackageDiagramInput,
        renderer: PackageDiagramRenderer,
      ) => {
        const response = this.materializePackageDiagram(generationId, diagram, renderer);
        this.query.upsertPackages.run(generationId, JSON.stringify(packages));
        return response;
      });

      this.scopeTransaction = db.transaction((generationId: number, scope: CacheScopeWrite) => {
        if (scope.file) {
          this.writeFileRow(generationId, scope.file);
          this.query.deleteScopeGotoDefs.run(generationId, scope.file.path);
          for (const definition of scope.definitions) {
            this.query.insertGotoDefinition.run(
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
        if (!scope.diagram) return;
        const { graph, outcome } = scope.diagram;
        assertUmlGraphIdentity(graph, graph.scopePath);
        if (outcome.status === "error" && graph.renderMode !== "bare") {
          throw invalidMaterialization("an error outcome requires a bare direct graph");
        }
        validateUmlDiagramGraph(graph);
        this.assertCatalogueIdentity(generationId, graph);
        this.graphStore.deleteGraph(generationId, "uml", graph.scopePath);
        this.graphStore.insertGraph(generationId, graph);
        const reloaded = this.graphStore.readGraph(generationId, "uml", graph.scopePath);
        if (reloaded?.kind !== "uml") {
          throw invalidMaterialization("persisted diagram graph header was not found");
        }
        try {
          validateUmlDiagramGraph(reloaded);
        } catch (error) {
          throw invalidMaterialization("invalid hydrated diagram graph", error);
        }
        this.query.upsertDiagram.run(
          generationId,
          "uml",
          graph.scopePath,
          JSON.stringify(outcome),
        );
      });

      this.definitionIndexTransaction = db.transaction((
        generationId: number,
        snapshot: DefinitionIndexSnapshot,
      ) => {
        this.query.deleteGenerationContributors.run(generationId);
        this.query.deleteGenerationBindings.run(generationId);
        this.query.deleteGenerationImports.run(generationId);
        this.query.deleteGenerationDefinitionIndex.run(generationId);
        for (const entry of snapshot.entries) {
          this.query.upsertTreeEntry.run(
            generationId,
            entry.path,
            parentPath(entry.path),
            entry.name,
            entry.kind,
            entry.viewable === true ? 1 : 0,
          );
        }
        for (const definition of snapshot.definitions) {
          this.query.insertDefinitionIndex.run(
            generationId,
            definition.key,
            definition.parentKey,
            definition.isTopLevel ? 1 : 0,
            definition.hasBody ? 1 : 0,
            definition.source.path,
            definition.name,
            definition.qualifiedName,
            definition.kind,
            definition.type,
            definition.source.line,
            definition.source.column,
          );
        }
        for (const binding of snapshot.bindings) {
          this.query.insertDefinitionBinding.run(
            generationId,
            binding.sourcePath,
            binding.scopeKey,
            binding.name,
            binding.space,
            binding.bindingKind,
            binding.ordinal,
            binding.target.kind === "definition" ? binding.target.key : null,
            binding.target.kind === "module" ? binding.target.path : null,
          );
        }
        for (const contributor of snapshot.contributors) {
          this.query.insertDefinitionContributor.run(
            generationId,
            contributor.definitionKey,
            contributor.sourcePath,
            contributor.kind,
          );
        }
        for (const edge of snapshot.imports) {
          this.query.insertFileImport.run(generationId, edge.sourcePath, edge.targetPath);
        }
      });

      this.sourceSnapshotTransaction = db.transaction((
        generationId: number,
        files: readonly CacheFileWrite[],
      ) => {
        for (const file of files) this.writeFileRow(generationId, file);
      });

      this.promotionTransaction = db.transaction((generationId: number) => {
        const result = this.query.markGenerationActive.run(Date.now(), generationId);
        if (result.changes !== 1) throw new Error(`cannot promote generation ${generationId}`);
        this.query.upsertActivePointer.run(String(generationId));
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

  /** Writes raw source without rebuilding the FTS entry when the bytes did not change. */
  private writeFileRow(generationId: number, file: CacheFileWrite): void {
    const existing = this.query.selectFileRaw.get(generationId, file.path);
    if (existing && existing.raw_content === file.rawContent) {
      this.query.updateFileDisplay.run(
        file.displayContent,
        file.sourceError,
        file.formatError,
        file.language,
        generationId,
        file.path,
      );
      return;
    }
    this.query.upsertFile.run(
      generationId,
      file.path,
      file.rawContent,
      file.displayContent,
      file.sourceError,
      file.formatError,
      file.language,
    );
  }

  /** Every UML node ID must name a catalogue definition of this generation. */
  private assertCatalogueIdentity(generationId: number, graph: UmlDiagramGraph): void {
    for (const node of graph.nodes) {
      if (!this.query.selectDefinitionByKey.get(generationId, node.nodeId)) {
        throw invalidMaterialization(`UML node is not an indexed definition: ${node.nodeId}`);
      }
    }
    if (graph.renderMode === "bare") return;
    const contributed = new Set(
      this.query.selectContributedKeys.all(generationId, graph.scopePath).map((row) => row.definition_key),
    );
    for (const entity of graph.entities) {
      if (!contributed.has(entity.definitionKey)) {
        throw invalidMaterialization(
          `UML entity has no contribution in ${graph.scopePath}: ${entity.definitionKey}`,
        );
      }
    }
  }

  private materializePackageDiagram(
    generationId: number,
    input: CachePackageDiagramInput,
    renderer: PackageDiagramRenderer,
  ): PackageDiagramPayload {
    let graph: PackageDiagramGraph | null = null;
    let fallbackRendered: RenderedPackageDiagram | null = null;
    try {
      if (!input || typeof input !== "object" || !("outcome" in input)) {
        throw new Error("missing diagram input");
      }
      if (
        (input.outcome.status === "ready" && "error" in input.outcome
          && input.outcome.error !== undefined)
        || (input.outcome.status !== "ready"
          && (input.outcome.status !== "error" || typeof input.outcome.error !== "string"))
      ) {
        throw new Error("invalid diagram outcome");
      }
      if ("graph" in input && "fallbackSource" in input) {
        throw new Error("diagram input cannot contain both graph and fallback source");
      }
      if ("graph" in input) {
        graph = input.graph;
        if (!graph || typeof graph !== "object") throw new Error("missing direct graph");
        assertPackageGraphIdentity(graph);
        if (input.outcome.status === "error" && graph.renderMode !== "bare") {
          throw new Error("an error outcome requires a bare direct graph");
        }
      } else if (!("fallbackSource" in input)) {
        throw new Error("invalid diagram input");
      }
    } catch (error) {
      if (error instanceof DiagramMaterializationError) throw error;
      throw invalidMaterialization("invalid diagram materialization input", error);
    }

    if (!("graph" in input)) {
      const source = input.fallbackSource;
      if (
        !source
        || !Number.isInteger(source.sourceGenerationId)
        || source.sourceGenerationId <= 0
        || source.sourceGenerationId === generationId
      ) {
        throw invalidMaterialization("invalid fallback source");
      }
      const sourceGraph = this.graphStore.readGraph(source.sourceGenerationId, "packages", "");
      const sourceResponseRow = this.query.selectDiagram.get(
        source.sourceGenerationId,
        "packages",
        "",
      );
      if (sourceGraph?.kind !== "packages") {
        throw invalidMaterialization("fallback source graph not found");
      }
      if (!sourceResponseRow) throw invalidMaterialization("fallback source response not found");
      try {
        validatePackageDiagramGraph(sourceGraph);
        const sourceResponse = parseJson<PackageDiagramPayload>(
          sourceResponseRow.response_json,
          "fallback diagram",
        );
        if (sourceResponse.kind !== "packages" || sourceResponse.scopePath !== "") {
          throw new Error("fallback source graph and response identity disagree");
        }
        fallbackRendered = validateRenderedPackageDiagram(sourceResponse);
      } catch (error) {
        throw invalidMaterialization("invalid fallback source", error);
      }
      graph = sourceGraph;
    }
    if (!graph) throw invalidMaterialization("diagram graph was not resolved");

    this.graphStore.deleteGraph(generationId, "packages", "");
    this.graphStore.insertGraph(generationId, graph);
    const reloaded = this.graphStore.readGraph(generationId, "packages", "");
    if (reloaded?.kind !== "packages") {
      throw invalidMaterialization("persisted diagram graph header was not found");
    }
    try {
      validatePackageDiagramGraph(reloaded);
    } catch (error) {
      throw invalidMaterialization("invalid hydrated diagram graph", error);
    }

    let rendered: RenderedPackageDiagram;
    try {
      rendered = validateRenderedPackageDiagram(renderer(reloaded));
    } catch (error) {
      if (!fallbackRendered) throw invalidMaterialization("diagram rendering failed", error);
      rendered = fallbackRendered;
    }
    const response: PackageDiagramPayload = {
      kind: "packages",
      scopePath: "",
      status: input.outcome.status,
      dsl: rendered.dsl,
      dsls: rendered.dsls,
      packageNodes: rendered.packageNodes,
      definitions: [],
      externalUsers: [],
      localUsers: [],
      ...(input.outcome.status === "error" ? { error: input.outcome.error } : {}),
    };
    this.query.upsertDiagram.run(generationId, "packages", "", JSON.stringify(response));
    return response;
  }

  recover(sourceFingerprint: string): number | null {
    const active = this.query.selectActiveGeneration.get() ?? null;
    const activeGenerationId =
      active !== null && active.source_fingerprint === sourceFingerprint ? active.id : null;
    this.recoveryTransaction.immediate(activeGenerationId);
    return activeGenerationId;
  }

  getActiveGenerationId(): number | null {
    return this.query.selectActiveGeneration.get()?.id ?? null;
  }

  hasFailedDiagrams(generationId: number): boolean {
    return this.query.selectFailedDiagram.get(generationId) !== null;
  }

  repairTableForSchemaError(error: unknown): CacheTableName | null {
    const tableName = cacheTableFromSchemaError(error);
    if (!tableName) return null;
    const tableDefinition = CACHE_SCHEMA_BY_NAME.get(tableName);
    if (tableDefinition?.kind !== "table") return null;
    const group: Partial<Record<string, readonly CacheSchemaObjectName[]>> =
      CACHE_TABLE_RECOVERY_GROUPS;
    const schemaObjects = group[tableName] ?? [tableName];
    const definitions = schemaObjects.map((name) => {
      const definition = CACHE_SCHEMA_BY_NAME.get(name);
      if (!definition) throw new Error(`cache schema descriptor not found: ${name}`);
      return definition;
    });
    const selectedObjects = new Set(schemaObjects);
    this.db.transaction(() => {
      for (let index = definitions.length - 1; index >= 0; index -= 1) {
        const definition = definitions[index];
        if (!definition) continue;
        const objectKind = definition.kind === "trigger"
          ? "TRIGGER"
          : definition.kind === "index"
            ? "INDEX"
            : "TABLE";
        this.db.run(`DROP ${objectKind} IF EXISTS "${definition.name}"`);
      }
      Cache.createSchema(this.db, selectedObjects);
    }).immediate();
    return tableName;
  }

  beginGeneration(cause: "startup" | "watch", sourceFingerprint: string): number {
    return Number(
      this.query.insertGeneration.run(cause, Date.now(), sourceFingerprint).lastInsertRowid,
    );
  }

  writeDiscovery(
    generationId: number,
    packages: readonly PackageInfo[],
    diagram: CachePackageDiagramInput,
    render: PackageDiagramRenderer,
  ): PackageDiagramPayload {
    return this.discoveryTransaction.immediate(generationId, packages, diagram, render);
  }

  /** Raw snapshots of an unpublished building generation; readers wait for index completion. */
  writeSourceSnapshots(generationId: number, files: readonly CacheFileWrite[]): void {
    this.sourceSnapshotTransaction.immediate(generationId, files);
  }

  writeScope(generationId: number, scope: CacheScopeWrite): void {
    this.scopeTransaction.immediate(generationId, scope);
  }

  writeDefinitionIndex(generationId: number, snapshot: DefinitionIndexSnapshot): void {
    this.definitionIndexTransaction.immediate(generationId, snapshot);
  }

  readTreeEntries(generationId: number): TreeNode[] {
    return this.query.selectTreeEntries.all(generationId).map((row) => this.toTreeNode(row));
  }

  readTreeChildren(generationId: number, path: string): TreeNode[] {
    const normalized = normalizeRelativePath(path);
    return this.query.selectTreeChildren
      .all(generationId, normalized, normalized)
      .map((row) => this.toTreeNode(row));
  }

  private toTreeNode(row: TreeRow): TreeNode {
    return row.kind === "file"
      ? { name: row.name, path: row.path, kind: "file", viewable: row.viewable !== 0 }
      : { name: row.name, path: row.path, kind: "directory" };
  }

  readPackages(generationId: number): PackageInfo[] {
    const row = this.query.selectPackages.get(generationId);
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
      if (graph.kind === "packages") validatePackageDiagramGraph(graph);
      else validateUmlDiagramGraph(graph);
      return graph;
    } catch (error) {
      throw invalidMaterialization("invalid hydrated diagram graph", error);
    }
  }

  readPackageDiagram(generationId: number): PackageDiagramPayload | null {
    const row = this.query.selectDiagram.get(generationId, "packages", "");
    return row ? parseJson<PackageDiagramPayload>(row.response_json, "diagram") : null;
  }

  readFile(generationId: number, path: string): CacheFileWrite | null {
    const row = this.query.selectFile.get(generationId, path);
    if (!row) return null;
    return {
      path: row.path,
      rawContent: row.raw_content,
      displayContent: row.display_content,
      sourceError: row.source_error,
      formatError: row.format_error,
      language: row.language,
    };
  }

  readDefinition(
    generationId: number,
    path: string,
    line: number,
    column: number,
  ): GotoDefinition | null {
    const row = this.query.selectDefinition.get(
      generationId,
      normalizeRelativePath(path),
      line,
      column,
    );
    return row ? toGotoDefinition(row) : null;
  }

  readDefinitions(generationId: number, path: string): EditorGotoDefinition[] {
    return this.query.selectDefinitions
      .all(generationId, normalizeRelativePath(path))
      .map((row) => ({
        ...toGotoDefinition(row),
        displayFrom: row.display_from,
        displayTo: row.display_to,
      }));
  }

  readFileDefinitions(generationId: number, path: string): FileDefinition[] {
    return this.query.selectFileDefinitions
      .all(generationId, normalizeRelativePath(path))
      .map((row) => {
        const { hasBody: _hasBody, ...definition } = toIndexedDefinition(row);
        return definition;
      });
  }

  lookupDefinition(path: string, name: string, qualifiedName: string): UmlSourceLocation | null {
    const row = this.query.selectDefinitionIndexEntry.get(
      normalizeRelativePath(path),
      name,
      qualifiedName,
    );
    return row
      ? { path: row.source_path, line: row.source_line, column: row.source_column }
      : null;
  }

  /** Prepared, generation-bound catalogue reads with per-job memoization. */
  createDefinitionResolutionIndex(generationId: number): DefinitionResolutionIndex {
    const definitionCache = new Map<string, IndexedFileDefinition | undefined>();
    const fileCache = new Map<string, IndexedFileDefinition[]>();
    const memberCache = new Map<string, IndexedFileDefinition[]>();
    const bindingCache = new Map<string, DefinitionBindingTarget[]>();
    const definition = (key: string): IndexedFileDefinition | undefined => {
      if (definitionCache.has(key)) return definitionCache.get(key);
      const row = this.query.selectDefinitionByKey.get(generationId, key);
      const value = row ? toIndexedDefinition(row) : undefined;
      definitionCache.set(key, value);
      return value;
    };
    return {
      definition,
      definitions: (path) => {
        const cached = fileCache.get(path);
        if (cached) return cached;
        const rows = this.query.selectFileDefinitions.all(generationId, path).map(toIndexedDefinition);
        fileCache.set(path, rows);
        return rows;
      },
      members: (parentKey) => {
        const cached = memberCache.get(parentKey);
        if (cached) return cached;
        const rows = this.query.selectDefinitionChildren
          .all(generationId, parentKey)
          .map(toIndexedDefinition);
        for (const contributor of this.query.selectContributors.all(generationId, parentKey)) {
          if (contributor.contribution_kind !== "module") continue;
          rows.push(
            ...this.query.selectFileDefinitions
              .all(generationId, contributor.source_path)
              .map(toIndexedDefinition)
              .filter((entry) => entry.isTopLevel),
          );
        }
        memberCache.set(parentKey, rows);
        return rows;
      },
      bindings: (path, scopeKey, name, space, exported) => {
        const cacheKey = JSON.stringify([path, scopeKey, name, space, exported]);
        const cached = bindingCache.get(cacheKey);
        if (cached) return cached;
        const rows = exported
          ? this.query.selectExportBindings.all(generationId, path, scopeKey, name, space)
          : this.query.selectLocalBindings.all(generationId, path, scopeKey, name, space);
        let targets = toBindingTargets(rows);
        if (!exported && !targets.length) {
          targets = toBindingTargets(
            this.query.selectImportBindings.all(generationId, path, scopeKey, name, space),
          );
        }
        bindingCache.set(cacheKey, targets);
        return targets;
      },
    };
  }

  /** The rooted UML selection, or the set of file graphs that must be preprocessed first. */
  readUmlDiagram(generationId: number, target: UmlTarget): UmlDiagramRead {
    const path = normalizeRelativePath(target.path);
    if (target.kind === "directory") {
      return { state: "complete", diagram: this.readDirectoryDiagram(generationId, target, path) };
    }
    return this.readDefinitionDiagram(generationId, target, path);
  }

  private assertTreeKind(
    generationId: number,
    path: string,
    kind: "directory" | "file",
  ): void {
    if (path === "") {
      if (kind !== "directory") {
        throw new PathError("BAD_REQUEST", "diagram target kind does not match path");
      }
      return;
    }
    const entry = this.query.selectTreeEntry.get(generationId, path);
    if (!entry) throw new PathError("NOT_FOUND", `path not found: ${path}`);
    if (entry.kind !== kind) {
      throw new PathError("BAD_REQUEST", "diagram target kind does not match path");
    }
  }

  private readDirectoryDiagram(
    generationId: number,
    target: UmlTarget,
    path: string,
  ): UmlDiagramPayload {
    this.assertTreeKind(generationId, path, "directory");
    const range = directoryRange(path);
    const inside = range
      ? this.query.selectDirectoryFiles.all(generationId, range.from, range.to)
      : this.query.selectAllFiles.all(generationId);
    const insidePaths = new Set(inside.map((row) => row.path));
    const edges = (range
      ? this.query.selectDirectoryImports.all(generationId, range.from, range.to)
      : this.query.selectAllImports.all(generationId))
      .map((row) => ({ sourcePath: row.source_path, targetPath: row.target_path }));
    const nodePaths = new Map<string, boolean>();
    for (const row of inside) nodePaths.set(row.path, false);
    for (const edge of edges) {
      if (!nodePaths.has(edge.targetPath)) nodePaths.set(edge.targetPath, true);
    }
    for (const filePath of insidePaths) {
      // Only source files feed the catalogue; a binary asset's decode failure is not a graph error.
      if (!isSourcePath(filePath)) continue;
      const record = this.query.selectFile.get(generationId, filePath);
      if (!record?.source_error) continue;
      return {
        kind: "uml",
        scopePath: path,
        target,
        status: "error",
        view: { kind: "files", nodes: [], edges: [] },
        error: `${filePath}: ${record.source_error}`,
      };
    }
    const nodes = [...nodePaths.entries()]
      .map(([nodePath, boundary]) => ({
        path: nodePath,
        boundary,
        test: isTestPath(nodePath),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    edges.sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath)
      || left.targetPath.localeCompare(right.targetPath)
    );
    return {
      kind: "uml",
      scopePath: path,
      target,
      status: "ready",
      view: { kind: "files", nodes, edges },
    };
  }

  private readDefinitionDiagram(
    generationId: number,
    target: UmlTarget,
    path: string,
  ): UmlDiagramRead {
    this.assertTreeKind(generationId, path, "file");
    const record = this.query.selectFile.get(generationId, path);
    if (record?.source_error) {
      return {
        state: "complete",
        diagram: {
          kind: "uml",
          scopePath: path,
          target,
          status: "error",
          view: { kind: "definitions", nodes: [], edges: [], frames: [] },
          error: record.source_error,
        },
      };
    }
    let roots: IndexedFileDefinition[];
    if (target.kind === "definition") {
      const row = this.query.selectDefinitionByKey.get(generationId, target.definitionKey);
      if (!row || row.source_path !== path) {
        throw new PathError("NOT_FOUND", "Definition not found");
      }
      roots = [toIndexedDefinition(row)];
    } else {
      roots = this.query.selectTopLevelDefinitions.all(generationId, path).map(toIndexedDefinition);
    }

    const reader = new UmlSelectionReader(this.query, this.graphStore, generationId);
    const frames: { rootKey: string; nodeKeys: string[] }[] = [];
    const visibleKeys = new Set<string>();
    const edges = new Map<string, UmlDefinitionEdge>();
    for (const root of roots) {
      const frame = reader.closure(root.key);
      if (reader.missing.size || reader.error) break;
      frames.push({ rootKey: root.key, nodeKeys: [...frame.keys].sort() });
      for (const key of frame.keys) visibleKeys.add(key);
      for (const edge of frame.edges) edges.set(`${edge.sourceKey}\u0000${edge.targetKey}\u0000${edge.kind}`, edge);
    }
    if (reader.missing.size) return { state: "pending", files: [...reader.missing].sort() };
    if (reader.error) {
      return {
        state: "complete",
        diagram: {
          kind: "uml",
          scopePath: path,
          target,
          status: "error",
          view: { kind: "definitions", nodes: [], edges: [], frames: [] },
          error: reader.error,
        },
      };
    }
    const nodes = [...visibleKeys]
      .map((key) => reader.node(key))
      .filter((node): node is UmlDefinitionNode => node !== undefined)
      .sort((left, right) =>
        left.definition.source.path.localeCompare(right.definition.source.path)
        || left.definition.source.line - right.definition.source.line
        || left.definition.source.column - right.definition.source.column
        || left.definition.key.localeCompare(right.definition.key)
      );
    const view: UmlViewModel = {
      kind: "definitions",
      nodes,
      edges: [...edges.values()].sort((left, right) =>
        left.sourceKey.localeCompare(right.sourceKey)
        || left.targetKey.localeCompare(right.targetKey)
        || left.kind.localeCompare(right.kind)
      ),
      frames,
    };
    return {
      state: "complete",
      diagram: { kind: "uml", scopePath: path, target, status: "ready", view },
    };
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
      ? this.query.selectIndexedSearchCandidates.all(generationId, likeQuery)
      : this.query.selectScanSearchCandidates.all(generationId);
    const definitionCandidates = indexed
      ? this.query.selectIndexedDefinitionCandidates.all(generationId, likeQuery, likeQuery)
      : this.query.selectScanDefinitionCandidates.all(generationId);
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
      ) continue;
      retainedDefinitions.set(`${candidate.source_path}\0${candidate.definition_key}`, candidate);
      paths.add(candidate.source_path);
    }
    const definitionRows = [...retainedDefinitions.values()].sort((left, right) =>
      left.source_path.localeCompare(right.source_path)
      || left.source_line - right.source_line
      || left.source_column - right.source_column
      || left.definition_key.localeCompare(right.definition_key)
    );
    const files = [...paths].sort((left, right) => left.localeCompare(right));
    return {
      query,
      caseInsensitive,
      files,
      definitions: definitionRows.map(toGotoDefinition),
      ...buildSearchScopes(files, this.readPackages(generationId)),
    };
  }

  promoteGeneration(generationId: number): void {
    this.promotionTransaction.immediate(generationId);
    this.query.deleteGenerationsExcept.run(generationId);
    this.query.optimizeSearch.run();
    this.query.optimizeGotoDefinitionSearch.run();
  }

  discardGeneration(generationId: number): void {
    if (this.query.selectActiveGeneration.get()?.id === generationId) {
      throw new Error(`cannot discard active generation ${generationId}`);
    }
    this.query.deleteInactiveGeneration.run(generationId);
  }

  failGeneration(generationId: number): void {
    this.query.markGenerationFailed.run(Date.now(), generationId);
  }

  close(): void {
    if (this.closed) return;
    for (const statement of this.statements) statement.finalize();
    this.db.close(true);
    this.closed = true;
  }
}

function toBindingTargets(rows: readonly BindingRow[]): DefinitionBindingTarget[] {
  return rows.map((row) =>
    row.target_key !== null
      ? { kind: "definition", key: row.target_key } as const
      : { kind: "module", path: row.target_module_path ?? "" } as const
  );
}

/**
 * One selection read: breadth-first closures over effective adjacency, with per-read memoization
 * of owner expansion, file graphs and assembled nodes.
 */
class UmlSelectionReader {
  readonly missing = new Set<string>();
  error: string | undefined;
  private readonly adjacency = new Map<string, { targetKey: string; kind: UmlRelationKind }[]>();
  private readonly hydrated = new Map<string, HydratedFileNominalModel | null>();
  private readonly nodes = new Map<string, UmlDefinitionNode | undefined>();
  private readonly definitions = new Map<string, IndexedFileDefinition | undefined>();

  constructor(
    private readonly query: ReturnType<typeof prepareQueries>,
    private readonly graphStore: PreparedGraphStore,
    private readonly generationId: number,
  ) {}

  private definition(key: string): IndexedFileDefinition | undefined {
    if (this.definitions.has(key)) return this.definitions.get(key);
    const row = this.query.selectDefinitionByKey.get(this.generationId, key);
    const value = row ? toIndexedDefinition(row) : undefined;
    this.definitions.set(key, value);
    return value;
  }

  private fileGraph(scopePath: string): HydratedFileNominalModel | null {
    if (this.hydrated.has(scopePath)) return this.hydrated.get(scopePath) ?? null;
    const outcomeRow = this.query.selectDiagram.get(this.generationId, "uml", scopePath);
    if (!outcomeRow) {
      this.missing.add(scopePath);
      this.hydrated.set(scopePath, null);
      return null;
    }
    const outcome = parseJson<UmlFileOutcome>(outcomeRow.response_json, "uml outcome");
    if (outcome.status === "error") {
      this.error ??= `${scopePath}: ${outcome.error}`;
      this.hydrated.set(scopePath, null);
      return null;
    }
    const graph = this.graphStore.readGraph(this.generationId, "uml", scopePath);
    const model = graph && graph.kind === "uml" ? hydrateUmlNominalModel(graph) : null;
    this.hydrated.set(scopePath, model);
    return model;
  }

  /** Every definition whose references a visible node absorbs: itself, its descendants, modules. */
  private owners(key: string): string[] {
    const owners: string[] = [];
    const seen = new Set<string>();
    const queue = [key];
    while (queue.length) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      owners.push(current);
      for (const child of this.query.selectDefinitionChildren.all(this.generationId, current)) {
        queue.push(child.definition_key);
      }
      for (const contributor of this.query.selectContributors.all(this.generationId, current)) {
        if (contributor.contribution_kind !== "module") continue;
        for (const row of this.query.selectFileDefinitions.all(this.generationId, contributor.source_path)) {
          queue.push(row.definition_key);
        }
      }
    }
    return owners;
  }

  effectiveAdjacency(key: string): { targetKey: string; kind: UmlRelationKind }[] {
    const cached = this.adjacency.get(key);
    if (cached) return cached;
    const seen = new Set<string>();
    const out: { targetKey: string; kind: UmlRelationKind }[] = [];
    for (const owner of this.owners(key)) {
      const contributors = this.query.selectContributors.all(this.generationId, owner);
      for (const contributor of contributors) this.fileGraph(contributor.source_path);
      for (const relation of this.query.selectOutgoingRelations.all(this.generationId, owner)) {
        const guard = `${relation.target_node_id}\u0000${relation.relation_kind}`;
        if (seen.has(guard)) continue;
        seen.add(guard);
        out.push({ targetKey: relation.target_node_id, kind: relation.relation_kind });
      }
    }
    this.adjacency.set(key, out);
    return out;
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let key: string | null | undefined = candidate;
    const guard = new Set<string>();
    while (key) {
      if (guard.has(key)) return false;
      guard.add(key);
      const definition = this.definition(key);
      if (!definition) return false;
      if (definition.parentKey === ancestor) return true;
      key = definition.parentKey;
    }
    return false;
  }

  closure(rootKey: string): { keys: Set<string>; edges: UmlDefinitionEdge[] } {
    const keys = new Set<string>();
    const edges: UmlDefinitionEdge[] = [];
    const queue = [rootKey];
    while (queue.length) {
      const key = queue.shift();
      if (key === undefined || keys.has(key)) continue;
      if (!this.definition(key)) continue;
      keys.add(key);
      const source = this.definition(key);
      const nominal = source !== undefined && NOMINAL_DEFINITION_KINDS[source.kind] === true;
      for (const edge of this.effectiveAdjacency(key)) {
        if (this.missing.size || this.error) return { keys, edges };
        // A nominal box absorbs references to its own members instead of drawing them.
        if (nominal && this.isDescendant(edge.targetKey, key)) continue;
        if (!this.definition(edge.targetKey)) continue;
        // A recursive reference stays in SQL; the view never draws a self arrow.
        if (edge.targetKey === key) continue;
        edges.push({ sourceKey: key, targetKey: edge.targetKey, kind: edge.kind });
        queue.push(edge.targetKey);
      }
    }
    return { keys, edges: edges.filter((edge) => keys.has(edge.targetKey)) };
  }

  node(key: string): UmlDefinitionNode | undefined {
    if (this.nodes.has(key)) return this.nodes.get(key);
    const definition = this.definition(key);
    if (!definition) {
      this.nodes.set(key, undefined);
      return undefined;
    }
    const contributors = this.query.selectContributors.all(this.generationId, key);
    let detail: UmlEntityModel | null = null;
    let category: UmlCategoryKind | null = null;
    const memberKeys: string[] = [];
    const seenMembers = new Set<string>();
    for (const contributor of contributors) {
      const model = this.fileGraph(contributor.source_path);
      const entity = model?.entities.get(key);
      if (!entity) continue;
      if (!detail || contributor.source_path === definition.source.path) {
        detail = detail
          ? { ...entity, properties: detail.properties, methods: detail.methods, items: detail.items }
          : { ...entity, properties: [], methods: [], items: [] };
      }
      for (const property of entity.properties) {
        if (seenMembers.has(property.definitionKey)) continue;
        seenMembers.add(property.definitionKey);
        detail.properties.push(property);
        memberKeys.push(property.definitionKey);
      }
      for (const method of entity.methods) {
        if (seenMembers.has(method.definitionKey)) continue;
        seenMembers.add(method.definitionKey);
        detail.methods.push(method);
        memberKeys.push(method.definitionKey);
      }
      for (const item of entity.items) {
        if (seenMembers.has(item.definitionKey)) continue;
        seenMembers.add(item.definitionKey);
        detail.items.push(item);
        memberKeys.push(item.definitionKey);
      }
      const hydratedCategory = model?.categories.get(key);
      if (hydratedCategory && (category === null || contributor.source_path === definition.source.path)) {
        category = hydratedCategory.category;
      }
    }
    const memberDefinitions = memberKeys
      .flatMap((memberKey) => {
        const member = this.definition(memberKey);
        if (!member) return [];
        const { hasBody: _hasBody, ...value } = member;
        return [value];
      })
      .sort((left, right) =>
        left.source.path.localeCompare(right.source.path)
        || left.source.line - right.source.line
        || left.source.column - right.source.column
      );
    if (detail) {
      const order = new Map(memberDefinitions.map((member, index) => [member.key, index]));
      const byOrder = (left: { definitionKey: string }, right: { definitionKey: string }): number =>
        (order.get(left.definitionKey) ?? 0) - (order.get(right.definitionKey) ?? 0);
      detail.properties.sort(byOrder);
      detail.methods.sort(byOrder);
      detail.items.sort(byOrder);
    }
    const { hasBody: _hasBody, ...plain } = definition;
    const node: UmlDefinitionNode = {
      definition: plain,
      detail,
      category,
      memberDefinitions,
      test: isTestPath(definition.source.path),
    };
    this.nodes.set(key, node);
    return node;
  }
}

function prepareQueries(db: Database) {
  return {
    selectActiveGeneration: db.query<ActiveGenerationRow, []>(`
      SELECT generations.id AS id, generations.source_fingerprint AS source_fingerprint
      FROM cache_meta
      JOIN generations
        ON generations.id = CAST(cache_meta.value AS INTEGER)
        AND generations.state = 'active'
      WHERE cache_meta.key = 'active_generation'
    `),
    deleteActivePointer: db.query<never, []>(
      "DELETE FROM cache_meta WHERE key = 'active_generation'",
    ),
    deleteGenerationsExcept: db.query<never, [number]>("DELETE FROM generations WHERE id <> ?"),
    deleteAllGenerations: db.query<never, []>("DELETE FROM generations"),
    insertGeneration: db.query<never, ["startup" | "watch", number, string]>(`
      INSERT INTO generations(state, cause, started_at, source_fingerprint)
      VALUES ('building', ?, ?, ?)
    `),
    upsertPackages: db.query<never, [number, string]>(`
      INSERT INTO package_snapshots(generation_id, packages_json)
      VALUES (?, ?)
      ON CONFLICT(generation_id) DO UPDATE SET packages_json = excluded.packages_json
    `),
    upsertTreeEntry: db.query<
      never,
      [number, string, string, string, "directory" | "file", number]
    >(`
      INSERT INTO tree_entries(generation_id, path, parent_path, name, kind, viewable)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, path) DO UPDATE SET
        parent_path = excluded.parent_path,
        name = excluded.name,
        kind = excluded.kind,
        viewable = excluded.viewable
    `),
    upsertDiagram: db.query<never, [number, DiagramKind, string, string]>(`
      INSERT INTO diagrams(generation_id, kind, scope_path, response_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(generation_id, kind, scope_path) DO UPDATE SET
        response_json = excluded.response_json
    `),
    upsertFile: db.query<
      never,
      [number, string, string | null, string | null, string | null, string | null, LanguageId | null]
    >(`
      INSERT INTO files(
        generation_id, path, raw_content, display_content, source_error, format_error, language
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, path) DO UPDATE SET
        raw_content = excluded.raw_content,
        display_content = excluded.display_content,
        source_error = excluded.source_error,
        format_error = excluded.format_error,
        language = excluded.language
    `),
    selectFileRaw: db.query<{ raw_content: string | null }, [number, string]>(
      "SELECT raw_content FROM files WHERE generation_id = ? AND path = ?",
    ),
    updateFileDisplay: db.query<
      never,
      [string | null, string | null, string | null, LanguageId | null, number, string]
    >(`
      UPDATE files
      SET display_content = ?, source_error = ?, format_error = ?, language = ?
      WHERE generation_id = ? AND path = ?
    `),
    deleteScopeGotoDefs: db.query<never, [number, string]>(
      "DELETE FROM GotoDef WHERE generation_id = ? AND source_path = ?",
    ),
    insertGotoDefinition: db.query<never, [
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
        generation_id, definition_key, kind, name, qualified_name, source_path,
        source_line, source_column, display_from, display_to, uml_scope_path,
        uml_entity_name, uml_member_name, uml_member_occurrence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteGenerationDefinitionIndex: db.query<never, [number]>(
      "DELETE FROM DefinitionIndex WHERE generation_id = ?",
    ),
    deleteGenerationBindings: db.query<never, [number]>(
      "DELETE FROM definition_bindings WHERE generation_id = ?",
    ),
    deleteGenerationContributors: db.query<never, [number]>(
      "DELETE FROM definition_contributors WHERE generation_id = ?",
    ),
    deleteGenerationImports: db.query<never, [number]>(
      "DELETE FROM file_imports WHERE generation_id = ?",
    ),
    insertDefinitionIndex: db.query<never, [
      number,
      string,
      string | null,
      number,
      number,
      string,
      string,
      string,
      FileDefinitionKind,
      string | null,
      number,
      number,
    ]>(`
      INSERT INTO DefinitionIndex(
        generation_id, definition_key, parent_key, is_top_level, has_body,
        source_path, name, qualified_name, kind, type_text, source_line, source_column
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertDefinitionBinding: db.query<never, [
      number,
      string,
      string,
      string,
      DefinitionBindingSpace,
      "local" | "import" | "export",
      number,
      string | null,
      string | null,
    ]>(`
      INSERT INTO definition_bindings(
        generation_id, source_path, scope_key, name, space, binding_kind,
        ordinal, target_key, target_module_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertDefinitionContributor: db.query<
      never,
      [number, string, string, "declaration" | "implementation" | "module"]
    >(`
      INSERT INTO definition_contributors(
        generation_id, definition_key, source_path, contribution_kind
      ) VALUES (?, ?, ?, ?)
    `),
    insertFileImport: db.query<never, [number, string, string]>(`
      INSERT INTO file_imports(generation_id, source_path, target_path) VALUES (?, ?, ?)
    `),
    selectDefinitionIndexEntry: db.query<DefinitionLocationRow, [string, string, string]>(`
      SELECT source_path, source_line, source_column
      FROM DefinitionIndex
      WHERE generation_id = (SELECT MAX(generation_id) FROM DefinitionIndex)
        AND source_path = ?
        AND name = ?
        AND qualified_name = ?
      ORDER BY source_line, source_column
      LIMIT 1
    `),
    selectFileDefinitions: db.query<DefinitionIndexRow, [number, string]>(`
      SELECT definition_key, parent_key, is_top_level, has_body, name, qualified_name,
        kind, type_text, source_path, source_line, source_column
      FROM DefinitionIndex
      WHERE generation_id = ? AND source_path = ?
      ORDER BY source_line, source_column, definition_key
    `),
    selectTopLevelDefinitions: db.query<DefinitionIndexRow, [number, string]>(`
      SELECT definition_key, parent_key, is_top_level, has_body, name, qualified_name,
        kind, type_text, source_path, source_line, source_column
      FROM DefinitionIndex
      WHERE generation_id = ? AND source_path = ? AND is_top_level = 1
      ORDER BY source_line, source_column, definition_key
    `),
    selectDefinitionByKey: db.query<DefinitionIndexRow, [number, string]>(`
      SELECT definition_key, parent_key, is_top_level, has_body, name, qualified_name,
        kind, type_text, source_path, source_line, source_column
      FROM DefinitionIndex
      WHERE generation_id = ? AND definition_key = ?
    `),
    selectDefinitionChildren: db.query<DefinitionIndexRow, [number, string]>(`
      SELECT definition_key, parent_key, is_top_level, has_body, name, qualified_name,
        kind, type_text, source_path, source_line, source_column
      FROM DefinitionIndex
      WHERE generation_id = ? AND parent_key = ?
      ORDER BY source_path, source_line, source_column, definition_key
    `),
    selectContributors: db.query<ContributorRow, [number, string]>(`
      SELECT source_path, contribution_kind
      FROM definition_contributors
      WHERE generation_id = ? AND definition_key = ?
      ORDER BY source_path, contribution_kind
    `),
    selectContributedKeys: db.query<{ definition_key: string }, [number, string]>(`
      SELECT definition_key
      FROM definition_contributors
      WHERE generation_id = ? AND source_path = ?
    `),
    selectOutgoingRelations: db.query<RelationRow, [number, string]>(`
      SELECT DISTINCT target_node_id, relation_kind
      FROM diagram_edge_relations
      WHERE generation_id = ? AND source_node_id = ? AND kind = 'uml'
      ORDER BY target_node_id, relation_kind
    `),
    selectLocalBindings: db.query<
      BindingRow,
      [number, string, string, string, DefinitionBindingSpace]
    >(`
      SELECT target_key, target_module_path
      FROM definition_bindings
      WHERE generation_id = ? AND source_path = ? AND scope_key = ?
        AND name = ? AND space = ? AND binding_kind = 'local'
      ORDER BY ordinal
    `),
    selectImportBindings: db.query<
      BindingRow,
      [number, string, string, string, DefinitionBindingSpace]
    >(`
      SELECT target_key, target_module_path
      FROM definition_bindings
      WHERE generation_id = ? AND source_path = ? AND scope_key = ?
        AND name = ? AND space = ? AND binding_kind = 'import'
      ORDER BY ordinal
    `),
    selectExportBindings: db.query<
      BindingRow,
      [number, string, string, string, DefinitionBindingSpace]
    >(`
      SELECT target_key, target_module_path
      FROM definition_bindings
      WHERE generation_id = ? AND source_path = ? AND scope_key = ?
        AND name = ? AND space = ? AND binding_kind = 'export'
      ORDER BY ordinal
    `),
    selectTreeEntries: db.query<TreeRow, [number]>(`
      SELECT path, name, kind, viewable
      FROM tree_entries
      WHERE generation_id = ?
      ORDER BY path
    `),
    selectTreeChildren: db.query<TreeRow, [number, string, string]>(`
      SELECT path, name, kind, viewable
      FROM tree_entries
      WHERE generation_id = ? AND parent_path = ? AND path <> ?
      ORDER BY path
    `),
    selectTreeEntry: db.query<TreeRow, [number, string]>(`
      SELECT path, name, kind, viewable
      FROM tree_entries
      WHERE generation_id = ? AND path = ?
    `),
    selectDirectoryFiles: db.query<{ path: string }, [number, string, string]>(`
      SELECT path FROM tree_entries
      WHERE generation_id = ? AND kind = 'file' AND path >= ? AND path < ?
      ORDER BY path
    `),
    selectAllFiles: db.query<{ path: string }, [number]>(`
      SELECT path FROM tree_entries WHERE generation_id = ? AND kind = 'file' ORDER BY path
    `),
    selectDirectoryImports: db.query<
      { source_path: string; target_path: string },
      [number, string, string]
    >(`
      SELECT source_path, target_path FROM file_imports
      WHERE generation_id = ? AND source_path >= ? AND source_path < ?
    `),
    selectAllImports: db.query<{ source_path: string; target_path: string }, [number]>(`
      SELECT source_path, target_path FROM file_imports WHERE generation_id = ?
    `),
    selectPackages: db.query<PackageRow, [number]>(`
      SELECT packages_json FROM package_snapshots WHERE generation_id = ?
    `),
    selectDiagram: db.query<DiagramRow, [number, DiagramKind, string]>(`
      SELECT response_json FROM diagrams
      WHERE generation_id = ? AND kind = ? AND scope_path = ?
    `),
    selectFailedDiagram: db.query<{ scope_path: string }, [number]>(`
      SELECT scope_path FROM diagrams
      WHERE generation_id = ? AND json_extract(response_json, '$.status') = 'error'
      LIMIT 1
    `),
    selectFile: db.query<FileRow, [number, string]>(`
      SELECT path, raw_content, display_content, source_error, format_error, language
      FROM files WHERE generation_id = ? AND path = ?
    `),
    selectDefinition: db.query<GotoDefinitionRow, [number, string, number, number]>(`
      SELECT definition_key, kind, name, qualified_name, source_path, source_line,
        source_column, display_from, display_to, uml_scope_path, uml_entity_name,
        uml_member_name, uml_member_occurrence
      FROM GotoDef
      WHERE generation_id = ? AND source_path = ? AND source_line = ? AND source_column = ?
      ORDER BY definition_key
      LIMIT 1
    `),
    selectDefinitions: db.query<GotoDefinitionRow, [number, string]>(`
      SELECT definition_key, kind, name, qualified_name, source_path, source_line,
        source_column, display_from, display_to, uml_scope_path, uml_entity_name,
        uml_member_name, uml_member_occurrence
      FROM GotoDef
      WHERE generation_id = ? AND source_path = ?
      ORDER BY source_line, source_column, definition_key
    `),
    selectIndexedSearchCandidates: db.query<SearchCandidateRow, [number, string]>(`
      SELECT files.path AS path, files.raw_content AS raw_content
      FROM file_search
      JOIN files ON file_search.rowid = files.id
      WHERE files.generation_id = ? AND file_search.raw_content LIKE ?
    `),
    selectScanSearchCandidates: db.query<SearchCandidateRow, [number]>(`
      SELECT path, raw_content FROM files
      WHERE generation_id = ? AND raw_content IS NOT NULL
    `),
    selectIndexedDefinitionCandidates: db.query<GotoDefinitionRow, [number, string, string]>(`
      SELECT GotoDef.definition_key, GotoDef.kind, GotoDef.name, GotoDef.qualified_name,
        GotoDef.source_path, GotoDef.source_line, GotoDef.source_column,
        GotoDef.display_from, GotoDef.display_to, GotoDef.uml_scope_path,
        GotoDef.uml_entity_name, GotoDef.uml_member_name, GotoDef.uml_member_occurrence
      FROM goto_def_search
      JOIN GotoDef ON goto_def_search.rowid = GotoDef.id
      WHERE GotoDef.generation_id = ?
        AND (goto_def_search.name LIKE ? OR goto_def_search.qualified_name LIKE ?)
    `),
    selectScanDefinitionCandidates: db.query<GotoDefinitionRow, [number]>(`
      SELECT definition_key, kind, name, qualified_name, source_path, source_line,
        source_column, display_from, display_to, uml_scope_path, uml_entity_name,
        uml_member_name, uml_member_occurrence
      FROM GotoDef WHERE generation_id = ?
    `),
    markGenerationActive: db.query<never, [number, number]>(`
      UPDATE generations SET state = 'active', completed_at = ?
      WHERE id = ? AND state IN ('building', 'active')
    `),
    upsertActivePointer: db.query<never, [string]>(`
      INSERT INTO cache_meta(key, value) VALUES ('active_generation', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    deleteInactiveGeneration: db.query<never, [number]>(
      "DELETE FROM generations WHERE id = ? AND state <> 'active'",
    ),
    markGenerationFailed: db.query<never, [number, number]>(`
      UPDATE generations SET state = 'failed', completed_at = ?
      WHERE id = ? AND state = 'building'
    `),
    optimizeSearch: db.query<never, []>(
      "INSERT INTO file_search(file_search) VALUES ('optimize')",
    ),
    optimizeGotoDefinitionSearch: db.query<never, []>(
      "INSERT INTO goto_def_search(goto_def_search) VALUES ('optimize')",
    ),
  };
}
