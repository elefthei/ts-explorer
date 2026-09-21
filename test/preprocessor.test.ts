import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, DiagramMaterializationError } from "../src/cache.ts";
import { DIAGRAM_GRAPH_FORMAT_VERSION, type UmlDiagramGraph } from "../src/diagram-graph.ts";
import { extractPackageDiagramGraph, renderPackageDiagramGraph } from "../src/packages.ts";
import { resolveCacheDbPath } from "../src/paths.ts";
import { Preprocessor } from "../src/preprocessor.ts";
import {
  isPreprocessProgressEvent,
  isPreprocessResponse,
  type PreprocessProgressEvent,
  type PreprocessResponse,
} from "../src/preprocess-protocol.ts";
import type {
  DiagramPayload,
  DiagramRequest,
  EditorGotoDefinition,
  FileDefinition,
  GotoDefinition,
  PackageInfo,
  TreeNode,
  UmlDiagramPayload,
} from "../src/types.ts";
import type { DefinitionIndexSnapshot } from "../src/uml/model.ts";
import type { UmlViewModel } from "../src/uml/view.ts";
import { createFixtureTracker } from "./support/fixtures.ts";

type DefinitionsView = Extract<UmlViewModel, { kind: "definitions" }>;
type FilesView = Extract<UmlViewModel, { kind: "files" }>;

/**
 * A synthetic catalogue for cache-level tests. The keys are test-owned opaque identifiers: the
 * cache only requires that every UML node names an indexed definition of the same generation.
 */
function fixtureCatalogue(scopePath: string): DefinitionIndexSnapshot {
  const nominal = ["Alpha", "Beta", "Gamma"].map((name, index) => ({
    key: `${scopePath}:${name}`,
    parentKey: null,
    isTopLevel: true,
    hasBody: true,
    name,
    qualifiedName: name,
    kind: "class" as const,
    type: name,
    source: { path: scopePath, line: index + 1, column: 14 },
  }));
  const definitions = [
    ...nominal,
    {
      key: `${scopePath}:Alpha.beta`,
      parentKey: `${scopePath}:Alpha`,
      isTopLevel: false,
      hasBody: true,
      name: "beta",
      qualifiedName: "Alpha.beta",
      kind: "method" as const,
      type: "(): Beta",
      source: { path: scopePath, line: 1, column: 30 },
    },
  ];
  return {
    entries: [
      { name: "root", path: "", kind: "directory" },
      { name: scopePath, path: scopePath, kind: "file", viewable: true },
    ],
    definitions,
    bindings: [],
    contributors: definitions.map((definition) => ({
      definitionKey: definition.key,
      sourcePath: scopePath,
      kind: "declaration" as const,
    })),
    imports: [],
  };
}

/** The direct per-file graph `fixtureCatalogue` describes: two directed edges, one method row. */
function fixtureUmlGraph(scopePath: string): UmlDiagramGraph {
  const key = (name: string) => `${scopePath}:${name}`;
  return {
    kind: "uml",
    scopePath,
    formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
    renderMode: "normal",
    nodes: [
      { nodeId: key("Alpha"), nodeOrdinal: 0, nodeKind: "entity", name: "Alpha" },
      { nodeId: key("Alpha.beta"), nodeOrdinal: 1, nodeKind: "definition", name: "beta" },
      { nodeId: key("Beta"), nodeOrdinal: 2, nodeKind: "entity", name: "Beta" },
      { nodeId: key("Gamma"), nodeOrdinal: 3, nodeKind: "entity", name: "Gamma" },
    ],
    edges: [
      {
        edgeOrdinal: 0,
        sourceNodeId: key("Alpha"),
        targetNodeId: key("Beta"),
        edgeKind: "uml-relation",
        directed: true,
        weight: 1,
      },
      {
        edgeOrdinal: 1,
        sourceNodeId: key("Alpha.beta"),
        targetNodeId: key("Gamma"),
        edgeKind: "uml-relation",
        directed: true,
        weight: 1,
      },
    ],
    relations: [
      {
        edgeOrdinal: 0,
        relationOrdinal: 0,
        relationKind: "extends",
        sourceNodeId: key("Alpha"),
        targetNodeId: key("Beta"),
      },
      {
        edgeOrdinal: 1,
        relationOrdinal: 0,
        relationKind: "references",
        sourceNodeId: key("Alpha.beta"),
        targetNodeId: key("Gamma"),
      },
    ],
    entities: [
      { entityOrdinal: 0, definitionKey: key("Alpha"), entityKind: "class", name: "Alpha" },
      { entityOrdinal: 1, definitionKey: key("Beta"), entityKind: "class", name: "Beta" },
      { entityOrdinal: 2, definitionKey: key("Gamma"), entityKind: "class", name: "Gamma" },
    ],
    properties: [],
    methods: [{
      entityOrdinal: 0,
      methodOrdinal: 0,
      definitionKey: key("Alpha.beta"),
      name: "beta",
      returnType: "Beta",
    }],
    memberModifiers: [{
      entityOrdinal: 0,
      memberKind: "method",
      memberOrdinal: 0,
      modifierOrdinal: 0,
      modifier: "public",
    }],
    enumItems: [],
    categories: [
      { categoryOrdinal: 0, definitionKey: key("Alpha"), category: "concrete", isTest: false },
      { categoryOrdinal: 1, definitionKey: key("Beta"), category: "concrete", isTest: false },
      { categoryOrdinal: 2, definitionKey: key("Gamma"), category: "concrete", isTest: false },
    ],
  };
}

const FIXTURE_PACKAGES: PackageInfo[] = [
  { name: "workspace-a", path: "packages/a", dependencies: ["workspace-b"] },
  { name: "workspace-b", path: "packages/b", dependencies: [] },
];

const fixtures = createFixtureTracker();
const { temporaryRoot, writeFixtureFile } = fixtures;
const preprocessors = new Set<Preprocessor>();
const subprocesses = new Set<Bun.Subprocess>();

afterEach(async () => {
  await Promise.allSettled([...preprocessors].map((preprocessor) => preprocessor.close()));
  preprocessors.clear();
  await Promise.allSettled(
    [...subprocesses].map(async (subprocess) => {
      if (subprocess.exitCode === null && !subprocess.killed) {
        try {
          subprocess.kill();
        } catch {
          // The subprocess may have exited between the checks and kill.
        }
      }
      await subprocess.exited;
    }),
  );
  subprocesses.clear();
  await fixtures.cleanup();
});

function flattenTree(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node === undefined) throw new Error("tree traversal stack unexpectedly empty");
    nodes.push(node);
    pending.push(...(node.children ?? []));
  }
  return nodes.sort((left, right) => left.path.localeCompare(right.path));
}

function openDatabase<T>(dbPath: string, operation: (db: Database) => T): T {
  let db: Database | null = new Database(dbPath, { strict: true });
  try {
    return operation(db);
  } finally {
    db.close();
    db = null;
    Bun.gc(true);
  }
}

function tableColumns(db: Database, table: string): { name: string; type: string }[] {
  const statement = db.query<{ name: string; type: string }, []>(`PRAGMA table_info('${table}')`);
  try {
    return statement.all().map(({ name, type }) => ({ name, type }));
  } finally {
    statement.finalize();
  }
}

/** Every generation-scoped cache table, discovered from the live schema rather than hard-coded. */
function generationTables(db: Database): string[] {
  return db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all()
    .map(({ name }) => name)
    .filter((table) => tableColumns(db, table).some(({ name }) => name === "generation_id"));
}

/** The normalized graph tables: generation plus graph identity. `diagrams` is the payload row. */
function normalizedGraphTables(db: Database): string[] {
  return generationTables(db).filter((table) =>
    table !== "diagrams" && tableColumns(db, table).some(({ name }) => name === "scope_path")
  );
}

function expectOnlyGeneration(db: Database, generationId: number): void {
  for (const table of generationTables(db)) {
    const statement = db.query<{ generation_id: number }, []>(
      `SELECT DISTINCT generation_id FROM "${table}"`,
    );
    try {
      expect(
        statement.all().map(({ generation_id }) => generation_id).filter((id) => id !== generationId),
        table,
      ).toEqual([]);
    } finally {
      statement.finalize();
    }
  }
}

