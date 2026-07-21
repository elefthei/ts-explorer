import { mkdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Database } from "bun:sqlite";
import { normalizeRelativePath } from "./paths.ts";
import { buildSearchScopes } from "./search.ts";
import type {
  DiagramResponse,
  EditorGotoDefinition,
  GotoDefinition,
  GotoDefinitionKind,
  PackageInfo,
  SearchResponse,
  TreeNode,
} from "./types.ts";

export const CACHE_SCHEMA_VERSION = 2;

export type CacheDiagramResponse = Omit<DiagramResponse, "version">;

export type CacheFileWrite = {
  path: string;
  rawContent: string | null;
  displayContent: string | null;
  sourceError: string | null;
  formatError: string | null;
};

export type CacheFileRecord = CacheFileWrite;
export type CacheGotoDefinitionWrite = EditorGotoDefinition;

export type CacheScopeWrite = {
  entries: readonly TreeNode[];
  diagram: CacheDiagramResponse;
  file?: CacheFileWrite;
  definitions: readonly CacheGotoDefinitionWrite[];
};

export type ExplorerCacheDatabase = {
  readonly dbPath: string;
  recover(): number | null;
  getActiveGenerationId(): number | null;
  beginGeneration(cause: "startup" | "watch"): number;
  writeDiscovery(
    generationId: number,
    packages: readonly PackageInfo[],
    packagesDiagram: CacheDiagramResponse,
  ): void;
  writeScope(generationId: number, scope: CacheScopeWrite): void;
  readTreeEntries(generationId: number): TreeNode[];
  readPackages(generationId: number): PackageInfo[];
  readDiagram(
    generationId: number,
    kind: CacheDiagramResponse["kind"],
    scopePath: string,
  ): CacheDiagramResponse | null;
  readFile(generationId: number, path: string): CacheFileRecord | null;
  readDefinition(
    generationId: number,
    path: string,
    line: number,
    column: number,
  ): GotoDefinition | null;
  readDefinitions(generationId: number, path: string): EditorGotoDefinition[];
  searchFiles(generationId: number, query: string): Omit<SearchResponse, "version">;
  promoteGeneration(generationId: number): void;
  discardGeneration(generationId: number): void;
  failGeneration(generationId: number): void;
  close(): void;
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

const SCHEMA_OBJECTS = [
  "cache_meta",
  "generations",
  "package_snapshots",
  "tree_entries",
  "diagrams",
  "files",
  "file_search",
  "files_ai",
  "files_bd",
  "files_bu",
  "files_au",
  "GotoDef",
  "goto_def_search",
  "goto_def_ai",
  "goto_def_bd",
  "goto_def_bu",
  "goto_def_au",
] as const;

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE generations (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('building', 'active', 'failed')),
      cause TEXT NOT NULL CHECK (cause IN ('startup', 'watch')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE package_snapshots (
      generation_id INTEGER PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
      packages_json TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE tree_entries (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
      viewable INTEGER NOT NULL,
      PRIMARY KEY (generation_id, path)
    )
  `);
  db.run(`
    CREATE TABLE diagrams (
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('packages', 'uml')),
      scope_path TEXT NOT NULL,
      response_json TEXT NOT NULL,
      PRIMARY KEY (generation_id, kind, scope_path)
    )
  `);
  db.run(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      raw_content TEXT,
      display_content TEXT,
      source_error TEXT,
      format_error TEXT,
      UNIQUE (generation_id, path)
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE file_search USING fts5(
      raw_content,
      content='files',
      content_rowid='id',
      tokenize='trigram'
    )
  `);
  db.run(`
    CREATE TRIGGER files_ai AFTER INSERT ON files
    WHEN NEW.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(rowid, raw_content) VALUES (NEW.id, NEW.raw_content);
    END
  `);
  db.run(`
    CREATE TRIGGER files_bd BEFORE DELETE ON files
    WHEN OLD.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(file_search, rowid, raw_content)
      VALUES ('delete', OLD.id, OLD.raw_content);
    END
  `);
  db.run(`
    CREATE TRIGGER files_bu BEFORE UPDATE OF raw_content ON files
    WHEN OLD.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(file_search, rowid, raw_content)
      VALUES ('delete', OLD.id, OLD.raw_content);
    END
  `);
  db.run(`
    CREATE TRIGGER files_au AFTER UPDATE OF raw_content ON files
    WHEN NEW.raw_content IS NOT NULL
    BEGIN
      INSERT INTO file_search(rowid, raw_content) VALUES (NEW.id, NEW.raw_content);
    END
  `);
  db.run(`
    CREATE TABLE GotoDef (
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
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE goto_def_search USING fts5(
      name,
      qualified_name,
      content='GotoDef',
      content_rowid='id',
      tokenize='trigram'
    )
  `);
  db.run(`
    CREATE TRIGGER goto_def_ai AFTER INSERT ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(rowid, name, qualified_name)
      VALUES (NEW.id, NEW.name, NEW.qualified_name);
    END
  `);
  db.run(`
    CREATE TRIGGER goto_def_bd BEFORE DELETE ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(goto_def_search, rowid, name, qualified_name)
      VALUES ('delete', OLD.id, OLD.name, OLD.qualified_name);
    END
  `);
  db.run(`
    CREATE TRIGGER goto_def_bu BEFORE UPDATE OF name, qualified_name ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(goto_def_search, rowid, name, qualified_name)
      VALUES ('delete', OLD.id, OLD.name, OLD.qualified_name);
    END
  `);
  db.run(`
    CREATE TRIGGER goto_def_au AFTER UPDATE OF name, qualified_name ON GotoDef
    BEGIN
      INSERT INTO goto_def_search(rowid, name, qualified_name)
      VALUES (NEW.id, NEW.name, NEW.qualified_name);
    END
  `);
}

