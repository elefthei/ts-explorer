import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExplorerServer } from "../src/server.ts";
import { ExplorerStore } from "../src/store.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import {
  expectSnapshotResponse,
  readNormalizedGraphSnapshot,
  type NormalizedGraphSnapshot,
  type NormalizedSnapshotRecord,
} from "./support/normalized-sql.ts";
import type {
  DiagramResponse,
  FileResponse,
  GotoDefinition,
  PackageDiagramNode,
  SearchResponse,
  TreeNode,
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

function openDatabase<Value>(dbPath: string, operation: (db: Database) => Value): Value {
  const db = new Database(dbPath, { strict: true, readonly: true });
  try {
    return operation(db);
  } finally {
    db.close(true);
  }
}

function readActiveNormalizedSnapshot(
  dbPath: string,
  kind: NormalizedGraphSnapshot["kind"],
  scopePath: string,
): NormalizedGraphSnapshot {
  return openDatabase(dbPath, (db) => {
    const active = queryOne<{ generation_id: number }>(
      db,
      `
        SELECT CAST(value AS INTEGER) AS generation_id
        FROM cache_meta
        WHERE key = 'active_generation'
      `,
    );
    if (!active) throw new Error("active generation is missing");
    return readNormalizedGraphSnapshot(db, active.generation_id, kind, scopePath);
  });
}

function expectPromotedFallback(
  before: NormalizedGraphSnapshot,
  after: NormalizedGraphSnapshot,
  readyResponse: DiagramResponse,
  errorResponse: DiagramResponse,
  assertKindRows: (records: readonly NormalizedSnapshotRecord[]) => void,
): void {
  expect(readyResponse.status).toBe("ready");
  expect(errorResponse.status).toBe("error");
  expect(after.generationId).not.toBe(before.generationId);
  expect({ kind: after.kind, scopePath: after.scopePath }).toEqual({
    kind: before.kind,
    scopePath: before.scopePath,
  });
  expect(before.header).toEqual({ format_version: 1, render_mode: "normal" });
  expect(after.header).toEqual(before.header);
  expect(after.records).toEqual(before.records);
  expectSnapshotResponse(before, readyResponse);
  expectSnapshotResponse(after, errorResponse);
  expect({
    dsl: errorResponse.dsl,
    dsls: errorResponse.dsls,
    packageNodes: errorResponse.packageNodes,
    definitions: errorResponse.definitions,
    externalUsers: errorResponse.externalUsers,
    localUsers: errorResponse.localUsers,
  }).toEqual({
    dsl: readyResponse.dsl,
    dsls: readyResponse.dsls,
    packageNodes: readyResponse.packageNodes,
    definitions: readyResponse.definitions,
    externalUsers: readyResponse.externalUsers,
    localUsers: readyResponse.localUsers,
  });
  assertKindRows(before.records);
}
function createPromotionGate(): {
  first: Promise<void>;
  second: Promise<void>;
  notify(): void;
} {
  let count = 0;
  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
  return {
    first,
    second,
    notify() {
      count += 1;
      if (count === 1) resolveFirst();
      if (count === 2) resolveSecond();
    },
  };
}


function readActiveRootUmlFootprint(
  dbPath: string,
  entityNames: readonly [string, string],
): {
  nodes: Array<{ name: string }>;
  edges: Array<{ source_name: string; target_name: string }>;
} {
  return openDatabase(dbPath, (db) => {
    const active = queryOne<{ generation_id: number }>(
      db,
      `
        SELECT CAST(value AS INTEGER) AS generation_id
        FROM cache_meta
        WHERE key = 'active_generation'
      `,
    );
    if (!active) throw new Error("active generation is missing");
    return {
      nodes: queryAll<{ name: string }>(
        db,
        `
          SELECT name
          FROM diagram_nodes
          WHERE generation_id = ?
            AND kind = 'uml'
            AND scope_path = ''
            AND name IN (?, ?)
          ORDER BY node_ordinal
        `,
        active.generation_id,
        entityNames[0],
        entityNames[1],
      ),
      edges: queryAll<{ source_name: string; target_name: string }>(
        db,
        `
          SELECT source.name AS source_name, target.name AS target_name
          FROM diagram_edges AS edge
          JOIN diagram_nodes AS source
            ON source.generation_id = edge.generation_id
            AND source.kind = edge.kind
            AND source.scope_path = edge.scope_path
            AND source.node_id = edge.source_node_id
          JOIN diagram_nodes AS target
            ON target.generation_id = edge.generation_id
            AND target.kind = edge.kind
            AND target.scope_path = edge.scope_path
            AND target.node_id = edge.target_node_id
          WHERE edge.generation_id = ?
            AND edge.kind = 'uml'
            AND edge.scope_path = ''
            AND (
              source.name IN (?, ?)
              OR target.name IN (?, ?)
            )
          ORDER BY edge.edge_ordinal
        `,
        active.generation_id,
        entityNames[0],
        entityNames[1],
        entityNames[0],
        entityNames[1],
      ),
    };
  });
}

function withTimeout<Value>(promise: Promise<Value>, description: string, timeout = 10_000): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeout);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    }),
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