function expectSearchSchema(
  db: Database,
  table: "files" | "GotoDef",
  searchTable: "file_search" | "goto_def_search",
  expectedTriggers: readonly string[],
): void {
  expect(db.query<{ name: string; type: string }, [string, string]>(`
    SELECT name, type
    FROM sqlite_schema
    WHERE name IN (?, ?)
    ORDER BY name
  `).all(table, searchTable)).toEqual(
    [
      { name: table, type: "table" },
      { name: searchTable, type: "table" },
    ].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  expect(db.query<{ name: string }, [string]>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ?
    ORDER BY name
  `).all(table)).toEqual(expectedTriggers.map((name) => ({ name })));
}

function withTimeout<Value>(promise: Promise<Value>, description: string, timeout = 10_000): Promise<Value> {
  const timed = Promise.withResolvers<Value>();
  const timer = setTimeout(
    () => timed.reject(new Error(`timed out waiting for ${description}`)),
    timeout,
  );
  void promise.then(
    (value) => {
      clearTimeout(timer);
      timed.resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      timed.reject(error);
    },
  );
  return timed.promise;
}

function occurrenceOffset(content: string, needle: string, occurrence: number): number {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = content.indexOf(needle, offset + 1);
    if (offset < 0) throw new Error(`missing occurrence ${occurrence} of ${needle}`);
  }
  return offset;
}

function withoutDisplay(definitions: readonly EditorGotoDefinition[]): GotoDefinition[] {
  return definitions.map((definition) => ({
    key: definition.key,
    kind: definition.kind,
    name: definition.name,
    qualifiedName: definition.qualifiedName,
    source: definition.source,
    uml: definition.uml,
  }));
}

function definitionRequest(path: string, definitionKey: string): DiagramRequest {
  return { kind: "uml", target: { kind: "definition", path, definitionKey } };
}

function fileRequest(path: string): DiagramRequest {
  return { kind: "uml", target: { kind: "file", path } };
}

function directoryRequest(path: string): DiagramRequest {
  return { kind: "uml", target: { kind: "directory", path } };
}

function expectUml(diagram: DiagramPayload): UmlDiagramPayload {
  if (diagram.kind !== "uml") throw new Error(`expected a UML diagram, got ${diagram.kind}`);
  return diagram;
}

function definitionsView(diagram: DiagramPayload): DefinitionsView {
  const view = expectUml(diagram).view;
  if (view.kind !== "definitions") throw new Error("expected a definitions view");
  return view;
}

function filesView(diagram: DiagramPayload): FilesView {
  const view = expectUml(diagram).view;
  if (view.kind !== "files") throw new Error("expected a files view");
  return view;
}

function nodeNames(view: DefinitionsView): string[] {
  return view.nodes.map((node) => node.definition.qualifiedName).sort();
}

/** Edges projected onto readable identities, so assertions never pin a key serialization. */
function edgeSummary(view: DefinitionsView): string[] {
  const names = new Map(view.nodes.map((node) => [node.definition.key, node.definition.qualifiedName]));
  return view.edges
    .map((edge) =>
      `${names.get(edge.sourceKey) ?? edge.sourceKey} -${edge.kind}-> ${
        names.get(edge.targetKey) ?? edge.targetKey
      }`
    )
    .sort();
}

function frameSummary(view: DefinitionsView): { root: string; nodes: string[] }[] {
  const names = new Map(view.nodes.map((node) => [node.definition.key, node.definition.qualifiedName]));
  return view.frames.map((frame) => ({
    root: names.get(frame.rootKey) ?? frame.rootKey,
    nodes: frame.nodeKeys.map((key) => names.get(key) ?? key).sort(),
  }));
}

function definitionKeyOf(definitions: readonly FileDefinition[], qualifiedName: string): string {
  const found = definitions.find((definition) => definition.qualifiedName === qualifiedName);
  if (!found) throw new Error(`definition ${qualifiedName} was not indexed`);
  return found.key;
}

async function captureError(operation: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await operation;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: String(failure.message ?? error) };
  }
  throw new Error("expected the operation to reject");
}

type PreprocessResponseWaiter = {
  resolve(response: PreprocessResponse): void;
  reject(error: Error): void;
};

function spawnPreprocessChild(): {
  subprocess: Bun.Subprocess;
  waitForResponse(id: number): Promise<PreprocessResponse>;
} {
  const waiters = new Map<number, PreprocessResponseWaiter>();
  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  const subprocess = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/preprocess-child.ts", import.meta.url)),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      windowsHide: true,
      ipc(message) {
        if (isPreprocessProgressEvent(message)) return;
        if (!isPreprocessResponse(message)) {
          rejectWaiters(new Error("preprocess child returned an invalid response"));
          return;
        }
        const waiter = waiters.get(message.id);
        if (!waiter) return;
        waiters.delete(message.id);
        waiter.resolve(message);
      },
      onDisconnect() {
        rejectWaiters(new Error("preprocess child IPC disconnected"));
      },
    },
  );
  subprocesses.add(subprocess);
  void subprocess.exited.then(
    (exitCode) => rejectWaiters(new Error(`preprocess child exited with code ${exitCode}`)),
    (error) => rejectWaiters(error instanceof Error ? error : new Error(String(error))),
  );

  return {
    subprocess,
    waitForResponse(id) {
      if (waiters.has(id)) throw new Error(`already waiting for preprocess response ${id}`);
      const { promise: response, resolve, reject } = Promise.withResolvers<PreprocessResponse>();
      waiters.set(id, { resolve, reject });
      return withTimeout(response, `preprocess response ${id}`, 30_000).finally(() => {
        waiters.delete(id);
      });
    },
  };
}

function trackedPreprocessor(
  root: string,
  onReady: () => void,
  onError: (error: Error) => void,
  processCount = 1,
  onProgress: (event: PreprocessProgressEvent) => void = () => undefined,
): Preprocessor {
  const preprocessor = new Preprocessor(root, onReady, onError, processCount, onProgress);
  preprocessors.add(preprocessor);
  return preprocessor;
}

async function closePreprocessor(preprocessor: Preprocessor): Promise<void> {
  await preprocessor.close();
  preprocessors.delete(preprocessor);
}

function groupProgressEvents(events: readonly PreprocessProgressEvent[]): Array<{
  generationId: number;
  component: PreprocessProgressEvent["component"];
  resource: string;
  events: PreprocessProgressEvent["event"][];
}> {
  const groups = new Map<string, {
    generationId: number;
    component: PreprocessProgressEvent["component"];
    resource: string;
    events: PreprocessProgressEvent["event"][];
  }>();
  for (const event of events) {
    const key = JSON.stringify([event.generationId, event.component, event.resource]);
    const group = groups.get(key);
    if (group) {
      group.events.push(event.event);
    } else {
      groups.set(key, {
        generationId: event.generationId,
        component: event.component,
        resource: event.resource,
        events: [event.event],
      });
    }
  }
  return [...groups.values()];
}

test("validates preprocessing response envelopes", () => {
  const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
    { name: "success", value: { id: 1, ok: true, value: null }, expected: true },
    {
      name: "failure",
      value: { id: 2, ok: false, error: { code: "NOT_FOUND", message: "missing" } },
      expected: true,
    },
    {
      name: "schema retry failure",
      value: { id: 7, ok: false, error: { code: "SCHEMA_RETRY", message: "repaired" } },
      expected: true,
    },
    { name: "non-boolean ok", value: { id: 3, ok: "true", value: null }, expected: false },
    { name: "success without value", value: { id: 6, ok: true }, expected: false },
    {
      name: "unknown error code",
      value: { id: 4, ok: false, error: { code: "UNKNOWN", message: "bad response" } },
      expected: false,
    },
    {
      name: "non-string error message",
      value: { id: 5, ok: false, error: { code: "INTERNAL", message: 5 } },
      expected: false,
    },
    {
      name: "inherited object key as error code",
      value: { id: 8, ok: false, error: { code: "constructor", message: "bad response" } },
      expected: false,
    },
  ];

  for (const { name, value, expected } of cases) {
    expect(isPreprocessResponse(value), name).toBe(expected);
  }
});

test("validates preprocessing progress envelopes", () => {
  const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
    {
      name: "exact startup envelope",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: 1,
        cause: "startup",
      },
      expected: true,
    },
    {
      name: "exact watch envelope",
      value: {
        event: "done",
        component: "code",
        resource: "./index.ts",
        generationId: Number.MAX_SAFE_INTEGER,
        cause: "watch",
      },
      expected: true,
    },
    {
      name: "legacy three-field envelope",
      value: { event: "start", component: "uml", resource: "." },
      expected: false,
    },
    {
      name: "missing generation ID",
      value: { event: "start", component: "uml", resource: ".", cause: "startup" },
      expected: false,
    },
    {
      name: "missing cause",
      value: { event: "start", component: "uml", resource: ".", generationId: 1 },
      expected: false,
    },
    {
      name: "unknown cause",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: 1,
        cause: "manual",
      },
      expected: false,
    },
    {
      name: "zero generation ID",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: 0,
        cause: "startup",
      },
      expected: false,
    },
    {
      name: "negative generation ID",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: -1,
        cause: "startup",
      },
      expected: false,
    },
    {
      name: "fractional generation ID",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: 1.5,
        cause: "startup",
      },
      expected: false,
    },
    {
      name: "unsafe generation ID",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: Number.MAX_SAFE_INTEGER + 1,
        cause: "startup",
      },
      expected: false,
    },
    {
      name: "extra field",
      value: {
        event: "start",
        component: "uml",
        resource: ".",
        generationId: 1,
        cause: "startup",
        requestId: 7,
      },
      expected: false,
    },
  ];

  for (const { name, value, expected } of cases) {
    expect(isPreprocessProgressEvent(value), name).toBe(expected);
  }
});

test("serves the preprocessing protocol from a Bun child process and exits cleanly", async () => {
  const root = await temporaryRoot("ts-explorer-preprocess-child-");
  const { subprocess, waitForResponse } = spawnPreprocessChild();
  expect(subprocess.pid).not.toBe(process.pid);

  const initResponse = waitForResponse(1);
  subprocess.send({
    id: 1,
    type: "init",
    sourceDir: root,
    dbPath: join(root, ".explore", "explore.db"),
    recover: true,
  });
  expect(await initResponse).toEqual({
    id: 1,
    ok: true,
    value: { activeGenerationId: null, hasFailedDiagrams: false },
  });

  const beginResponse = waitForResponse(2);
  const unknownResponse = waitForResponse(3);
  subprocess.send({ id: 2, type: "begin-generation", cause: "startup" });
  subprocess.send({ id: 3, type: "unknown" });
  const [begin, unknown] = await Promise.all([beginResponse, unknownResponse]);
  expect(begin).toEqual({
    id: 2,
    ok: true,
    value: { generationId: 1 },
  });
  expect(unknown).toMatchObject({
    id: 3,
    ok: false,
    error: { code: "BAD_REQUEST" },
  });

  const missingSearchModeResponse = waitForResponse(4);
  const nonBooleanSearchModeResponse = waitForResponse(5);
  subprocess.send({
    id: 4,
    type: "search",
    generationId: 1,
    query: "needle",
  });
  subprocess.send({
    id: 5,
    type: "search",
    generationId: 1,
    query: "needle",
    caseInsensitive: "true",
  });
  expect(await missingSearchModeResponse).toEqual({
    id: 4,
    ok: false,
    error: { code: "BAD_REQUEST", message: "caseInsensitive must be a boolean" },
  });
  expect(await nonBooleanSearchModeResponse).toEqual({
    id: 5,
    ok: false,
    error: { code: "BAD_REQUEST", message: "caseInsensitive must be a boolean" },
  });

  // `preprocess-scope` no longer carries a package snapshot; the cause is still required.
  const missingCauseResponse = waitForResponse(6);
  subprocess.send({
    id: 6,
    type: "preprocess-scope",
    generationId: 1,
    scope: { path: "", kind: "directory" },
  });
  expect(await missingCauseResponse).toEqual({
    id: 6,
    ok: false,
    error: { code: "BAD_REQUEST", message: "cause must be startup or watch" },
  });

  const diagramCases = [
    { id: 7, request: { kind: "hybrid" }, message: "kind must be packages or uml" },
    { id: 8, request: { kind: "uml" }, message: "target must be an object" },
    {
      id: 9,
      request: { kind: "uml", target: { kind: "file", path: "" } },
      message: "path is required",
    },
    {
      id: 10,
      request: { kind: "uml", target: { kind: "definition", path: "a.ts", definitionKey: "" } },
      message: "definition is required",
    },
    {
      id: 11,
      request: { kind: "packages", scopePath: "src" },
      message: "packages diagram scope must be the source root",
    },
  ];
  const diagramResponses = diagramCases.map(({ id }) => waitForResponse(id));
  for (const { id, request } of diagramCases) {
    subprocess.send({ id, type: "read-diagram", generationId: 1, request });
  }
  expect(await Promise.all(diagramResponses)).toEqual(
    diagramCases.map(({ id, message }) => ({
      id,
      ok: false,
      error: { code: "BAD_REQUEST", message },
    })),
  );

  const shutdownResponse = waitForResponse(12);
  subprocess.send({ id: 12, type: "shutdown" });
  expect(await shutdownResponse).toEqual({ id: 12, ok: true, value: null });
  expect(await withTimeout(subprocess.exited, "preprocess child exit")).toBe(0);
}, 30_000);

test("exits when the parent IPC channel disconnects", async () => {
  const root = await temporaryRoot("ts-explorer-preprocess-child-disconnect-");
  const { subprocess, waitForResponse } = spawnPreprocessChild();

  const initResponse = waitForResponse(1);
  subprocess.send({
    id: 1,
    type: "init",
    sourceDir: root,
    dbPath: join(root, ".explore", "explore.db"),
    recover: true,
  });
  expect(await initResponse).toEqual({
    id: 1,
    ok: true,
    value: { activeGenerationId: null, hasFailedDiagrams: false },
  });

  subprocess.disconnect();
  expect(await withTimeout(subprocess.exited, "preprocess child exit after IPC disconnect")).toBe(0);
}, 30_000);

test("names the owner and dependency files a rooted selection still needs", async () => {
  const root = await temporaryRoot("ts-explorer-preprocess-readiness-");
  const dbPath = join(root, ".explore", "explore.db");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "readiness" }));
  await writeFixtureFile(
    root,
    "feature/root.ts",
    'import { B } from "./b";\nexport class Root { value: B; }\n',
  );
  await writeFixtureFile(
    root,
    "feature/b.ts",
    'import { C } from "../shared/c";\nexport class B { value: C; }\n',
  );
  await writeFixtureFile(
    root,
    "shared/c.ts",
    'import { B } from "../feature/b";\nexport class C { value: B; }\n',
  );
  await writeFixtureFile(root, "unrelated.ts", "export class Unrelated {}\n");

  const { subprocess, waitForResponse } = spawnPreprocessChild();
  let nextId = 0;
  const call = async <Value>(request: Record<string, unknown>): Promise<Value> => {
    nextId += 1;
    const id = nextId;
    const response = waitForResponse(id);
    subprocess.send({ ...request, id });
    const settled = await response;
    if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
    return settled.value as Value;
  };

  await call({ type: "init", sourceDir: root, dbPath, recover: true });
  const { generationId } = await call<{ generationId: number }>({
    type: "begin-generation",
    cause: "startup",
  });
  await call({ type: "discover-packages", generationId });
  const indexed = await call<{ definitionCount: number }>({
    type: "index-definitions",
    generationId,
    cause: "startup",
  });
  expect(indexed.definitionCount).toBeGreaterThan(0);

  const rootDefinitions = await call<FileDefinition[]>({
    type: "read-file-definitions",
    generationId,
    path: "feature/root.ts",
  });
  const rootKey = definitionKeyOf(rootDefinitions, "Root");
  const request = definitionRequest("feature/root.ts", rootKey);

  const readSelection = () =>
    call<
      { state: "pending"; files: string[] } | { state: "complete"; diagram: DiagramPayload }
    >({ type: "read-diagram", generationId, request });
  const processFile = (path: string) =>
    call({ type: "preprocess-scope", generationId, cause: "startup", scope: { path, kind: "file" } });

  // No file scope has run yet: the owner file itself is the only thing the selection needs.
  expect(await readSelection()).toEqual({ state: "pending", files: ["feature/root.ts"] });
  await processFile("feature/root.ts");
  expect(await readSelection()).toEqual({ state: "pending", files: ["feature/b.ts"] });
  await processFile("feature/b.ts");
  expect(await readSelection()).toEqual({ state: "pending", files: ["shared/c.ts"] });
  await processFile("shared/c.ts");

  const complete = await readSelection();
  if (complete.state !== "complete") {
    throw new Error(`selection is still pending: ${complete.files.join(", ")}`);
  }
  const view = definitionsView(complete.diagram);
  expect(expectUml(complete.diagram).status).toBe("ready");
  expect(nodeNames(view)).toEqual(["B", "C", "Root"]);
  expect(edgeSummary(view)).toEqual([
    "B -references-> C",
    "C -references-> B",
    "Root -references-> B",
  ]);
  expect(frameSummary(view)).toEqual([{ root: "Root", nodes: ["B", "C", "Root"] }]);

  // Nothing outside that closure was preprocessed, and the generation was never promoted.
  expect(
    await call<{ state: string; files: string[] }>({
      type: "read-diagram",
      generationId,
      request: fileRequest("unrelated.ts"),
    }),
  ).toEqual({ state: "pending", files: ["unrelated.ts"] });

  const shutdownId = nextId + 1;
  const shutdown = waitForResponse(shutdownId);
  subprocess.send({ id: shutdownId, type: "shutdown" });
  expect(await shutdown).toEqual({ id: shutdownId, ok: true, value: null });
  expect(await withTimeout(subprocess.exited, "preprocess child exit")).toBe(0);

  openDatabase(dbPath, (db) => {
    expect(db.query<{ id: number; state: string }, []>("SELECT id, state FROM generations").all())
      .toEqual([{ id: generationId, state: "building" }]);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM cache_meta WHERE key = 'active_generation'",
    ).get()).toEqual({ count: 0 });
    expect(db.query<{ scope_path: string }, [number]>(`
      SELECT scope_path FROM diagrams
      WHERE generation_id = ? AND kind = 'uml'
      ORDER BY scope_path
    `).all(generationId).map(({ scope_path }) => scope_path)).toEqual([
      "feature/b.ts",
      "feature/root.ts",
      "shared/c.ts",
    ]);
  });
}, 60_000);

test("preprocesses each visible scope once and serves formatted files and literal search from the persistent cache", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-");
  const outside = await temporaryRoot("ts-explorer-preprocessor-outside-");
  const rootSource = [
    "export const before={x:1}",
    "export class SearchNeedleEntity<T>{",
    '  SearchNeedleAlpha(){return ""}',
    "  SearchNeedleBeta(){return 1}",
    "  SearchNeedleGamma(){return true}",
    "}",
    "export interface OtherNeedle {",
    "  SearchNeedleDelta():void",
    "}",
    "export const targetValue=42",
    'export const rootText="MixedCaseNeedle"',
    "",
  ].join("\n");
  const formattedRootSource = [
    "export const before = { x: 1 };",
    "export class SearchNeedleEntity<T> {",
    "  SearchNeedleAlpha() {",
    '    return "";',
    "  }",
    "  SearchNeedleBeta() {",
    "    return 1;",
    "  }",
    "  SearchNeedleGamma() {",
    "    return true;",
    "  }",
    "}",
    "export interface OtherNeedle {",
    "  SearchNeedleDelta(): void;",
    "}",
    "export const targetValue = 42;",
    'export const rootText = "MixedCaseNeedle";',
    "",
  ].join("\n");
  const rootDefinitions: EditorGotoDefinition[] = [
    {
      key: '["class","SearchNeedleEntity",0,null,null]',
      kind: "class",
      name: "SearchNeedleEntity",
      qualifiedName: "SearchNeedleEntity",
      source: { path: "root.ts", line: 2, column: 14 },
      uml: { scopePath: "root.ts", entityName: "SearchNeedleEntity<T>" },
      displayFrom: occurrenceOffset(formattedRootSource, "SearchNeedleEntity", 0),
      displayTo: occurrenceOffset(formattedRootSource, "SearchNeedleEntity", 0) + "SearchNeedleEntity".length,
    },
    ...["SearchNeedleAlpha", "SearchNeedleBeta", "SearchNeedleGamma"].map(
      (name, occurrence): EditorGotoDefinition => ({
        key: `["class","SearchNeedleEntity",0,"${name}",0]`,
        kind: "method",
        name,
        qualifiedName: `SearchNeedleEntity.${name}`,
        source: { path: "root.ts", line: occurrence + 3, column: 3 },
        uml: {
          scopePath: "root.ts",
          entityName: "SearchNeedleEntity<T>",
          memberName: name,
          memberOccurrence: 0,
        },
        displayFrom: occurrenceOffset(formattedRootSource, name, 0),
        displayTo: occurrenceOffset(formattedRootSource, name, 0) + name.length,
      }),
    ),
    {
      key: '["interface","OtherNeedle",0,null,null]',
      kind: "interface",
      name: "OtherNeedle",
      qualifiedName: "OtherNeedle",
      source: { path: "root.ts", line: 7, column: 18 },
      uml: { scopePath: "root.ts", entityName: "OtherNeedle" },
      displayFrom: occurrenceOffset(formattedRootSource, "OtherNeedle", 0),
      displayTo: occurrenceOffset(formattedRootSource, "OtherNeedle", 0) + "OtherNeedle".length,
    },
    {
      key: '["interface","OtherNeedle",0,"SearchNeedleDelta",0]',
      kind: "method",
      name: "SearchNeedleDelta",
      qualifiedName: "OtherNeedle.SearchNeedleDelta",
      source: { path: "root.ts", line: 8, column: 3 },
      uml: {
        scopePath: "root.ts",
        entityName: "OtherNeedle",
        memberName: "SearchNeedleDelta",
        memberOccurrence: 0,
      },
      displayFrom: occurrenceOffset(formattedRootSource, "SearchNeedleDelta", 0),
      displayTo: occurrenceOffset(formattedRootSource, "SearchNeedleDelta", 0) + "SearchNeedleDelta".length,
    },
  ];
  const gotoDefinitions = withoutDisplay(rootDefinitions);
  const malformedSource = "export const malformed = {\n";

  await writeFixtureFile(root, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }));
  await writeFixtureFile(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "workspace-a", dependencies: { "workspace-b": "workspace:*" } }),
  );
  await writeFixtureFile(root, "packages/b/package.json", JSON.stringify({ name: "workspace-b" }));
  await writeFixtureFile(root, "root.ts", rootSource);
  await writeFixtureFile(root, "packages/a/index.js", "export const packageValue={answer:42}\n");
  await writeFixtureFile(root, "packages/b/index.js", "export const jsValue={text:'js-untracked'}\n");
  await writeFixtureFile(
    root,
    "nested/deep/helper.js",
    'export const helper="mixedcaseneedle"; export const short="§ Ωx"; export const unicode="ΩmegaNeedle"\n',
  );
  await writeFixtureFile(
    root,
    "notes.txt",
    'untracked MixedCaseNeedle -NEEDLE.[x]*$ and ["quoted"]*\n',
  );
  await writeFixtureFile(root, "wildcard.txt", "literal 100%_literal value\n");
  await writeFixtureFile(root, "malformed.js", malformedSource);
  await writeFixtureFile(root, "nul.js", new TextEncoder().encode('const hidden = "MixedCaseNeedle";\0'));
  await writeFixtureFile(root, "invalid.js", Uint8Array.from([0xff, 0xfe, ...new TextEncoder().encode("MixedCaseNeedle")]));
  await writeFixtureFile(root, "binary.bin", Uint8Array.from([0xff, 0x00, 0xfe]));
  await writeFixtureFile(root, ".explore/ignored.txt", "MixedCaseNeedle");
  await writeFixtureFile(root, "node_modules/dependency/index.js", 'export const ignored="MixedCaseNeedle";\n');
  await writeFixtureFile(outside, "outside.txt", "MixedCaseNeedle");

  const promotions: string[] = [];
  const errors: Error[] = [];
  const progressEvents: PreprocessProgressEvent[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
    4,
    (event) => progressEvents.push(event),
  );
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });

  await preprocessor.ready();
  expect(idleResolved).toBe(false);

  const packages = await preprocessor.getPackages();
  expect(packages).toEqual(FIXTURE_PACKAGES);
  expect(idleResolved).toBe(false);

  await idle;
  expect(promotions).toEqual(["promoted"]);
  expect(errors).toEqual([]);
  expect(progressEvents.length).toBeGreaterThan(0);
  const progressGenerationIds = [...new Set(progressEvents.map((event) => event.generationId))];
  expect(progressGenerationIds).toHaveLength(1);
  const [progressGenerationId] = progressGenerationIds;
  if (progressGenerationId === undefined) throw new Error("startup generation ID was not recorded");
  expect(Number.isSafeInteger(progressGenerationId) && progressGenerationId > 0).toBe(true);
  expect([...new Set(progressEvents.map((event) => event.cause))]).toEqual(["startup"]);
  for (const group of groupProgressEvents(progressEvents)) {
    expect(group.events, `${group.component} ${group.resource}`).toEqual(["start", "done"]);
  }

  const expectedPaths = [
    "",
    "binary.bin",
    "invalid.js",
    "malformed.js",
    "nested",
    "nested/deep",
    "nested/deep/helper.js",
    "notes.txt",
    "nul.js",
    "package.json",
    "packages",
    "packages/a",
    "packages/a/index.js",
    "packages/a/package.json",
    "packages/b",
    "packages/b/index.js",
    "packages/b/package.json",
    "root.ts",
    "wildcard.txt",
  ];
  // Only source files own a direct UML graph; directories and text files never write one.
  const umlScopePaths = [
    "invalid.js",
    "malformed.js",
    "nested/deep/helper.js",
    "nul.js",
    "packages/a/index.js",
    "packages/b/index.js",
    "root.ts",
  ];
  const treeNodes = flattenTree(await preprocessor.getTree());
  expect(treeNodes.map(({ path }) => path)).toEqual(expectedPaths);
  expect(
    treeNodes
      .filter((node) => node.kind === "file")
      .map(({ path, viewable }) => ({ path, viewable })),
  ).toEqual([
    { path: "binary.bin", viewable: false },
    { path: "invalid.js", viewable: true },
    { path: "malformed.js", viewable: true },
    { path: "nested/deep/helper.js", viewable: true },
    { path: "notes.txt", viewable: false },
    { path: "nul.js", viewable: true },
    { path: "package.json", viewable: false },
    { path: "packages/a/index.js", viewable: true },
    { path: "packages/a/package.json", viewable: false },
    { path: "packages/b/index.js", viewable: true },
    { path: "packages/b/package.json", viewable: false },
    { path: "root.ts", viewable: true },
    { path: "wildcard.txt", viewable: false },
  ]);

  const packageDiagram = await preprocessor.getDiagram({ kind: "packages", scopePath: "" });
  if (packageDiagram.kind !== "packages") throw new Error("expected a package diagram");
  expect(packageDiagram).toMatchObject({
    kind: "packages",
    scopePath: "",
    status: "ready",
    packageNodes: [
      { nodeId: "p0", name: "workspace-a", path: "packages/a" },
      { nodeId: "p1", name: "workspace-b", path: "packages/b" },
    ],
    definitions: [],
  });
  expect(packageDiagram.dsl).toContain("p0 --> p1");

  // A directory selection is a file-import graph over every visible file in the subtree.
  expect(filesView(await preprocessor.getDiagram(directoryRequest("nested")))).toEqual({
    kind: "files",
    nodes: [{ path: "nested/deep/helper.js", boundary: false, test: false }],
    edges: [],
  });
  expect(filesView(await preprocessor.getDiagram(directoryRequest("packages/a")))).toEqual({
    kind: "files",
    nodes: [
      { path: "packages/a/index.js", boundary: false, test: false },
      { path: "packages/a/package.json", boundary: false, test: false },
    ],
    edges: [],
  });

  // An in-scope file that could not be decoded is reported, never passed off as a complete graph.
  const rootDirectory = expectUml(await preprocessor.getDiagram(directoryRequest("")));
  expect(rootDirectory.status).toBe("error");
  expect(rootDirectory.error).toContain("file is not valid UTF-8 text");
  const nulDiagram = expectUml(await preprocessor.getDiagram(fileRequest("nul.js")));
  expect(nulDiagram).toMatchObject({
    kind: "uml",
    scopePath: "nul.js",
    status: "error",
    error: "file contains NUL bytes",
  });

  const javaScriptView = definitionsView(
    await preprocessor.getDiagram(fileRequest("packages/b/index.js")),
  );
  expect(nodeNames(javaScriptView)).toEqual(["jsValue"]);
  expect(frameSummary(javaScriptView)).toEqual([{ root: "jsValue", nodes: ["jsValue"] }]);

  const rootOutline = await preprocessor.getFileDefinitions("root.ts");
  const rootFileView = definitionsView(await preprocessor.getDiagram(fileRequest("root.ts")));
  expect(frameSummary(rootFileView).map(({ root: name }) => name)).toEqual([
    "before",
    "SearchNeedleEntity",
    "OtherNeedle",
    "targetValue",
    "rootText",
  ]);
  const entityView = definitionsView(await preprocessor.getDiagram(
    definitionRequest("root.ts", definitionKeyOf(rootOutline, "SearchNeedleEntity")),
  ));
  expect(nodeNames(entityView)).toEqual(["SearchNeedleEntity"]);
  expect(edgeSummary(entityView)).toEqual([]);

  expect(await preprocessor.readFile("root.ts")).toEqual({
    path: "root.ts",
    content: formattedRootSource,
    definitions: rootDefinitions,
    highlights: expect.any(Array),
  });
  expect(await preprocessor.readFile("packages/b/index.js")).toEqual({
    path: "packages/b/index.js",
    content: 'export const jsValue = { text: "js-untracked" };\n',
    definitions: [],
    highlights: expect.any(Array),
  });
  expect(await preprocessor.readFile("malformed.js")).toEqual({
    path: "malformed.js",
    content: malformedSource,
    definitions: [],
    highlights: expect.any(Array),
  });

  const positioned = await preprocessor.readFile("root.ts", { line: 10, column: 14 });
  expect(positioned.content).toBe(formattedRootSource);
  expect(positioned.definitions).toEqual(rootDefinitions);
  expect(positioned.cursorOffset).toBe(positioned.content.indexOf("targetValue"));
  const nulRead = await preprocessor.readFile("nul.js").then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect(nulRead).toMatchObject({
    error: { code: "INVALID_INPUT", message: "file contains NUL bytes" },
  });
  const invalidUtf8Read = await preprocessor.readFile("invalid.js").then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect(invalidUtf8Read).toMatchObject({
    error: { code: "INVALID_INPUT", message: "file is not valid UTF-8 text" },
  });

  expect(await preprocessor.getDefinition("root.ts", { line: 2, column: 14 })).toEqual(
    gotoDefinitions[0],
  );
  expect(await preprocessor.getDefinition("root.ts", { line: 2, column: 15 })).toBeNull();

  expect(await preprocessor.search("mIxEdCaSeNeEdLe", false)).toEqual({
    query: "mIxEdCaSeNeEdLe",
    caseInsensitive: false,
    files: [],
    definitions: [],
    directories: [],
    renderDirs: [],
  });
  expect(await preprocessor.search("mIxEdCaSeNeEdLe", true)).toEqual({
    query: "mIxEdCaSeNeEdLe",
    caseInsensitive: true,
    files: ["nested/deep/helper.js", "notes.txt", "root.ts"],
    definitions: [],
    directories: ["", "nested", "nested/deep"],
    renderDirs: [""],
  });
  expect(await preprocessor.search("sEaRcHnEeDlEaLpHa", false)).toEqual({
    query: "sEaRcHnEeDlEaLpHa",
    caseInsensitive: false,
    files: [],
    definitions: [],
    directories: [],
    renderDirs: [],
  });
  expect(await preprocessor.search("sEaRcHnEeDlEaLpHa", true)).toEqual({
    query: "sEaRcHnEeDlEaLpHa",
    caseInsensitive: true,
    files: ["root.ts"],
    definitions: [gotoDefinitions[1]],
    directories: [""],
    renderDirs: [""],
  });
  expect(await preprocessor.search("sEaRcHnEeDlEeNtItY.sEaRcHnEeDlE", false)).toEqual({
    query: "sEaRcHnEeDlEeNtItY.sEaRcHnEeDlE",
    caseInsensitive: false,
    files: [],
    definitions: [],
    directories: [],
    renderDirs: [],
  });
  expect(await preprocessor.search("sEaRcHnEeDlEeNtItY.sEaRcHnEeDlE", true)).toEqual({
    query: "sEaRcHnEeDlEeNtItY.sEaRcHnEeDlE",
    caseInsensitive: true,
    files: ["root.ts"],
    definitions: gotoDefinitions.slice(1, 4),
    directories: [""],
    renderDirs: [""],
  });
  expect(await preprocessor.search("SearchNeedleEntity.SearchNeedle", false)).toEqual({
    query: "SearchNeedleEntity.SearchNeedle",
    caseInsensitive: false,
    files: ["root.ts"],
    definitions: gotoDefinitions.slice(1, 4),
    directories: [""],
    renderDirs: [""],
  });
  expect(await preprocessor.search("ωMEGAnEEDLE", false)).toEqual({
    query: "ωMEGAnEEDLE",
    caseInsensitive: false,
    files: [],
    definitions: [],
    directories: [],
    renderDirs: [],
  });
  expect(await preprocessor.search("ωMEGAnEEDLE", true)).toEqual({
    query: "ωMEGAnEEDLE",
    caseInsensitive: true,
    files: ["nested/deep/helper.js"],
    definitions: [],
    directories: ["", "nested", "nested/deep"],
    renderDirs: ["nested/deep"],
  });
  const searchCases = [
    { query: "-NEEDLE.[x]*$", files: ["notes.txt"] },
    { query: '["quoted"]*', files: ["notes.txt"] },
    { query: "100%_literal", files: ["wildcard.txt"] },
    { query: "%_", files: ["wildcard.txt"] },
    { query: "§", files: ["nested/deep/helper.js"] },
    { query: "Ωx", files: ["nested/deep/helper.js"] },
    { query: "not-present", files: [] },
  ];
  for (const { query, files } of searchCases) {
    expect((await preprocessor.search(query, false)).files).toEqual(files);
  }

  const dbPath = resolveCacheDbPath(root);
  expect((await stat(dbPath)).isFile()).toBe(true);
  await closePreprocessor(preprocessor);

  const generationId = openDatabase(dbPath, (db) => {
    const activeGeneration = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id
      FROM cache_meta
      WHERE key = 'active_generation'
    `).get();
    if (activeGeneration === null) throw new Error("active generation was not persisted");
    return activeGeneration.id;
  });
  openDatabase(dbPath, (db) => {
    expect(db.query<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }, []>("PRAGMA table_info('GotoDef')").all().map(({ name, type, notnull, pk }) => ({
      name,
      type,
      notnull,
      pk,
    }))).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "generation_id", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "definition_key", type: "TEXT", notnull: 1, pk: 0 },
      { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
      { name: "name", type: "TEXT", notnull: 1, pk: 0 },
      { name: "qualified_name", type: "TEXT", notnull: 1, pk: 0 },
      { name: "source_path", type: "TEXT", notnull: 1, pk: 0 },
      { name: "source_line", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "source_column", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "display_from", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "display_to", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "uml_scope_path", type: "TEXT", notnull: 1, pk: 0 },
      { name: "uml_entity_name", type: "TEXT", notnull: 1, pk: 0 },
      { name: "uml_member_name", type: "TEXT", notnull: 0, pk: 0 },
      { name: "uml_member_occurrence", type: "INTEGER", notnull: 0, pk: 0 },
    ]);
    expect(db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations
    `).all()).toEqual([{ id: generationId, state: "active", cause: "startup" }]);

    const treePaths = db.query<{ path: string }, [number]>(`
      SELECT path FROM tree_entries WHERE generation_id = ? ORDER BY path
    `).all(generationId).map(({ path }) => path);
    expect(treePaths).toEqual(expectedPaths);

    const diagrams = db.query<{ kind: string; scope_path: string; response_json: string }, [number]>(`
      SELECT kind, scope_path, response_json
      FROM diagrams
      WHERE generation_id = ?
      ORDER BY kind, scope_path
    `).all(generationId);
    expect(diagrams.filter(({ kind }) => kind === "packages").map(({ scope_path }) => scope_path)).toEqual([""]);
    expect(diagrams.filter(({ kind }) => kind === "uml").map(({ scope_path }) => scope_path)).toEqual(umlScopePaths);
    // A UML row stores only its completion outcome; the display model lives in normalized tables.
    for (const row of diagrams.filter(({ kind }) => kind === "uml")) {
      const outcome = JSON.parse(row.response_json) as { status?: string; error?: string };
      expect(outcome.status, row.scope_path).toBe(
        row.scope_path === "nul.js" || row.scope_path === "invalid.js" ? "error" : "ready",
      );
      expect(Object.keys(outcome).sort(), row.scope_path).toEqual(
        outcome.status === "error" ? ["error", "status"] : ["status"],
      );
    }
    const packageResponse = JSON.parse(
      diagrams.find(({ kind }) => kind === "packages")?.response_json ?? "null",
    ) as { kind: string; scopePath: string; version?: number };
    expect(packageResponse.kind).toBe("packages");
    expect(packageResponse.scopePath).toBe("");
    expect(packageResponse.version).toBeUndefined();

    expect(db.query<{
      kind: string;
      scope_path: string;
      graph_headers: number;
    }, [number]>(`
      SELECT diagrams.kind, diagrams.scope_path, COUNT(diagram_graphs.kind) AS graph_headers
      FROM diagrams
      LEFT JOIN diagram_graphs
        ON diagram_graphs.generation_id = diagrams.generation_id
        AND diagram_graphs.kind = diagrams.kind
        AND diagram_graphs.scope_path = diagrams.scope_path
      WHERE diagrams.generation_id = ?
      GROUP BY diagrams.kind, diagrams.scope_path
      ORDER BY diagrams.kind, diagrams.scope_path
    `).all(generationId)).toEqual(diagrams.map(({ kind, scope_path }) => ({
      kind,
      scope_path,
      graph_headers: 1,
    })));
    expect(db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) AS count
      FROM diagram_graphs
      WHERE generation_id = ?
    `).get(generationId)).toEqual({ count: diagrams.length });

    const normalizedTables = normalizedGraphTables(db);
    expect(normalizedTables).toContain("diagram_edge_relations");
    expect(normalizedTables).toContain("uml_categories");
    const primaryPayloadColumns: string[] = [];
    for (const table of normalizedTables) {
      primaryPayloadColumns.push(...tableColumns(db, table)
        .filter(({ name, type }) =>
          type.toUpperCase().includes("JSON")
          || name === "response_json"
          || name === "dsl"
          || name === "dsls"
          || name === "mermaid"
          || name === "mermaid_dsl"
        )
        .map(({ name }) => `${table}.${name}`));
    }
    expect(primaryPayloadColumns).toEqual([]);

    for (const table of normalizedTables) {
      const statement = db.query<{ detail: string }, [number, string, string]>(`
        EXPLAIN QUERY PLAN
        SELECT *
        FROM ${table}
        WHERE generation_id = ? AND kind = ? AND scope_path = ?
      `);
      try {
        const plan = statement.all(generationId, "uml", "root.ts");
        expect(
          plan.some(({ detail }) =>
            detail.includes(`sqlite_autoindex_${table}_`)
            && (detail.includes("USING INDEX") || detail.includes("USING COVERING INDEX"))
          ),
          `${table} complete-identity lookup`,
        ).toBe(true);
      } finally {
        statement.finalize();
      }
    }

    const files = db.query<{
      path: string;
      raw_content: string | null;
      display_content: string | null;
      source_error: string | null;
      format_error: string | null;
    }, [number]>(`
      SELECT path, raw_content, display_content, source_error, format_error
      FROM files
      WHERE generation_id = ?
      ORDER BY path
    `).all(generationId);
    expect(files.map(({ path }) => path)).toEqual(
      treeNodes.filter(({ kind }) => kind === "file").map(({ path }) => path),
    );
    expect(files.find(({ path }) => path === "malformed.js")).toMatchObject({
      raw_content: malformedSource,
      display_content: malformedSource,
      source_error: null,
    });
    expect(files.find(({ path }) => path === "malformed.js")?.format_error).toBeString();
    expect(files.find(({ path }) => path === "nul.js")).toMatchObject({
      raw_content: null,
      display_content: null,
      source_error: "file contains NUL bytes",
      format_error: null,
    });
    expect(files.find(({ path }) => path === "invalid.js")).toMatchObject({
      raw_content: null,
      display_content: null,
      source_error: "file is not valid UTF-8 text",
      format_error: null,
    });
    expect(files.find(({ path }) => path === "binary.bin")).toMatchObject({
      raw_content: null,
      display_content: null,
      source_error: "file is not valid UTF-8 text",
      format_error: null,
    });

    const definitionRows = db.query<{
      definition_key: string;
      kind: string;
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
    }, [number]>(`
      SELECT
        definition_key, kind, name, qualified_name, source_path, source_line, source_column,
        display_from, display_to, uml_scope_path, uml_entity_name, uml_member_name,
        uml_member_occurrence
      FROM GotoDef
      WHERE generation_id = ?
      ORDER BY source_path, source_line, source_column, definition_key
    `).all(generationId);
    expect(definitionRows).toEqual(rootDefinitions.map((definition) => ({
      definition_key: definition.key,
      kind: definition.kind,
      name: definition.name,
      qualified_name: definition.qualifiedName,
      source_path: definition.source.path,
      source_line: definition.source.line,
      source_column: definition.source.column,
      display_from: definition.displayFrom,
      display_to: definition.displayTo,
      uml_scope_path: definition.uml.scopePath,
      uml_entity_name: definition.uml.entityName,
      uml_member_name: definition.uml.memberName ?? null,
      uml_member_occurrence: definition.uml.memberOccurrence ?? null,
    })));
    const invalidGotoDef = db.query<never, [number]>(`
      INSERT INTO GotoDef(
        generation_id, definition_key, kind, name, qualified_name, source_path,
        source_line, source_column, display_from, display_to, uml_scope_path,
        uml_entity_name, uml_member_name, uml_member_occurrence
      ) VALUES (?, 'invalid-method', 'method', 'bad', 'Bad.bad', 'root.ts',
        1, 1, 0, 3, 'root.ts', 'Bad', NULL, NULL)
    `);
    try {
      expect(() => invalidGotoDef.run(generationId)).toThrow();
    } finally {
      invalidGotoDef.finalize();
    }
    expect(db.query<{ count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM GotoDef WHERE generation_id = ?",
    ).get(generationId)).toEqual({ count: rootDefinitions.length });

    expect(db.query<{ definition_key: string }, [number, string]>(`
      SELECT GotoDef.definition_key
      FROM goto_def_search
      JOIN GotoDef ON goto_def_search.rowid = GotoDef.id
      WHERE GotoDef.generation_id = ? AND goto_def_search.qualified_name LIKE ?
      ORDER BY GotoDef.source_line, GotoDef.source_column, GotoDef.definition_key
    `).all(generationId, "%SearchNeedleEntity.SearchNeedle%")).toEqual(
      rootDefinitions.slice(1, 4).map(({ key }) => ({ definition_key: key })),
    );
    const definitionQueryPlan = db.query<{ detail: string }, [number, string]>(`
      EXPLAIN QUERY PLAN
      SELECT GotoDef.definition_key
      FROM goto_def_search
      JOIN GotoDef ON goto_def_search.rowid = GotoDef.id
      WHERE GotoDef.generation_id = ? AND goto_def_search.qualified_name LIKE ?
    `).all(generationId, "%SearchNeedleEntity.SearchNeedle%");
    expect(
      definitionQueryPlan.some(({ detail }) =>
        detail.includes("VIRTUAL TABLE INDEX") && detail.includes("L1")
      ),
    ).toBe(true);

    const indexedLike = db.query<{ path: string }, [number, string]>(`
      SELECT files.path AS path
      FROM file_search
      JOIN files ON file_search.rowid = files.id
      WHERE files.generation_id = ? AND file_search.raw_content LIKE ?
      ORDER BY files.path
    `);
    expect(indexedLike.all(generationId, "%mIxEdCaSeNeEdLe%")).toEqual([
      { path: "nested/deep/helper.js" },
      { path: "notes.txt" },
      { path: "root.ts" },
    ]);
    expect(indexedLike.all(generationId, "%-needle.[X]*$%")).toEqual([{ path: "notes.txt" }]);
    expect(indexedLike.all(generationId, `%["quoted"]*%`)).toEqual([{ path: "notes.txt" }]);
    expect(indexedLike.all(generationId, "%ωMEGAnEEDLE%")).toEqual([]);
    indexedLike.finalize();

    const queryPlan = db.query<{ detail: string }, [number, string]>(`
      EXPLAIN QUERY PLAN
      SELECT files.path
      FROM file_search
      JOIN files ON file_search.rowid = files.id
      WHERE files.generation_id = ? AND file_search.raw_content LIKE ?
    `).all(generationId, "%MixedCaseNeedle%");
    expect(queryPlan.some(({ detail }) => detail.includes("VIRTUAL TABLE INDEX") && detail.includes("L0"))).toBe(true);
  });

  const cache = new Cache(dbPath);
  try {
    const packagePayload = cache.readPackageDiagram(generationId);
    const packageGraph = cache.readDiagramGraph(generationId, "packages", "");
    if (packagePayload === null || packageGraph?.kind !== "packages") {
      throw new Error("package diagram was not persisted");
    }
    expect(packagePayload).toEqual({
      ...renderPackageDiagramGraph(packageGraph),
      scopePath: "",
      status: "ready",
      definitions: [],
      externalUsers: [],
      localUsers: [],
    });

    for (const scopePath of umlScopePaths) {
      const graph = cache.readDiagramGraph(generationId, "uml", scopePath);
      expect(graph, `${scopePath} graph`).not.toBeNull();
      expect(graph).toMatchObject({ kind: "uml", scopePath });
      const read = cache.readUmlDiagram(generationId, { kind: "file", path: scopePath });
      expect(read.state, `${scopePath} selection`).toBe("complete");
    }

    // A scope write replaces the file row, its editor definitions and their search entries.
    const replacementContent = "class CacheReplacement {}\n";
    const replacementDefinition: EditorGotoDefinition = {
      key: '["class","CacheReplacement",0,null,null]',
      kind: "class",
      name: "CacheReplacement",
      qualifiedName: "CacheReplacement",
      source: { path: "root.ts", line: 1, column: 7 },
      uml: { scopePath: "root.ts", entityName: "CacheReplacement" },
      displayFrom: 6,
      displayTo: 22,
    };
    cache.writeScope(generationId, {
      file: {
        path: "root.ts",
        rawContent: replacementContent,
        displayContent: replacementContent,
        sourceError: null,
        formatError: null,
        language: "typescript",
      },
      definitions: [replacementDefinition],
    });
    expect(cache.readFile(generationId, "root.ts")).toEqual({
      path: "root.ts",
      rawContent: replacementContent,
      displayContent: replacementContent,
      sourceError: null,
      formatError: null,
      language: "typescript",
    });
    expect(cache.readDefinitions(generationId, "root.ts")).toEqual([replacementDefinition]);
    expect(cache.searchFiles(
      generationId,
      "SearchNeedleEntity.SearchNeedle",
      false,
    )).toEqual({
      query: "SearchNeedleEntity.SearchNeedle",
      caseInsensitive: false,
      files: [],
      definitions: [],
      directories: [],
      renderDirs: [],
    });
    expect(cache.searchFiles(generationId, "CacheReplacement", false)).toEqual({
      query: "CacheReplacement",
      caseInsensitive: false,
      files: ["root.ts"],
      definitions: withoutDisplay([replacementDefinition]),
      directories: [""],
      renderDirs: [""],
    });
  } finally {
    cache.close();
  }
}, 60_000);

