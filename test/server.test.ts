import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveCacheDbPath, resolveSourceDir } from "../src/paths.ts";
import { ExplorerServer } from "../src/server.ts";
import { ExplorerStore } from "../src/store.ts";
import { withBound } from "./support/async.ts";
import { createFixtureTracker, randomVersionSeed, removeFixtureRoot } from "./support/fixtures.ts";
import { openDatabase } from "./support/normalized-sql.ts";
import {
  type DefinitionsView,
  definitionsView,
  edgeRows,
  filesView,
  frameRows,
  umlLabel,
} from "./support/uml-contract.ts";
import type {
  DiagramResponse,
  FileDefinition,
  FileResponse,
  GotoDefinition,
  PackageDiagramNode,
  PackageDiagramPayload,
  SearchResponse,
  TreeNode,
  WatchEventName,
  WatchMessage,
} from "../src/types.ts";

type WatchClient = {
  waitFor(predicate: (message: WatchMessage) => boolean): Promise<WatchMessage>;
  history(): readonly WatchMessage[];
  close(): Promise<void>;
};

type RunningServer = {
  port: number;
  stop(): Promise<void>;
};

type WatchWaiter = {
  predicate: (message: WatchMessage) => boolean;
  resolve: (message: WatchMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SqlValue = string | number | null;

function queryAll<Row>(db: Database, sql: string, ...bindings: SqlValue[]): Row[] {
  const statement = db.prepare<Row, SqlValue[]>(sql);
  try {
    return statement.all(...bindings);
  } finally {
    statement.finalize();
  }
}

function queryOne<Row>(db: Database, sql: string, ...bindings: SqlValue[]): Row | null {
  const statement = db.prepare<Row, SqlValue[]>(sql);
  try {
    return statement.get(...bindings);
  } finally {
    statement.finalize();
  }
}

type PackageGraphRows = {
  generationId: number;
  nodes: { node_id: string; node_ordinal: number; node_kind: string; name: string }[];
  edges: {
    edge_ordinal: number;
    source_node_id: string;
    target_node_id: string;
    edge_kind: string;
    directed: number;
    weight: number;
  }[];
  relations: {
    edge_ordinal: number;
    relation_ordinal: number;
    relation_kind: string;
    source_node_id: string;
    target_node_id: string;
  }[];
  packageNodes: { node_id: string; package_path: string | null }[];
};

function findActiveGenerationId(db: Database): number | undefined {
  const active = queryOne<{ generation_id: number }>(
    db,
    `
      SELECT CAST(value AS INTEGER) AS generation_id
      FROM cache_meta
      WHERE key = 'active_generation'
    `,
  );
  return active?.generation_id;
}

function activeGenerationId(db: Database): number {
  const generationId = findActiveGenerationId(db);
  if (generationId === undefined) throw new Error("active generation is missing");
  return generationId;
}

/** The promoted package topology exactly as the active generation stores it. */
function readActivePackageGraph(dbPath: string): PackageGraphRows {
  return openDatabase(dbPath, (db) => {
    const generationId = activeGenerationId(db);
    return {
      generationId,
      nodes: queryAll<PackageGraphRows["nodes"][number]>(
        db,
        `
          SELECT node_id, node_ordinal, node_kind, name
          FROM diagram_nodes
          WHERE generation_id = ? AND kind = 'packages' AND scope_path = ''
          ORDER BY node_ordinal
        `,
        generationId,
      ),
      edges: queryAll<PackageGraphRows["edges"][number]>(
        db,
        `
          SELECT edge_ordinal, source_node_id, target_node_id, edge_kind, directed, weight
          FROM diagram_edges
          WHERE generation_id = ? AND kind = 'packages' AND scope_path = ''
          ORDER BY edge_ordinal
        `,
        generationId,
      ),
      relations: queryAll<PackageGraphRows["relations"][number]>(
        db,
        `
          SELECT edge_ordinal, relation_ordinal, relation_kind, source_node_id, target_node_id
          FROM diagram_edge_relations
          WHERE generation_id = ? AND kind = 'packages' AND scope_path = ''
          ORDER BY edge_ordinal, relation_ordinal
        `,
        generationId,
      ),
      packageNodes: queryAll<PackageGraphRows["packageNodes"][number]>(
        db,
        `
          SELECT node_id, package_path
          FROM package_graph_nodes
          WHERE generation_id = ? AND kind = 'packages' AND scope_path = ''
          ORDER BY node_id
        `,
        generationId,
      ),
    };
  }, { readonly: true });
}

function packagesPayload(response: DiagramResponse): PackageDiagramPayload {
  if (response.kind !== "packages") throw new Error("expected a packages diagram response");
  return response;
}

function definitionLabels(view: DefinitionsView): string[] {
  return view.nodes.map((node) => umlLabel(node.definition));
}

async function fetchDiagram(base: string, query: string): Promise<DiagramResponse> {
  const response = await fetch(`${base}/api/diagram?${query}`);
  expect(response.status, query).toBe(200);
  return await response.json() as DiagramResponse;
}

/** The outline key of one declaration, obtained the way the browser obtains it. */
async function definitionKey(base: string, path: string, qualifiedName: string): Promise<string> {
  const response = await fetch(`${base}/api/file-definitions?path=${encodeURIComponent(path)}`);
  expect(response.status, path).toBe(200);
  const body = await response.json() as { definitions: FileDefinition[] };
  const match = body.definitions.find((definition) => definition.qualifiedName === qualifiedName);
  if (!match) throw new Error(`${path} declares no ${qualifiedName}`);
  return match.key;
}

/**
 * Outline identity without the opaque catalogue key: `parentKey` is resolved back to the owner's
 * qualified name so ownership is asserted by meaning, not by key serialization.
 */
function outlineShape(definitions: readonly FileDefinition[]): {
  qualifiedName: string;
  kind: string;
  type: string | null;
  at: string;
  parent: string | null;
  isTopLevel: boolean;
}[] {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  return definitions.map((definition) => ({
    qualifiedName: definition.qualifiedName,
    kind: definition.kind,
    type: definition.type,
    at: `${definition.source.line}:${definition.source.column}`,
    parent: definition.parentKey === null
      ? null
      : byKey.get(definition.parentKey)?.qualifiedName ?? `unresolved:${definition.parentKey}`,
    isTopLevel: definition.isTopLevel,
  }));
}

type ServerStartOptions = Parameters<typeof ExplorerServer.start>[0];

/** Every server here starts on a random watch version, so no assertion can pin a literal one. */
function startServer(
  options: Omit<ServerStartOptions, "initialVersion">,
): Promise<ExplorerServer> {
  return ExplorerServer.start({ ...options, initialVersion: randomVersionSeed() });
}

/**
 * Polls `read` until `accept` holds; an unrelated rebuild only delays the answer, never breaks it.
 *
 * The condition is produced by a real filesystem watcher feeding a preprocessor subprocess, so no
 * in-process clock can drive it: the retry cadence below is a bounded poll interval, not a guess at
 * how long the rebuild takes. Correctness depends only on `accept`, never on the delay.
 */
async function until<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
  description: string,
  timeout = 30_000,
): Promise<Value> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

async function openWatch(base: string): Promise<WatchClient> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
  const history: WatchMessage[] = [];
  const waiters = new Set<WatchWaiter>();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as WatchMessage;
    history.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  await withBound(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    }),
    10_000,
    "websocket connection",
  );

  return {
    waitFor(predicate) {
      const existing = history.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<WatchMessage>((resolve, reject) => {
        const waiter: WatchWaiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("timed out waiting for websocket message"));
          }, 30_000),
        };
        waiters.add(waiter);
      });
    },
    history() {
      return [...history];
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    },
  };
}

// A batch may carry several paths, so the regression only holds when the expected path itself
// carries the expected event, not when some other path in the same batch happens to.
function hasWatchEvent(message: WatchMessage, path: string, event: WatchEventName): boolean {
  if (message.type !== "changed") return false;
  const index = message.paths.indexOf(path);
  return index >= 0 && message.events[index] === event;
}


const fixtures = createFixtureTracker();
const { writeFixtureFile } = fixtures;
afterEach(fixtures.cleanup);