function recreateSchema(db: Database): void {
  db.run("DROP TRIGGER IF EXISTS goto_def_au");
  db.run("DROP TRIGGER IF EXISTS goto_def_bu");
  db.run("DROP TRIGGER IF EXISTS goto_def_bd");
  db.run("DROP TRIGGER IF EXISTS goto_def_ai");
  db.run("DROP TABLE IF EXISTS goto_def_search");
  db.run("DROP TABLE IF EXISTS GotoDef");
  db.run("DROP TRIGGER IF EXISTS files_au");
  db.run("DROP TRIGGER IF EXISTS files_bu");
  db.run("DROP TRIGGER IF EXISTS files_bd");
  db.run("DROP TRIGGER IF EXISTS files_ai");
  db.run("DROP TABLE IF EXISTS file_search");
  db.run("DROP TABLE IF EXISTS files");
  db.run("DROP TABLE IF EXISTS diagrams");
  db.run("DROP TABLE IF EXISTS tree_entries");
  db.run("DROP TABLE IF EXISTS package_snapshots");
  db.run("DROP TABLE IF EXISTS cache_meta");
  db.run("DROP TABLE IF EXISTS generations");
  createSchema(db);
  db.run(`PRAGMA user_version=${CACHE_SCHEMA_VERSION}`);
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

export function openCache(dbPath: string): ExplorerCacheDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });

  try {
    db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
    db.run("PRAGMA synchronous=NORMAL");
    db.run("PRAGMA foreign_keys=ON");
    db.run("PRAGMA busy_timeout=5000");

    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    if (version !== CACHE_SCHEMA_VERSION) db.transaction(() => recreateSchema(db)).immediate();

    const schemaObjects = db.query<SchemaObjectRow, []>(`
      SELECT name
      FROM sqlite_schema
      WHERE name IN (
        'cache_meta',
        'generations',
        'package_snapshots',
        'tree_entries',
        'diagrams',
        'files',
        'file_search',
        'files_ai',
        'files_bd',
        'files_bu',
        'files_au',
        'GotoDef',
        'goto_def_search',
        'goto_def_ai',
        'goto_def_bd',
        'goto_def_bu',
        'goto_def_au'
      )
    `).all();
    const presentObjects = new Set(schemaObjects.map(({ name }) => name));
    const missingObjects = SCHEMA_OBJECTS.filter((name) => !presentObjects.has(name));
    if (missingObjects.length) {
      throw new Error(`cache schema is incomplete: missing ${missingObjects.join(", ")}`);
    }
  } catch (error) {
    try {
      db.close(true);
    } catch {
      db.close();
    }
    throw error;
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
  ];


  const recoveryTransaction = db.transaction((activeGenerationId: number | null) => {
    if (activeGenerationId === null) {
      deleteActivePointer.run();
      deleteAllGotoDefs.run();
      deleteAllFiles.run();
      deleteAllGenerations.run();
      return;
    }
    deleteGotoDefsExceptGeneration.run(activeGenerationId);
    deleteFilesExceptGeneration.run(activeGenerationId);
    deleteGenerationsExcept.run(activeGenerationId);
  });
  const discoveryTransaction = db.transaction((
    generationId: number,
    packages: readonly PackageInfo[],
    diagram: CacheDiagramResponse,
  ) => {
    upsertPackages.run(generationId, JSON.stringify(packages));
    upsertDiagram.run(generationId, diagram.kind, diagram.scopePath, JSON.stringify(diagram));
  });
  const scopeTransaction = db.transaction((generationId: number, scope: CacheScopeWrite) => {
    for (const entry of scope.entries) {
      const viewable = (entry as TreeNode & { viewable?: boolean }).viewable === true ? 1 : 0;
      upsertTreeEntry.run(
        generationId,
        entry.path,
        parentPath(entry.path),
        entry.name,
        entry.kind,
        viewable,
      );
    }
    const diagram = scope.diagram;
    upsertDiagram.run(generationId, diagram.kind, diagram.scopePath, JSON.stringify(diagram));
    if (scope.file) {
      const file = scope.file;
      deleteScopeGotoDefs.run(generationId, file.path);
      upsertFile.run(
        generationId,
        file.path,
        file.rawContent,
        file.displayContent,
        file.sourceError,
        file.formatError,
      );
      for (const definition of scope.definitions) {
        insertGotoDefinition.run(
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
  });
  const promotionTransaction = db.transaction((generationId: number) => {
    const result = markGenerationActive.run(Date.now(), generationId);
    if (result.changes !== 1) throw new Error(`cannot promote generation ${generationId}`);
    upsertActivePointer.run(String(generationId));
  });
  const cleanupTransaction = db.transaction((generationId: number) => {
    deleteGotoDefsExceptGeneration.run(generationId);
    deleteFilesExceptGeneration.run(generationId);
    deleteGenerationsExcept.run(generationId);
  });
  const discardTransaction = db.transaction((generationId: number) => {
    deleteGenerationGotoDefs.run(generationId);
    deleteGenerationFiles.run(generationId);
    deleteInactiveGeneration.run(generationId);
  });

  let closed = false;

  const readPackages = (generationId: number): PackageInfo[] => {
    const row = selectPackages.get(generationId);
    if (!row) throw new Error(`cache package snapshot not found for generation ${generationId}`);
    return parseJson<PackageInfo[]>(row.packages_json, "package snapshot");
  };

  return {
    dbPath,
    recover() {
      const hasPointer = selectRawActiveGeneration.get() !== null;
      const activeGenerationId = selectActiveGeneration.get()?.id ?? null;
      recoveryTransaction.immediate(activeGenerationId);
      return hasPointer ? activeGenerationId : null;
    },
    getActiveGenerationId() {
      return selectActiveGeneration.get()?.id ?? null;
    },
    beginGeneration(cause) {
      return Number(insertGeneration.run(cause, Date.now()).lastInsertRowid);
    },
    writeDiscovery(generationId, packages, packagesDiagram) {
      discoveryTransaction.immediate(generationId, packages, packagesDiagram);
    },
    writeScope(generationId, scope) {
      scopeTransaction.immediate(generationId, scope);
    },
    readTreeEntries(generationId) {
      return selectTreeEntries.all(generationId).map((row): TreeNode => {
        const base = { name: row.name, path: row.path, kind: row.kind };
        if (row.kind === "file") {
          return { ...base, viewable: row.viewable !== 0 } as TreeNode;
        }
        return base;
      });
    },
    readPackages,
    readDiagram(generationId, kind, scopePath) {
      const row = selectDiagram.get(generationId, kind, scopePath);
      return row ? parseJson<CacheDiagramResponse>(row.response_json, "diagram") : null;
    },
    readFile(generationId, path) {
      const row = selectFile.get(generationId, path);
      if (!row) return null;
      return {
        path: row.path,
        rawContent: row.raw_content,
        displayContent: row.display_content,
        sourceError: row.source_error,
        formatError: row.format_error,
      };
    },
    readDefinition(generationId, path, line, column) {
      const row = selectDefinition.get(
        generationId,
        normalizeRelativePath(path),
        line,
        column,
      );
      return row ? toGotoDefinition(row) : null;
    },
    readDefinitions(generationId, path) {
      return selectDefinitions
        .all(generationId, normalizeRelativePath(path))
        .map(toEditorGotoDefinition);
    },
    searchFiles(generationId, query) {
      const indexed = hasAtLeastThreeCodePoints(query) && !query.includes("%") && !query.includes("_");
      const likeQuery = `%${query}%`;
      const fileCandidates = indexed
        ? selectIndexedSearchCandidates.all(generationId, likeQuery)
        : selectScanSearchCandidates.all(generationId);
      const definitionCandidates = indexed
        ? selectIndexedDefinitionCandidates.all(generationId, likeQuery, likeQuery)
        : selectScanDefinitionCandidates.all(generationId);
      const foldedQuery = query.toLowerCase();
      const paths = new Set<string>();
      for (const candidate of fileCandidates) {
        if (candidate.raw_content.toLowerCase().includes(foldedQuery)) paths.add(candidate.path);
      }
      const retainedDefinitions = new Map<string, GotoDefinitionRow>();
      for (const candidate of definitionCandidates) {
        if (
          !candidate.name.toLowerCase().includes(foldedQuery)
          && !candidate.qualified_name.toLowerCase().includes(foldedQuery)
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
        files,
        definitions,
        ...buildSearchScopes(files, readPackages(generationId)),
      };
    },
    promoteGeneration(generationId) {
      promotionTransaction.immediate(generationId);
      cleanupTransaction.immediate(generationId);
      optimizeSearch.run();
      optimizeGotoDefinitionSearch.run();
    },
    discardGeneration(generationId) {
      if (selectActiveGeneration.get()?.id === generationId) {
        throw new Error(`cannot discard active generation ${generationId}`);
      }
      discardTransaction.immediate(generationId);
    },
    failGeneration(generationId) {
      markGenerationFailed.run(Date.now(), generationId);
    },
    close() {
      if (closed) return;
      for (const statement of statements) statement.finalize();
      db.close(true);
      closed = true;
    },
  };
}