test("rejects unavailable or inconsistent package fallback sources without replacing target rows", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-fallback-");
  const dbPath = join(root, "fallback.db");
  const cache = new Cache(dbPath);
  let activeCache = cache;
  try {
    const sourceGenerationId = activeCache.beginGeneration("startup", "");
    const targetGenerationId = activeCache.beginGeneration("watch", "");
    for (const generationId of [sourceGenerationId, targetGenerationId]) {
      activeCache.writeDiscovery(
        generationId,
        FIXTURE_PACKAGES,
        { graph: extractPackageDiagramGraph(FIXTURE_PACKAGES), outcome: { status: "ready" } },
        renderPackageDiagramGraph,
      );
    }

    const cases = [
      { name: "missing generation", sourceGenerationId: sourceGenerationId + 10_000 },
      { name: "fallback source is the target itself", sourceGenerationId: targetGenerationId },
    ];
    for (const { name, sourceGenerationId: fallbackId } of cases) {
      const beforeGraph = activeCache.readDiagramGraph(targetGenerationId, "packages", "");
      const beforeResponse = activeCache.readPackageDiagram(targetGenerationId);
      let rendered = false;
      expect(() =>
        activeCache.writeDiscovery(
          targetGenerationId,
          [],
          {
            fallbackSource: { sourceGenerationId: fallbackId },
            outcome: { status: "error", error: name },
          },
          (graph) => {
            rendered = true;
            return renderPackageDiagramGraph(graph);
          },
        ), name).toThrow(DiagramMaterializationError);
      expect(rendered, name).toBe(false);
      expect(activeCache.readDiagramGraph(targetGenerationId, "packages", ""), name).toEqual(beforeGraph);
      expect(activeCache.readPackageDiagram(targetGenerationId), name).toEqual(beforeResponse);
      expect(activeCache.readPackages(targetGenerationId), name).toEqual(FIXTURE_PACKAGES);
    }

    // A healthy fallback republishes the source rendering even when the target renderer fails.
    const sourceResponse = activeCache.readPackageDiagram(sourceGenerationId);
    if (sourceResponse === null) throw new Error("source response was not persisted");
    const fallback = activeCache.writeDiscovery(
      targetGenerationId,
      [],
      {
        fallbackSource: { sourceGenerationId },
        outcome: { status: "error", error: "discovery failed" },
      },
      () => {
        throw new Error("renderer failure");
      },
    );
    expect(fallback).toEqual({
      ...sourceResponse,
      status: "error",
      error: "discovery failed",
    });
    expect(activeCache.readPackageDiagram(targetGenerationId)).toEqual(fallback);

    const beforeDisagreementGraph = activeCache.readDiagramGraph(targetGenerationId, "packages", "");
    const beforeDisagreementResponse = activeCache.readPackageDiagram(targetGenerationId);
    activeCache.close();
    openDatabase(dbPath, (db) => {
      db.query<never, [string, number]>(`
        UPDATE diagrams
        SET response_json = ?
        WHERE generation_id = ? AND kind = 'packages' AND scope_path = ''
      `).run(JSON.stringify({ ...sourceResponse, scopePath: "different" }), sourceGenerationId);
    });
    activeCache = new Cache(dbPath);

    expect(() =>
      activeCache.writeDiscovery(
        targetGenerationId,
        [],
        {
          fallbackSource: { sourceGenerationId },
          outcome: { status: "error", error: "source response disagrees with graph identity" },
        },
        renderPackageDiagramGraph,
      )).toThrow(DiagramMaterializationError);
    expect(activeCache.readDiagramGraph(targetGenerationId, "packages", "")).toEqual(
      beforeDisagreementGraph,
    );
    expect(activeCache.readPackageDiagram(targetGenerationId)).toEqual(
      beforeDisagreementResponse,
    );
  } finally {
    activeCache.close();
  }
});