async function createServerFixture(): Promise<{ outerRoot: string; root: string; sourceFile: string }> {
  const outerRoot = await mkdtemp(join(tmpdir(), "ts-explorer-server-"));
  const root = join(outerRoot, "explorer");
  await writeFixtureFile(root, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  await writeFixtureFile(
    root,
    "packages/demo/package.json",
    JSON.stringify({ name: "demo" }),
  );

  const sourceFile = join(root, "packages", "demo", "src", "index.ts");
  await writeFixtureFile(root, "packages/demo/src/index.ts", "export const value=1\n");
  await writeFixtureFile(
    root,
    "packages/demo/src/machine.ts",
    "export class AbstractStateMachine {}\n",
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/runtime.ts",
    'import { AbstractStateMachine } from "./machine";\nexport class DataflowRuntime { getMachine(): AbstractStateMachine { return new AbstractStateMachine(); } }\n',
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/indexed-service.ts",
    "export class IndexedService{\nrunFirst(value:string){return value}\nrunSecond(value:number){return value}\n}\n",
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/target/widget.ts",
    "export class Widget {}\n",
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/target/local-user.ts",
    'import { Widget } from "./widget";\nexport function acceptWidget(widget: Widget): void { void widget; }\n',
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/consumer.ts",
    'import { Widget } from "./target/widget";\nexport class Consumer { build(): Widget { return new Widget(); } }\n',
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/pair.ts",
    'import { Widget } from "./target/widget";\n'
      + "export class PairFirst { widget!: Widget; }\n"
      + "export function pairSecond(): void {}\n",
  );

  const literal = "-Needle.[x]*$";
  await writeFixtureFile(
    root,
    "packages/demo/src/literal.txt",
    "literal: -nEeDlE.[X]*$\n",
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/nested/edited.txt",
    `nested: ${literal}\n`,
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/untracked.txt",
    `untracked: ${literal}\n`,
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/regex-decoy.txt",
    "decoy: -NEEDLEQxxx\n",
  );
  await writeFixtureFile(
    root,
    "packages/demo/src/binary.bin",
    Buffer.from(`binary: ${literal}\0\n`),
  );
  await writeFixtureFile(root, "node_modules/hidden.txt", `hidden: ${literal}\n`);
  await writeFixtureFile(outerRoot, "outside-source.txt", `outside: ${literal}\n`);
  await Promise.all(
    Array.from({ length: 240 }, (_, index) =>
      writeFixtureFile(
        root,
        `bulk/entry-${index.toString().padStart(3, "0")}.ts`,
        `export const entry${index} = ${index};\n`,
      )
    ),
  );
  return { outerRoot, root, sourceFile };
}

test("failed startup on an occupied port cleans up before the port is reused", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-occupied-port-");
  await writeFile(join(root, "index.ts"), "export const value=1\n");
  const blocker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("blocked"),
  });
  let blockerStopped = false;
  let replacement: ExplorerServer | undefined;
  try {
    const port = blocker.port;
    if (port === undefined) throw new Error("Bun.serve did not assign a port");
    await expect(
      startServer({ sourceDir: root, host: "127.0.0.1", port }),
    ).rejects.toThrow();
    blocker.stop(true);
    blockerStopped = true;
    replacement = await startServer({ sourceDir: root, host: "127.0.0.1", port });
    await replacement.stop();
    replacement = undefined;
  } finally {
    if (!blockerStopped) blocker.stop(true);
    await replacement?.stop();
  }
}, 30_000);

test("concurrent stop calls share one promise and release the port", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-idempotent-stop-");
  await writeFile(join(root, "index.ts"), "export const value=1\n");
  let server: ExplorerServer | undefined;
  let replacement: ExplorerServer | undefined;
  try {
    server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const port = server.port;
    const firstStop = server.stop();
    const secondStop = server.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    server = undefined;

    replacement = await startServer({ sourceDir: root, host: "127.0.0.1", port });
    await replacement.stop();
    replacement = undefined;
  } finally {
    await replacement?.stop();
    await server?.stop();
  }
}, 30_000);

