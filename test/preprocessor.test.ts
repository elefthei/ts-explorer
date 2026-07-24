import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, DiagramMaterializationError } from "../src/cache.ts";
import type {
  DiagramGraph,
  RenderedDiagram,
  UmlDiagramGraph,
} from "../src/diagram-graph.ts";
import { Preprocessor } from "../src/preprocessor.ts";
import {
  isPreprocessProgressEvent,
  isPreprocessResponse,
  type PreprocessProgressEvent,
  type PreprocessResponse,
} from "../src/preprocess-protocol.ts";
import type { EditorGotoDefinition, GotoDefinition, TreeNode } from "../src/types.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { renderDiagramGraph } from "./support/normalized-graph.ts";
import {
  expectOnlyNormalizedGeneration,
  NORMALIZED_TABLE_SPECS,
  normalizedGenerationIds,
  type NormalizedTable,
} from "./support/normalized-sql.ts";

const NORMALIZED_GRAPH_TABLES = Object.keys(NORMALIZED_TABLE_SPECS) as NormalizedTable[];

function fixtureUmlGraph(scopePath: string): UmlDiagramGraph {
  return {
    kind: "uml",
    scopePath,
    formatVersion: 1,
    renderMode: "normal",
    nodes: [
      { nodeId: "a", nodeOrdinal: 0, nodeKind: "entity", name: "Alpha", community: 0 },
      { nodeId: "b", nodeOrdinal: 1, nodeKind: "entity", name: "Beta", community: 0 },
      { nodeId: "c", nodeOrdinal: 2, nodeKind: "entity", name: "Gamma", community: 0 },
    ],
    aliases: [{ nodeId: "a", aliasOrdinal: 0, alias: "AlphaAlias" }],
    edges: [{
      edgeOrdinal: 0,
      sourceNodeId: "a",
      targetNodeId: "b",
      edgeKind: "uml-relation",
      directed: false,
      weight: 1,
    }],
    relations: [{
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "usage",
      sourceNodeId: "a",
      targetNodeId: "b",
    }],
    settings: {
      glob: scopePath,
      tsconfig: null,
      outFile: "",
      propertyTypes: true,
      modifiers: true,
      typeLinks: true,
      outDsl: "",
      outMermaidDsl: "",
      memberAssociations: true,
      exportedTypesOnly: false,
    },
    settingLines: [],
    declarations: [
      { declarationOrdinal: 0, fileName: "alpha.ts", memberAssociationsPresent: false },
      { declarationOrdinal: 1, fileName: "beta.ts", memberAssociationsPresent: false },
      { declarationOrdinal: 2, fileName: "gamma.ts", memberAssociationsPresent: false },
    ],
    entities: [
      { declarationOrdinal: 0, entityKind: "class", entityOrdinal: 0, nodeId: "a" },
      { declarationOrdinal: 1, entityKind: "class", entityOrdinal: 0, nodeId: "b" },
      { declarationOrdinal: 2, entityKind: "class", entityOrdinal: 0, nodeId: "c" },
    ],
    properties: [],
    propertyTypeIds: [],
    methods: [{
      declarationOrdinal: 0,
      entityKind: "class",
      entityOrdinal: 0,
      methodOrdinal: 0,
      modifierFlags: 0,
      name: "beta",
      returnType: "Beta",
      returnTypeIdsPresent: true,
    }],
    methodReturnTypeIds: [{
      declarationOrdinal: 0,
      entityKind: "class",
      entityOrdinal: 0,
      methodOrdinal: 0,
      typeIdOrdinal: 0,
      typeId: "b",
    }],
    enumItems: [],
    entityHeritageClauses: [],
    declarationHeritageGroups: [],
    declarationHeritageClauses: [],
    memberAssociations: [],
    categories: [
      { categoryOrdinal: 0, entityName: "Alpha", category: "concrete", isTest: false },
      { categoryOrdinal: 1, entityName: "Beta", category: "concrete", isTest: false },
      { categoryOrdinal: 2, entityName: "Gamma", category: "concrete", isTest: false },
    ],
    methodReturnDependencies: [],
    usageEdges: [],
    localUsers: [],
    externalUsers: [],
    localUserTargets: [],
    externalUserTargets: [],
    definitions: [],
  };
}