test("rejects invalid and uncatalogued UML graphs atomically", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-invalid-graph-");
  const dbPath = join(root, "invalid-graph.db");
  const cache = new Cache(dbPath);
  try {
    const generationId = cache.beginGeneration("startup", "");
    const scopePath = "constraints.ts";
    cache.writeDefinitionIndex(generationId, fixtureCatalogue(scopePath));
    const validGraph = fixtureUmlGraph(scopePath);
    cache.writeScope(generationId, {
      diagram: { graph: validGraph, outcome: { status: "ready" } },
      file: {
        path: scopePath,
        rawContent: "baseline",
        displayContent: "baseline",
        sourceError: null,
        formatError: null,
        language: "typescript",
      },
      definitions: [],
    });
    const baselineGraph = cache.readDiagramGraph(generationId, "uml", scopePath);
    const baselineFile = cache.readFile(generationId, scopePath);
    expect(baselineGraph).toMatchObject({ kind: "uml", scopePath, formatVersion: 2 });

    const key = (name: string) => `${scopePath}:${name}`;
    const cases: Array<{
      name: string;
      materialization: boolean;
      mutate(graph: UmlDiagramGraph): void;
      outcome?: { status: "error"; error: string };
    }> = [
      {
        name: "graph scope path is not normalized",
        materialization: true,
        mutate: (graph) => {
          graph.scopePath = `./${scopePath}`;
        },
      },
      {
        name: "node is not an indexed definition",
        materialization: true,
        mutate: (graph) => {
          const [node] = graph.nodes;
          if (node === undefined) throw new Error("fixture UML graph has no first node");
          node.nodeId = key("Missing");
          graph.edges[0]!.sourceNodeId = key("Missing");
          graph.relations[0]!.sourceNodeId = key("Missing");
          graph.entities[0]!.definitionKey = key("Missing");
          graph.categories[0]!.definitionKey = key("Missing");
        },
      },
      {
        name: "error outcome keeps a populated graph",
        materialization: true,
        mutate: () => undefined,
        outcome: { status: "error", error: "extraction failed" },
      },
      {
        name: "duplicate node ordinal",
        materialization: false,
        mutate: (graph) => {
          graph.nodes[1]!.nodeOrdinal = 0;
        },
      },
      {
        name: "edge weight differs from relation count",
        materialization: false,
        mutate: (graph) => {
          graph.edges[0]!.weight = 2;
        },
      },
      {
        name: "relation endpoints differ from the parent edge",
        materialization: false,
        mutate: (graph) => {
          graph.relations[0]!.targetNodeId = key("Gamma");
        },
      },
      {
        name: "bare graph retains model rows",
        materialization: false,
        mutate: (graph) => {
          graph.renderMode = "bare";
        },
      },
      {
        name: "entity has no entity node",
        materialization: false,
        mutate: (graph) => {
          graph.nodes[0]!.nodeKind = "boundary";
        },
      },
    ];
    for (const { name, materialization, mutate, outcome } of cases) {
      const graph = structuredClone(validGraph);
      mutate(graph);
      let thrown: unknown;
      try {
        cache.writeScope(generationId, {
          diagram: { graph, outcome: outcome ?? { status: "ready" } },
          file: {
            path: scopePath,
            rawContent: name,
            displayContent: name,
            sourceError: null,
            formatError: null,
            language: "typescript",
          },
          definitions: [],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(Error);
      expect(thrown instanceof DiagramMaterializationError, name).toBe(materialization);
      expect(cache.readDiagramGraph(generationId, "uml", scopePath), name).toEqual(baselineGraph);
      expect(cache.readFile(generationId, scopePath), name).toEqual(baselineFile);
    }

    // A nominal entity must actually be contributed by the file that claims it.
    const foreignScope = "foreign.ts";
    const foreignKey = `${foreignScope}:Delta`;
    cache.writeDefinitionIndex(generationId, {
      ...fixtureCatalogue(scopePath),
      definitions: [
        ...fixtureCatalogue(scopePath).definitions,
        {
          key: foreignKey,
          parentKey: null,
          isTopLevel: true,
          hasBody: true,
          name: "Delta",
          qualifiedName: "Delta",
          kind: "class",
          type: "Delta",
          source: { path: foreignScope, line: 1, column: 14 },
        },
      ],
      contributors: [
        ...fixtureCatalogue(scopePath).contributors,
        { definitionKey: foreignKey, sourcePath: foreignScope, kind: "declaration" },
      ],
    });
    const foreignGraph = structuredClone(validGraph);
    foreignGraph.nodes.push({
      nodeId: foreignKey,
      nodeOrdinal: foreignGraph.nodes.length,
      nodeKind: "entity",
      name: "Delta",
    });
    foreignGraph.entities.push({
      entityOrdinal: foreignGraph.entities.length,
      definitionKey: foreignKey,
      entityKind: "class",
      name: "Delta",
    });
    expect(() =>
      cache.writeScope(generationId, {
        diagram: { graph: foreignGraph, outcome: { status: "ready" } },
        definitions: [],
      })).toThrow(DiagramMaterializationError);
  } finally {
    cache.close();
  }
});

test("labels repeated scope work across startup and watch generations", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-generations-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "generation-labels" }));
  await writeFixtureFile(root, "index.ts", "export const generationLabel = 1;\n");

  const errors: Error[] = [];
  const progressEvents: PreprocessProgressEvent[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => undefined,
    (error) => errors.push(error),
    1,
    (event) => progressEvents.push(event),
  );

  await preprocessor.ready();
  await preprocessor.whenIdle();
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();

  expect(errors).toEqual([]);
  const generationIds = [...new Set(progressEvents.map((event) => event.generationId))];
  expect(generationIds).toHaveLength(2);
  const [startupGenerationId, watchGenerationId] = generationIds;
  if (startupGenerationId === undefined || watchGenerationId === undefined) {
    throw new Error("startup and watch generation IDs were not recorded");
  }
  expect(startupGenerationId).not.toBe(watchGenerationId);
  expect(
    Number.isSafeInteger(startupGenerationId) &&
      startupGenerationId > 0 &&
      Number.isSafeInteger(watchGenerationId) &&
      watchGenerationId > 0,
  ).toBe(true);

  for (const [generationId, cause] of [
    [startupGenerationId, "startup"],
    [watchGenerationId, "watch"],
  ] as const) {
    const generationEvents = progressEvents.filter((event) => event.generationId === generationId);
    expect([...new Set(generationEvents.map((event) => event.cause))]).toEqual([cause]);
    // The catalogue runs once for the whole generation; UML is per source file, never per directory.
    expect(
      [...new Set(
        generationEvents
          .filter((event) => event.component === "definitions")
          .map((event) => event.resource),
      )],
    ).toEqual(["."]);
    expect(
      [...new Set(
        generationEvents
          .filter((event) => event.component === "uml")
          .map((event) => event.resource),
      )].sort(),
    ).toEqual(["./index.ts"]);
    expect(
      [...new Set(
        generationEvents
          .filter((event) => event.component === "code")
          .map((event) => event.resource),
      )].sort(),
    ).toEqual(["./index.ts"]);
    for (const group of groupProgressEvents(generationEvents)) {
      expect(group.events, `${cause} ${group.component} ${group.resource}`).toEqual([
        "start",
        "done",
      ]);
    }
  }

  await closePreprocessor(preprocessor);
  openDatabase(resolveCacheDbPath(root), (db) => {
    const activeGeneration = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id
      FROM cache_meta
      WHERE key = 'active_generation'
    `).get();
    if (activeGeneration === null) throw new Error("active generation was not persisted");
    expect(activeGeneration.id).toBe(watchGenerationId);
    expectOnlyGeneration(db, watchGenerationId);
  });
}, 30_000);

test("serves concurrent roots from one target file with a single UML phase", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-priority-");
  const targetPath = "z-priority.ts";
  const blockerSource = Array.from(
    { length: 1_000 },
    (_, index) => `export const blocker${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  const backlogSource = Array.from(
    { length: 300 },
    (_, index) => `export const backlog${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  const backlogPaths = Array.from(
    { length: 8 },
    (_, index) => `m-pending-${String(index).padStart(2, "0")}.ts`,
  );
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "priority-root" }));
  await writeFixtureFile(root, "a-blocker.ts", `${blockerSource}\n`);
  await Promise.all(backlogPaths.map((path) => writeFixtureFile(root, path, `${backlogSource}\n`)));
  await writeFixtureFile(
    root,
    targetPath,
    [
      "export class PriorityDependency {}",
      "export class PriorityTarget { value: PriorityDependency; }",
      "export class PriorityIsolated {}",
      "",
    ].join("\n"),
  );

  const blockerStarted = Promise.withResolvers<void>();
  const progress: PreprocessProgressEvent[] = [];
  const promotions: string[] = [];
  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
    1,
    (event) => {
      progress.push(event);
      if (event.event === "start" && event.component === "code" && event.resource === "./a-blocker.ts") {
        blockerStarted.resolve();
      }
    },
  );
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });
  await preprocessor.ready();
  const outline = await preprocessor.getFileDefinitions(targetPath);
  await withTimeout(blockerStarted.promise, "blocker preprocessing start", 30_000);

  // Three selections rooted in the same unprocessed file: the first pending reply must not be
  // cached, and the file must be extracted exactly once for all of them.
  const [targetDiagram, isolatedDiagram, fileDiagram] = await withTimeout(
    Promise.all([
      preprocessor.getDiagram(definitionRequest(targetPath, definitionKeyOf(outline, "PriorityTarget"))),
      preprocessor.getDiagram(definitionRequest(targetPath, definitionKeyOf(outline, "PriorityIsolated"))),
      preprocessor.getDiagram(fileRequest(targetPath)),
    ]),
    "rooted selections from a building generation",
    45_000,
  );

  const targetView = definitionsView(targetDiagram);
  expect(expectUml(targetDiagram).status).toBe("ready");
  expect(nodeNames(targetView)).toEqual(["PriorityDependency", "PriorityTarget"]);
  expect(edgeSummary(targetView)).toEqual(["PriorityTarget -references-> PriorityDependency"]);

  // A completed root with no outgoing reference is a one-node graph, not a pending selection.
  const isolatedView = definitionsView(isolatedDiagram);
  expect(nodeNames(isolatedView)).toEqual(["PriorityIsolated"]);
  expect(edgeSummary(isolatedView)).toEqual([]);
  expect(frameSummary(isolatedView)).toEqual([
    { root: "PriorityIsolated", nodes: ["PriorityIsolated"] },
  ]);

  expect(frameSummary(definitionsView(fileDiagram)).map(({ root: name }) => name)).toEqual([
    "PriorityDependency",
    "PriorityTarget",
    "PriorityIsolated",
  ]);

  const targetUmlPhases = groupProgressEvents(progress).filter(
    (group) => group.component === "uml" && group.resource === `./${targetPath}`,
  );
  expect(targetUmlPhases.map(({ events }) => events)).toEqual([["start", "done"]]);

  // The requested closure finished while the background backlog and promotion were still pending.
  const backlogDone = progress.filter(
    (event) =>
      event.event === "done" && event.component === "code"
      && backlogPaths.some((path) => event.resource === `./${path}`),
  );
  expect(backlogDone.length).toBeLessThan(backlogPaths.length / 2);
  expect(idleResolved).toBe(false);
  expect(promotions).toEqual([]);

  await idle;
  expect(promotions).toEqual(["promoted"]);
  expect(errors).toEqual([]);
}, 90_000);

test("reports queued, processing and done for a prioritized selection without promoting the incomplete generation", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-priority-api-");
  const targetPath = "z-priority-api.ts";
  const blockerSource = Array.from(
    { length: 1_000 },
    (_, index) => `export const blocker${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "priority-api" }));
  await writeFixtureFile(root, "a-blocker.ts", `${blockerSource}\n`);
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      writeFixtureFile(
        root,
        `m-pending-${String(index).padStart(2, "0")}.ts`,
        `export class Pending${index} {}\n`,
      )),
  );
  await writeFixtureFile(root, targetPath, "export class PriorityTarget { locate() { return 1; } }\n");

  const blockerStarted = Promise.withResolvers<void>();
  const targetStarted = Promise.withResolvers<void>();
  const progress: PreprocessProgressEvent[] = [];
  const promotions: string[] = [];
  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
    1,
    (event) => {
      progress.push(event);
      if (event.event === "start" && event.component === "code" && event.resource === "./a-blocker.ts") {
        blockerStarted.resolve();
      }
      if (event.event === "start" && event.component === "code" && event.resource === `./${targetPath}`) {
        targetStarted.resolve();
      }
    },
  );
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });
  await preprocessor.ready();
  await withTimeout(blockerStarted.promise, "blocker preprocessing start", 30_000);

  expect(await preprocessor.getDefinition(targetPath, { line: 1, column: 14 })).toBeNull();
  const priority = await preprocessor.prioritize(`./${targetPath}`);
  expect(priority).toEqual({
    resource: targetPath,
    status: "queued",
    requestId: priority.requestId,
  });
  await withTimeout(targetStarted.promise, "prioritized source start", 30_000);
  expect(await preprocessor.poll(priority.requestId)).toEqual({
    resource: targetPath,
    status: "processing",
    requestId: priority.requestId,
  });
  expect(
    progress.findIndex(({ event, component, resource }) =>
      event === "start" && component === "code" && resource === `./${targetPath}`
    ),
  ).toBeGreaterThan(
    progress.findIndex(({ event, component, resource }) =>
      event === "start" && component === "code" && resource === "./a-blocker.ts"
    ),
  );
  expect(idleResolved).toBe(false);
  expect(promotions).toEqual([]);

  await idle;
  expect(await preprocessor.poll(priority.requestId)).toEqual({
    resource: targetPath,
    status: "done",
    requestId: priority.requestId,
  });
  expect(promotions).toEqual(["promoted"]);
  expect(errors).toEqual([]);
}, 60_000);