test("serves the subprocess-backed read-only API and non-Git literal search", async () => {
  const { outerRoot, root, sourceFile } = await createServerFixture();
  const server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
  let watch: WatchClient | undefined;
  try {
    const base = `http://127.0.0.1:${server.port}`;
    // Everything below describes the promoted steady state, so wait for the first cache promotion
    // rather than racing startup readiness against it.
    watch = await openWatch(base);
    const promotion = await watch.waitFor(
      (message) => message.type === "cache-ready" || message.type === "watch-error",
    );
    expect(promotion.type).toBe("cache-ready");
    await watch.close();
    watch = undefined;

    const pageResponse = await fetch(`${base}/`);
    expect(pageResponse.status).toBe(200);
    await pageResponse.text();

    const mainResponse = await fetch(`${base}/main.js`);
    expect(mainResponse.status).toBe(200);
    await mainResponse.text();
    const styleResponse = await fetch(`${base}/style.css`);
    expect(styleResponse.status).toBe(200);
    await styleResponse.text();

    const tree = await withBound(
      fetch(`${base}/api/tree`).then(async (response) => {
        expect(response.status).toBe(200);
        return response.json() as Promise<{ version: number; root: TreeNode }>;
      }),
      5_000,
      "complete live filesystem tree",
    );
    const bulk = tree.root.children?.find((child) => child.path === "bulk");
    expect(bulk?.children?.map((child) => child.path)).toEqual(
      Array.from(
        { length: 240 },
        (_, index) => `bulk/entry-${index.toString().padStart(3, "0")}.ts`,
      ),
    );
    expect(bulk?.children?.every((child) => child.kind === "file" && child.viewable)).toBe(true);
    expect(tree.root.children?.map((child) => child.name)).toContain("packages");
    expect(tree.root.children?.map((child) => child.name)).not.toContain(".explore");
    const packages = await (await fetch(`${base}/api/packages`)).json() as {
      packages: Array<{ name: string }>;
    };
    expect(packages.packages.map((pkg) => pkg.name)).toEqual(["demo"]);
    const indexedPath = "packages/demo/src/indexed-service.ts";
    const indexedDefinitions = [
      {
        key: '["class","IndexedService",0,null,null]',
        kind: "class",
        name: "IndexedService",
        qualifiedName: "IndexedService",
        source: { path: indexedPath, line: 1, column: 14 },
        uml: { scopePath: indexedPath, entityName: "IndexedService" },
      },
      {
        key: '["class","IndexedService",0,"runFirst",0]',
        kind: "method",
        name: "runFirst",
        qualifiedName: "IndexedService.runFirst",
        source: { path: indexedPath, line: 2, column: 1 },
        uml: {
          scopePath: indexedPath,
          entityName: "IndexedService",
          memberName: "runFirst",
          memberOccurrence: 0,
        },
      },
      {
        key: '["class","IndexedService",0,"runSecond",0]',
        kind: "method",
        name: "runSecond",
        qualifiedName: "IndexedService.runSecond",
        source: { path: indexedPath, line: 3, column: 1 },
        uml: {
          scopePath: indexedPath,
          entityName: "IndexedService",
          memberName: "runSecond",
          memberOccurrence: 0,
        },
      },
    ] satisfies GotoDefinition[];

    const submittedLiteral = "-NEEDLE.[x]*$";
    const sensitiveLiteralResponse = {
      version: tree.version,
      query: submittedLiteral,
      files: [],
      definitions: [],
      directories: [],
      renderDirs: [],
      caseInsensitive: false,
    } satisfies SearchResponse;
    for (const mode of [
      { name: "omitted mode", parameter: "" },
      { name: "explicit case-sensitive mode", parameter: "&caseInsensitive=false" },
    ]) {
      const response = await fetch(
        `${base}/api/search?q=${encodeURIComponent(`  ${submittedLiteral}  `)}${mode.parameter}`,
      );
      expect(response.status, mode.name).toBe(200);
      expect(await response.json(), mode.name).toEqual(sensitiveLiteralResponse);
    }

    const insensitiveLiteralResponse = await fetch(
      `${base}/api/search?q=${encodeURIComponent(`  ${submittedLiteral}  `)}&caseInsensitive=true`,
    );
    expect(insensitiveLiteralResponse.status).toBe(200);
    expect(await insensitiveLiteralResponse.json() as SearchResponse).toEqual({
      version: tree.version,
      query: submittedLiteral,
      files: [
        "packages/demo/src/literal.txt",
        "packages/demo/src/nested/edited.txt",
        "packages/demo/src/untracked.txt",
      ],
      definitions: [],
      directories: [
        "packages/demo",
        "packages/demo/src",
        "packages/demo/src/nested",
      ],
      renderDirs: ["packages/demo/src"],
      caseInsensitive: true,
    });

    const noMatch = await fetch(`${base}/api/search?q=definitely-not-present`);
    expect(await noMatch.json() as SearchResponse).toEqual({
      version: tree.version,
      query: "definitely-not-present",
      files: [],
      definitions: [],
      directories: [],
      renderDirs: [],
      caseInsensitive: false,
    });
    for (const invalid of [
      { name: "blank", query: " \t ", error: "search query is required" },
      { name: "multiline", query: "first\nsecond", error: "search query must be one line" },
    ]) {
      const response = await fetch(`${base}/api/search?q=${encodeURIComponent(invalid.query)}`);
      expect(response.status, invalid.name).toBe(422);
      expect(await response.json(), invalid.name).toEqual({ error: invalid.error });
    }

    const invalidMode = await fetch(
      `${base}/api/search?q=${encodeURIComponent(submittedLiteral)}&caseInsensitive=invalid`,
    );
    expect(invalidMode.status).toBe(422);
    expect(await invalidMode.json()).toEqual({
      error: "caseInsensitive must be true or false",
    });

    const packageDiagram = await fetchDiagram(base, "kind=packages&path=");
    expect(packageDiagram.scopePath).toBe("");
    expect(packagesPayload(packageDiagram).dsl).toContain("flowchart LR");
    expect(packagesPayload(packageDiagram).packageNodes).toEqual([
      { nodeId: "p0", name: "demo", path: "packages/demo" },
    ] satisfies PackageDiagramNode[]);

    // A definition selection is exactly one frame rooted at the requested key. `getMachine` is a
    // member of the nominal root, so it supplies the dependency without becoming its own node.
    const runtimePath = "packages/demo/src/runtime.ts";
    const machinePath = "packages/demo/src/machine.ts";
    const runtimeKey = await definitionKey(base, runtimePath, "DataflowRuntime");
    const rootDefinition = await fetchDiagram(
      base,
      `kind=uml&target=definition&path=${encodeURIComponent(runtimePath)}`
        + `&definition=${encodeURIComponent(runtimeKey)}`,
    );
    expect(rootDefinition.status).toBe("ready");
    expect(rootDefinition.scopePath).toBe(runtimePath);
    expect(rootDefinition.kind === "uml" && rootDefinition.target).toEqual({
      kind: "definition",
      path: runtimePath,
      definitionKey: runtimeKey,
    });
    const rootView = definitionsView(rootDefinition);
    expect(definitionLabels(rootView)).toEqual([
      `AbstractStateMachine@${machinePath}`,
      `DataflowRuntime@${runtimePath}`,
    ]);
    expect(edgeRows(rootView, umlLabel)).toEqual([
      `DataflowRuntime@${runtimePath} -references-> AbstractStateMachine@${machinePath}`,
    ]);
    expect(frameRows(rootView, umlLabel)).toEqual([
      {
        root: `DataflowRuntime@${runtimePath}`,
        nodes: [`AbstractStateMachine@${machinePath}`, `DataflowRuntime@${runtimePath}`],
      },
    ]);
    // UML navigation metadata now lives in the view nodes; the removed top-level arrays must not
    // reappear on the wire.
    for (const removed of ["packageNodes", "definitions", "localUsers", "externalUsers", "dsl"]) {
      expect(Object.hasOwn(rootDefinition, removed), removed).toBe(false);
    }

    // A file selection is one frame per top-level definition, in source order; an isolated root is
    // still a one-node frame.
    const pairPath = "packages/demo/src/pair.ts";
    const widgetPath = "packages/demo/src/target/widget.ts";
    const pairFile = await fetchDiagram(
      base,
      `kind=uml&target=file&path=${encodeURIComponent(pairPath)}`,
    );
    expect(pairFile.status).toBe("ready");
    expect(frameRows(definitionsView(pairFile), umlLabel)).toEqual([
      {
        root: `PairFirst@${pairPath}`,
        nodes: [`PairFirst@${pairPath}`, `Widget@${widgetPath}`],
      },
      { root: `pairSecond@${pairPath}`, nodes: [`pairSecond@${pairPath}`] },
    ]);

    // A directory selection is the file import graph: every visible regular file in the subtree,
    // and only the edges whose source lies inside it. `consumer.ts` imports `widget.ts` from
    // outside the subtree, so that incoming edge is absent.
    const targetDir = "packages/demo/src/target";
    const scopedDirectory = await fetchDiagram(
      base,
      `kind=uml&target=directory&path=${encodeURIComponent(targetDir)}`,
    );
    expect(scopedDirectory.scopePath).toBe(targetDir);
    expect(filesView(scopedDirectory)).toEqual({
      kind: "files",
      nodes: [
        { path: `${targetDir}/local-user.ts`, boundary: false, test: false },
        { path: widgetPath, boundary: false, test: false },
      ],
      edges: [{ sourcePath: `${targetDir}/local-user.ts`, targetPath: widgetPath }],
    });

    const packageDirectory = await fetchDiagram(
      base,
      "kind=uml&target=directory&path=packages%2Fdemo",
    );
    expect(packageDirectory.scopePath).toBe("packages/demo");
    const packageFiles = filesView(packageDirectory);
    // Non-source and isolated files are nodes too.
    expect(packageFiles.nodes.map((node) => node.path)).toEqual(expect.arrayContaining([
      "packages/demo/package.json",
      "packages/demo/src/literal.txt",
      "packages/demo/src/index.ts",
      runtimePath,
    ]));
    expect(packageFiles.nodes.some((node) => node.boundary)).toBe(false);
    expect(packageFiles.edges).toEqual([
      { sourcePath: "packages/demo/src/consumer.ts", targetPath: widgetPath },
      { sourcePath: pairPath, targetPath: widgetPath },
      { sourcePath: runtimePath, targetPath: machinePath },
      { sourcePath: `${targetDir}/local-user.ts`, targetPath: widgetPath },
    ]);

    const rootDirectory = await fetchDiagram(base, "kind=uml&target=directory&path=");
    expect(rootDirectory.scopePath).toBe("");
    const rootFiles = filesView(rootDirectory);
    expect(rootFiles.nodes.map((node) => node.path)).toEqual(expect.arrayContaining([
      "package.json",
      "bulk/entry-000.ts",
      runtimePath,
    ]));
    expect(rootFiles.edges).toEqual(packageFiles.edges);

    const missingScope = await fetch(
      `${base}/api/diagram?kind=uml&target=file&path=packages%2Fdemo%2Fsrc%2Fmissing.ts`,
    );
    expect(missingScope.status).toBe(404);
    // The active and building generations legitimately word this differently; only the contract holds.
    expect(await missingScope.json()).toEqual({ error: expect.any(String) });

    const plainFileResponse = await fetch(`${base}/api/file?path=packages%2Fdemo%2Fsrc%2Findex.ts`);
    expect(plainFileResponse.status).toBe(200);
    expect(await plainFileResponse.json() as FileResponse).toEqual({
      path: "packages/demo/src/index.ts",
      content: "export const value = 1;\n",
      definitions: [],
      highlights: expect.any(Array),
    });

    const positionedFileResponse = await fetch(
      `${base}/api/file?path=packages%2Fdemo%2Fsrc%2Findex.ts&line=1&column=20`,
    );
    expect(positionedFileResponse.status).toBe(200);
    const positioned = await positionedFileResponse.json() as FileResponse;
    expect(positioned).toEqual({
      path: "packages/demo/src/index.ts",
      content: "export const value = 1;\n",
      definitions: [],
      highlights: expect.any(Array),
      cursorOffset: 21,
    });
    expect(positioned.content[positioned.cursorOffset ?? -1]).toBe("1");

    const definitionSearch = await fetch(
      `${base}/api/search?q=${encodeURIComponent("IndexedService.run")}`,
    );
    expect(definitionSearch.status).toBe(200);
    expect(await definitionSearch.json() as SearchResponse).toEqual({
      version: tree.version,
      query: "IndexedService.run",
      files: [indexedPath],
      definitions: indexedDefinitions.slice(1),
      directories: ["packages/demo", "packages/demo/src"],
      renderDirs: ["packages/demo/src"],
      caseInsensitive: false,
    });

    const mixedCaseDefinitionQuery = "indexedservice.RUN";
    const sensitiveDefinitionSearch = await fetch(
      `${base}/api/search?q=${encodeURIComponent(mixedCaseDefinitionQuery)}&caseInsensitive=false`,
    );
    expect(sensitiveDefinitionSearch.status).toBe(200);
    expect(await sensitiveDefinitionSearch.json() as SearchResponse).toEqual({
      version: tree.version,
      query: mixedCaseDefinitionQuery,
      files: [],
      definitions: [],
      directories: [],
      renderDirs: [],
      caseInsensitive: false,
    });

    const insensitiveDefinitionSearch = await fetch(
      `${base}/api/search?q=${encodeURIComponent(mixedCaseDefinitionQuery)}&caseInsensitive=true`,
    );
    expect(insensitiveDefinitionSearch.status).toBe(200);
    expect(await insensitiveDefinitionSearch.json() as SearchResponse).toEqual({
      version: tree.version,
      query: mixedCaseDefinitionQuery,
      files: [indexedPath],
      definitions: indexedDefinitions.slice(1),
      directories: ["packages/demo", "packages/demo/src"],
      renderDirs: ["packages/demo/src"],
      caseInsensitive: true,
    });

    const definitionHit = await fetch(
      `${base}/api/goto-definition?path=${encodeURIComponent(indexedPath)}&line=3&column=1`,
    );
    expect(definitionHit.status).toBe(200);
    expect(await definitionHit.json()).toEqual({
      version: tree.version,
      definition: indexedDefinitions[2],
    });
    const definitionMiss = await fetch(
      `${base}/api/goto-definition?path=${encodeURIComponent(indexedPath)}&line=3&column=2`,
    );
    expect(definitionMiss.status).toBe(200);
    expect(await definitionMiss.json()).toEqual({
      version: tree.version,
      definition: null,
    });

    for (const invalidDefinitionLocation of [
      {
        name: "missing path",
        query: "line=1&column=1",
        status: 422,
        error: "path, line, and column are required",
      },
      {
        name: "missing column",
        query: `path=${encodeURIComponent(indexedPath)}&line=1`,
        status: 422,
        error: "line and column must be provided together",
      },
      {
        name: "invalid line",
        query: `path=${encodeURIComponent(indexedPath)}&line=0&column=1`,
        status: 422,
        error: "line and column must be positive integers",
      },
      {
        name: "escaping path",
        query: `path=${encodeURIComponent("../indexed-service.ts")}&line=1&column=1`,
        status: 403,
        error: "path escapes the source root",
      },
    ]) {
      const response = await fetch(
        `${base}/api/goto-definition?${invalidDefinitionLocation.query}`,
      );
      expect(response.status, invalidDefinitionLocation.name).toBe(
        invalidDefinitionLocation.status,
      );
      expect(await response.json(), invalidDefinitionLocation.name).toEqual({
        error: invalidDefinitionLocation.error,
      });
    }

    const fastDefinitionHit = await fetch(
      `${base}/api/definition?path=${encodeURIComponent(indexedPath)}&name=runSecond`
        + `&qualifiedName=${encodeURIComponent("IndexedService.runSecond")}`,
    );
    expect(fastDefinitionHit.status).toBe(200);
    expect(await fastDefinitionHit.json()).toEqual({
      version: tree.version,
      definition: { path: indexedPath, line: 3, column: 1 },
    });
    const fastDefinitionMiss = await fetch(
      `${base}/api/definition?path=${encodeURIComponent(indexedPath)}&name=runThird`
        + `&qualifiedName=${encodeURIComponent("IndexedService.runThird")}`,
    );
    expect(fastDefinitionMiss.status).toBe(200);
    expect(await fastDefinitionMiss.json()).toEqual({
      version: tree.version,
      definition: null,
    });

    for (const invalidDefinitionLookup of [
      {
        name: "missing qualified name",
        query: `path=${encodeURIComponent(indexedPath)}&name=runFirst`,
        status: 422,
        error: "path, name, and qualifiedName are required",
      },
      {
        name: "empty name",
        query: `path=${encodeURIComponent(indexedPath)}&name=&qualifiedName=IndexedService`,
        status: 422,
        error: "name and qualifiedName must not be empty",
      },
      {
        name: "escaping path",
        query: `path=${encodeURIComponent("../indexed-service.ts")}`
          + "&name=IndexedService&qualifiedName=IndexedService",
        status: 403,
        error: "path escapes the source root",
      },
    ]) {
      const response = await fetch(`${base}/api/definition?${invalidDefinitionLookup.query}`);
      expect(response.status, invalidDefinitionLookup.name).toBe(
        invalidDefinitionLookup.status,
      );
      expect(await response.json(), invalidDefinitionLookup.name).toEqual({
        error: invalidDefinitionLookup.error,
      });
    }

    const indexedFileResponse = await fetch(
      `${base}/api/file?path=${encodeURIComponent(indexedPath)}`,
    );
    expect(indexedFileResponse.status).toBe(200);
    expect(await indexedFileResponse.json() as FileResponse).toEqual({
      path: indexedPath,
      content:
        "export class IndexedService {\n  runFirst(value: string) {\n    return value;\n  }\n  runSecond(value: number) {\n    return value;\n  }\n}\n",
      definitions: [
        { ...indexedDefinitions[0], displayFrom: 13, displayTo: 27 },
        { ...indexedDefinitions[1], displayFrom: 32, displayTo: 40 },
        { ...indexedDefinitions[2], displayFrom: 82, displayTo: 91 },
      ],
      highlights: expect.any(Array),
    });

    const priorityResponse = await fetch(`${base}/api/preprocess`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prioritize", resource: `./${indexedPath}` }),
    });
    expect(priorityResponse.status).toBe(200);
    const priority = await priorityResponse.json() as {
      status: string;
      resource: string;
      requestId: number;
    };
    expect(priority).toEqual({
      status: "queued",
      resource: indexedPath,
      requestId: expect.any(Number),
    });
    expect(priority.requestId).toBeGreaterThan(0);
    const polls = new AbortController();
    let polled = priority;
    try {
      await withBound(
        (async () => {
          while (polled.status !== "done") {
            // Only yield while the request is still outstanding; the loop ends on the terminal state.
            await Bun.sleep(10);
            const pollResponse = await fetch(`${base}/api/preprocess`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "poll", requestId: priority.requestId }),
              signal: polls.signal,
            });
            expect(pollResponse.status).toBe(200);
            polled = await pollResponse.json() as typeof priority;
            expect(["queued", "processing", "done"]).toContain(polled.status);
            expect(polled.resource).toBe(indexedPath);
            expect(polled.requestId).toBe(priority.requestId);
          }
        })(),
        5_000,
        "priority request completion",
      );
    } finally {
      polls.abort();
    }
    expect(polled).toEqual({
      status: "done",
      resource: indexedPath,
      requestId: priority.requestId,
    });

    for (const invalidLocation of [
      { name: "missing column", suffix: "&line=1", error: "line and column must be provided together" },
      { name: "zero line", suffix: "&line=0&column=1", error: "line and column must be positive integers" },
    ]) {
      const response = await fetch(
        `${base}/api/file?path=packages%2Fdemo%2Fsrc%2Findex.ts${invalidLocation.suffix}`,
      );
      expect(response.status, invalidLocation.name).toBe(422);
      expect(await response.json(), invalidLocation.name).toEqual({ error: invalidLocation.error });
    }

    const unsupported = await fetch(`${base}/api/file?path=packages%2Fdemo%2Fsrc%2Fliteral.txt`);
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({
      error: "only TypeScript, JavaScript, and Rust source files can be viewed",
    });

    const removedRoutes = [
      await fetch(`${base}/api/file/format`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "changed" }),
      }),
      await fetch(`${base}/api/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "changed" }),
      }),
    ];
    for (const response of removedRoutes) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
    expect(await readFile(sourceFile, "utf8")).toBe("export const value=1\n");
  } finally {
    try {
      await watch?.close();
      await server.stop();
    } finally {
      // The cache is redirected off the share for WSL roots, so remove it through the helper before
      // deleting the outer fixture directory.
      await removeFixtureRoot(root);
      await rm(outerRoot, { recursive: true, force: true });
    }
  }
}, 60_000);

test("serves live add and remove trees before separately promoted APIs", async () => {
  // Fixture I/O uses the canonical root; the server receives TEMP/TMP as configured, which on Windows
  // may be a namespaced WSL spelling the application must canonicalize itself.
  const root = await mkdtemp(join(resolveSourceDir(tmpdir()), "ts-explorer-live-watch-"));
  const sourceArgument = join(tmpdir(), basename(root));
  const watchedDir = join(root, "watched");
  const addedFile = join(watchedDir, "added.ts");
  const deletedModelFile = join(watchedDir, "deleted-model.ts");
  await mkdir(watchedDir);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "live-watch" }));
  await writeFile(join(root, "index.ts"), "export const initial=1\n");
  await writeFile(
    deletedModelFile,
    [
      "export class WatchedTarget {}",
      "export class WatchedSource {",
      "  getTarget(): WatchedTarget { return new WatchedTarget(); }",
      "}",
      "",
    ].join("\n"),
  );
  const watchBatches: Array<{ paths: string[]; events: string[]; version: number }> = [];
  const server = await startServer({
    sourceDir: sourceArgument,
    host: "127.0.0.1",
    port: 0,
    onWatchBatch(paths, events, version) {
      watchBatches.push({ paths: [...paths], events: [...events], version });
      throw new Error("watch diagnostic failed");
    },
  });
  let watch: WatchClient | undefined;
  let replay: WatchClient | undefined;
  try {
    const base = `http://127.0.0.1:${server.port}`;
    watch = await openWatch(base);
    await watch.waitFor((message) => message.type === "cache-ready");

    const addedChanged = watch.waitFor(
      (message) => hasWatchEvent(message, "watched/added.ts", "add"),
    );
    await writeFile(addedFile, 'export const watchedToken="WATCHED_LIVE_TOKEN"\n');
    const addedMessage = await addedChanged;
    if (addedMessage.type !== "changed") throw new Error("expected added change");
    expect(watchBatches.filter(({ version }) => version === addedMessage.version)).toEqual([{
      paths: addedMessage.paths,
      events: addedMessage.events,
      version: addedMessage.version,
    }]);
    const addedTree = await withBound(
      fetch(`${base}/api/tree`).then(
        (response) => response.json() as Promise<{ root: TreeNode }>,
      ),
      5_000,
      "live tree after add",
    );
    expect(
      addedTree.root.children
        ?.find((child) => child.path === "watched")
        ?.children?.map((child) => child.path),
    ).toContain("watched/added.ts");

    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === addedMessage.version,
    );
    const addedFileResponse = await fetch(
      `${base}/api/file?path=${encodeURIComponent("watched/added.ts")}`,
    );
    expect(addedFileResponse.status).toBe(200);
    expect(await addedFileResponse.json() as FileResponse).toEqual({
      path: "watched/added.ts",
      content: 'export const watchedToken = "WATCHED_LIVE_TOKEN";\n',
      definitions: [],
      highlights: expect.any(Array),
    });

    const deletedModelPath = "watched/deleted-model.ts";
    const presentUml = await fetchDiagram(
      base,
      `kind=uml&target=file&path=${encodeURIComponent(deletedModelPath)}`,
    );
    expect(presentUml.status).toBe("ready");
    expect(frameRows(definitionsView(presentUml), umlLabel)).toEqual([
      {
        root: `WatchedTarget@${deletedModelPath}`,
        nodes: [`WatchedTarget@${deletedModelPath}`],
      },
      {
        root: `WatchedSource@${deletedModelPath}`,
        nodes: [`WatchedSource@${deletedModelPath}`, `WatchedTarget@${deletedModelPath}`],
      },
    ]);

    const modelRemovedChanged = watch.waitFor(
      (message) =>
        message.type === "changed" &&
        message.version > addedMessage.version &&
        hasWatchEvent(message, "watched/deleted-model.ts", "unlink"),
    );
    await rm(deletedModelFile);
    const modelRemovedMessage = await modelRemovedChanged;
    if (modelRemovedMessage.type !== "changed") throw new Error("expected model removal change");
    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === modelRemovedMessage.version,
    );
    const removedUml = await fetch(
      `${base}/api/diagram?kind=uml&target=file&path=${encodeURIComponent(deletedModelPath)}`,
    );
    expect(removedUml.status).toBe(404);
    await removedUml.json();

    const removedChanged = watch.waitFor(
      (message) =>
        message.type === "changed" &&
        message.version > addedMessage.version &&
        hasWatchEvent(message, "watched/added.ts", "unlink"),
    );
    await rm(addedFile);
    const removedMessage = await removedChanged;
    if (removedMessage.type !== "changed") throw new Error("expected removed change");
    expect(watchBatches.filter(({ version }) => version === removedMessage.version)).toEqual([{
      paths: removedMessage.paths,
      events: removedMessage.events,
      version: removedMessage.version,
    }]);
    const removedTree = await withBound(
      fetch(`${base}/api/tree`).then(
        (response) => response.json() as Promise<{ root: TreeNode }>,
      ),
      5_000,
      "live tree after remove",
    );
    expect(
      removedTree.root.children
        ?.find((child) => child.path === "watched")
        ?.children?.map((child) => child.path),
    ).not.toContain("watched/added.ts");

    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === removedMessage.version,
    );
    const removedSearch = await fetch(
      `${base}/api/search?q=${encodeURIComponent("WATCHED_LIVE_TOKEN")}`,
    );
    expect(removedSearch.status).toBe(200);
    expect((await removedSearch.json() as SearchResponse).files).toEqual([]);

    replay = await openWatch(base);
    await replay.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === removedMessage.version,
    );
    const replayHistory = replay.history();
    const handshakeIndex = replayHistory.findIndex(
      (message) =>
        message.type === "changed" &&
        message.version === removedMessage.version &&
        message.paths.length === 0 &&
        message.events.length === 0,
    );
    const readyIndex = replayHistory.findIndex(
      (message) =>
        message.type === "cache-ready" && message.version === removedMessage.version,
    );
    expect(handshakeIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(handshakeIndex);
  } finally {
    try {
      await replay?.close();
      await watch?.close();
      await server.stop();
    } finally {
      await removeFixtureRoot(root);
    }
  }
}, 60_000);