function renderFixtureGraph(graph: DiagramGraph): RenderedDiagram {
  return {
    dsl: `${graph.kind}:${graph.scopePath}:${graph.nodes.map(({ name }) => name).join(",")}`,
    dsls: [`${graph.kind}:${graph.scopePath}`],
    packageNodes: [],
    definitions: [],
    externalUsers: [],
    localUsers: [],
  };
}

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
      return withTimeout(response, `preprocess response ${id}`).finally(() => {
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
    value: { activeGenerationId: null },
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

  const missingCauseResponse = waitForResponse(6);
  subprocess.send({
    id: 6,
    type: "preprocess-scope",
    generationId: 1,
    scope: { path: "", kind: "directory" },
    packages: [],
  });
  expect(await missingCauseResponse).toEqual({
    id: 6,
    ok: false,
    error: { code: "BAD_REQUEST", message: "cause must be startup or watch" },
  });

  const shutdownResponse = waitForResponse(7);
  subprocess.send({ id: 7, type: "shutdown" });
  expect(await shutdownResponse).toEqual({ id: 7, ok: true, value: null });
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
    value: { activeGenerationId: null },
  });

  subprocess.disconnect();
  expect(await withTimeout(subprocess.exited, "preprocess child exit after IPC disconnect")).toBe(0);
}, 30_000);

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
  expect(packages).toEqual([
    { name: "workspace-a", path: "packages/a", dependencies: ["workspace-b"] },
    { name: "workspace-b", path: "packages/b", dependencies: [] },
  ]);
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

  const packageDiagram = await preprocessor.getDiagram("packages", "");
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
  const rootDiagram = await preprocessor.getDiagram("uml", "");
  expect(rootDiagram).toMatchObject({ kind: "uml", scopePath: "", definitions: gotoDefinitions });
  expect(await preprocessor.getDiagram("uml", "packages/a")).toMatchObject({
    kind: "uml",
    scopePath: "packages/a",
    definitions: [],
  });
  expect(await preprocessor.getDiagram("uml", "packages/b/index.js")).toEqual({
    kind: "uml",
    scopePath: "packages/b/index.js",
    status: "ready",
    dsl: "classDiagram",
    dsls: ["classDiagram"],
    packageNodes: [],
    definitions: [],
    externalUsers: [],
    localUsers: [],
  });

  expect(await preprocessor.readFile("root.ts")).toEqual({
    path: "root.ts",
    content: formattedRootSource,
    definitions: rootDefinitions,
  });
  expect(await preprocessor.readFile("packages/b/index.js")).toEqual({
    path: "packages/b/index.js",
    content: 'export const jsValue = { text: "js-untracked" };\n',
    definitions: [],
  });
  expect(await preprocessor.readFile("malformed.js")).toEqual({
    path: "malformed.js",
    content: malformedSource,
    definitions: [],
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

  const dbPath = join(root, ".explore", "explore.db");
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
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
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
    expect(diagrams.filter(({ kind }) => kind === "uml").map(({ scope_path }) => scope_path)).toEqual(expectedPaths);
    for (const row of diagrams) {
      const response = JSON.parse(row.response_json) as { kind: string; scopePath: string; version?: number };
      expect(response.kind).toBe(row.kind);
      expect(response.scopePath).toBe(row.scope_path);
      expect(response.version).toBeUndefined();
    }

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

    const primaryPayloadColumns: string[] = [];
    for (const table of NORMALIZED_GRAPH_TABLES) {
      const statement = db.query<{ name: string; type: string }, []>(
        `PRAGMA table_info('${table}')`,
      );
      try {
        primaryPayloadColumns.push(...statement.all()
          .filter(({ name, type }) =>
            type.toUpperCase().includes("JSON")
            || name === "response_json"
            || name === "dsl"
            || name === "dsls"
            || name === "mermaid"
            || name === "mermaid_dsl"
          )
          .map(({ name }) => `${table}.${name}`));
      } finally {
        statement.finalize();
      }
    }
    expect(primaryPayloadColumns).toEqual([]);

    for (const table of NORMALIZED_GRAPH_TABLES) {
      const statement = db.query<{ detail: string }, [number, string, string]>(`
        EXPLAIN QUERY PLAN
        SELECT *
        FROM ${table}
        WHERE generation_id = ? AND kind = ? AND scope_path = ?
      `);
      try {
        const plan = statement.all(generationId, "uml", "");
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
  let activeCache = cache;
  try {
    const persistedGraphs: DiagramGraph[] = [];
    const persistedIdentities = [
      { kind: "packages", scopePath: "" },
      ...expectedPaths.map((scopePath) => ({ kind: "uml" as const, scopePath })),
    ] as const;
    for (const { kind, scopePath } of persistedIdentities) {
      const graph = activeCache.readDiagramGraph(generationId, kind, scopePath);
      const response = activeCache.readDiagram(generationId, kind, scopePath);
      expect(graph, `${kind}:${scopePath} graph`).not.toBeNull();
      expect(response, `${kind}:${scopePath} response`).not.toBeNull();
      if (graph === null || response === null) {
        throw new Error(`${kind}:${scopePath} graph or response was not persisted`);
      }
      persistedGraphs.push(graph);
      expect(graph).toMatchObject({ kind, scopePath });
      const rerendered = renderDiagramGraph(graph);
      expect(response).toEqual({
        kind,
        scopePath,
        status: response.status,
        ...rerendered,
        ...(response.status === "error" ? { error: response.error } : {}),
      });
    }

    activeCache.close();
    openDatabase(dbPath, (db) => {
      for (const table of NORMALIZED_GRAPH_TABLES) {
        const expected = (["packages", "uml"] as const).flatMap((kind) => {
          const count = persistedGraphs
            .filter((graph) => graph.kind === kind)
            .reduce((sum, graph) =>
              sum + NORMALIZED_TABLE_SPECS[table].expectedRows(graph).length, 0);
          return count === 0 ? [] : [{ kind, count }];
        });
        const statement = db.query<{ kind: "packages" | "uml"; count: number }, [number]>(`
          SELECT kind, COUNT(*) AS count
          FROM ${table}
          WHERE generation_id = ?
          GROUP BY kind
          ORDER BY kind
        `);
        try {
          expect(statement.all(generationId), table).toEqual(expected);
        } finally {
          statement.finalize();
        }
      }
    });
    activeCache = new Cache(dbPath);

    const rootGraph = activeCache.readDiagramGraph(generationId, "uml", "");
    if (rootGraph?.kind !== "uml") throw new Error("root UML graph was not persisted");
    const originalGraph = structuredClone(rootGraph);
    const originalResponse = activeCache.readDiagram(generationId, "uml", "");
    const originalFile = activeCache.readFile(generationId, "root.ts");
    const originalDefinitions = activeCache.readDefinitions(generationId, "root.ts");

    const rendererFailureGraph = structuredClone(rootGraph);
    const rendererFailureSettings = rendererFailureGraph.settings;
    if (rendererFailureSettings === null) throw new Error("fixture UML graph has no settings");
    rendererFailureGraph.settings = {
      ...rendererFailureSettings,
      outFile: "renderer-failure-must-roll-back",
    };
    const rendererCall: { graph: DiagramGraph | null } = { graph: null };
    expect(() => activeCache.writeScope(generationId, {
      entries: [],
      diagram: { graph: rendererFailureGraph, outcome: { status: "ready" } },
      file: {
        path: "root.ts",
        rawContent: "renderer failure must roll back",
        displayContent: "renderer failure must roll back",
        sourceError: null,
        formatError: null,
      },
      definitions: [],
    }, (reloaded) => {
      rendererCall.graph = reloaded;
      throw new Error("renderer failure");
    })).toThrow(DiagramMaterializationError);
    const rendererArgument = rendererCall.graph;
    if (rendererArgument === null || rendererArgument.kind !== "uml") {
      throw new Error("renderer did not receive the reloaded UML graph");
    }
    expect(rendererArgument).not.toBe(rendererFailureGraph);
    expect(rendererArgument).toEqual(rendererFailureGraph);
    expect(activeCache.readDiagramGraph(generationId, "uml", "")).toEqual(originalGraph);
    expect(activeCache.readDiagram(generationId, "uml", "")).toEqual(originalResponse);
    expect(activeCache.readFile(generationId, "root.ts")).toEqual(originalFile);
    expect(activeCache.readDefinitions(generationId, "root.ts")).toEqual(originalDefinitions);

    const [rootDefinition] = rootDefinitions;
    if (rootDefinition === undefined) throw new Error("root definition fixture was not created");
    const invalidDefinition: EditorGotoDefinition = {
      ...rootDefinition,
      key: "invalid-method",
      kind: "method",
      name: "invalid",
      qualifiedName: "SearchNeedleEntity.invalid",
      uml: { scopePath: "root.ts", entityName: "SearchNeedleEntity<T>" },
    };
    const definitionFailureGraph = structuredClone(rootGraph);
    const definitionFailureSettings = definitionFailureGraph.settings;
    if (definitionFailureSettings === null) throw new Error("fixture UML graph has no settings");
    definitionFailureGraph.settings = {
      ...definitionFailureSettings,
      outFile: "definition-failure-must-roll-back",
    };
    let definitionRendererCalled = false;
    expect(() => activeCache.writeScope(generationId, {
      entries: [],
      diagram: { graph: definitionFailureGraph, outcome: { status: "ready" } },
      file: {
        path: "root.ts",
        rawContent: "definition failure must roll back",
        displayContent: "definition failure must roll back",
        sourceError: null,
        formatError: null,
      },
      definitions: [invalidDefinition],
    }, (reloaded) => {
      definitionRendererCalled = true;
      return renderDiagramGraph(reloaded);
    })).toThrow();
    expect(definitionRendererCalled).toBe(true);
    expect(activeCache.readDiagramGraph(generationId, "uml", "")).toEqual(originalGraph);
    expect(activeCache.readDiagram(generationId, "uml", "")).toEqual(originalResponse);
    expect(activeCache.readFile(generationId, "root.ts")).toEqual(originalFile);
    expect(activeCache.readDefinitions(generationId, "root.ts")).toEqual(originalDefinitions);

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
    const replacementGraph = structuredClone(rootGraph);
    replacementGraph.definitions = [{
      definitionOrdinal: 0,
      definitionKey: replacementDefinition.key,
      definitionKind: replacementDefinition.kind,
      name: replacementDefinition.name,
      qualifiedName: replacementDefinition.qualifiedName,
      sourcePath: replacementDefinition.source.path,
      sourceLine: replacementDefinition.source.line,
      sourceColumn: replacementDefinition.source.column,
      umlScopePath: replacementDefinition.uml.scopePath,
      umlEntityName: replacementDefinition.uml.entityName,
      umlMemberName: null,
      umlMemberOccurrence: null,
    }];
    activeCache.writeScope(generationId, {
      entries: [],
      diagram: { graph: replacementGraph, outcome: { status: "ready" } },
      file: {
        path: "root.ts",
        rawContent: replacementContent,
        displayContent: replacementContent,
        sourceError: null,
        formatError: null,
      },
      definitions: [replacementDefinition],
    }, renderDiagramGraph);
    expect(activeCache.readFile(generationId, "root.ts")).toEqual({
      path: "root.ts",
      rawContent: replacementContent,
      displayContent: replacementContent,
      sourceError: null,
      formatError: null,
    });
    expect(activeCache.readDefinitions(generationId, "root.ts")).toEqual([replacementDefinition]);
    expect(activeCache.searchFiles(
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
    expect(activeCache.searchFiles(generationId, "CacheReplacement", false)).toEqual({
      query: "CacheReplacement",
      caseInsensitive: false,
      files: ["root.ts"],
      definitions: withoutDisplay([replacementDefinition]),
      directories: [""],
      renderDirs: [""],
    });
  } finally {
    activeCache.close();
  }
}, 30_000);

test("rejects unavailable or inconsistent fallback sources without replacing target rows", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-fallback-");
  const dbPath = join(root, "fallback.db");
  const cache = new Cache(dbPath);
  let activeCache = cache;
  try {
    const sourceGenerationId = activeCache.beginGeneration("startup");
    const targetGenerationId = activeCache.beginGeneration("watch");
    const sourceGraph = fixtureUmlGraph("source.ts");
    const targetSourceGraph = fixtureUmlGraph("source.ts");
    const targetSourceSettings = targetSourceGraph.settings;
    if (targetSourceSettings === null) throw new Error("fixture UML graph has no settings");
    targetSourceGraph.settings = { ...targetSourceSettings, outFile: "target-source" };
    const targetOtherGraph = fixtureUmlGraph("other.ts");
    const targetOtherSettings = targetOtherGraph.settings;
    if (targetOtherSettings === null) throw new Error("fixture UML graph has no settings");
    targetOtherGraph.settings = { ...targetOtherSettings, outFile: "target-other" };

    activeCache.writeScope(sourceGenerationId, {
      entries: [],
      diagram: { graph: sourceGraph, outcome: { status: "ready" } },
      definitions: [],
    }, renderFixtureGraph);
    for (const graph of [targetSourceGraph, targetOtherGraph]) {
      activeCache.writeScope(targetGenerationId, {
        entries: [],
        diagram: { graph, outcome: { status: "ready" } },
        definitions: [],
      }, renderFixtureGraph);
    }

    const cases = [
      {
        name: "missing generation",
        scopePath: "source.ts",
        fallbackSource: {
          sourceGenerationId: sourceGenerationId + 10_000,
          kind: "uml" as const,
          scopePath: "source.ts",
        },
      },
      {
        name: "scope does not match the source graph",
        scopePath: "other.ts",
        fallbackSource: {
          sourceGenerationId,
          kind: "uml" as const,
          scopePath: "other.ts",
        },
      },
    ];
    for (const { name, scopePath, fallbackSource } of cases) {
      const beforeGraph = activeCache.readDiagramGraph(targetGenerationId, "uml", scopePath);
      const beforeResponse = activeCache.readDiagram(targetGenerationId, "uml", scopePath);
      let rendered = false;
      expect(() => activeCache.writeScope(targetGenerationId, {
        entries: [],
        diagram: {
          fallbackSource,
          outcome: { status: "error", error: name },
        },
        definitions: [],
      }, (graph) => {
        rendered = true;
        return renderFixtureGraph(graph);
      }), name).toThrow(DiagramMaterializationError);
      expect(rendered, name).toBe(false);
      expect(activeCache.readDiagramGraph(targetGenerationId, "uml", scopePath), name).toEqual(beforeGraph);
      expect(activeCache.readDiagram(targetGenerationId, "uml", scopePath), name).toEqual(beforeResponse);
    }

    const beforeDisagreementGraph = activeCache.readDiagramGraph(
      targetGenerationId,
      "uml",
      "source.ts",
    );
    const beforeDisagreementResponse = activeCache.readDiagram(
      targetGenerationId,
      "uml",
      "source.ts",
    );
    const sourceResponse = activeCache.readDiagram(sourceGenerationId, "uml", "source.ts");
    if (sourceResponse === null) throw new Error("source response was not persisted");
    activeCache.close();
    openDatabase(dbPath, (db) => {
      db.query<never, [string, number]>(`
        UPDATE diagrams
        SET response_json = ?
        WHERE generation_id = ? AND kind = 'uml' AND scope_path = 'source.ts'
      `).run(JSON.stringify({ ...sourceResponse, scopePath: "different.ts" }), sourceGenerationId);
    });
    activeCache = new Cache(dbPath);

    expect(() => activeCache.writeScope(targetGenerationId, {
      entries: [],
      diagram: {
        fallbackSource: {
          sourceGenerationId,
          kind: "uml",
          scopePath: "source.ts",
        },
        outcome: { status: "error", error: "source response disagrees with graph identity" },
      },
      definitions: [],
    }, renderFixtureGraph)).toThrow(DiagramMaterializationError);
    expect(activeCache.readDiagramGraph(targetGenerationId, "uml", "source.ts")).toEqual(
      beforeDisagreementGraph,
    );
    expect(activeCache.readDiagram(targetGenerationId, "uml", "source.ts")).toEqual(
      beforeDisagreementResponse,
    );
  } finally {
    activeCache.close();
  }
});

test("rejects constrained and domain-invalid graph replacements atomically", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-invalid-graph-");
  const dbPath = join(root, "invalid-graph.db");
  const cache = new Cache(dbPath);
  try {
    const generationId = cache.beginGeneration("startup");
    const scopePath = "constraints.ts";
    const validGraph = fixtureUmlGraph(scopePath);
    cache.writeScope(generationId, {
      entries: [],
      diagram: { graph: validGraph, outcome: { status: "ready" } },
      file: {
        path: scopePath,
        rawContent: "baseline",
        displayContent: "baseline",
        sourceError: null,
        formatError: null,
      },
      definitions: [],
    }, renderFixtureGraph);
    const baselineGraph = cache.readDiagramGraph(generationId, "uml", scopePath);
    const baselineResponse = cache.readDiagram(generationId, "uml", scopePath);
    const baselineFile = cache.readFile(generationId, scopePath);

    const sqlConstraintCases: Array<{
      name: string;
      mutate(graph: UmlDiagramGraph): void;
    }> = [
      {
        name: "negative node ordinal",
        mutate: (graph) => {
          const [node] = graph.nodes;
          if (node === undefined) throw new Error("fixture UML graph has no first node");
          node.nodeOrdinal = -1;
        },
      },
      {
        name: "duplicate node ordinal",
        mutate: (graph) => {
          const [, node] = graph.nodes;
          if (node === undefined) throw new Error("fixture UML graph has no second node");
          node.nodeOrdinal = 0;
        },
      },
      {
        name: "graph-wide duplicate alias",
        mutate: (graph) => {
          graph.aliases.push({ nodeId: "b", aliasOrdinal: 0, alias: "AlphaAlias" });
        },
      },
      {
        name: "nonpositive edge weight",
        mutate: (graph) => {
          const [edge] = graph.edges;
          if (edge === undefined) throw new Error("fixture UML graph has no first edge");
          edge.weight = 0;
        },
      },
    ];
    for (const { name, mutate } of sqlConstraintCases) {
      const graph = structuredClone(validGraph);
      mutate(graph);
      let rendererCalled = false;
      let thrown: unknown;
      try {
        cache.writeScope(generationId, {
          entries: [],
          diagram: { graph, outcome: { status: "ready" } },
          file: {
            path: scopePath,
            rawContent: name,
            displayContent: name,
            sourceError: null,
            formatError: null,
          },
          definitions: [],
        }, (reloaded) => {
          rendererCalled = true;
          return renderFixtureGraph(reloaded);
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(Error);
      expect(thrown, name).not.toBeInstanceOf(DiagramMaterializationError);
      expect(rendererCalled, name).toBe(false);
      expect(cache.readDiagramGraph(generationId, "uml", scopePath), name).toEqual(baselineGraph);
      expect(cache.readDiagram(generationId, "uml", scopePath), name).toEqual(baselineResponse);
      expect(cache.readFile(generationId, scopePath), name).toEqual(baselineFile);
    }

    const domainCases: Array<{
      name: string;
      mutate(graph: UmlDiagramGraph): void;
    }> = [
      {
        name: "missing node ordinal",
        mutate: (graph) => {
          const [node] = graph.nodes;
          if (node === undefined) throw new Error("fixture UML graph has no first node");
          node.nodeOrdinal = 3;
        },
      },
      {
        name: "package node in a UML graph",
        mutate: (graph) => {
          const [node] = graph.nodes;
          if (node === undefined) throw new Error("fixture UML graph has no first node");
          node.nodeKind = "package";
          node.community = null;
        },
      },
      {
        name: "alias collides with another node ID",
        mutate: (graph) => {
          const [alias] = graph.aliases;
          if (alias === undefined) throw new Error("fixture UML graph has no first alias");
          alias.alias = "b";
        },
      },
      {
        name: "noncanonical reversed UML edge",
        mutate: (graph) => {
          const [edge] = graph.edges;
          if (edge === undefined) throw new Error("fixture UML graph has no first edge");
          edge.sourceNodeId = "b";
          edge.targetNodeId = "a";
        },
      },
      {
        name: "relation endpoints differ from the parent edge",
        mutate: (graph) => {
          const [relation] = graph.relations;
          if (relation === undefined) throw new Error("fixture UML graph has no first relation");
          relation.targetNodeId = "c";
        },
      },
      {
        name: "relation ordinal starts after zero",
        mutate: (graph) => {
          const [relation] = graph.relations;
          if (relation === undefined) throw new Error("fixture UML graph has no first relation");
          relation.relationOrdinal = 1;
        },
      },
      {
        name: "edge weight differs from relation count",
        mutate: (graph) => {
          const [edge] = graph.edges;
          if (edge === undefined) throw new Error("fixture UML graph has no first edge");
          edge.weight = 2;
        },
      },
      {
        name: "normal graph has no settings",
        mutate: (graph) => {
          graph.settings = null;
        },
      },
      {
        name: "bare graph retains model rows",
        mutate: (graph) => {
          graph.renderMode = "bare";
        },
      },
      {
        name: "return type IDs exist while presence flag is false",
        mutate: (graph) => {
          const [method] = graph.methods;
          if (method === undefined) throw new Error("fixture UML graph has no first method");
          method.returnTypeIdsPresent = false;
        },
      },
    ];
    for (const { name, mutate } of domainCases) {
      const graph = structuredClone(validGraph);
      mutate(graph);
      let rendererCalled = false;
      expect(() => cache.writeScope(generationId, {
        entries: [],
        diagram: { graph, outcome: { status: "ready" } },
        file: {
          path: scopePath,
          rawContent: name,
          displayContent: name,
          sourceError: null,
          formatError: null,
        },
        definitions: [],
      }, (reloaded) => {
        rendererCalled = true;
        return renderFixtureGraph(reloaded);
      }), name).toThrow(DiagramMaterializationError);
      expect(rendererCalled, name).toBe(false);
      expect(cache.readDiagramGraph(generationId, "uml", scopePath), name).toEqual(baselineGraph);
      expect(cache.readDiagram(generationId, "uml", scopePath), name).toEqual(baselineResponse);
      expect(cache.readFile(generationId, scopePath), name).toEqual(baselineFile);
    }
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
    expect(
      [...new Set(
        generationEvents
          .filter((event) => event.component === "uml")
          .map((event) => event.resource),
      )].sort(),
    ).toEqual([".", "./index.ts"]);
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
  openDatabase(join(root, ".explore", "explore.db"), (db) => {
    const activeGeneration = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id
      FROM cache_meta
      WHERE key = 'active_generation'
    `).get();
    if (activeGeneration === null) throw new Error("active generation was not persisted");
    const activeGenerationId = activeGeneration.id;
    expect(activeGenerationId).toBe(watchGenerationId);
    expect(normalizedGenerationIds(db, "diagram_graphs")).toEqual([watchGenerationId]);
    expectOnlyNormalizedGeneration(db, watchGenerationId);
  });
}, 30_000);

test("prioritizes a queued definition miss without promoting the incomplete generation", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-priority-");
  const targetPath = "z-priority.ts";
  const blockerSource = Array.from(
    { length: 1_000 },
    (_, index) => `export const blocker${index}={value:${index},text:"${index}"}`,
  ).join("\n");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "priority-root" }));
  await writeFixtureFile(root, "a-blocker.ts", `${blockerSource}\n`);
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      writeFixtureFile(
        root,
        `m-pending-${String(index).padStart(2, "0")}.ts`,
        `export class Pending${index} {}\n`,
      )
    ),
  );
  await writeFixtureFile(
    root,
    targetPath,
    "export class PriorityTarget { locate() { return 1; } }\n",
  );

  const blockerStarted = Promise.withResolvers<void>();
  const targetStarted = Promise.withResolvers<void>();
  const targetDone = Promise.withResolvers<void>();
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
      if (event.component === "code" && event.resource === `./${targetPath}`) {
        if (event.event === "start") targetStarted.resolve();
        else targetDone.resolve();
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
  await withTimeout(targetDone.promise, "prioritized source completion", 30_000);
  expect(await preprocessor.getDefinition(targetPath, { line: 1, column: 14 })).toEqual({
    key: '["class","PriorityTarget",0,null,null]',
    kind: "class",
    name: "PriorityTarget",
    qualifiedName: "PriorityTarget",
    source: { path: targetPath, line: 1, column: 14 },
    uml: { scopePath: targetPath, entityName: "PriorityTarget" },
  });
  expect(idleResolved).toBe(false);
  expect(promotions).toEqual([]);
  expect(
    progress.findIndex(({ event, component, resource }) =>
      event === "start" && component === "code" && resource === `./${targetPath}`
    ),
  ).toBeGreaterThan(
    progress.findIndex(({ event, component, resource }) =>
      event === "start" && component === "code" && resource === "./a-blocker.ts"
    ),
  );

  await idle;
  expect(await preprocessor.poll(priority.requestId)).toEqual({
    resource: targetPath,
    status: "done",
    requestId: priority.requestId,
  });
  expect(promotions).toEqual(["promoted"]);
  expect(errors).toEqual([]);
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

  openDatabase(join(root, ".explore", "explore.db"), (db) => {
    const generations = db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all();
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ state: "active", cause: "watch" });
    expect(generations.filter(({ state }) => state === "building" || state === "failed")).toEqual([]);
    const active = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id
      FROM cache_meta
      WHERE key = 'active_generation'
    `).get();
    expect(active?.id).toBe(generations[0]?.id);
    expect(active).not.toBeNull();
    if (active === null) throw new Error("active generation was not persisted");
    expect(db.query<{ generation_id: number; count: number }, []>(`
      SELECT generation_id, COUNT(*) AS count
      FROM GotoDef
      GROUP BY generation_id
    `).all()).toEqual([{ generation_id: active.id, count: sourcePaths.length }]);
    expectOnlyNormalizedGeneration(db, active.id);
  });
}, 60_000);

test("startup recovery removes orphan generations and rebuilds when the active pointer is invalid", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-recovery-");
  const dbPath = join(root, ".explore", "explore.db");
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "root-workspace" }));
  await writeFixtureFile(root, "app.js", 'export const state="initial-cache";\n');

  const firstErrors: Error[] = [];
  const first = trackedPreprocessor(root, () => undefined, (error) => firstErrors.push(error));
  await first.ready();
  await first.whenIdle();
  expect((await first.search("initial-cache", false)).files).toEqual(["app.js"]);
  expect(firstErrors).toEqual([]);
  await closePreprocessor(first);

  const activeId = openDatabase(dbPath, (db) => {
    const activeGeneration = db.query<{ id: number }, []>(`
      SELECT CAST(value AS INTEGER) AS id FROM cache_meta WHERE key = 'active_generation'
    `).get();
    if (activeGeneration === null) throw new Error("active generation was not persisted");
    return activeGeneration.id;
  });
  const orphanCache = new Cache(dbPath);
  let orphanId: number;
  try {
    orphanId = orphanCache.beginGeneration("watch");
    orphanCache.writeScope(orphanId, {
      entries: [],
      diagram: { graph: fixtureUmlGraph("orphan.ts"), outcome: { status: "ready" } },
      definitions: [],
    }, renderFixtureGraph);
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
    for (const table of NORMALIZED_GRAPH_TABLES) {
      expect(
        db.query<{ count: number }, [number, string]>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE generation_id = ? AND scope_path = ?`,
        ).get(seeded.orphanId, "orphan.ts"),
      ).toEqual({ count: 0 });
    }
    expectOnlyNormalizedGeneration(db, seeded.activeId);
  });
  await closePreprocessor(recoveryProbe);

  await writeFixtureFile(root, "app.js", 'export const state="after-orphan-recovery";\n');
  const secondErrors: Error[] = [];
  const second = trackedPreprocessor(root, () => undefined, (error) => secondErrors.push(error));
  await second.ready();
  await second.whenIdle();
  expect((await second.search("initial-cache", false)).files).toEqual(["app.js"]);
  expect((await second.search("after-orphan-recovery", false)).files).toEqual([]);
  expect(secondErrors).toEqual([]);
  openDatabase(dbPath, (db) => {
    expect(db.query<{ id: number; state: string; cause: string }, []>(`
      SELECT id, state, cause FROM generations ORDER BY id
    `).all()).toEqual([
      { id: seeded.activeId, state: "active", cause: "startup" },
    ]);
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
    expect(generation.id).not.toBe(seeded.activeId);
    expectOnlyNormalizedGeneration(db, generation.id);
  });

  await writeFixtureFile(root, "app.js", 'export const state="invalid-pointer-rebuilt";\n');
  const invalidPointerCache = new Cache(dbPath);
  let invalidPointerOrphanId: number;
  try {
    invalidPointerOrphanId = invalidPointerCache.beginGeneration("watch");
    invalidPointerCache.writeScope(invalidPointerOrphanId, {
      entries: [],
      diagram: {
        graph: fixtureUmlGraph("invalid-pointer-orphan.ts"),
        outcome: { status: "ready" },
      },
      definitions: [],
    }, renderFixtureGraph);
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
    expect(pointer?.id).toBe(generation.id);
    expect(pointer?.id).not.toBe(999999999);
    expect(pointer).not.toBeNull();
    if (pointer === null) throw new Error("active generation pointer was not rebuilt");
    expect(db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) AS count FROM package_snapshots WHERE generation_id = ?
    `).get(pointer.id)?.count).toBe(1);
    expect(db.query<{ path: string }, [number]>(`
      SELECT path FROM tree_entries WHERE generation_id = ? ORDER BY path
    `).all(pointer.id).map(({ path }) => path)).toEqual(["", "app.js", "package.json"]);
    expectOnlyNormalizedGeneration(db, pointer.id);
    for (const table of NORMALIZED_GRAPH_TABLES) {
      expect(
        db.query<{ count: number }, [number, string]>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE generation_id = ? AND scope_path = ?`,
        ).get(invalidPointerOrphanId, "invalid-pointer-orphan.ts"),
      ).toEqual({ count: 0 });
    }
  });
}, 30_000);

test("defers recovered readiness when a watch rebuild is requested before bootstrap completes", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-recovery-race-");
  const dbPath = join(root, ".explore", "explore.db");
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
    expectOnlyNormalizedGeneration(db, generation.id);
  });
}, 30_000);

test("recovers named cache tables and retries queued database work for runtime loads and stores", async () => {
  const root = await temporaryRoot("ts-explorer-preprocessor-schema-retry-");
  const dbPath = join(root, ".explore", "explore.db");
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
    expectOnlyNormalizedGeneration(db, generation.id);
  });
  await closePreprocessor(preprocessor);
}, 30_000);