test("reuses warm SQL and a recovered generation without restarting UML extraction", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-warm-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "warm-cache" }));
  await writeFixtureFile(root, "dep.ts", "export class Dependency {}\n");
  await writeFixtureFile(
    root,
    "root.ts",
    'import { Dependency } from "./dep";\nexport class Root { value: Dependency; }\n',
  );

  const umlStarts = (events: readonly PreprocessProgressEvent[]) =>
    events.filter((event) => event.component === "uml" && event.event === "start").length;

  const warmProgress: PreprocessProgressEvent[] = [];
  const warmErrors: Error[] = [];
  const warm = trackedPreprocessor(
    root,
    () => undefined,
    (error) => warmErrors.push(error),
    1,
    (event) => warmProgress.push(event),
  );
  await warm.ready();
  await warm.whenIdle();
  const rootKey = definitionKeyOf(await warm.getFileDefinitions("root.ts"), "Root");
  const extractedPhases = umlStarts(warmProgress);
  expect(extractedPhases).toBe(2);

  const warmDiagram = definitionsView(await warm.getDiagram(definitionRequest("root.ts", rootKey)));
  expect(nodeNames(warmDiagram)).toEqual(["Dependency", "Root"]);
  expect(edgeSummary(warmDiagram)).toEqual(["Root -references-> Dependency"]);
  await warm.getDiagram(fileRequest("root.ts"));
  await warm.getDiagram(directoryRequest(""));
  expect(umlStarts(warmProgress)).toBe(extractedPhases);
  expect(warmErrors).toEqual([]);
  await closePreprocessor(warm);

  const restartProgress: PreprocessProgressEvent[] = [];
  const restartErrors: Error[] = [];
  const restarted = trackedPreprocessor(
    root,
    () => undefined,
    (error) => restartErrors.push(error),
    1,
    (event) => restartProgress.push(event),
  );
  await restarted.ready();
  await restarted.whenIdle();
  const restartedDiagram = definitionsView(
    await restarted.getDiagram(definitionRequest("root.ts", rootKey)),
  );
  expect(nodeNames(restartedDiagram)).toEqual(["Dependency", "Root"]);
  expect(edgeSummary(restartedDiagram)).toEqual(["Root -references-> Dependency"]);
  // An unchanged fingerprint recovers the active generation: nothing is preprocessed again.
  expect(restartProgress).toEqual([]);
  expect(restartErrors).toEqual([]);
  await closePreprocessor(restarted);
}, 60_000);