test("package diagram errors retain the last promoted snapshot", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-package-fallback-");
  await writeFixtureFile(root, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  await writeFixtureFile(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "a", dependencies: { b: "*" } }),
  );
  await writeFixtureFile(root, "packages/b/package.json", JSON.stringify({ name: "b" }));

  const store = new ExplorerStore(root, undefined, undefined, undefined, undefined, randomVersionSeed());
  try {
    await store.ready();
    const ready = await until(
      () => store.getDiagram({ kind: "packages", scopePath: "" }),
      (diagram) => diagram.status === "ready",
      "initial package diagram promotion",
    );
    const graphDbPath = resolveCacheDbPath(root);
    // A ready diagram does not imply a promoted generation: the meta row lands once the rebuild
    // commits, so each graph read below waits for the generation it is about to inspect.
    const promotedGeneration = async (): Promise<number | undefined> =>
      openDatabase(graphDbPath, findActiveGenerationId, { readonly: true });
    await until(
      promotedGeneration,
      (generationId) => generationId !== undefined,
      "the initial package graph generation to be promoted",
    );
    const readyGraph = readActivePackageGraph(graphDbPath);
    expect(readyGraph.nodes).toEqual([
      { node_id: "p0", node_ordinal: 0, node_kind: "package", name: "a" },
      { node_id: "p1", node_ordinal: 1, node_kind: "package", name: "b" },
    ]);
    expect(readyGraph.edges).toEqual([
      {
        edge_ordinal: 0,
        source_node_id: "p0",
        target_node_id: "p1",
        edge_kind: "package-dependency",
        directed: 1,
        weight: 1,
      },
    ]);
    expect(readyGraph.relations).toEqual([
      {
        edge_ordinal: 0,
        relation_ordinal: 0,
        relation_kind: "package-dependency",
        source_node_id: "p0",
        target_node_id: "p1",
      },
    ]);
    expect(readyGraph.packageNodes).toEqual([
      { node_id: "p0", package_path: "packages/a" },
      { node_id: "p1", package_path: "packages/b" },
    ]);

    await writeFile(join(root, "package.json"), "{ malformed");
    const failed = await until(
      () => store.getDiagram({ kind: "packages", scopePath: "" }),
      (diagram) => diagram.status === "error",
      "package diagram rebuild after the manifest was corrupted",
    );
    await until(
      promotedGeneration,
      (generationId) => generationId !== readyGraph.generationId,
      "the failed rebuild to promote a new generation",
    );
    const failedGraph = readActivePackageGraph(graphDbPath);

    // The failed rebuild republishes the last good topology rather than an empty graph.
    expect({ ...failedGraph, generationId: readyGraph.generationId }).toEqual(readyGraph);
    if (ready.kind !== "packages" || failed.kind !== "packages") {
      throw new Error("expected package diagram responses");
    }
    expect(failed.packageNodes).toEqual(ready.packageNodes);
    expect(failed.dsl).toBe(ready.dsl);
    expect(failed.dsls).toEqual(ready.dsls);
    expect(failed.error).toEqual(expect.any(String));
  } finally {
    await store.close();
  }
}, 30_000);