function assertReadOnlyNavigationAssets(html: string, mainScript: string): void {
  expect(html).toMatch(
    /\bid\s*=\s*["']packages-mode["'][\s\S]*\bid\s*=\s*["']uml-mode["'][\s\S]*\bid\s*=\s*["']editor-mode["']/i,
  );
  expect(html).toMatch(/\bid\s*=\s*["']editor-close["']/i);
  expect(html).not.toMatch(/\bid\s*=\s*["'](?:save-file|format-file|conflict-banner)["']/i);
  expect(html).not.toMatch(/\b(?:Save|Format|conflict)\b/i);

  const definitionResults =
    html.match(
      /<div\b(?=[^>]*\bid=["']definition-results["'])(?=[^>]*\brole=["']listbox["'])[^>]*>/gi,
    ) ?? [];
  expect(definitionResults).toHaveLength(1);
  const editorLoading =
    html.match(
      /<div\b(?=[^>]*\bid=["']editor-loading["'])(?=[^>]*\brole=["']status["'])(?=[^>]*\baria-live=["']polite["'])[^>]*>\s*Loading\.\.\.\s*<\/div>/gi,
    ) ?? [];
  expect(editorLoading).toHaveLength(1);
  expect(editorLoading[0]).toMatch(/\bhidden(?:\s|>)/i);

  const caseInsensitiveToggle =
    html.match(
      /<input\b(?=[^>]*\bid=["']search-case-insensitive["'])(?=[^>]*\btype=["']checkbox["'])[^>]*>/gi,
    ) ?? [];
  expect(caseInsensitiveToggle).toHaveLength(1);
  expect(caseInsensitiveToggle[0]).not.toMatch(/\bchecked\b/i);

  expect(mainScript).toMatch(/\.readOnly\.of\(true\)/);
  expect(mainScript).toMatch(/\.editable\.of\(false\)/);
  expect(mainScript).toContain("Read-only preprocessed source");
  expect(mainScript).not.toContain("/api/file/format");
  expect(mainScript).not.toMatch(/\bMod-s\b|method\s*:\s*["']PUT["']|conflict-banner/);

  expect(mainScript).toContain("/api/goto-definition?");
  expect(mainScript).toContain("/api/preprocess");
  expect(mainScript).toMatch(/method\s*:\s*["']POST["']/);
  expect(mainScript).toMatch(/action\s*:\s*["']prioritize["']/);
  const searchRequestIndex = mainScript.indexOf("/api/search?");
  expect(searchRequestIndex).toBeGreaterThanOrEqual(0);
  const searchRequest = mainScript.slice(Math.max(0, searchRequestIndex - 300), searchRequestIndex + 80);
  expect(searchRequest).toMatch(
    /new URLSearchParams\(\s*\{[\s\S]*?\bcaseInsensitive\s*:\s*String\([^)]*\)[\s\S]*?\}\s*\)/,
  );
  expect(mainScript).toMatch(/action\s*:\s*["']poll["']/);
  expect(mainScript).toMatch(
    /classList\.add\(\s*["']uml-definition-link["']\s*\)[\s\S]{0,240}setAttribute\(\s*["']role["']\s*,\s*["']link["']\s*\)/,
  );
  expect(mainScript).toMatch(
    /class\s*:\s*["']editor-definition-link["'][\s\S]{0,240}role\s*:\s*["']link["'][\s\S]{0,240}tabindex\s*:\s*["']0["']/,
  );
  expect(mainScript).toContain(" UML definition");
  expect(mainScript).toContain(" editor definition");
  expect(mainScript).toMatch(/path\s*:\s*\w+\.uml\.scopePath/);
  expect(mainScript).toMatch(/\w+\.source\.path\s*,\s*\w+\.source/);
  expect(
    (
      mainScript.match(
        /\w+\.key\s*!==\s*["']Enter["']\s*&&\s*\w+\.key\s*!==\s*["'] ["']/g,
      ) ?? []
    ).length,
  ).toBeGreaterThanOrEqual(2);

  const lookupIndex = mainScript.indexOf("/api/goto-definition?");
  const watchIndex = mainScript.indexOf('message.type === "cache-ready"', lookupIndex);
  expect(lookupIndex).toBeGreaterThanOrEqual(0);
  expect(watchIndex).toBeGreaterThan(lookupIndex);
  const definitionNavigation = mainScript.slice(lookupIndex, watchIndex);
  expect(definitionNavigation.match(/\.next\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(
    definitionNavigation.match(/if\s*\(\s*!\w+\([^)]*\)\s*\)\s*return/g)?.length ?? 0,
  ).toBeGreaterThanOrEqual(3);

  const stateDeclaration = mainScript.match(
    /(?:const|let|var)\s+(state\w*)\s*=\s*\{(?=[^;]*\bmode\s*:\s*["']packages["'])(?=[^;]*\bscope\s*:\s*["']{2})(?=[^;]*\bumlScope\s*:\s*["']{2})[^;]*\}\s*;/,
  );
  expect(stateDeclaration).not.toBeNull();
  const stateName = stateDeclaration?.[1] ?? "";
  const escapedState = stateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectScope = mainScript.match(
    /async function\s+(selectScope\w*)\([^)]*\)\s*\{[\s\S]*?(?=function\s+destroyEditor\w*\s*\()/,
  );
  expect(selectScope).not.toBeNull();
  const selectScopeName = selectScope?.[1] ?? "";
  const escapedSelectScope = selectScopeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(selectScope?.[0] ?? "").toMatch(
    new RegExp(
      String.raw`if\s*\(\s*${escapedState}\.mode\s*===\s*["']uml["']\s*\)\s*(?:\{\s*)?${escapedState}\.umlScope\s*=\s*[^;]+\.path\s*;`,
    ),
  );
  expect(mainScript).toMatch(
    new RegExp(
      String.raw`[A-Za-z_$][\w$]*\(\s*["']#packages-mode["']\s*\)\.onclick\s*=\s*\(\s*\)\s*=>\s*void\s+${escapedSelectScope}\(\s*\{\s*name\s*:\s*["']Packages["']\s*,\s*path\s*:\s*["']{2}\s*,\s*kind\s*:\s*["']directory["']\s*\}\s*,\s*["']packages["']\s*\)`,
    ),
  );
  expect(mainScript).toMatch(
    new RegExp(
      String.raw`[A-Za-z_$][\w$]*\(\s*["']#uml-mode["']\s*\)\.onclick\s*=\s*\(\s*\)\s*=>\s*void\s+${escapedSelectScope}\(\s*\{\s*name\s*:\s*["']Selected["']\s*,\s*path\s*:\s*${escapedState}\.umlScope\s*,\s*kind\s*:\s*["']directory["']\s*\}\s*,\s*["']uml["']\s*\)`,
    ),
  );

  const cacheRefresh = mainScript.match(
    /function\s+refreshCachedViews\w*\([^)]*\)\s*\{[\s\S]*?(?=function\s+handleWatch\w*\s*\()/,
  )?.[0] ?? "";
  expect(cacheRefresh).toMatch(/reloadOpenFile\w*\(\)/);
  expect(cacheRefresh).toMatch(/loadTree\w*\(\)/);
  expect(cacheRefresh).toMatch(/(?:commitSearch|loadDiagram)\w*\(/);
  expect(mainScript).toMatch(
    /if\s*\(\s*\w+\.type\s*===\s*["']cache-ready["']\s*\)\s*\{\s*refreshCachedViews\w*\(\)/,
  );
}

const { writeFixtureFile } = createFixtureTracker();

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
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-occupied-port-"));
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
      ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port }),
    ).rejects.toThrow();
    blocker.stop(true);
    blockerStopped = true;
    replacement = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port });
    await replacement.stop();
    replacement = undefined;
  } finally {
    if (!blockerStopped) blocker.stop(true);
    try {
      await replacement?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("concurrent stop calls share one promise and release the port", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-idempotent-stop-"));
  await writeFile(join(root, "index.ts"), "export const value=1\n");
  let server: ExplorerServer | undefined;
  let replacement: ExplorerServer | undefined;
  try {
    server = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const port = server.port;
    const firstStop = server.stop();
    const secondStop = server.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    server = undefined;

    replacement = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port });
    await replacement.stop();
    replacement = undefined;
  } finally {
    try {
      await replacement?.stop();
      await server?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("serves the subprocess-backed read-only API and non-Git literal search", async () => {
  const { outerRoot, root, sourceFile } = await createServerFixture();
  const server = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    const pageResponse = await fetch(`${base}/`);
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    const loading = html.match(/<div\b(?=[^>]*\bid=["']diagram-loading["'])[^>]*>/i)?.[0] ?? "";
    expect(loading).toMatch(/\brole=["']status["']/i);
    expect(loading).toMatch(/\baria-live=["']polite["']/i);
    expect(loading).toMatch(/\bhidden(?:\s|>)/i);

    const mainResponse = await fetch(`${base}/main.js`);
    expect(mainResponse.status).toBe(200);
    const mainScript = await mainResponse.text();
    assertReadOnlyNavigationAssets(html, mainScript);

    const tree = await withTimeout(
      fetch(`${base}/api/tree`).then(async (response) => {
        expect(response.status).toBe(200);
        return response.json() as Promise<{ version: number; root: TreeNode }>;
      }),
      "complete live filesystem tree",
      5_000,
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

    const packageDiagram = await (
      await fetch(`${base}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(packageDiagram.scopePath).toBe("");
    expect(packageDiagram.dsl).toContain("flowchart LR");
    expect(packageDiagram.packageNodes).toEqual([
      { nodeId: "p0", name: "demo", path: "packages/demo" },
    ] satisfies PackageDiagramNode[]);

    const rootUml = await (
      await fetch(`${base}/api/diagram?kind=uml&path=`)
    ).json() as DiagramResponse;
    expect(rootUml.scopePath).toBe("");
    expect(rootUml.dsl).toContain("classDiagram");

    const packageUml = await (
      await fetch(`${base}/api/diagram?kind=uml&path=packages%2Fdemo`)
    ).json() as DiagramResponse;
    expect(packageUml.scopePath).toBe("packages/demo");
    expect(packageUml.dsl).toMatch(
      /^[ \t]*DataflowRuntime[ \t]*-->[ \t]*AbstractStateMachine[ \t]*\r?$/m,
    );
    expect(packageUml.definitions).toEqual(expect.arrayContaining([
      indexedDefinitions[0],
      {
        key: '["class","AbstractStateMachine",0,null,null]',
        kind: "class",
        name: "AbstractStateMachine",
        qualifiedName: "AbstractStateMachine",
        source: {
          path: "packages/demo/src/machine.ts",
          line: 1,
          column: 14,
        },
        uml: {
          scopePath: "packages/demo/src/machine.ts",
          entityName: "AbstractStateMachine",
        },
      },
      {
        key: '["class","DataflowRuntime",0,null,null]',
        kind: "class",
        name: "DataflowRuntime",
        qualifiedName: "DataflowRuntime",
        source: {
          path: "packages/demo/src/runtime.ts",
          line: 2,
          column: 14,
        },
        uml: {
          scopePath: "packages/demo/src/runtime.ts",
          entityName: "DataflowRuntime",
        },
      },
    ]));
    expect(Object.hasOwn(packageUml, "sources")).toBe(false);
    expect(packageUml.packageNodes).toEqual([]);
    expect(Object.hasOwn(packageUml, "graph")).toBe(false);

    const scopedUml = await (
      await fetch(`${base}/api/diagram?kind=uml&path=packages%2Fdemo%2Fsrc%2Ftarget`)
    ).json() as DiagramResponse;
    expect(scopedUml.localUsers).toEqual([
      {
        nodeId: "local0",
        label: "local: packages/demo/src/target/local-user.ts: acceptWidget(Widget)",
        kind: "function",
        path: "packages/demo/src/target/local-user.ts",
        line: 2,
        column: 17,
      },
    ]);
    expect(scopedUml.externalUsers).toEqual([
      {
        nodeId: "extern0",
        label: "extern: packages/demo/src/consumer.ts: Consumer.build()",
        scopePath: "packages/demo/src/consumer.ts",
        kind: "method",
      },
    ]);
    expect(scopedUml.dsl).toContain(
      'class local0["local: packages/demo/src/target/local-user.ts<br/>acceptWidget(Widget)"]',
    );
    expect(scopedUml.dsl).toContain(
      'class extern0["extern: packages/demo/src/consumer.ts<br/>Consumer.build()"]',
    );

    const missingScope = await fetch(
      `${base}/api/diagram?kind=uml&path=packages%2Fdemo%2Fsrc%2Fmissing`,
    );
    expect(missingScope.status).toBe(404);
    expect(await missingScope.json()).toEqual({
      error: "cached uml diagram not found: packages/demo/src/missing",
    });

    const plainFileResponse = await fetch(`${base}/api/file?path=packages%2Fdemo%2Fsrc%2Findex.ts`);
    expect(plainFileResponse.status).toBe(200);
    expect(await plainFileResponse.json() as FileResponse).toEqual({
      path: "packages/demo/src/index.ts",
      content: "export const value = 1;\n",
      definitions: [],
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
    let polled = priority;
    for (let attempt = 0; attempt < 200 && polled.status !== "done"; attempt += 1) {
      const pollResponse = await fetch(`${base}/api/preprocess`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "poll", requestId: priority.requestId }),
      });
      expect(pollResponse.status).toBe(200);
      polled = await pollResponse.json() as typeof priority;
      expect(["queued", "processing", "done"]).toContain(polled.status);
      expect(polled.resource).toBe(indexedPath);
      expect(polled.requestId).toBe(priority.requestId);
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
      error: "only TypeScript and JavaScript source files can be viewed",
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
      await server.stop();
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  }
}, 60_000);

test("serves live add and remove trees before separately promoted APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-live-watch-"));
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
  const server = await ExplorerServer.start({
    sourceDir: root,
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
    await watch.waitFor(
      (message) => message.type === "cache-ready" && message.version === 0,
    );

    const addedChanged = watch.waitFor(
      (message) =>
        message.type === "changed" &&
        message.paths.includes("watched/added.ts") &&
        message.events.includes("add"),
    );
    await writeFile(addedFile, 'export const watchedToken="WATCHED_LIVE_TOKEN"\n');
    const addedMessage = await addedChanged;
    if (addedMessage.type !== "changed") throw new Error("expected added change");
    expect(watchBatches.filter(({ version }) => version === addedMessage.version)).toEqual([{
      paths: addedMessage.paths,
      events: addedMessage.events,
      version: addedMessage.version,
    }]);
    const addedTree = await withTimeout(
      fetch(`${base}/api/tree`).then(
        (response) => response.json() as Promise<{ root: TreeNode }>,
      ),
      "live tree after add",
      5_000,
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
    });

    const graphDbPath = join(root, ".explore", "explore.db");
    const entityNames = ["WatchedSource", "WatchedTarget"] as const;
    const presentFootprint = readActiveRootUmlFootprint(graphDbPath, entityNames);
    expect(presentFootprint.nodes.map(({ name }) => name).sort()).toEqual([...entityNames].sort());
    expect(
      presentFootprint.edges.map(({ source_name, target_name }) =>
        [source_name, target_name].sort()
      ),
    ).toContainEqual([...entityNames].sort());

    const modelRemovedChanged = watch.waitFor(
      (message) =>
        message.type === "changed" &&
        message.version > addedMessage.version &&
        message.paths.includes("watched/deleted-model.ts") &&
        message.events.includes("unlink"),
    );
    await rm(deletedModelFile);
    const modelRemovedMessage = await modelRemovedChanged;
    if (modelRemovedMessage.type !== "changed") throw new Error("expected model removal change");
    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === modelRemovedMessage.version,
    );
    expect(readActiveRootUmlFootprint(graphDbPath, entityNames)).toEqual({
      nodes: [],
      edges: [],
    });

    const removedChanged = watch.waitFor(
      (message) =>
        message.type === "changed" &&
        message.version > addedMessage.version &&
        message.paths.includes("watched/added.ts") &&
        message.events.includes("unlink"),
    );
    await rm(addedFile);
    const removedMessage = await removedChanged;
    if (removedMessage.type !== "changed") throw new Error("expected removed change");
    expect(watchBatches.filter(({ version }) => version === removedMessage.version)).toEqual([{
      paths: removedMessage.paths,
      events: removedMessage.events,
      version: removedMessage.version,
    }]);
    const removedTree = await withTimeout(
      fetch(`${base}/api/tree`).then(
        (response) => response.json() as Promise<{ root: TreeNode }>,
      ),
      "live tree after remove",
      5_000,
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
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60_000);

test("package diagram errors retain the last promoted snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-package-fallback-"));
  await writeFixtureFile(root, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  await writeFixtureFile(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "a", dependencies: { b: "*" } }),
  );
  await writeFixtureFile(root, "packages/b/package.json", JSON.stringify({ name: "b" }));

  const promotions = createPromotionGate();
  const store = new ExplorerStore(root, () => undefined, promotions.notify);
  try {
    await store.ready();
    await withTimeout(promotions.first, "initial cache promotion");
    const ready = await store.getDiagram("packages", "");
    expect(ready.status).toBe("ready");
    const graphDbPath = join(root, ".explore", "explore.db");
    const readySnapshot = readActiveNormalizedSnapshot(graphDbPath, "packages", "");

    await writeFile(join(root, "package.json"), "{ malformed");
    await withTimeout(promotions.second, "watch cache promotion");
    const failed = await store.getDiagram("packages", "");
    const failedSnapshot = readActiveNormalizedSnapshot(graphDbPath, "packages", "");
    expectPromotedFallback(
      readySnapshot,
      failedSnapshot,
      ready,
      failed,
      (records) => {
        expect(records).toEqual([
          {
            table: "diagram_nodes",
            kind: "packages",
            scope_path: "",
            node_id: "p0",
            node_ordinal: 0,
            node_kind: "package",
            name: "a",
            community: null,
          },
          {
            table: "diagram_nodes",
            kind: "packages",
            scope_path: "",
            node_id: "p1",
            node_ordinal: 1,
            node_kind: "package",
            name: "b",
            community: null,
          },
          {
            table: "diagram_edges",
            kind: "packages",
            scope_path: "",
            edge_ordinal: 0,
            source_node_id: "p0",
            target_node_id: "p1",
            edge_kind: "package-dependency",
            directed: 1,
            weight: 1,
          },
          {
            table: "diagram_edge_relations",
            kind: "packages",
            scope_path: "",
            edge_ordinal: 0,
            relation_ordinal: 0,
            relation_kind: "package-dependency",
            source_node_id: "p0",
            target_node_id: "p1",
          },
          {
            table: "package_graph_nodes",
            kind: "packages",
            scope_path: "",
            node_id: "p0",
            package_path: "packages/a",
          },
          {
            table: "package_graph_nodes",
            kind: "packages",
            scope_path: "",
            node_id: "p1",
            package_path: "packages/b",
          },
        ]);
      },
    );
  } finally {
    try {
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("UML extraction errors retain the last promoted normalized graph and response", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-fallback-"));
  await writeFixtureFile(root, "package.json", JSON.stringify({ name: "uml-fallback" }));
  await writeFixtureFile(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
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

  const promotions = createPromotionGate();
  const store = new ExplorerStore(root, () => undefined, promotions.notify);
  try {
    await store.ready();
    await withTimeout(promotions.first, "initial UML cache promotion");
    const ready = await store.getDiagram("uml", "");
    expect(ready.status).toBe("ready");
    expect(ready.dsl).toContain("FallbackSource");
    expect(ready.dsl).toContain("FallbackTarget");

    const graphDbPath = join(root, ".explore", "explore.db");
    const readySnapshot = readActiveNormalizedSnapshot(graphDbPath, "uml", "");

    await writeFile(join(root, "tsconfig.json"), "{ malformed");
    await withTimeout(promotions.second, "failed UML cache promotion");
    const failed = await store.getDiagram("uml", "");
    await store.close();

    const failedSnapshot = readActiveNormalizedSnapshot(graphDbPath, "uml", "");
    expectPromotedFallback(
      readySnapshot,
      failedSnapshot,
      ready,
      failed,
      (records) => {
        const nodes = records.filter((record) => record.table === "diagram_nodes");
        expect(
          nodes.map(({ node_ordinal, node_kind, name, community }) => ({
            node_ordinal,
            node_kind,
            name,
            community,
          })),
        ).toEqual([
          { node_ordinal: 1, node_kind: "entity", name: "FallbackSource", community: 0 },
          { node_ordinal: 0, node_kind: "entity", name: "FallbackTarget", community: 0 },
        ]);
        const nodeNames = new Map(nodes.map(({ node_id, name }) => [node_id, name]));
        expect(
          records
            .filter((record) => record.table === "diagram_edges")
            .map(({
              edge_ordinal,
              source_node_id,
              target_node_id,
              edge_kind,
              directed,
              weight,
            }) => ({
              edge_ordinal,
              source_name: nodeNames.get(source_node_id),
              target_name: nodeNames.get(target_node_id),
              edge_kind,
              directed,
              weight,
            })),
        ).toEqual([
          {
            edge_ordinal: 0,
            source_name: "FallbackSource",
            target_name: "FallbackTarget",
            edge_kind: "uml-relation",
            directed: 0,
            weight: 1,
          },
        ]);
        expect(
          records
            .filter((record) => record.table === "uml_declarations")
            .map(({
              kind,
              scope_path,
              declaration_ordinal,
              file_name,
              member_associations_present,
            }) => ({
              kind,
              scope_path,
              declaration_ordinal,
              file_name: file_name.replace(/^.*[\\/]/, ""),
              member_associations_present,
            })),
        ).toEqual([
          {
            kind: "uml",
            scope_path: "",
            declaration_ordinal: 0,
            file_name: "model.ts",
            member_associations_present: 1,
          },
        ]);
        expect(
          records
            .filter((record) => record.table === "uml_entities")
            .map(({ declaration_ordinal, entity_kind, entity_ordinal, node_id }) => ({
              declaration_ordinal,
              entity_kind,
              entity_ordinal,
              name: nodeNames.get(node_id),
            })),
        ).toEqual([
          {
            declaration_ordinal: 0,
            entity_kind: "class",
            entity_ordinal: 0,
            name: "FallbackTarget",
          },
          {
            declaration_ordinal: 0,
            entity_kind: "class",
            entity_ordinal: 1,
            name: "FallbackSource",
          },
        ]);
      },
    );
  } finally {
    try {
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 30_000);

test("a malformed root manifest produces the stable empty package error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-malformed-root-"));
  await writeFile(join(root, "package.json"), "{ malformed");
  const store = new ExplorerStore(root);
  try {
    await store.ready();
    const response = await store.getDiagram("packages", "");
    expect(response.status).toBe("error");
    expect(response.dsl).toBe("flowchart LR");
    expect(response.dsls).toEqual(["flowchart LR"]);
    expect(response.packageNodes).toEqual([]);
  } finally {
    try {
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("warm restart trusts recovered package graph until a live change rebuilds it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-package-restart-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await mkdir(join(root, "packages", "a"), { recursive: true });
  const packageAManifest = join(root, "packages", "a", "package.json");
  await writeFile(packageAManifest, JSON.stringify({ name: "a" }));

  let firstServer: RunningServer | undefined;
  let secondServer: RunningServer | undefined;
  let watch: WatchClient | undefined;
  try {
    firstServer = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const firstBase = `http://127.0.0.1:${firstServer.port}`;
    const firstWatch = await openWatch(firstBase);
    try {
      await firstWatch.waitFor(
        (message) => message.type === "cache-ready" && message.version === 0,
      );
    } finally {
      await firstWatch.close();
    }
    const firstDiagram = await (
      await fetch(`${firstBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(firstDiagram.packageNodes).toEqual([
      { nodeId: "p0", name: "a", path: "packages/a" },
    ]);
    const dbPath = join(root, ".explore", "explore.db");
    const recoveredId = readActiveNormalizedSnapshot(dbPath, "packages", "").generationId;

    await firstServer.stop();
    firstServer = undefined;

    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b" }));
    await writeFile(
      packageAManifest,
      JSON.stringify({ name: "a", dependencies: { b: "*" } }),
    );

    secondServer = await ExplorerServer.start({ sourceDir: root, host: "127.0.0.1", port: 0 });
    const secondBase = `http://127.0.0.1:${secondServer.port}`;
    watch = await openWatch(secondBase);
    await watch.waitFor((message) => message.type === "cache-ready" && message.version === 0);
    expect(watch.history()).toContainEqual({ type: "cache-ready", version: 0 });

    const recoveredDiagram = await (
      await fetch(`${secondBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(recoveredDiagram).toEqual(firstDiagram);
    expect(readActiveNormalizedSnapshot(dbPath, "packages", "").generationId).toBe(recoveredId);
    expect(openDatabase(dbPath, (db) =>
      queryAll<{ id: number; state: string; cause: string }>(
        db,
        "SELECT id, state, cause FROM generations ORDER BY id",
      )
    )).toEqual([{ id: recoveredId, state: "active", cause: "startup" }]);

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
    expect(changedMessage.version).toBe(1);
    await watch.waitFor(
      (message) =>
        message.type === "cache-ready" && message.version === changedMessage.version,
    );

    const rebuiltDiagram = await (
      await fetch(`${secondBase}/api/diagram?kind=packages&path=`)
    ).json() as DiagramResponse;
    expect(rebuiltDiagram.packageNodes).toEqual([
      { nodeId: "p0", name: "a", path: "packages/a" },
      { nodeId: "p1", name: "b", path: "packages/b" },
    ]);
    expect(rebuiltDiagram.dsl).toContain("p0 --> p1");
    expect(rebuiltDiagram.dsl).not.toBe(firstDiagram.dsl);
    const rebuiltId = readActiveNormalizedSnapshot(dbPath, "packages", "").generationId;
    expect(rebuiltId).not.toBe(recoveredId);
    expect(openDatabase(dbPath, (db) =>
      queryAll<{ id: number; state: string; cause: string }>(
        db,
        "SELECT id, state, cause FROM generations ORDER BY id",
      )
    )).toEqual([{ id: rebuiltId, state: "active", cause: "watch" }]);
  } finally {
    try {
      await watch?.close();
      await secondServer?.stop();
      await firstServer?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60_000);