test("drops a root's last edge when its dependency is removed and 404s a deleted root", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-root-updates-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "root-updates" }));
  await writeFixtureFile(root, "dep.ts", "export class Dependency {}\n");
  await writeFixtureFile(
    root,
    "root.ts",
    'import { Dependency } from "./dep";\nexport class Root { value: Dependency; }\n',
  );

  const promotions: string[] = [];
  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();

  const rootKey = definitionKeyOf(await preprocessor.getFileDefinitions("root.ts"), "Root");
  const before = definitionsView(await preprocessor.getDiagram(definitionRequest("root.ts", rootKey)));
  expect(nodeNames(before)).toEqual(["Dependency", "Root"]);
  expect(edgeSummary(before)).toEqual(["Root -references-> Dependency"]);

  await writeFixtureFile(root, "root.ts", "\nexport class Root { value: number; }\n");
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();

  // The key is stable across a line-only edit, so the selection survives the rebuild.
  expect(definitionKeyOf(await preprocessor.getFileDefinitions("root.ts"), "Root")).toBe(rootKey);
  const after = definitionsView(await preprocessor.getDiagram(definitionRequest("root.ts", rootKey)));
  expect(nodeNames(after)).toEqual(["Root"]);
  expect(edgeSummary(after)).toEqual([]);
  expect(frameSummary(after)).toEqual([{ root: "Root", nodes: ["Root"] }]);

  await writeFixtureFile(root, "root.ts", "export class Renamed {}\n");
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();
  const promotionsBefore = promotions.length;

  const failure = await withTimeout(
    captureError(preprocessor.getDiagram(definitionRequest("root.ts", rootKey))),
    "deleted root selection",
  );
  expect(failure.code).toBe("NOT_FOUND");
  expect(failure.message).toBe("Definition not found");
  // A missing root is final: it never triggers a repair rebuild loop.
  expect(promotions.length).toBe(promotionsBefore);
  expect(errors).toEqual([]);
  await closePreprocessor(preprocessor);
}, 60_000);

test("settles rooted selections across supersession and close", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-selection-settling-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "selection-settling" }));
  await writeFixtureFile(root, "app.ts", "export class First {}\n");

  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(root, () => undefined, (error) => errors.push(error));
  await preprocessor.ready();
  await preprocessor.whenIdle();

  await writeFixtureFile(root, "app.ts", "export class Second {}\n");
  preprocessor.rebuild("watch");
  const superseded = preprocessor.getDiagram(fileRequest("app.ts"));
  await writeFixtureFile(root, "app.ts", "export class Third {}\n");
  preprocessor.rebuild("watch");
  const settled = definitionsView(await withTimeout(superseded, "superseded diagram read", 30_000));
  expect(nodeNames(settled)).toEqual(["Third"]);
  await preprocessor.whenIdle();
  expect(errors).toEqual([]);

  await writeFixtureFile(root, "app.ts", "export class Fourth {}\n");
  preprocessor.rebuild("watch");
  const duringClose = preprocessor.getDiagram(fileRequest("app.ts")).then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
  await closePreprocessor(preprocessor);
  expect(["resolved", "rejected"]).toContain(
    await withTimeout(duringClose, "diagram read during close"),
  );
}, 60_000);