test("an undecodable source file reports its real error instead of a stale graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-fallback-"));
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "uml-fallback" }));
  await writeFixtureFile(
    root,
    "model.ts",
    [
      "export class FallbackTarget {}",
      "export class FallbackSource {",
      "  getTarget(): FallbackTarget { return new FallbackTarget(); }",
      "}",
      "",
    ].join("\n"),
  );
  // A binary asset is a normal subtree member; only a real source decode failure may fail a
  // directory view.
  await writeFixtureFile(root, "assets/blob.bin", Buffer.from("blob\0\n"));

  const store = new ExplorerStore(root, undefined, undefined, undefined, undefined, randomVersionSeed());
  try {
    await store.ready();
    const target = { kind: "file", path: "model.ts" } as const;
    const ready = await until(
      () => store.getDiagram({ kind: "uml", target }),
      (diagram) => diagram.status === "ready",
      "initial UML cache promotion",
    );
    expect(frameRows(definitionsView(ready), umlLabel)).toEqual([
      { root: "FallbackTarget@model.ts", nodes: ["FallbackTarget@model.ts"] },
      {
        root: "FallbackSource@model.ts",
        nodes: ["FallbackSource@model.ts", "FallbackTarget@model.ts"],
      },
    ]);
    const project = { kind: "directory", path: "" } as const;
    const readyProject = await store.getDiagram({ kind: "uml", target: project });
    expect(readyProject.status).toBe("ready");
    expect(filesView(readyProject).nodes.map((node) => node.path)).toEqual([
      "assets/blob.bin",
      "model.ts",
      "package.json",
    ]);

    // The parser rejects invalid UTF-8, which is the only source-level failure it can observe.
    await writeFile(join(root, "model.ts"), Buffer.from([0x65, 0x78, 0x70, 0xff, 0xfe]));
    const failed = await until(
      () => store.getDiagram({ kind: "uml", target }),
      (diagram) => diagram.status === "error",
      "UML rebuild after the source became undecodable",
    );
    expect(failed.error).toEqual(expect.any(String));
    // Keys and edges from the previous generation are never republished under the new catalogue.
    expect(definitionsView(failed)).toEqual({
      kind: "definitions",
      nodes: [],
      edges: [],
      frames: [],
    });
    const failedProject = await store.getDiagram({ kind: "uml", target: project });
    expect(failedProject.status).toBe("error");
    expect(failedProject.error).toContain("model.ts");
    expect(filesView(failedProject)).toEqual({ kind: "files", nodes: [], edges: [] });
  } finally {
    try {
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 30_000);

test("a malformed root manifest produces the stable empty package error", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-malformed-root-");
  await writeFile(join(root, "package.json"), "{ malformed");
  const store = new ExplorerStore(root);
  try {
    await store.ready();
    const response = await store.getDiagram({ kind: "packages", scopePath: "" });
    expect(response.status).toBe("error");
    if (response.kind !== "packages") throw new Error("expected a packages diagram response");
    expect(response.dsl).toBe("flowchart LR");
    expect(response.dsls).toEqual(["flowchart LR"]);
    expect(response.packageNodes).toEqual([]);
  } finally {
    await store.close();
  }
}, 30_000);