test("drains superseded subprocess jobs before discarding their generation", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-supersession-");
  const sourcePaths = Array.from(
    { length: 80 },
    (_, index) => `bulk/file-${String(index).padStart(3, "0")}.ts`,
  );
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "bulk-root" }));
  await Promise.all(
    sourcePaths.map((path, index) =>
      writeFixtureFile(root, path, `export class Value${index} {}\n`),
    ),
  );

  const promotions: string[] = [];
  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
    4,
  );
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });

  await preprocessor.ready();
  expect(idleResolved).toBe(false);
  preprocessor.rebuild("watch");
  await idle;

  expect(errors).toEqual([]);
  expect(promotions).toEqual(["promoted"]);
  const treeFiles = flattenTree(await preprocessor.getTree())
    .filter(({ kind, path }) => kind === "file" && path.endsWith(".ts"))
    .map(({ path }) => path);
  expect(treeFiles).toEqual(sourcePaths);
  const [firstSourcePath] = sourcePaths;
  if (firstSourcePath === undefined) throw new Error("bulk source fixture was not created");
  expect(await preprocessor.getDefinition(firstSourcePath, { line: 1, column: 14 })).toEqual({
    key: '["class","Value0",0,null,null]',
    kind: "class",
    name: "Value0",
    qualifiedName: "Value0",
    source: { path: firstSourcePath, line: 1, column: 14 },
    uml: { scopePath: firstSourcePath, entityName: "Value0" },
  });
  await closePreprocessor(preprocessor);

  openDatabase(resolveCacheDbPath(root), (db) => {
    const generations = db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ state: "active", cause: "watch" });
    const active = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id
      FROM cache_meta
      WHERE key = 'active_generation'
    `).get();
    expect(active).not.toBeNull();
    if (active === null) throw new Error("active generation was not persisted");
    expect(active.id).toBe(generations[0]?.id);
    expect(db.query<{ generation_id: number; count: number }, []>(`
      SELECT generation_id, COUNT(*) AS count
      FROM GotoDef
      GROUP BY generation_id
    `).all()).toEqual([{ generation_id: active.id, count: sourcePaths.length }]);
    expectOnlyGeneration(db, active.id);
  });
}, 60_000);

test("startup recovery removes orphan generations and rebuilds when the active pointer is invalid", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-recovery-");
  const dbPath = resolveCacheDbPath(root);
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "root-workspace" }));
  await writeFixtureFile(root, "app.js", 'export const state="initial-cache";\n');

  const firstErrors: Error[] = [];
  const first = trackedPreprocessor(root, () => undefined, (error) => firstErrors.push(error));
  await first.ready();
  await first.whenIdle();
  expect((await first.search("initial-cache", false)).files).toEqual(["app.js"]);
  expect(firstErrors).toEqual([]);
  await closePreprocessor(first);

  const active = openDatabase(dbPath, (db) => {
    const activeGeneration = db.query<{ id: number; started_at: number }, []>(`
      SELECT generations.id AS id, generations.started_at AS started_at
      FROM cache_meta
      JOIN generations ON generations.id = CAST(cache_meta.value AS INTEGER)
      WHERE cache_meta.key = 'active_generation'
    `).get();
    if (activeGeneration === null) throw new Error("active generation was not persisted");
    return activeGeneration;
  });
  const activeId = active.id;
  const orphanCache = new Cache(dbPath);
  let orphanId: number;
  try {
    orphanId = orphanCache.beginGeneration("watch", "");
    orphanCache.writeDefinitionIndex(orphanId, fixtureCatalogue("orphan.ts"));
    orphanCache.writeScope(orphanId, {
      diagram: { graph: fixtureUmlGraph("orphan.ts"), outcome: { status: "ready" } },
      definitions: [],
    });
  } finally {
    orphanCache.close();
  }
  openDatabase(dbPath, (db) => {
    db.query<never, [number]>(`
      INSERT INTO GotoDef(
        generation_id, definition_key, kind, name, qualified_name, source_path,
        source_line, source_column, display_from, display_to, uml_scope_path,
        uml_entity_name, uml_member_name, uml_member_occurrence
      ) VALUES (?, 'orphan-definition', 'class', 'OrphanDefinition', 'OrphanDefinition',
        'orphan.ts', 1, 14, 13, 29, 'orphan.ts', 'OrphanDefinition', NULL, NULL)
    `).run(orphanId);
  });
  const seeded = { activeId, orphanId };

  const recoveryReady: string[] = [];
  const recoveryProgress: PreprocessProgressEvent[] = [];
  const recoveryErrors: Error[] = [];
  const recoveryProbe = trackedPreprocessor(
    root,
    () => recoveryReady.push("ready"),
    (error) => recoveryErrors.push(error),
    1,
    (event) => recoveryProgress.push(event),
  );
  await recoveryProbe.ready();
  await recoveryProbe.whenIdle();
  expect(recoveryReady).toEqual(["ready"]);
  expect(recoveryProgress).toEqual([]);
  expect(recoveryErrors).toEqual([]);

  openDatabase(dbPath, (db) => {
    expect(db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all()).toEqual([
      { id: seeded.activeId, state: "active", cause: "startup" },
    ]);
    expect(db.query<{ count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM GotoDef WHERE generation_id = ?",
    ).get(seeded.orphanId)).toEqual({ count: 0 });
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM goto_def_search WHERE goto_def_search MATCH 'OrphanDefinition'",
    ).get()).toEqual({ count: 0 });
    for (const table of normalizedGraphTables(db)) {
      expect(
        db.query<{ count: number }, [number, string]>(
          `SELECT COUNT(*) AS count FROM "${table}" WHERE generation_id = ? AND scope_path = ?`,
        ).get(seeded.orphanId, "orphan.ts"),
        table,
      ).toEqual({ count: 0 });
    }
    expectOnlyGeneration(db, seeded.activeId);
  });
  await closePreprocessor(recoveryProbe);

  await writeFixtureFile(root, "app.js", 'export const state="after-orphan-recovery";\n');
  const secondErrors: Error[] = [];
  const second = trackedPreprocessor(root, () => undefined, (error) => secondErrors.push(error));
  await second.ready();
  await second.whenIdle();
  expect((await second.search("after-orphan-recovery", false)).files).toEqual(["app.js"]);
  expect((await second.search("initial-cache", false)).files).toEqual([]);
  expect(secondErrors).toEqual([]);
  const restartedId = openDatabase(dbPath, (db) => {
    const generations = db.query<{ id: number; state: string; cause: string; started_at: number }, []>(`
      SELECT id, state, cause, started_at FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    const [generation] = generations;
    if (generation === undefined) throw new Error("startup generation was not rebuilt");
    expect(generation).toMatchObject({ state: "active", cause: "startup" });
    expect(generation.started_at).toBeGreaterThan(active.started_at);
    return generation.id;
  });

  second.rebuild("watch");
  await second.whenIdle();
  expect((await second.search("after-orphan-recovery", false)).files).toEqual(["app.js"]);
  expect((await second.search("initial-cache", false)).files).toEqual([]);
  expect(secondErrors).toEqual([]);
  await closePreprocessor(second);

  openDatabase(dbPath, (db) => {
    const generations = db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    const [generation] = generations;
    if (generation === undefined) throw new Error("watch generation was not promoted");
    expect(generation).toMatchObject({ state: "active", cause: "watch" });
    expect(generation.id).not.toBe(restartedId);
    expectOnlyGeneration(db, generation.id);
  });

  await writeFixtureFile(root, "app.js", 'export const state="invalid-pointer-rebuilt";\n');
  const invalidPointerCache = new Cache(dbPath);
  let invalidPointerOrphanId: number;
  try {
    invalidPointerOrphanId = invalidPointerCache.beginGeneration("watch", "");
    invalidPointerCache.writeDefinitionIndex(
      invalidPointerOrphanId,
      fixtureCatalogue("invalid-pointer-orphan.ts"),
    );
    invalidPointerCache.writeScope(invalidPointerOrphanId, {
      diagram: {
        graph: fixtureUmlGraph("invalid-pointer-orphan.ts"),
        outcome: { status: "ready" },
      },
      definitions: [],
    });
  } finally {
    invalidPointerCache.close();
  }
  openDatabase(dbPath, (db) => {
    db.query<never, [string]>(`
      UPDATE cache_meta SET value = ? WHERE key = 'active_generation'
    `).run("999999999");
  });

  const thirdErrors: Error[] = [];
  const third = trackedPreprocessor(root, () => undefined, (error) => thirdErrors.push(error));
  await third.ready();
  expect((await third.search("invalid-pointer-rebuilt", false)).files).toEqual(["app.js"]);
  await third.whenIdle();
  expect(thirdErrors).toEqual([]);
  await closePreprocessor(third);

  openDatabase(dbPath, (db) => {
    const generations = db.query<{ id: number; state: string }, []>(`
      SELECT id, state FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    const [generation] = generations;
    if (generation === undefined) throw new Error("active generation was not rebuilt");
    expect(generation.state).toBe("active");
    const pointer = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id FROM cache_meta WHERE key = 'active_generation'
    `).get();
    expect(pointer).not.toBeNull();
    if (pointer === null) throw new Error("active generation pointer was not rebuilt");
    expect(pointer.id).toBe(generation.id);
    expect(pointer.id).not.toBe(999999999);
    expect(db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) AS count FROM package_snapshots WHERE generation_id = ?
    `).get(pointer.id)?.count).toBe(1);
    expect(db.query<{ path: string }, [number]>(`
      SELECT path FROM tree_entries WHERE generation_id = ? ORDER BY path
    `).all(pointer.id).map(({ path }) => path)).toEqual(["", "app.js", "package.json"]);
    expectOnlyGeneration(db, pointer.id);
    for (const table of normalizedGraphTables(db)) {
      expect(
        db.query<{ count: number }, [number, string]>(
          `SELECT COUNT(*) AS count FROM "${table}" WHERE generation_id = ? AND scope_path = ?`,
        ).get(invalidPointerOrphanId, "invalid-pointer-orphan.ts"),
        table,
      ).toEqual({ count: 0 });
    }
  });
}, 60_000);

test("startup retries diagram scopes whose cached outcome is an error", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-failure-retry-");
  const dbPath = resolveCacheDbPath(root);
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "retry-workspace" }));
  await writeFixtureFile(root, "app.ts", "export class RetryTarget {}\n");

  const first = trackedPreprocessor(root, () => undefined, () => undefined);
  await first.ready();
  await first.whenIdle();
  await closePreprocessor(first);
  const readActiveId = () =>
    openDatabase(dbPath, (db) =>
      db.query<{ id: number }, []>(
        `SELECT CAST(value AS INTEGER) AS id FROM cache_meta WHERE key = 'active_generation'`,
      ).get()?.id);
  const seededId = readActiveId();
  if (seededId === undefined) throw new Error("active generation was not persisted");

  // A healthy warm cache is reused: no new generation.
  const second = trackedPreprocessor(root, () => undefined, () => undefined);
  await second.ready();
  await second.whenIdle();
  await closePreprocessor(second);
  expect(readActiveId()).toBe(seededId);

  // Poison the cached per-file UML outcome.
  const changes = openDatabase(dbPath, (db) =>
    db.query<never, [number]>(`
      UPDATE diagrams
      SET response_json = json_object('status', 'error', 'error', 'seeded stale failure')
      WHERE generation_id = ? AND kind = 'uml' AND scope_path = 'app.ts'
    `).run(seededId).changes);
  expect(changes).toBe(1);

  const thirdErrors: Error[] = [];
  const third = trackedPreprocessor(root, () => undefined, (error) => thirdErrors.push(error));
  await third.ready();
  await third.whenIdle();
  const repaired = expectUml(await third.getDiagram(fileRequest("app.ts")));
  await closePreprocessor(third);
  expect(thirdErrors).toEqual([]);
  expect(repaired.status).toBe("ready");
  expect(repaired.error).toBeUndefined();
  expect(nodeNames(definitionsView(repaired))).toEqual(["RetryTarget"]);
  expect(readActiveId()).not.toBe(seededId);
}, 60_000);

test("serves packages from a building generation before the watch rebuild promotes", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-packages-rebuild-");
  const dbPath = resolveCacheDbPath(root);
  const blockerSource = Array.from(
    { length: 1_000 },
    (_, index) => `export const blocker${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "packages-root", workspaces: ["packages/*"] }),
  );
  await writeFixtureFile(root, "packages/a/package.json", JSON.stringify({ name: "a" }));
  await writeFixtureFile(root, "packages/a/a-blocker.ts", `${blockerSource}\n`);

  const readActiveId = () =>
    openDatabase(dbPath, (db) =>
      db.query<{ id: number }, []>(
        `SELECT CAST(value AS INTEGER) AS id FROM cache_meta WHERE key = 'active_generation'`,
      ).get()?.id);

  const promotions: string[] = [];
  const errors: Error[] = [];
  const rebuildScopeStarted = Promise.withResolvers<void>();
  let watchingRebuild = false;
  const preprocessor = trackedPreprocessor(
    root,
    () => promotions.push("promoted"),
    (error) => errors.push(error),
    1,
    (event) => {
      if (
        watchingRebuild && event.cause === "watch" && event.event === "start" &&
        event.component === "code"
      ) {
        rebuildScopeStarted.resolve();
      }
    },
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();
  expect((await preprocessor.getPackages()).map((pkg) => pkg.name)).toEqual(["a"]);
  const seededId = readActiveId();
  if (seededId === undefined) throw new Error("active generation was not persisted");
  const promotionsBeforeRebuild = promotions.length;

  // A live change adds a second workspace package, then a rebuild starts.
  await writeFixtureFile(root, "packages/b/package.json", JSON.stringify({ name: "b" }));
  await writeFixtureFile(root, "packages/b/b-blocker.ts", `${blockerSource}\n`);
  watchingRebuild = true;
  preprocessor.rebuild("watch");
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });

  // A scope job for the rebuild means discovery already finished and the remaining scope work is
  // still queued: exactly the window in which /api/packages used to block until promotion.
  await withTimeout(rebuildScopeStarted.promise, "watch rebuild scope start", 30_000);
  const rebuilding = await preprocessor.getPackages();
  expect(rebuilding.map((pkg) => pkg.name).sort()).toEqual(["a", "b"]);
  expect(readActiveId()).toBe(seededId);
  expect(promotions.length).toBe(promotionsBeforeRebuild);
  expect(idleResolved).toBe(false);

  await idle;
  expect(readActiveId()).not.toBe(seededId);
  expect((await preprocessor.getPackages()).map((pkg) => pkg.name).sort()).toEqual(["a", "b"]);
  await closePreprocessor(preprocessor);
  expect(errors).toEqual([]);
}, 60_000);

test("reserves a subprocess slot so background scope work never saturates the pool", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-interactive-slot-");
  const blockerSource = Array.from(
    { length: 400 },
    (_, index) => `export const blocker${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  const targetPath = "z-slot-target.ts";
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "interactive-slot" }));
  for (const name of ["a", "b", "c"]) {
    await writeFixtureFile(root, `${name}-blocker.ts`, `${blockerSource}\n`);
  }
  await writeFixtureFile(root, targetPath, "export class SlotTarget { locate() { return 1; } }\n");

  const poolSize = 2;
  const errors: Error[] = [];
  let activeScopes = 0;
  let peakScopes = 0;
  const rebuildScopeStarted = Promise.withResolvers<void>();
  let watchingRebuild = false;
  const preprocessor = trackedPreprocessor(
    root,
    () => undefined,
    (error) => errors.push(error),
    poolSize,
    (event) => {
      if (event.component !== "code") return;
      if (event.event === "start") {
        activeScopes += 1;
        peakScopes = Math.max(peakScopes, activeScopes);
        if (watchingRebuild && event.cause === "watch") rebuildScopeStarted.resolve();
      } else {
        activeScopes -= 1;
      }
    },
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();

  watchingRebuild = true;
  preprocessor.rebuild("watch");
  let idleResolved = false;
  const idle = preprocessor.whenIdle().then(() => {
    idleResolved = true;
  });
  await withTimeout(rebuildScopeStarted.promise, "watch rebuild scope start", 30_000);

  // Issued while the rebuild owns the pool: the reserved slot has to serve it anyway.
  await preprocessor.getDefinition(targetPath, { line: 1, column: 14 });
  expect(idleResolved).toBe(false);

  await idle;
  expect(peakScopes).toBe(poolSize - 1);
  await closePreprocessor(preprocessor);
  expect(errors).toEqual([]);
}, 60_000);

test("defers recovered readiness when a watch rebuild is requested before bootstrap completes", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-recovery-race-");
  const dbPath = resolveCacheDbPath(root);
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "recovery-race" }));
  await writeFixtureFile(root, "app.js", 'export const searchable="recovery-race-token";\n');

  const firstErrors: Error[] = [];
  const first = trackedPreprocessor(root, () => undefined, (error) => firstErrors.push(error));
  await first.ready();
  await first.whenIdle();
  expect((await first.search("recovery-race-token", false)).files).toEqual(["app.js"]);
  expect(firstErrors).toEqual([]);
  await closePreprocessor(first);

  const seedId = openDatabase(dbPath, (db) => {
    const active = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id FROM cache_meta WHERE key = 'active_generation'
    `).get();
    if (active === null) throw new Error("seed generation was not persisted");
    return active.id;
  });

  const progress: PreprocessProgressEvent[] = [];
  const readyProgressCounts: number[] = [];
  const secondErrors: Error[] = [];
  const second = trackedPreprocessor(
    root,
    () => readyProgressCounts.push(progress.length),
    (error) => secondErrors.push(error),
    1,
    (event) => progress.push(event),
  );
  second.rebuild("watch");
  await second.ready();
  await second.whenIdle();

  expect(secondErrors).toEqual([]);
  expect(readyProgressCounts).toHaveLength(1);
  expect(readyProgressCounts[0]).toBeGreaterThan(0);
  await closePreprocessor(second);

  openDatabase(dbPath, (db) => {
    const generations = db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    const [generation] = generations;
    if (generation === undefined) throw new Error("watch generation was not promoted");
    expect(generation).toMatchObject({ state: "active", cause: "watch" });
    expect(generation.id).not.toBe(seedId);
    expectOnlyGeneration(db, generation.id);
  });
}, 30_000);

test("recovers named cache tables and retries queued database work for runtime loads and stores", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-schema-retry-");
  const dbPath = resolveCacheDbPath(root);
  const expectedPackages = [{
    name: "runtime-recovery",
    path: "",
    dependencies: [],
  }];
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "runtime-recovery" }));
  await writeFixtureFile(
    root,
    "app.ts",
    "export class RuntimeRecoveryNeedle { locate() { return 1; } }\n",
  );

  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => undefined,
    (error) => errors.push(error),
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();
  expect(await preprocessor.getPackages()).toEqual(expectedPackages);
  expect(await preprocessor.getDefinition("app.ts", { line: 1, column: 14 })).toEqual({
    key: '["class","RuntimeRecoveryNeedle",0,null,null]',
    kind: "class",
    name: "RuntimeRecoveryNeedle",
    qualifiedName: "RuntimeRecoveryNeedle",
    source: { path: "app.ts", line: 1, column: 14 },
    uml: { scopePath: "app.ts", entityName: "RuntimeRecoveryNeedle" },
  });

  const startupGenerationId = openDatabase(dbPath, (db) => {
    const generation = db.query<{ id: number }, []>(`
      SELECT id FROM generations WHERE state = 'active'
    `).get();
    if (generation === null) throw new Error("startup generation was not promoted");
    db.run("DROP TABLE GotoDef");
    return generation.id;
  });

  expect(await preprocessor.search("RuntimeRecoveryNeedle", false)).toEqual({
    query: "RuntimeRecoveryNeedle",
    caseInsensitive: false,
    files: ["app.ts"],
    definitions: [],
    directories: [""],
    renderDirs: [""],
  });
  expect(errors).toEqual([]);

  openDatabase(dbPath, (db) => {
    expectSearchSchema(
      db,
      "GotoDef",
      "goto_def_search",
      ["goto_def_ai", "goto_def_au", "goto_def_bd", "goto_def_bu"],
    );
  });

  openDatabase(dbPath, (db) => db.run("DROP TABLE files"));
  const filesRepairSearch = await preprocessor.search("RuntimeRecoveryNeedle", false);
  expect(filesRepairSearch.files).toEqual([]);
  expect(filesRepairSearch.definitions).toEqual([]);
  expect(errors).toEqual([]);

  openDatabase(dbPath, (db) => {
    expectSearchSchema(
      db,
      "files",
      "file_search",
      ["files_ai", "files_au", "files_bd", "files_bu"],
    );
    expect(db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all()).toEqual([
      { id: startupGenerationId, state: "active", cause: "startup" },
    ]);
    const snapshot = db.query<{ generation_id: number; packages_json: string }, []>(`
      SELECT generation_id, packages_json FROM package_snapshots
    `).get();
    expect(snapshot?.generation_id).toBe(startupGenerationId);
    expect(JSON.parse(snapshot?.packages_json ?? "null")).toEqual(expectedPackages);
  });

  openDatabase(dbPath, (db) => db.run("DROP TABLE package_snapshots"));
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();

  expect(await preprocessor.getPackages()).toEqual(expectedPackages);
  expect(errors).toEqual([]);
  openDatabase(dbPath, (db) => {
    const generations = db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    const [generation] = generations;
    if (generation === undefined) throw new Error("watch generation was not promoted");
    expect(generation).toMatchObject({ state: "active", cause: "watch" });
    expect(generation.id).not.toBe(startupGenerationId);

    const snapshot = db.query<{ generation_id: number; packages_json: string }, []>(`
      SELECT generation_id, packages_json FROM package_snapshots
    `).get();
    expect(snapshot?.generation_id).toBe(generation.id);
    expect(JSON.parse(snapshot?.packages_json ?? "null")).toEqual(expectedPackages);
    expect(db.query<{ path: string }, []>(`
      SELECT files.path AS path
      FROM file_search
      JOIN files ON file_search.rowid = files.id
      WHERE file_search MATCH 'RuntimeRecoveryNeedle'
      ORDER BY files.path
    `).all()).toEqual([{ path: "app.ts" }]);
    expect(db.query<{ definition_key: string }, []>(`
      SELECT GotoDef.definition_key
      FROM goto_def_search
      JOIN GotoDef ON goto_def_search.rowid = GotoDef.id
      WHERE goto_def_search MATCH 'RuntimeRecoveryNeedle'
        AND GotoDef.kind = 'class'
      ORDER BY GotoDef.definition_key
    `).all()).toEqual([
      { definition_key: '["class","RuntimeRecoveryNeedle",0,null,null]' },
    ]);
    expectOnlyGeneration(db, generation.id);
  });
  await closePreprocessor(preprocessor);
}, 30_000);

test("indexes every definition before UML extraction and disambiguates lookups by qualified name", async () => {
  const root = await temporaryRoot("ts-explorer-definition-index-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "definition-index" }));
  await writeFixtureFile(
    root,
    "root.ts",
    [
      "export class Alpha {",
      "  run(): void {}",
      "}",
      "export interface Beta {",
      "  run(): void;",
      "}",
      "",
    ].join("\n"),
  );

  const errors: Error[] = [];
  const progressEvents: PreprocessProgressEvent[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => undefined,
    (error) => errors.push(error),
    1,
    (event) => progressEvents.push(event),
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();
  expect(errors).toEqual([]);

  const outline = await preprocessor.getFileDefinitions("root.ts");
  expect(outline.map(({ key, ...definition }) => definition)).toEqual([
    {
      parentKey: null,
      isTopLevel: true,
      name: "Alpha",
      qualifiedName: "Alpha",
      kind: "class",
      type: "Alpha",
      source: { path: "root.ts", line: 1, column: 14 },
    },
    {
      parentKey: definitionKeyOf(outline, "Alpha"),
      isTopLevel: false,
      name: "run",
      qualifiedName: "Alpha.run",
      kind: "method",
      type: "(): void",
      source: { path: "root.ts", line: 2, column: 3 },
    },
    {
      parentKey: null,
      isTopLevel: true,
      name: "Beta",
      qualifiedName: "Beta",
      kind: "interface",
      type: "Beta",
      source: { path: "root.ts", line: 4, column: 18 },
    },
    {
      parentKey: definitionKeyOf(outline, "Beta"),
      isTopLevel: false,
      name: "run",
      qualifiedName: "Beta.run",
      kind: "method",
      type: "(): void",
      source: { path: "root.ts", line: 5, column: 3 },
    },
  ]);
  // Same-named members in different owners never share a catalogue key.
  expect(new Set(outline.map(({ key }) => key)).size).toBe(outline.length);

  expect(await preprocessor.lookupDefinition("root.ts", "run", "Beta.run")).toEqual({
    path: "root.ts",
    line: 5,
    column: 3,
  });
  expect(await preprocessor.lookupDefinition("root.ts", "run", "Alpha.run")).toEqual({
    path: "root.ts",
    line: 2,
    column: 3,
  });
  expect(await preprocessor.lookupDefinition("root.ts", "Gamma", "Gamma")).toBeNull();

  const definitionsDone = progressEvents.findIndex(
    (event) => event.component === "definitions" && event.event === "done",
  );
  const firstUmlStart = progressEvents.findIndex(
    (event) => event.component === "uml" && event.event === "start",
  );
  expect(definitionsDone).toBeGreaterThanOrEqual(0);
  expect(firstUmlStart).toBeGreaterThan(definitionsDone);

  await closePreprocessor(preprocessor);
}, 30_000);

test("serves repeated read-only requests from memory and drops them when a rebuild promotes", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-ipc-cache-");
  const dbPath = resolveCacheDbPath(root);
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "ipc-cache" }));
  await writeFixtureFile(root, "app.ts", "export const cached = 1;\n");

  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(
    root,
    () => undefined,
    (error) => errors.push(error),
  );
  await preprocessor.ready();
  await preprocessor.whenIdle();
  expect((await preprocessor.readFile("app.ts")).content).toBe("export const cached = 1;\n");

  expect(openDatabase(dbPath, (db) =>
    db.query<never, [string]>(`
      UPDATE files SET display_content = ? WHERE path = 'app.ts'
    `).run("export const tampered = 2;\n").changes)).toBe(1);
  expect((await preprocessor.readFile("app.ts")).content).toBe("export const cached = 1;\n");

  await writeFixtureFile(root, "app.ts", "export const rebuilt = 3;\n");
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();
  expect((await preprocessor.readFile("app.ts")).content).toBe("export const rebuilt = 3;\n");
  expect(errors).toEqual([]);

  await closePreprocessor(preprocessor);
}, 30_000);

function outlineSummary(definitions: readonly { qualifiedName: string; kind: string; type: string | null }[]): string[] {
  return definitions.map((definition) => `${definition.qualifiedName} ${definition.kind} ${definition.type ?? "—"}`);
}

test("serves file outlines from the current generation and never from an older one", async () => {
  const root = await temporaryRoot("ts-explorer-file-outline-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "file-outline" }));
  await writeFixtureFile(root, "outline.ts", "export const LIMIT: number = 3;\n");

  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(root, () => undefined, (error) => errors.push(error));

  // Readable from the still-building generation: the outline waits on the definition index only.
  expect(outlineSummary(await withTimeout(
    preprocessor.getFileDefinitions("outline.ts"),
    "outline before UML completion",
  ))).toEqual(["LIMIT constant number"]);
  await preprocessor.whenIdle();

  await writeFixtureFile(root, "outline.ts", 'export const LIMIT: string = "updated";\n');
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();
  expect(outlineSummary(await preprocessor.getFileDefinitions("outline.ts"))).toEqual([
    "LIMIT constant string",
  ]);

  await writeFixtureFile(root, "outline.ts", "");
  preprocessor.rebuild("watch");
  await preprocessor.whenIdle();
  expect(await preprocessor.getFileDefinitions("outline.ts")).toEqual([]);
  expect(errors).toEqual([]);

  await closePreprocessor(preprocessor);
}, 30_000);

test("settles pending file outline reads across supersession and shutdown", async () => {
  const root = await temporaryRoot("ts-explorer-file-outline-pending-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "outline-pending" }));
  await writeFixtureFile(root, "outline.ts", "export const FIRST: number = 1;\n");

  const errors: Error[] = [];
  const preprocessor = trackedPreprocessor(root, () => undefined, (error) => errors.push(error));
  await preprocessor.ready();
  await preprocessor.whenIdle();

  await writeFixtureFile(root, "outline.ts", "export const SECOND: number = 2;\n");
  preprocessor.rebuild("watch");
  const superseded = preprocessor.getFileDefinitions("outline.ts");
  await writeFixtureFile(root, "outline.ts", "export const THIRD: number = 3;\n");
  preprocessor.rebuild("watch");
  expect(outlineSummary(await withTimeout(superseded, "superseded outline read"))).toEqual([
    "THIRD constant number",
  ]);
  await preprocessor.whenIdle();

  await writeFixtureFile(root, "outline.ts", "export const FOURTH: number = 4;\n");
  preprocessor.rebuild("watch");
  const duringClose = preprocessor.getFileDefinitions("outline.ts").then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
  await closePreprocessor(preprocessor);
  expect(["resolved", "rejected"]).toContain(await withTimeout(duringClose, "outline read during close"));
}, 30_000);