test("warm restart rebuilds when sources changed while stopped and reuses the cache when they did not", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-package-restart-");
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await mkdir(join(root, "packages", "a"), { recursive: true });
  const packageAManifest = join(root, "packages", "a", "package.json");
  await writeFile(packageAManifest, JSON.stringify({ name: "a" }));

  let firstServer: RunningServer | undefined;
  let secondServer: RunningServer | undefined;
  let watch: WatchClient | undefined;
  try {
    firstServer = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const firstBase = `http://127.0.0.1:${firstServer.port}`;
    const firstWatch = await openWatch(firstBase);
    try {
      await firstWatch.waitFor((message) => message.type === "cache-ready");
    } finally {
      await firstWatch.close();
    }
    const firstDiagram = await (
      await fetch(`${firstBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(packagesPayload(firstDiagram).packageNodes).toEqual([
      { nodeId: "p0", name: "a", path: "packages/a" },
    ]);
    const dbPath = resolveCacheDbPath(root);
    const recoveredId = readActivePackageGraph(dbPath).generationId;
    const recoveredStartedAt = openDatabase(
      dbPath,
      (db) =>
        queryAll<{ started_at: number }>(db, "SELECT started_at FROM generations ORDER BY id"),
      { readonly: true },
    );
    expect(recoveredStartedAt).toHaveLength(1);

    await firstServer.stop();
    firstServer = undefined;

    firstServer = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const untouchedBase = `http://127.0.0.1:${firstServer.port}`;
    const untouchedWatch = await openWatch(untouchedBase);
    try {
      await untouchedWatch.waitFor((message) => message.type === "cache-ready");
    } finally {
      await untouchedWatch.close();
    }
    const untouchedDiagram = await (
      await fetch(`${untouchedBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    // The ambient watch version differs per server; the served topology must not.
    expect({ ...untouchedDiagram, version: firstDiagram.version }).toEqual(firstDiagram);
    expect(readActivePackageGraph(dbPath).generationId).toBe(recoveredId);
    expect(openDatabase(
      dbPath,
      (db) =>
        queryAll<{ id: number; state: string; cause: string }>(
          db,
          "SELECT id, state, cause FROM generations ORDER BY id",
        ),
      { readonly: true },
    )).toEqual([{ id: recoveredId, state: "active", cause: "startup" }]);
    await firstServer.stop();
    firstServer = undefined;

    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b" }));
    await writeFile(
      packageAManifest,
      JSON.stringify({ name: "a", dependencies: { b: "*" } }),
    );

    secondServer = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const secondBase = `http://127.0.0.1:${secondServer.port}`;
    watch = await openWatch(secondBase);
    await watch.waitFor((message) => message.type === "cache-ready");

    const restartedDiagram = await (
      await fetch(`${secondBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(packagesPayload(restartedDiagram).packageNodes).toEqual([
      { nodeId: "p0", name: "a", path: "packages/a" },
      { nodeId: "p1", name: "b", path: "packages/b" },
    ]);
    expect(packagesPayload(restartedDiagram).dsl).toContain("p0 --> p1");
    const restartedGenerations = openDatabase(
      dbPath,
      (db) =>
        queryAll<{ id: number; state: string; cause: string; started_at: number }>(
          db,
          "SELECT id, state, cause, started_at FROM generations ORDER BY id",
        ),
      { readonly: true },
    );
    expect(restartedGenerations).toHaveLength(1);
    const [restartedGeneration] = restartedGenerations;
    if (restartedGeneration === undefined) throw new Error("startup generation was not rebuilt");
    expect(restartedGeneration).toMatchObject({ state: "active", cause: "startup" });
    expect(restartedGeneration.started_at).toBeGreaterThan(recoveredStartedAt[0]?.started_at ?? 0);
    const restartedId = restartedGeneration.id;

    const changed = watch.waitFor((message) => {
      if (message.type !== "changed") return false;
      const pathIndex = message.paths.indexOf("packages/a/package.json");
      return pathIndex >= 0 && message.events[pathIndex] === "change";
    });
    await writeFile(
      packageAManifest,
      JSON.stringify({ name: "a", version: "1.0.0", dependencies: { b: "*" } }),
    );
    const changedMessage = await changed;
    if (changedMessage.type !== "changed") throw new Error("expected package manifest change");
    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === changedMessage.version,
    );

    const rebuiltDiagram = await (
      await fetch(`${secondBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(packagesPayload(rebuiltDiagram).packageNodes).toEqual([
      { nodeId: "p0", name: "a", path: "packages/a" },
      { nodeId: "p1", name: "b", path: "packages/b" },
    ]);
    expect(packagesPayload(rebuiltDiagram).dsl).toContain("p0 --> p1");
    expect(packagesPayload(rebuiltDiagram).dsl).not.toBe(packagesPayload(firstDiagram).dsl);
    const rebuiltId = readActivePackageGraph(dbPath).generationId;
    expect(rebuiltId).not.toBe(restartedId);
    expect(openDatabase(
      dbPath,
      (db) =>
        queryAll<{ id: number; state: string; cause: string }>(
          db,
          "SELECT id, state, cause FROM generations ORDER BY id",
        ),
      { readonly: true },
    )).toEqual([{ id: rebuiltId, state: "active", cause: "watch" }]);
  } finally {
    await watch?.close();
    await secondServer?.stop();
    await firstServer?.stop();
  }
}, 60_000);

test("warm restart serves file content edited while the server was stopped", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-restart-file-");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "restart-file" }));
  await mkdir(join(root, "src"), { recursive: true });
  const filePath = join(root, "src", "a.ts");
  await writeFile(filePath, "export const EMPTY_BATCH = 1;\nexport const kept = 2;\n");

  let server: RunningServer | undefined;
  try {
    server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const firstBase = `http://127.0.0.1:${server.port}`;
    const firstWatch = await openWatch(firstBase);
    try {
      await firstWatch.waitFor((message) => message.type === "cache-ready");
    } finally {
      await firstWatch.close();
    }
    const staleResponse = await fetch(`${firstBase}/api/file?path=src%2Fa.ts`);
    expect(staleResponse.status).toBe(200);
    expect((await staleResponse.json() as FileResponse).content).toContain("EMPTY_BATCH");

    await server.stop();
    server = undefined;

    await writeFile(filePath, "export const kept = 2;\n");

    server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const secondBase = `http://127.0.0.1:${server.port}`;
    const secondWatch = await openWatch(secondBase);
    try {
      await secondWatch.waitFor((message) => message.type === "cache-ready");
    } finally {
      await secondWatch.close();
    }
    const freshResponse = await fetch(`${secondBase}/api/file?path=src%2Fa.ts`);
    expect(freshResponse.status).toBe(200);
    const fresh = await freshResponse.json() as FileResponse;
    expect(fresh.content).toContain("kept");
    expect(fresh.content).not.toContain("EMPTY_BATCH");
  } finally {
    await server?.stop();
  }
}, 60_000);

test("serves real file outlines and rejects unusable paths", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-file-outline-");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "file-outline" }));
  await writeFile(
    join(root, "outline.ts"),
    [
      "export const LIMIT: number = 3;",
      "export function greet(name: string): string { const local = name; return local; }",
      "export interface Greeter { greet(name: string): string; }",
      "export class Box<T> { value!: T; get(): T { return this.value; } }",
      "export namespace Tools { export const FLAG: boolean = true; export function run(): void {} }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "outline.rs"),
    [
      "pub const LIMIT: i32 = 3;",
      "pub fn greet(name: &str) -> String { let local = name; local.to_owned() }",
      "pub trait Greeter { fn greet(&self) -> String; }",
      "pub struct Boxed { pub value: i32 }",
      "impl Boxed { pub fn read(&self) -> i32 { self.value } }",
      "pub mod tools { pub const FLAG: bool = true; }",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "empty.ts"), "");
  await writeFile(join(root, "notes.txt"), "plain text\n");
  let server: ExplorerServer | undefined;
  try {
    server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const outline = async (path: string) => {
      const response = await fetch(`${base}/api/file-definitions?path=${encodeURIComponent(path)}`);
      return { status: response.status, body: await response.json() as { definitions?: FileDefinition[]; error?: string } };
    };

    const script = await outline("outline.ts");
    expect(script.status).toBe(200);
    expect(outlineShape(script.body.definitions ?? [])).toEqual([
      { qualifiedName: "LIMIT", kind: "constant", type: "number", at: "1:14", parent: null, isTopLevel: true },
      { qualifiedName: "greet", kind: "function", type: "(name: string): string", at: "2:17", parent: null, isTopLevel: true },
      { qualifiedName: "Greeter", kind: "interface", type: "Greeter", at: "3:18", parent: null, isTopLevel: true },
      { qualifiedName: "Greeter.greet", kind: "method", type: "(name: string): string", at: "3:28", parent: "Greeter", isTopLevel: false },
      { qualifiedName: "Box", kind: "class", type: "Box<T>", at: "4:14", parent: null, isTopLevel: true },
      { qualifiedName: "Box.value", kind: "property", type: "T", at: "4:23", parent: "Box", isTopLevel: false },
      { qualifiedName: "Box.get", kind: "method", type: "(): T", at: "4:34", parent: "Box", isTopLevel: false },
      { qualifiedName: "Tools", kind: "namespace", type: null, at: "5:18", parent: null, isTopLevel: true },
      { qualifiedName: "Tools.FLAG", kind: "constant", type: "boolean", at: "5:39", parent: "Tools", isTopLevel: false },
      { qualifiedName: "Tools.run", kind: "function", type: "(): void", at: "5:77", parent: "Tools", isTopLevel: false },
    ]);
    expect(script.body.definitions?.every((definition) => definition.source.path === "outline.ts"))
      .toBe(true);

    const rust = await outline("outline.rs");
    expect(rust.status).toBe(200);
    // A Rust `impl` member is owned by the implemented type, never promoted to a file root.
    expect(outlineShape(rust.body.definitions ?? [])).toEqual([
      { qualifiedName: "LIMIT", kind: "constant", type: "i32", at: "1:11", parent: null, isTopLevel: true },
      { qualifiedName: "greet", kind: "function", type: "(name: &str) -> String", at: "2:8", parent: null, isTopLevel: true },
      { qualifiedName: "Greeter", kind: "trait", type: "Greeter", at: "3:11", parent: null, isTopLevel: true },
      { qualifiedName: "Greeter.greet", kind: "method", type: "(&self) -> String", at: "3:24", parent: "Greeter", isTopLevel: false },
      { qualifiedName: "Boxed", kind: "struct", type: "Boxed", at: "4:12", parent: null, isTopLevel: true },
      { qualifiedName: "Boxed.value", kind: "property", type: "i32", at: "4:24", parent: "Boxed", isTopLevel: false },
      { qualifiedName: "Boxed.read", kind: "method", type: "(&self) -> i32", at: "5:21", parent: "Boxed", isTopLevel: false },
      { qualifiedName: "tools", kind: "module", type: null, at: "6:9", parent: null, isTopLevel: true },
      { qualifiedName: "tools.FLAG", kind: "constant", type: "bool", at: "6:27", parent: "tools", isTopLevel: false },
    ]);

    // A valid path with no indexed declarations is an empty outline, not an error.
    for (const path of ["empty.ts", "notes.txt", "missing.ts"]) {
      const empty = await outline(path);
      expect(empty.status, path).toBe(200);
      expect(empty.body.definitions, path).toEqual([]);
    }

    const missingPath = await fetch(`${base}/api/file-definitions`);
    expect(missingPath.status).toBe(422);
    expect(await missingPath.json()).toEqual({ error: "path is required" });
    const emptyPath = await outline("");
    expect(emptyPath.status).toBe(422);
    expect(emptyPath.body).toEqual({ error: "path is required" });
    const escaping = await outline("../outside.ts");
    expect(escaping.status).toBe(403);
    expect(escaping.body).toEqual({ error: "path escapes the source root" });
  } finally {
    await server?.stop();
  }
}, 60_000);

test("the diagram route enforces its typed target contract", async () => {
  const outerRoot = await mkdtemp(join(tmpdir(), "ts-explorer-diagram-contract-"));
  const root = join(outerRoot, "project");
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "diagram-contract" }));
  await writeFile(join(root, "lib", "leaf.ts"), "export class Leaf {}\n");
  await writeFile(
    join(root, "lib", "root.ts"),
    'import { Leaf } from "./leaf";\nexport class Root { leaf!: Leaf; }\n',
  );
  await writeFile(join(root, "empty.ts"), "");
  await writeFile(join(outerRoot, "outside.ts"), "export class Outside {}\n");
  await symlink(join(outerRoot, "outside.ts"), join(root, "escape.ts"));

  let server: ExplorerServer | undefined;
  try {
    server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const rootKey = await definitionKey(base, "lib/root.ts", "Root");
    const leafKey = await definitionKey(base, "lib/leaf.ts", "Leaf");
    const encodedRootKey = encodeURIComponent(rootKey);

    const definition = await fetchDiagram(
      base,
      `kind=uml&target=definition&path=lib%2Froot.ts&definition=${encodedRootKey}`,
    );
    expect(definition.status).toBe("ready");
    expect(frameRows(definitionsView(definition), umlLabel)).toEqual([
      { root: "Root@lib/root.ts", nodes: ["Leaf@lib/leaf.ts", "Root@lib/root.ts"] },
    ]);

    // Concurrent shallow and deep reads of one root must not share a normalized, deduped or IPC
    // cache entry, and neither may a repeat of each after they settle.
    const definitionQuery = `kind=uml&target=definition&path=lib%2Froot.ts&definition=${encodedRootKey}`;
    const [rootOnly, rootAndLeaf] = await Promise.all([
      fetchDiagram(base, `${definitionQuery}&depth=0`),
      fetchDiagram(base, `${definitionQuery}&depth=1`),
    ]);
    expect(frameRows(definitionsView(rootOnly), umlLabel)).toEqual([
      { root: "Root@lib/root.ts", nodes: ["Root@lib/root.ts"] },
    ]);
    expect(frameRows(definitionsView(rootAndLeaf), umlLabel)).toEqual([
      { root: "Root@lib/root.ts", nodes: ["Leaf@lib/leaf.ts", "Root@lib/root.ts"] },
    ]);
    expect(frameRows(definitionsView(await fetchDiagram(base, `${definitionQuery}&depth=0`)), umlLabel))
      .toEqual([{ root: "Root@lib/root.ts", nodes: ["Root@lib/root.ts"] }]);
    expect(frameRows(definitionsView(await fetchDiagram(base, `${definitionQuery}&depth=1`)), umlLabel))
      .toEqual([
        { root: "Root@lib/root.ts", nodes: ["Leaf@lib/leaf.ts", "Root@lib/root.ts"] },
      ]);

    // A directory import graph ignores depth rather than rejecting it.
    expect((await fetchDiagram(base, "kind=uml&target=directory&path=lib&depth=0")).status)
      .toBe("ready");

    for (const depth of ["", "-1", "1.5", "1e2", "9007199254740992", " 1", "01x"]) {
      const response = await fetch(
        `${base}/api/diagram?${definitionQuery}&depth=${encodeURIComponent(depth)}`,
      );
      expect(response.status, `depth=${depth}`).toBe(422);
      expect(await response.json(), `depth=${depth}`).toEqual({ error: expect.any(String) });
    }

    // A syntactically valid empty source file is a completed selection with no frames.
    const empty = await fetchDiagram(base, "kind=uml&target=file&path=empty.ts");
    expect(empty.status).toBe("ready");
    expect(definitionsView(empty)).toEqual({
      kind: "definitions",
      nodes: [],
      edges: [],
      frames: [],
    });

    for (const invalid of [
      { name: "missing kind", query: "path=", error: "kind must be packages or uml" },
      { name: "invalid kind", query: "kind=graph&path=", error: "kind must be packages or uml" },
      {
        name: "missing target",
        query: "kind=uml&path=lib%2Froot.ts",
        error: "target must be definition, file, or directory",
      },
      {
        name: "invalid target",
        query: "kind=uml&target=entity&path=lib%2Froot.ts",
        error: "target must be definition, file, or directory",
      },
      { name: "empty file path", query: "kind=uml&target=file&path=", error: "path is required" },
      {
        name: "empty definition path",
        query: `kind=uml&target=definition&path=&definition=${encodedRootKey}`,
        error: "path is required",
      },
      {
        name: "missing definition key",
        query: "kind=uml&target=definition&path=lib%2Froot.ts",
        error: "definition is required",
      },
      {
        name: "empty definition key",
        query: "kind=uml&target=definition&path=lib%2Froot.ts&definition=",
        error: "definition is required",
      },
      {
        name: "definition key on a file target",
        query: `kind=uml&target=file&path=lib%2Froot.ts&definition=${encodedRootKey}`,
        error: "definition is only valid for a definition target",
      },
      {
        name: "definition key on a directory target",
        query: `kind=uml&target=directory&path=lib&definition=${encodedRootKey}`,
        error: "definition is only valid for a definition target",
      },
    ]) {
      const response = await fetch(`${base}/api/diagram?${invalid.query}`);
      expect(response.status, invalid.name).toBe(422);
      expect(await response.json(), invalid.name).toEqual({ error: invalid.error });
    }

    for (const missing of [
      { name: "missing file", query: "kind=uml&target=file&path=lib%2Fabsent.ts" },
      { name: "missing directory", query: "kind=uml&target=directory&path=absent" },
      {
        name: "unknown definition key",
        query: "kind=uml&target=definition&path=lib%2Froot.ts"
          + `&definition=${encodeURIComponent('["lib/root.ts","class","Absent",0]')}`,
      },
      {
        // A real key belonging to another file is not a key of the requested path.
        name: "definition key from another file",
        query: `kind=uml&target=definition&path=lib%2Froot.ts&definition=${
          encodeURIComponent(leafKey)
        }`,
      },
    ]) {
      const response = await fetch(`${base}/api/diagram?${missing.query}`);
      expect(response.status, missing.name).toBe(404);
      expect(await response.json(), missing.name).toEqual({ error: expect.any(String) });
    }

    for (const mismatch of [
      { name: "directory as file", query: "kind=uml&target=file&path=lib" },
      { name: "file as directory", query: "kind=uml&target=directory&path=lib%2Froot.ts" },
      {
        name: "directory as definition",
        query: `kind=uml&target=definition&path=lib&definition=${encodedRootKey}`,
      },
    ]) {
      const response = await fetch(`${base}/api/diagram?${mismatch.query}`);
      expect(response.status, mismatch.name).toBe(400);
      expect(await response.json(), mismatch.name).toEqual({
        error: "diagram target kind does not match path",
      });
    }

    for (const forbidden of [
      {
        name: "traversing file target",
        query: `kind=uml&target=file&path=${encodeURIComponent("../outside.ts")}`,
        error: "path escapes the source root",
      },
      {
        name: "traversing directory target",
        query: `kind=uml&target=directory&path=${encodeURIComponent("lib/../..")}`,
        error: "path escapes the source root",
      },
      {
        name: "absolute file target",
        query: `kind=uml&target=file&path=${encodeURIComponent("/etc/passwd")}`,
        error: "path must be relative to the source root",
      },
      {
        name: "symlinked file target",
        query: "kind=uml&target=file&path=escape.ts",
        error: "symbolic links are not allowed",
      },
    ]) {
      const response = await fetch(`${base}/api/diagram?${forbidden.query}`);
      expect(response.status, forbidden.name).toBe(403);
      expect(await response.json(), forbidden.name).toEqual({ error: forbidden.error });
    }
  } finally {
    try {
      await server?.stop();
    } finally {
      await removeFixtureRoot(root);
      await rm(outerRoot, { recursive: true, force: true });
    }
  }
}, 60_000);
