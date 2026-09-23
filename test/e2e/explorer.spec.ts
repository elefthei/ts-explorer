import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type TestInfo,
  type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  DiagramResponse,
  SearchResponse,
  WatchMessage,
} from "../../src/types.ts";
import { withBound } from "../support/async.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputTailLimit = 64 * 1024;
const bindErrorPattern = /EADDRINUSE|port\b.*\bin use/i;
// A server that is listening but has not finished its first accept answers with an invalid or
// empty response, not a refusal; both are "not ready yet", so the 30-second loop must retry them.
const retryableNavigationPattern =
  /ERR_CONNECTION_(?:REFUSED|RESET)|ERR_(?:INVALID_HTTP_RESPONSE|EMPTY_RESPONSE)|page\.goto: Timeout \d+ms exceeded/;

type CliChild = ChildProcessByStdio<null, Readable, Readable>;
type CliExit = { code: number | null; signal: NodeJS.Signals | null };

type SpawnedCli = {
  child: CliChild;
  port: number;
  stdout: OutputTail;
  stderr: OutputTail;
  exitPromise: Promise<CliExit>;
  readonly cliExited: boolean;
  readonly spawnError: Error | undefined;
};

type TestResource = {
  fixtureRoot?: string;
  context?: BrowserContext;
  page?: Page;
  clis: SpawnedCli[];
  cleanupPromise?: Promise<void>;
};

type PrintCounterWindow = Window & { printCalls?: number };
type RepaintFlagWindow = Window & { umlRepaintSuperseded?: boolean };
type DiagramWorkerProbeWindow = Window & {
  Worker: typeof Worker;
  __e2eLayoutStarted?: boolean;
  __e2eNativeWorker?: typeof Worker;
};

class OutputTail {
  private bytes = Buffer.alloc(0);

  append(chunk: string | Buffer): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes = Buffer.concat([this.bytes, next]);
    if (this.bytes.length > outputTailLimit) {
      this.bytes = this.bytes.subarray(this.bytes.length - outputTailLimit);
    }
  }

  text(): string {
    return this.bytes.toString("utf8");
  }
}

const resources = new Set<TestResource>();

function describeCli(cli: SpawnedCli): string {
  const exit = cli.child.exitCode !== null
    ? `exit code ${cli.child.exitCode}`
    : cli.child.signalCode !== null
      ? `signal ${cli.child.signalCode}`
      : cli.spawnError
        ? `spawn error: ${cli.spawnError.message}`
        : "process still running";
  return [
    `CLI ${exit}`,
    `stdout tail:\n${cli.stdout.text() || "<empty>"}`,
    `stderr tail:\n${cli.stderr.text() || "<empty>"}`,
  ].join("\n");
}

function hasExited(cli: SpawnedCli): boolean {
  return cli.cliExited || cli.child.exitCode !== null || cli.child.signalCode !== null;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("loopback port reservation did not return a TCP address");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function spawnCli(fixtureRoot: string, port: number): SpawnedCli {
  const child: CliChild = spawn(
    "bun",
    [
      "run",
      "src/cli.ts",
      fixtureRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));

  let cliExited = false;
  let spawnError: Error | undefined;
  const exitPromise = new Promise<CliExit>((resolve) => {
    child.once("exit", (code, signal) => {
      cliExited = true;
      resolve({ code, signal });
    });
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  return {
    child,
    port,
    stdout,
    stderr,
    exitPromise,
    get cliExited() {
      return cliExited;
    },
    get spawnError() {
      return spawnError;
    },
  };
}

async function runTaskkill(pid: number): Promise<number | null> {
  const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  taskkill.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  taskkill.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  const completion = new Promise<number | null>((resolve, reject) => {
    taskkill.once("error", reject);
    taskkill.once("exit", (code) => resolve(code));
  });
  try {
    return await withBound(completion, 5_000, `taskkill process tree ${pid}`);
  } catch (error) {
    taskkill.kill();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `taskkill stdout tail:\n${stdout.text() || "<empty>"}\n` +
      `taskkill stderr tail:\n${stderr.text() || "<empty>"}`,
    );
  }
}

async function reapCli(cli: SpawnedCli): Promise<void> {
  if (hasExited(cli)) return;
  const pid = cli.child.pid;
  if (pid === undefined) {
    if (cli.spawnError) return;
    throw new Error(`CLI has no pid and emitted no spawn error\n${describeCli(cli)}`);
  }

  if (process.platform === "win32") {
    let taskkillCode: number | null | undefined;
    let taskkillError: unknown;
    try {
      taskkillCode = await runTaskkill(pid);
    } catch (error) {
      taskkillError = error;
    }

    let exitError: unknown;
    try {
      await withBound(cli.exitPromise, 5_000, `CLI ${pid} exit after taskkill`);
    } catch (error) {
      exitError = error;
    }
    const exited = hasExited(cli);
    const failures: unknown[] = [];
    if (taskkillError) failures.push(taskkillError);
    if (taskkillCode !== undefined && taskkillCode !== 0 && !exited) {
      failures.push(new Error(`taskkill exited with code ${taskkillCode}`));
    }
    if (exitError && !exited) failures.push(exitError);
    if (!exited) failures.push(new Error(`CLI ${pid} did not exit`));
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to reap CLI process tree ${pid}\n${describeCli(cli)}`);
    }
    return;
  }

  try {
    cli.child.kill("SIGTERM");
  } catch (error) {
    if (!hasExited(cli)) throw error;
  }
  try {
    await withBound(cli.exitPromise, 5_000, `CLI ${pid} exit after SIGTERM`);
    return;
  } catch {
    if (hasExited(cli)) return;
  }
  try {
    cli.child.kill("SIGKILL");
  } catch (error) {
    if (!hasExited(cli)) throw error;
  }
  await withBound(cli.exitPromise, 5_000, `CLI ${pid} exit after SIGKILL`);
}

function registerResource(): TestResource {
  const resource: TestResource = { clis: [] };
  resources.add(resource);
  return resource;
}

async function openPage(browser: Browser, resource: TestResource): Promise<Page> {
  resource.context = await browser.newContext();
  resource.page = await resource.context.newPage();
  return resource.page;
}

async function openUmlFixturePage(
  browser: Browser,
  resource: TestResource,
  readyDescription: string,
): Promise<{ page: Page; watch: CacheReadyWatch; fixtureRoot: string }> {
  const fixtureRoot = await createUmlFixture(resource);
  const page = await openPage(browser, resource);
  const watch = watchCacheReady(page);
  await navigateToCli(page, fixtureRoot, resource);
  await expect(treeRow(page, "feature")).toBeVisible({ timeout: 15_000 });
  await withBound(watch.cacheReady, 60_000, readyDescription);
  return { page, watch, fixtureRoot };
}

function cleanupResource(resource: TestResource): Promise<void> {
  if (resource.cleanupPromise) return resource.cleanupPromise;
  resource.cleanupPromise = (async () => {
    const failures: unknown[] = [];
    const browserCleanup = await Promise.allSettled([
      resource.page
        ? withBound(resource.page.close(), 3_000, "Playwright page close")
        : Promise.resolve(),
      resource.context
        ? withBound(resource.context.close(), 3_000, "Playwright context close")
        : Promise.resolve(),
    ]);
    for (const result of browserCleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    const cliCleanup = await Promise.allSettled(resource.clis.map((cli) => reapCli(cli)));
    for (const result of cliCleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    const allClisReaped = resource.clis.every(
      (cli) => hasExited(cli) || (cli.child.pid === undefined && cli.spawnError !== undefined),
    );
    if (resource.fixtureRoot && allClisReaped) {
      try {
        await rm(resource.fixtureRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (error) {
        failures.push(error);
      }
    } else if (resource.fixtureRoot) {
      failures.push(new Error(`refusing to remove fixture before every CLI was reaped: ${resource.fixtureRoot}`));
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "E2E resource cleanup failed");
    }
  })();
  return resource.cleanupPromise;
}

async function cleanupAll(): Promise<void> {
  const pending = [...resources];
  const results = await Promise.allSettled(pending.map((resource) => cleanupResource(resource)));
  pending.forEach((resource) => {
    resources.delete(resource);
  });
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "E2E cleanup failed");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT_SOURCE = [
  'import { B } from "./b";',
  "export class Root {",
  "  value: B;",
  "  run(): B { return new B(); }",
  "}",
  "export class Isolated {}",
  "",
].join("\n");

/**
 * The rooted-UML fixture: one outgoing chain with a cycle (`Root -> B <-> C`), an isolated root,
 * files that are only importers, a test file, a JavaScript pair and a class whose name and member
 * type are full of Mermaid-special characters.
 */
async function createUmlFixture(resource: TestResource): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-uml-e2e-"));
  resource.fixtureRoot = fixtureRoot;
  await Promise.all([
    mkdir(join(fixtureRoot, "feature")),
    mkdir(join(fixtureRoot, "shared")),
  ]);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "uml-e2e", private: true })}\n`,
    "feature/root.ts": ROOT_SOURCE,
    "feature/b.ts": ['import { C } from "../shared/c";', "export class B { value: C; }", ""].join("\n"),
    "feature/boxed.ts": [
      "export class Box<TValue> {",
      "  entries: Record<string, { value: TValue }>;",
      "}",
      "",
    ].join("\n"),
    "feature/side-effect.ts": ['import "../shared/extra";', "export const sideEffect = true;", ""].join("\n"),
    "feature/root.test.ts": ['import { Root } from "./root";', "export const spec = new Root();", ""].join("\n"),
    "shared/c.ts": [
      'import { B } from "../feature/b";',
      'import { extra } from "./extra";',
      "export class C { value: B; }",
      "export const useExtra = extra;",
      "",
    ].join("\n"),
    "shared/extra.ts": "export const extra = 1;\n",
    "consumer.ts": ['import { Root } from "./feature/root";', "export class Consumer { value: Root; }", ""].join("\n"),
    "unrelated.ts": "export class Unrelated {}\n",
    "empty.ts": "",
    "helper.js": "export function helper(value) { return value + 1; }\n",
    "caller.js": ['import { helper } from "./helper.js";', "export function caller(n) { return helper(n); }", ""].join("\n"),
  };
  await Promise.all(
    Object.entries(files).map(([path, content]) => writeFile(join(fixtureRoot, path), content)),
  );
  return fixtureRoot;
}

async function createNestedPackagesFixture(resource: TestResource): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-packages-e2e-"));
  resource.fixtureRoot = fixtureRoot;
  await mkdir(join(fixtureRoot, "junco-runtime", "packages", "demo"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(
      join(fixtureRoot, "package.json"),
      JSON.stringify({ private: true, workspaces: ["junco-runtime/packages/*"] }),
    ),
    writeFile(
      join(fixtureRoot, "junco-runtime", "packages", "demo", "package.json"),
      JSON.stringify({ name: "junco-runtime-demo" }),
    ),
    writeFile(
      join(fixtureRoot, "junco-runtime", "packages", "demo", "index.ts"),
      "export class JuncoRuntimeDemo {}\n",
    ),
  ]);
  return fixtureRoot;
}

/** A deliberately slow project: the tree must paint long before the cache finishes. */
async function createBulkFixture(resource: TestResource): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-e2e-"));
  resource.fixtureRoot = fixtureRoot;
  await writeFile(
    join(fixtureRoot, "marker.ts"),
    'export const marker = "TREE_READY_BEFORE_CACHE";\n',
  );
  await Promise.all([
    mkdir(join(fixtureRoot, "z-late")),
    mkdir(join(fixtureRoot, "zz-stale")),
  ]);
  await Promise.all([
    writeFile(
      join(fixtureRoot, "00-ready.ts"),
      [
        "export class ImmediateDefinition {",
        '  ping(): string { return "ready"; }',
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(fixtureRoot, "z-late", "late-definition.ts"),
      [
        "export class LateDefinition {",
        "  resolve(value: string): string { return value; }",
        "}",
        ...Array.from(
          { length: 2_000 },
          (_, index) => `export const latePadding${index} = ${index};`,
        ),
        "",
      ].join("\n"),
    ),
    writeFile(
      join(fixtureRoot, "zz-stale", "stale-definition.ts"),
      [
        "export class StaleDefinition {",
        '  value(): string { return "stale"; }',
        "}",
        ...Array.from(
          { length: 3_000 },
          (_, index) => `export const stalePadding${index} = ${index};`,
        ),
        "",
      ].join("\n"),
    ),
  ]);
  await Promise.all(
    Array.from({ length: 24 }, (_, directoryIndex) =>
      mkdir(join(fixtureRoot, `bulk-${directoryIndex.toString().padStart(2, "0")}`)),
    ),
  );
  const genericFixture = [
    "export interface SessionStorage<TMetadata> {",
    "  metadata: TMetadata;",
    "}",
    "export class DurableSessionStorage implements SessionStorage<string> {",
    '  metadata = "";',
    "}",
    "export class JuncoAgent<TSkill, TTool, Ctx> {",
    "  skill!: TSkill;",
    "  tool!: TTool;",
    "  context!: Ctx;",
    "}",
    "",
  ].join("\n");
  await Promise.all(
    Array.from({ length: 24 }, (_, directoryIndex) =>
      Array.from({ length: 10 }, (_, fileIndex) => {
        const directory = directoryIndex.toString().padStart(2, "0");
        const file = fileIndex.toString().padStart(2, "0");
        const value = directoryIndex === 23 && fileIndex === 9
          ? "E2E_UNIQUE_SEARCH_TOKEN"
          : `bulk-${directory}-generated-${file}`;
        return writeFile(
          join(fixtureRoot, `bulk-${directory}`, `generated-${file}.ts`),
          `${directoryIndex === 0 && fileIndex === 0 ? genericFixture : ""}export const generated_${directory}_${file} = ${JSON.stringify(value)};\n`,
        );
      }),
    ).flat(),
  );
  return fixtureRoot;
}

/**
 * 23 x 23 distinct import pairs inside `graph/`: 529 edges, comfortably past Mermaid's default
 * limit of 500 and heavy enough that its layout solve is worth interrupting. Package creation
 * stays with the caller so the same graph can be dropped into any fixture.
 */
async function addDenseImportFixture(fixtureRoot: string): Promise<{
  expectedNodes: string[];
  edgeCount: number;
}> {
  await mkdir(join(fixtureRoot, "graph"), { recursive: true });
  const leaves = Array.from({ length: 23 }, (_, index) => `leaf${String(index).padStart(2, "0")}`);
  const hubs = Array.from({ length: 23 }, (_, index) => `hub${String(index).padStart(2, "0")}`);
  await Promise.all([
    ...leaves.map((leaf, index) =>
      writeFile(join(fixtureRoot, "graph", `${leaf}.ts`), `export const ${leaf} = ${index};\n`)
    ),
    ...hubs.map((hub) =>
      writeFile(
        join(fixtureRoot, "graph", `${hub}.ts`),
        [
          ...leaves.map((leaf) => `import { ${leaf} } from "./${leaf}.ts";`),
          `export const ${hub} = [${leaves.join(", ")}];`,
          "",
        ].join("\n"),
      )
    ),
  ]);
  return {
    expectedNodes: [...hubs, ...leaves].map((name) => `graph/${name}.ts`).sort(),
    edgeCount: leaves.length * hubs.length,
  };
}

// ---------------------------------------------------------------------------
// Watcher + CLI helpers
// ---------------------------------------------------------------------------

function isWatchMessage(value: unknown): value is WatchMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== "number" || typeof candidate.type !== "string") return false;
  if (candidate.type === "cache-ready") return true;
  if (candidate.type === "watch-error") return typeof candidate.error === "string";
  return candidate.type === "changed" &&
    Array.isArray(candidate.paths) && candidate.paths.every((path) => typeof path === "string") &&
    Array.isArray(candidate.events) && candidate.events.every((event) => typeof event === "string");
}

type CacheReadyWatch = {
  history: readonly WatchMessage[];
  cacheReady: Promise<WatchMessage>;
};

function watchCacheReady(page: Page): CacheReadyWatch {
  const history: WatchMessage[] = [];
  let settled = false;
  let resolveReady!: (message: WatchMessage) => void;
  let rejectReady!: (error: Error) => void;
  const cacheReady = new Promise<WatchMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void cacheReady.catch(() => undefined);

  const rejectPrematurely = (description: string) => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(description));
  };
  const acceptFrame = (payload: string | Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : payload);
    } catch {
      return;
    }
    if (!isWatchMessage(parsed)) return;
    history.push(parsed);
    if (!settled && parsed.type === "cache-ready") {
      settled = true;
      resolveReady(parsed);
    }
  };
  const attach = (socket: PlaywrightWebSocket) => {
    let pathname: string;
    try {
      pathname = new URL(socket.url()).pathname;
    } catch {
      return;
    }
    if (pathname !== "/ws") return;
    socket.on("framereceived", (event) => acceptFrame(event.payload));
    socket.on("socketerror", (error) => rejectPrematurely(`watch websocket error: ${error}`));
    socket.on("close", () => rejectPrematurely("watch websocket closed before cache-ready"));
    const retained = history.find((message) => message.type === "cache-ready");
    if (!settled && retained) {
      settled = true;
      resolveReady(retained);
    }
  };
  page.on("websocket", attach);
  return { history, cacheReady };
}

async function navigateToCli(
  page: Page,
  fixtureRoot: string,
  resource: TestResource,
): Promise<string> {
  const deadline = performance.now() + 30_000;
  let cli: SpawnedCli | undefined;
  let base = "";
  let bindAttempts = 0;

  while (performance.now() < deadline) {
    if (!cli) {
      if (bindAttempts >= 3) throw new Error("CLI exhausted three loopback bind attempts");
      bindAttempts += 1;
      const port = await reserveLoopbackPort();
      cli = spawnCli(fixtureRoot, port);
      resource.clis.push(cli);
      base = `http://127.0.0.1:${port}`;
    }

    if (cli.spawnError || hasExited(cli)) {
      const details = describeCli(cli);
      if (bindErrorPattern.test(cli.stderr.text()) && bindAttempts < 3) {
        await reapCli(cli);
        cli = undefined;
        continue;
      }
      throw new Error(`CLI exited before navigation\n${details}`);
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      const response = await page.goto(base, {
        waitUntil: "commit",
        timeout: Math.min(2_000, remaining),
      });
      if (response === null) throw new Error("navigation committed without an HTTP response");
      if (response.status() !== 200) {
        throw new Error(`navigation returned HTTP ${response.status()}\n${describeCli(cli)}`);
      }
      return base;
    } catch (error) {
      if (cli.spawnError || hasExited(cli)) {
        const details = describeCli(cli);
        if (bindErrorPattern.test(cli.stderr.text()) && bindAttempts < 3) {
          await reapCli(cli);
          cli = undefined;
          continue;
        }
        throw new Error(`CLI exited during navigation\n${details}`, { cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!retryableNavigationPattern.test(message)) throw error;
      const retryDelay = Math.min(50, Math.max(0, deadline - performance.now()));
      if (retryDelay > 0) await delay(retryDelay);
    }
  }

  throw new Error(`CLI did not accept navigation within 30 seconds\n${cli ? describeCli(cli) : "CLI was not spawned"}`);
}

async function expectCliOutput(
  cli: SpawnedCli,
  expected: string,
  timeout: number,
): Promise<void> {
  await expect.poll(
    () => cli.stdout.text(),
    {
      message: `CLI output containing ${JSON.stringify(expected)}\n${describeCli(cli)}`,
      timeout,
    },
  ).toContain(expected);
}

// ---------------------------------------------------------------------------
// Response gating
// ---------------------------------------------------------------------------

type ResponseGate = {
  handler(route: Route): Promise<void>;
  /** Resolves once a matching response has been fetched from the server and is being held. */
  captured: Promise<void>;
  /** Resolves once the held response has been delivered to the page. */
  finished: Promise<void>;
  release(): void;
};

/** Holds the *first* matching response; every later request passes straight through. */
function createResponseGate(matches: (url: URL) => boolean): ResponseGate {
  const captured = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let held = false;
  return {
    captured: captured.promise,
    finished: finished.promise,
    release: () => released.resolve(),
    async handler(route: Route): Promise<void> {
      if (held || !matches(new URL(route.request().url()))) {
        await route.continue();
        return;
      }
      held = true;
      const response = await route.fetch();
      captured.resolve();
      await released.promise;
      await route.fulfill({ response });
      finished.resolve();
    },
  };
}

function isUmlDiagramUrl(url: URL, target: string, path: string): boolean {
  return url.pathname === "/api/diagram" &&
    url.searchParams.get("kind") === "uml" &&
    url.searchParams.get("target") === target &&
    url.searchParams.get("path") === path;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function treeRow(page: Page, path: string) {
  return page.locator(`.tree-row[data-tree-path="${path}"]`);
}

function treeToggle(page: Page, path: string) {
  return page.locator(`.tree-toggle[data-tree-path="${path}"]`);
}

function definitionRow(page: Page, path: string, qualifiedName: string) {
  return page
    .locator(`.tree-definition-row[data-source-path="${path}"]`)
    .filter({
      has: page.locator(".tree-definition-name", { hasText: new RegExp(`^${qualifiedName}$`) }),
    });
}

function definitionNames(page: Page, path: string) {
  return page.locator(`.tree-definition-row[data-source-path="${path}"] .tree-definition-name`);
}

function outlineMessage(page: Page, path: string) {
  return page.locator(`.tree-definitions[aria-label="Definitions in ${path}"] .tree-definition-message`);
}

/** Expansion is chevron-only: a label click never changes it. */
async function expandTree(page: Page, path: string): Promise<void> {
  const toggle = treeToggle(page, path);
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function collapseTree(page: Page, path: string): Promise<void> {
  const toggle = treeToggle(page, path);
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

/** Expands a file through its chevron, then opens Editor by double-clicking one definition. */
async function openDefinitionSource(
  page: Page,
  filePath: string,
  qualifiedName: string,
): Promise<void> {
  await expandTree(page, filePath);
  const row = definitionRow(page, filePath, qualifiedName);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.dblclick();
}

async function readDefinitionKey(
  page: Page,
  path: string,
  qualifiedName: string,
): Promise<string> {
  const key = await page.evaluate(async (request) => {
    const response = await fetch(
      `/api/file-definitions?${new URLSearchParams({ path: request.path })}`,
    );
    const body = await response.json() as {
      definitions: { key: string; qualifiedName: string }[];
    };
    return body.definitions.find(
      (definition) => definition.qualifiedName === request.qualifiedName,
    )?.key ?? null;
  }, { path, qualifiedName });
  if (key === null) throw new Error(`${qualifiedName} is not indexed in ${path}`);
  return key;
}

// ---------------------------------------------------------------------------
// Diagram helpers
// ---------------------------------------------------------------------------

function frameHeadings(page: Page) {
  return page.locator("#svg-holder .uml-frame .uml-frame-heading");
}

function definitionLink(page: Page, qualifiedName: string) {
  return page.locator(
    `#svg-holder [data-diagram-link][aria-label="Select ${qualifiedName}; double-click to open its source"]`,
  );
}

/**
 * Tags the SVG node a gesture is about to press. A repaint replaces the whole `#svg-holder`, so
 * the marker disappearing is proof that the pressed node is no longer under the pointer.
 */
async function markPressedLink(page: Page, qualifiedName: string): Promise<void> {
  await page.evaluate((label) => {
    document
      .querySelector(`#svg-holder [data-diagram-link][aria-label="${label}"]`)
      ?.setAttribute("data-pressed-link", "1");
  }, `Select ${qualifiedName}; double-click to open its source`);
  await expect(page.locator("[data-pressed-link]")).toHaveCount(1);
}

/** Node identities as painted, sorted so a layout order change cannot break the assertion. */
function diagramNodeNames(page: Page, frameIndex?: number): Promise<string[]> {
  return page.evaluate((index) => {
    const scope = index === undefined
      ? document.querySelector("#svg-holder")
      : document.querySelectorAll(".uml-frame")[index];
    if (!scope) return [];
    return [...scope.querySelectorAll("g.node")]
      .map((node) => {
        const label = node.querySelector(".label-group .label")
          ?? node.querySelector(".nodeLabel")
          ?? node;
        return (label.textContent ?? "").trim();
      })
      .sort();
  }, frameIndex);
}

/** The painted outline of every definition box; the selected root is drawn thicker. */
function definitionNodeOutlines(page: Page): Promise<
  { name: string; root: boolean; strokeWidth: string }[]
> {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>("#svg-holder g.node")].map((node) => {
      const shape = [...node.querySelectorAll<SVGPathElement>(".label-container > path")].at(-1);
      return {
        name: (node.querySelector(".label-group .label")?.textContent ?? "").trim(),
        root: node.classList.contains("rootNode"),
        strokeWidth: shape ? getComputedStyle(shape).strokeWidth : "",
      };
    })
  );
}

function fileNodeOutlines(page: Page): Promise<
  { path: string; boundary: boolean; test: boolean; dashed: boolean }[]
> {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>("#svg-holder g.node")].map((node) => {
      const shape = node.querySelector<SVGGraphicsElement>("rect, path, polygon");
      return {
        path: (node.querySelector(".nodeLabel")?.textContent ?? "").trim(),
        boundary: node.classList.contains("boundaryFile"),
        test: node.classList.contains("testFile"),
        dashed: shape ? getComputedStyle(shape).strokeDasharray !== "none" : false,
      };
    })
  );
}

function afterTwoAnimationFrames(page: Page): Promise<void> {
  return page.evaluate(() =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })
  );
}

/** Viewport coordinates of an element, scrolled into the stage first so a press can reach it. */
async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("the element has no bounding box");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** One primary tap: pointerdown + pointerup without moving. */
async function tap(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Keeps the rendered diagram as an inspectable artefact next to the run's other output. */
async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function countRequests(page: Page, matches: (url: URL) => boolean): {
  readonly count: number;
  stop(): void;
} {
  let count = 0;
  const listener = (request: Request): void => {
    if (matches(new URL(request.url()))) count += 1;
  };
  page.on("request", listener);
  return {
    get count() {
      return count;
    },
    stop() {
      page.off("request", listener);
    },
  };
}

test.afterEach(async ({ browserName }, testInfo) => {
  void browserName;
  testInfo.setTimeout(20_000);
  await cleanupAll();
});

// ---------------------------------------------------------------------------
// Selection, expansion and activation
// ---------------------------------------------------------------------------

test("tree labels select UML targets while chevrons only change expansion", async ({ browser }) => {
  test.setTimeout(150_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");
    await expect(page.locator("#packages-mode")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 30_000 });

    // A chevron only expands; Packages stays painted and the editor stays closed.
    const paintedBeforeExpansion = await page.locator("#dsl-content").textContent();
    await expandTree(page, "feature");
    await expect(treeRow(page, "feature/root.ts")).toBeVisible();
    await expect(page.locator("#packages-mode")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#dsl-content")).toHaveText(paintedBeforeExpansion ?? "");
    await expect(page.locator("#editor-panel")).toBeHidden();

    // A file label selects that file: one frame per top-level definition, in source order.
    await treeRow(page, "feature/root.ts").click();
    await expect(page.locator("#uml-mode")).toHaveClass(/\bactive\b/);
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );
    await expect(page.locator("#editor-panel")).toBeHidden();
    await expect(treeRow(page, "feature/root.ts")).toHaveAttribute("aria-current", "true");
    // Selecting never expands.
    await expect(treeToggle(page, "feature/root.ts")).toHaveAttribute("aria-expanded", "false");
    expect(await diagramNodeNames(page, 0)).toEqual(["B", "C", "Root"]);
    expect(await diagramNodeNames(page, 1)).toEqual(["Isolated"]);

    // Expanding the selected file changes the outline, never the painted view.
    const paintedBeforeOutline = await page.locator("#dsl-content").textContent();
    await expandTree(page, "feature/root.ts");
    await expect(definitionNames(page, "feature/root.ts")).toHaveText(
      ["Root", "Root.value", "Root.run", "Isolated"],
      { timeout: 30_000 },
    );
    await expect(page.locator("#dsl-content")).toHaveText(paintedBeforeOutline ?? "");
    await expect(treeRow(page, "feature/root.ts")).toHaveAttribute("aria-current", "true");

    // A definition label selects exactly that root.
    const rootKey = await readDefinitionKey(page, "feature/root.ts", "Root");
    const rootRow = definitionRow(page, "feature/root.ts", "Root");
    await expect(rootRow).toHaveAttribute("data-definition-key", rootKey);
    await rootRow.click();
    await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"], { timeout: 60_000 });
    await expect(page.locator("#dsl-content")).toContainText("direction TB");
    await expect(rootRow).toHaveAttribute("aria-current", "true");
    await expect(definitionRow(page, "feature/root.ts", "Isolated"))
      .not.toHaveAttribute("aria-current", "true");
    await expect(definitionRow(page, "feature/root.ts", "Root.run"))
      .not.toHaveAttribute("aria-current", "true");
    await expect(treeRow(page, "feature/root.ts")).not.toHaveAttribute("aria-current", "true");
    await expect(page.locator("#editor-panel")).toBeHidden();
    // Outgoing transitive closure only: Consumer imports Root, Isolated is a sibling root.
    expect(await diagramNodeNames(page)).toEqual(["B", "C", "Root"]);

    // A method is its own root and carries only its own outgoing references.
    await definitionRow(page, "feature/root.ts", "Root.run").click();
    await expect(frameHeadings(page)).toHaveText(["Root.run · feature/root.ts"], { timeout: 60_000 });
    await expect(definitionRow(page, "feature/root.ts", "Root.run"))
      .toHaveAttribute("aria-current", "true");
    await expect(rootRow).not.toHaveAttribute("aria-current", "true");
    expect(await diagramNodeNames(page)).toEqual(["B", "C", "run"]);

    // A directory label selects the file-import view for that subtree.
    await treeRow(page, "feature").click();
    await expect(frameHeadings(page)).toHaveText(["feature"], { timeout: 60_000 });
    await expect(page.locator("#dsl-content")).toContainText("flowchart LR");
    expect(await diagramNodeNames(page)).toEqual([
      "feature/b.ts",
      "feature/boxed.ts",
      "feature/root.test.ts",
      "feature/root.ts",
      "feature/side-effect.ts",
      "shared/c.ts",
      "shared/extra.ts",
    ]);
    await expect(treeRow(page, "feature")).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#editor-panel")).toBeHidden();

    // Collapsing keeps the selection and the painted view.
    const paintedBeforeCollapse = await page.locator("#dsl-content").textContent();
    await collapseTree(page, "feature/root.ts");
    await expect(definitionNames(page, "feature/root.ts")).toHaveCount(0);
    await expect(page.locator("#dsl-content")).toHaveText(paintedBeforeCollapse ?? "");
    await expect(treeRow(page, "feature")).toHaveAttribute("aria-current", "true");
  } finally {
    await cleanupResource(resource);
  }
});

test("double-click opens the exact source while its diagram response is held", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createUmlFixture(resource);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await expect(treeRow(page, "consumer.ts")).toBeVisible({ timeout: 15_000 });
    await withBound(watch.cacheReady, 60_000, "uml fixture cache-ready");

    // A fast held response: the selection the first click started must not steal the editor.
    const fileGate = createResponseGate((url) => isUmlDiagramUrl(url, "file", "consumer.ts"));
    await page.route("**/api/diagram?*", fileGate.handler);
    try {
      await treeRow(page, "consumer.ts").dblclick();
      await withBound(fileGate.captured, 30_000, "held consumer.ts file diagram");
      await expect(page.locator("#editor-path")).toHaveText("consumer.ts", { timeout: 30_000 });
      await expect(page.locator(".cm-content")).toContainText("export class Consumer");
      fileGate.release();
      await withBound(fileGate.finished, 15_000, "released consumer.ts file diagram");
      await afterTwoAnimationFrames(page);
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#editor-panel")).toBeVisible();
      await expect(page.locator("#graph-panel")).toBeHidden();
      await expect(page.locator("#editor-path")).toHaveText("consumer.ts");
    } finally {
      fileGate.release();
      await page.unroute("**/api/diagram?*", fileGate.handler);
    }

    // A delayed held response, released well after the editor settled.
    await expandTree(page, "feature");
    await expandTree(page, "feature/root.ts");
    await expect(definitionRow(page, "feature/root.ts", "Root")).toHaveCount(1, { timeout: 30_000 });
    const rootKey = await readDefinitionKey(page, "feature/root.ts", "Root");
    const definitionGate = createResponseGate(
      (url) => url.pathname === "/api/diagram" && url.searchParams.get("definition") === rootKey,
    );
    await page.route("**/api/diagram?*", definitionGate.handler);
    try {
      await definitionRow(page, "feature/root.ts", "Root").dblclick();
      await withBound(definitionGate.captured, 30_000, "held Root definition diagram");
      await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
      await expect(page.locator(".cm-activeLine")).toContainText("export class Root");
      await delay(1_500);
      definitionGate.release();
      await withBound(definitionGate.finished, 15_000, "released Root definition diagram");
      await afterTwoAnimationFrames(page);
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#editor-panel")).toBeVisible();
      await expect(page.locator("#graph-panel")).toBeHidden();
      await expect(page.locator("#editor-path")).toHaveText("feature/root.ts");
    } finally {
      definitionGate.release();
      await page.unroute("**/api/diagram?*", definitionGate.handler);
    }

    // Another file's outline settling between the two presses must not destroy the pressed row.
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();
    await expandTree(page, "shared");
    const outlineGate = createResponseGate(
      (url) => url.pathname === "/api/file-definitions" && url.searchParams.get("path") === "shared/c.ts",
    );
    await page.route("**/api/file-definitions?*", outlineGate.handler);
    try {
      await treeToggle(page, "shared/c.ts").click();
      await withBound(outlineGate.captured, 30_000, "held shared/c.ts outline");
      const isolatedRow = definitionRow(page, "feature/root.ts", "Isolated");
      const point = await centreOf(isolatedRow);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.up();
      outlineGate.release();
      await expect(definitionNames(page, "shared/c.ts")).toHaveText(["C", "C.value", "useExtra"], {
        timeout: 30_000,
      });
      // The retained row still occupies its original position, so the second press lands on it.
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
      await expect(page.locator(".cm-activeLine")).toContainText("export class Isolated");
      expect(await centreOf(isolatedRow)).toEqual(point);
    } finally {
      outlineGate.release();
      await page.unroute("**/api/file-definitions?*", outlineGate.handler);
    }
  } finally {
    await cleanupResource(resource);
  }
});

test("a diagram double-tap opens the first pressed target", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");
    await expandTree(page, "feature");

    const selectRootFile = async (): Promise<void> => {
      await treeRow(page, "feature/root.ts").click();
      await expect(frameHeadings(page)).toHaveText(
        ["Root · feature/root.ts", "Isolated · feature/root.ts"],
        { timeout: 60_000 },
      );
    };
    await selectRootFile();

    const fileReads = countRequests(
      page,
      (url) => url.pathname === "/api/file" && url.searchParams.get("path") === "feature/root.ts",
    );
    try {
      // The root response repaints between the presses, so the pressed node is gone and the
      // second press lands on something else; the *first* target must still open.
      await markPressedLink(page, "Root");
      const point = await centreOf(definitionLink(page, "Root"));
      await tap(page, point);
      await page.waitForFunction(
        () =>
          document.querySelector("[data-pressed-link]") === null &&
          document.querySelectorAll("#svg-holder .uml-frame svg").length === 1 &&
          document.querySelector("#diagram-stage")?.getAttribute("aria-busy") === "false",
        undefined,
        { polling: "raf", timeout: 15_000 },
      );
      await tap(page, point);
      await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
      await expect(page.locator(".cm-activeLine")).toContainText("export class Root");
      // The superseded root paint must not come back over the editor.
      await delay(1_500);
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#graph-panel")).toBeHidden();
      expect(fileReads.count).toBe(1);
    } finally {
      fileReads.stop();
    }

    // The SVG may also be replaced between the second pointerdown and pointerup.
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();
    await selectRootFile();
    const rootKey = await readDefinitionKey(page, "feature/root.ts", "Root");
    const gate = createResponseGate(
      (url) => url.pathname === "/api/diagram" && url.searchParams.get("definition") === rootKey,
    );
    await page.route("**/api/diagram?*", gate.handler);
    try {
      await markPressedLink(page, "Root");
      const point = await centreOf(definitionLink(page, "Root"));
      await tap(page, point);
      await withBound(gate.captured, 30_000, "held Root definition diagram");
      await page.mouse.down();
      gate.release();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-pressed-link]") === null &&
          document.querySelectorAll("#svg-holder .uml-frame svg").length === 1,
        undefined,
        { polling: "raf", timeout: 15_000 },
      );
      await page.mouse.up();
      await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
    } finally {
      gate.release();
      await page.unroute("**/api/diagram?*", gate.handler);
    }

    // Negative gestures: a drag, a late second tap and a displaced second tap only ever select.
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();
    await selectRootFile();

    const dragStart = await centreOf(definitionLink(page, "Root"));
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 60, dragStart.y + 40, { steps: 6 });
    await page.mouse.up();
    await afterTwoAnimationFrames(page);
    await expect(page.locator("#editor-panel")).toBeHidden();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
    );

    await selectRootFile();
    const latePoint = await centreOf(definitionLink(page, "Root"));
    await tap(page, latePoint);
    await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"], { timeout: 60_000 });
    await delay(700);
    await tap(page, latePoint);
    await afterTwoAnimationFrames(page);
    await expect(page.locator("#editor-panel")).toBeHidden();

    await selectRootFile();
    const nearPoint = await centreOf(definitionLink(page, "Root"));
    await tap(page, nearPoint);
    await tap(page, { x: nearPoint.x + 24, y: nearPoint.y });
    await afterTwoAnimationFrames(page);
    await expect(page.locator("#editor-panel")).toBeHidden();
  } finally {
    await cleanupResource(resource);
  }
});

test("a held root response never repaints over the next selection", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page, fixtureRoot } = await openUmlFixturePage(
      browser,
      resource,
      "uml fixture cache-ready",
    );
    await expandTree(page, "feature");
    await expandTree(page, "feature/root.ts");
    await expect(definitionRow(page, "feature/root.ts", "Isolated")).toHaveCount(1, {
      timeout: 30_000,
    });
    const rootKey = await readDefinitionKey(page, "feature/root.ts", "Root");

    const gate = createResponseGate(
      (url) => url.pathname === "/api/diagram" && url.searchParams.get("definition") === rootKey,
    );
    await page.route("**/api/diagram?*", gate.handler);
    try {
      await definitionRow(page, "feature/root.ts", "Root").click();
      await withBound(gate.captured, 30_000, "held Root definition diagram");
      await definitionRow(page, "feature/root.ts", "Isolated").click();
      await expect(frameHeadings(page)).toHaveText(["Isolated · feature/root.ts"], {
        timeout: 60_000,
      });
      gate.release();
      await withBound(gate.finished, 15_000, "released Root definition diagram");
      await afterTwoAnimationFrames(page);
      await expect(frameHeadings(page)).toHaveText(["Isolated · feature/root.ts"]);
      expect(await diagramNodeNames(page)).toEqual(["Isolated"]);
      await expect(definitionRow(page, "feature/root.ts", "Isolated"))
        .toHaveAttribute("aria-current", "true");
    } finally {
      gate.release();
      await page.unroute("**/api/diagram?*", gate.handler);
    }

    // A line-only edit keeps the definition key, so the selected root survives the new generation.
    await definitionRow(page, "feature/root.ts", "Root").click();
    await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"], { timeout: 60_000 });
    await writeFile(join(fixtureRoot, "feature", "root.ts"), `// shifted by one line\n${ROOT_SOURCE}`);
    await expect(definitionRow(page, "feature/root.ts", "Root"))
      .toHaveAttribute("data-source-line", "3", { timeout: 60_000 });
    await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"], { timeout: 60_000 });
    await expect(page.locator("#error-panel")).toBeHidden();
    expect(await diagramNodeNames(page)).toEqual(["B", "C", "Root"]);

    // Deleting the selected declaration reports it; other expansion state is kept.
    await writeFile(join(fixtureRoot, "feature", "root.ts"), "export class Isolated {}\n");
    await expect(page.locator("#error-panel")).toContainText("Definition not found", {
      timeout: 60_000,
    });
    await expect(page.locator("#status")).toHaveClass(/\berror\b/);
    await expect(treeToggle(page, "feature")).toHaveAttribute("aria-expanded", "true");
    await expect(treeToggle(page, "feature/root.ts")).toHaveAttribute("aria-expanded", "true");
    await expect(definitionNames(page, "feature/root.ts")).toHaveText(["Isolated"], {
      timeout: 60_000,
    });

    // The replacement root is still selectable, so the error is not a dead end.
    await definitionRow(page, "feature/root.ts", "Isolated").click();
    await expect(frameHeadings(page)).toHaveText(["Isolated · feature/root.ts"], {
      timeout: 60_000,
    });
    await expect(page.locator("#error-panel")).toBeHidden();
  } finally {
    await cleanupResource(resource);
  }
});

test("renders root frames, directory imports and their detail controls", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");
    await expandTree(page, "feature");

    // A file selection shows exactly its root frames, each headed by its root and source path.
    await treeRow(page, "feature/root.ts").click();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );
    const outlines = await definitionNodeOutlines(page);
    expect(outlines.map((node) => ({ name: node.name, root: node.root }))).toEqual([
      { name: "B", root: false },
      { name: "Root", root: true },
      { name: "C", root: false },
      { name: "Isolated", root: true },
    ]);
    // The selected root is visibly thicker than the dependencies it reaches.
    const rootWidths = new Set(outlines.filter((node) => node.root).map((node) => node.strokeWidth));
    const leafWidths = new Set(outlines.filter((node) => !node.root).map((node) => node.strokeWidth));
    expect([...rootWidths]).toEqual(["4px"]);
    expect(leafWidths.has("4px")).toBe(false);
    await attachScreenshot(page, testInfo, "definition-view");

    // Mermaid-special characters in a source name and a member type survive as text.
    await treeRow(page, "feature/boxed.ts").click();
    await expect(frameHeadings(page)).toHaveText(["Box · feature/boxed.ts"], { timeout: 60_000 });
    expect(await diagramNodeNames(page)).toEqual(["Box⟨TValue⟩"]);
    await expect(page.locator("#svg-holder")).toContainText(
      "+entries: Record⟨string, ｛ value: TValue ｝⟩",
    );
    await expect(page.locator("#dsl-content")).not.toContainText("~");
    await expect(page.locator("#status")).not.toHaveClass(/\berror\b/);

    // A syntactically valid empty file is a completed, empty selection.
    await treeRow(page, "empty.ts").click();
    await expect(page.locator("#svg-holder .uml-frame.empty .uml-frame-body")).toHaveText("No definitions", {
      timeout: 60_000,
    });
    await expect(page.locator("#error-panel")).toBeHidden();

    // A directory selection shows every file in the subtree plus dashed boundary leaves.
    await treeRow(page, "feature").click();
    await expect(frameHeadings(page)).toHaveText(["feature"], { timeout: 60_000 });
    expect(await fileNodeOutlines(page)).toEqual([
      { path: "feature/b.ts", boundary: false, test: false, dashed: false },
      { path: "feature/boxed.ts", boundary: false, test: false, dashed: false },
      { path: "feature/root.test.ts", boundary: false, test: true, dashed: true },
      { path: "feature/root.ts", boundary: false, test: false, dashed: false },
      { path: "feature/side-effect.ts", boundary: false, test: false, dashed: false },
      { path: "shared/c.ts", boundary: true, test: false, dashed: true },
      { path: "shared/extra.ts", boundary: true, test: false, dashed: true },
    ]);
    await attachScreenshot(page, testInfo, "directory-view");

    // Tests hides test files and their incident edges inside the directory view.
    const directoryRequests = countRequests(page, (url) => url.pathname === "/api/diagram");
    try {
      await page.locator("#uml-show-tests").uncheck();
      await expect(page.locator("#dsl-content")).not.toContainText("feature/root.test.ts");
      expect(await diagramNodeNames(page)).toEqual([
        "feature/b.ts",
        "feature/boxed.ts",
        "feature/root.ts",
        "feature/side-effect.ts",
        "shared/c.ts",
        "shared/extra.ts",
      ]);
      expect(directoryRequests.count).toBe(0);
    } finally {
      directoryRequests.stop();
    }

    // Attributes, Methods and Types change the compartments of a definition view only.
    await treeRow(page, "feature/root.ts").click();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );
    const dsl = page.locator("#dsl-content");
    const holder = page.locator("#svg-holder");
    await expect(dsl).toContainText("+value: B");
    await expect(dsl).toContainText("+run()");

    const toggleRequests = countRequests(page, (url) => url.pathname === "/api/diagram");
    try {
      await page.locator("#uml-show-types").uncheck();
      await expect(dsl).toContainText("+value");
      await expect(dsl).not.toContainText("+value: B");
      await expect(holder).not.toContainText("+value: B");

      await page.locator("#uml-show-attributes").uncheck();
      await expect(dsl).not.toContainText("+value");
      await expect(holder).not.toContainText("+value");
      await expect(dsl).toContainText("+run()");

      await page.locator("#uml-show-methods").uncheck();
      await expect(dsl).not.toContainText("+run()");
      await expect(holder).not.toContainText("run()");
      // Hiding compartments never hides the graph itself.
      expect(await diagramNodeNames(page, 0)).toEqual(["B", "C", "Root"]);
      expect(toggleRequests.count).toBe(0);
    } finally {
      toggleRequests.stop();
    }

    // Every stored choice survives a round trip through a directory selection.
    await treeRow(page, "feature").click();
    await expect(frameHeadings(page)).toHaveText(["feature"], { timeout: 60_000 });
    await treeRow(page, "feature/root.ts").click();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );
    for (const id of ["attributes", "methods", "types", "tests"]) {
      await expect(page.locator(`#uml-show-${id}`)).not.toBeChecked();
    }
    await expect(dsl).not.toContainText("+value");
    await expect(dsl).not.toContainText("+run()");

    await page.locator("#uml-show-attributes").check();
    await page.locator("#uml-show-types").check();
    await expect(dsl).toContainText("+value: B");
    await expect(page.locator("#uml-visibility")).toBeVisible();
    await page.locator("#packages-mode").click();
    await expect(page.locator("#uml-visibility")).toBeHidden();
  } finally {
    await cleanupResource(resource);
  }
});

test("keyboard navigation selects UML and opens sources", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");

    // ArrowRight expands, ArrowDown walks rows, Enter selects.
    await treeRow(page, "feature").focus();
    await expect(treeToggle(page, "feature")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(treeToggle(page, "feature")).toHaveAttribute("aria-expanded", "true");
    await expect(treeRow(page, "feature/b.ts")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(treeRow(page, "feature/b.ts")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(frameHeadings(page)).toHaveText(["B · feature/b.ts"], { timeout: 60_000 });
    await expect(page.locator("#editor-panel")).toBeHidden();

    // ArrowUp walks back and Space selects the directory.
    await page.keyboard.press("ArrowUp");
    await expect(treeRow(page, "feature")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(frameHeadings(page)).toHaveText(["feature"], { timeout: 60_000 });

    // ArrowLeft collapses without changing the selection.
    await page.keyboard.press("ArrowLeft");
    await expect(treeToggle(page, "feature")).toHaveAttribute("aria-expanded", "false");
    await expect(frameHeadings(page)).toHaveText(["feature"]);
    await page.keyboard.press("ArrowRight");
    await expect(treeToggle(page, "feature")).toHaveAttribute("aria-expanded", "true");

    // Ctrl+Enter is the keyboard equivalent of a double-click on a focused file.
    await treeRow(page, "feature/root.ts").focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
    await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();

    // And on a focused definition row, which opens at its source position.
    await expandTree(page, "feature/root.ts");
    await expect(definitionRow(page, "feature/root.ts", "Root.run")).toHaveCount(1, {
      timeout: 30_000,
    });
    await definitionRow(page, "feature/root.ts", "Root.run").focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
    await expect(page.locator(".cm-activeLine")).toContainText("run(): B");
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();

    // A diagram link answers Enter with a selection and Ctrl+Enter with the editor.
    await treeRow(page, "feature/root.ts").click();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );
    await definitionLink(page, "B").focus();
    await page.keyboard.press("Enter");
    await expect(frameHeadings(page)).toHaveText(["B · feature/b.ts"], { timeout: 60_000 });
    await expect(page.locator("#editor-panel")).toBeHidden();
    await definitionLink(page, "C").focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.locator("#editor-path")).toHaveText("shared/c.ts", { timeout: 30_000 });
    await expect(page.locator(".cm-activeLine")).toContainText("export class C");
  } finally {
    await cleanupResource(resource);
  }
});

test("search results select definition roots and open their sources", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");

    const searchInput = page.locator("#node-search");
    const runSearch = async (query: string): Promise<void> => {
      const response = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return url.pathname === "/api/search" && url.searchParams.get("q") === query;
      });
      await searchInput.fill(query);
      await searchInput.press("Enter");
      expect((await response).status()).toBe(200);
    };

    await runSearch("Root");
    const rootResult = page
      .locator("#definition-results .definition-result", { hasText: "class · Root" })
      .filter({ hasText: "feature/root.ts:2" });
    await expect(rootResult).toBeVisible();
    await expect(rootResult).toHaveAttribute("role", "option");

    // A single click resolves the hit to its outline key and selects that root only.
    await rootResult.click();
    await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"], { timeout: 60_000 });
    expect(await diagramNodeNames(page)).toEqual(["B", "C", "Root"]);
    await expect(page.locator("#diagram-loading")).toBeHidden();
    await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#editor-panel")).toBeHidden();

    // A double click opens the hit's own source position.
    await rootResult.dblclick();
    await expect(page.locator("#editor-path")).toHaveText("feature/root.ts", { timeout: 30_000 });
    await expect(page.locator(".cm-activeLine")).toContainText("export class Root");
    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();

    // A double click while the outline read is held opens Editor and cancels the root selection.
    await runSearch("Consumer");
    const consumerResult = page
      .locator("#definition-results .definition-result", { hasText: "class · Consumer" })
      .filter({ hasText: "consumer.ts:2" });
    await expect(consumerResult).toBeVisible();
    const outlineGate = createResponseGate(
      (url) => url.pathname === "/api/file-definitions" && url.searchParams.get("path") === "consumer.ts",
    );
    await page.route("**/api/file-definitions?*", outlineGate.handler);
    const consumerDiagrams = countRequests(
      page,
      (url) => url.pathname === "/api/diagram" && url.searchParams.get("path") === "consumer.ts",
    );
    try {
      await consumerResult.dblclick();
      await withBound(outlineGate.captured, 30_000, "held consumer.ts outline");
      await expect(page.locator("#editor-path")).toHaveText("consumer.ts", { timeout: 30_000 });
      await expect(page.locator(".cm-activeLine")).toContainText("export class Consumer");
      outlineGate.release();
      await withBound(outlineGate.finished, 15_000, "released consumer.ts outline");
      await afterTwoAnimationFrames(page);
      await delay(500);
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#editor-panel")).toBeVisible();
      await expect(page.locator("#graph-panel")).toBeHidden();
      expect(consumerDiagrams.count).toBe(0);
    } finally {
      consumerDiagrams.stop();
      outlineGate.release();
      await page.unroute("**/api/file-definitions?*", outlineGate.handler);
    }
  } finally {
    await cleanupResource(resource);
  }
});

/** Commits the `Root` search and settles the overview paint that a selection then supersedes. */
async function commitRootSearch(page: Page): Promise<Locator> {
  const searchInput = page.locator("#node-search");
  const searched = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === "/api/search" && url.searchParams.get("q") === "Root";
  });
  await searchInput.fill("Root");
  await searchInput.press("Enter");
  expect((await searched).status()).toBe(200);
  await expect(page.locator("#status")).toContainText("Search · ", { timeout: 60_000 });
  await expect(page.locator("#diagram-loading")).toBeHidden();
  const rootResult = page
    .locator("#definition-results .definition-result", { hasText: "class · Root" })
    .filter({ hasText: "feature/root.ts:2" });
  await expect(rootResult).toBeVisible();
  return rootResult;
}

test("finishes loading after a visibility repaint supersedes a selected graph", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(
      browser,
      resource,
      "visibility repaint fixture cache-ready",
    );
    const rootResult = await commitRootSearch(page);

    const gate = createResponseGate((url) => isUmlDiagramUrl(url, "definition", "feature/root.ts"));
    await page.route("**/api/diagram?*", gate.handler);
    try {
      await rootResult.click();
      await withBound(gate.captured, 30_000, "held Root definition diagram");
      await expect(page.locator("#diagram-loading")).toBeVisible();
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "true");

      // The selection installs its model and empties the holder before painting it. Unchecking a
      // compartment exactly there supersedes a request whose own finalizer can never run again.
      await page.evaluate(() => {
        const holder = document.querySelector("#svg-holder");
        const stage = document.querySelector("#diagram-stage");
        const methods = document.querySelector<HTMLInputElement>("#uml-show-methods");
        if (!holder || !stage || !methods) throw new Error("diagram controls are missing");
        const flag: RepaintFlagWindow = window;
        flag.umlRepaintSuperseded = false;
        const observer = new MutationObserver(() => {
          if (holder.childElementCount !== 0) return;
          if (stage.getAttribute("aria-busy") !== "true") return;
          observer.disconnect();
          methods.checked = false;
          methods.dispatchEvent(new Event("change"));
          flag.umlRepaintSuperseded = true;
        });
        observer.observe(holder, { childList: true });
      });
      gate.release();
      await withBound(gate.finished, 30_000, "released Root definition diagram");
      await page.waitForFunction(
        () => (window as RepaintFlagWindow).umlRepaintSuperseded === true,
        undefined,
        { timeout: 15_000 },
      );

      // The superseding repaint owns the outcome: its model paints and its finalizer ends loading.
      await expect(frameHeadings(page)).toHaveText(["Root · feature/root.ts"]);
      expect(await diagramNodeNames(page)).toEqual(["B", "C", "Root"]);
      await expect(page.locator("#dsl-content")).not.toContainText("+run()");
      await expect(page.locator("#diagram-loading")).toBeHidden();
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");
    } finally {
      gate.release();
      await page.unroute("**/api/diagram?*", gate.handler);
    }

    // A released overlay stops covering the stage, so the painted graph stays navigable.
    await tap(page, await centreOf(definitionLink(page, "B")));
    await expect(frameHeadings(page)).toHaveText(["B · feature/b.ts"], { timeout: 60_000 });
    expect(await diagramNodeNames(page)).toEqual(["B", "C"]);
  } finally {
    await cleanupResource(resource);
  }
});

test("clears diagram loading when editor navigation fails after superseding it", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(
      browser,
      resource,
      "failed editor fixture cache-ready",
    );
    const rootResult = await commitRootSearch(page);
    const overviewHeadings = await frameHeadings(page).allTextContents();

    let failedReads = 0;
    const failRootSource = async (route: Route): Promise<void> => {
      const url = new URL(route.request().url());
      if (failedReads > 0 || url.searchParams.get("path") !== "feature/root.ts") {
        await route.continue();
        return;
      }
      failedReads++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "source unavailable" }),
      });
    };
    const gate = createResponseGate((url) => isUmlDiagramUrl(url, "definition", "feature/root.ts"));
    await page.route("**/api/diagram?*", gate.handler);
    await page.route("**/api/file?*", failRootSource);
    try {
      await rootResult.click();
      await withBound(gate.captured, 30_000, "held Root definition diagram");
      await expect(page.locator("#diagram-loading")).toBeVisible();
      await expect(rootResult).toBeVisible();

      // The double click abandons the held selection; its own failure must still free the overlay.
      await rootResult.dblclick();
      await expect(page.locator("#status")).toHaveText("source unavailable", { timeout: 30_000 });
      await expect(page.locator("#status")).toHaveClass(/\berror\b/);
      await expect(page.locator("#diagram-loading")).toBeHidden();
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");
      expect(failedReads).toBe(1);

      // The abandoned response lands afterwards: it may neither repaint nor restore loading.
      gate.release();
      await withBound(gate.finished, 30_000, "released Root definition diagram");
      await afterTwoAnimationFrames(page);
      await delay(500);
      await expect(page.locator("#diagram-loading")).toBeHidden();
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("#editor-panel")).toBeHidden();
      await expect(page.locator("#graph-panel")).toBeVisible();
      expect(await frameHeadings(page).allTextContents()).toEqual(overviewHeadings);
    } finally {
      gate.release();
      await page.unroute("**/api/file?*", failRootSource);
      await page.unroute("**/api/diagram?*", gate.handler);
    }
  } finally {
    await cleanupResource(resource);
  }
});

test("dismisses search results outside the search control", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createUmlFixture(resource);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    const cli = resource.clis.at(-1);
    if (!cli) throw new Error("managed CLI was not registered");
    await expect(treeRow(page, "feature")).toBeVisible({ timeout: 15_000 });
    await withBound(watch.cacheReady, 60_000, "dismissal fixture cache-ready");

    const isRootSearch = (url: URL): boolean =>
      url.pathname === "/api/search" &&
      url.searchParams.get("q") === "Root" &&
      url.searchParams.get("caseInsensitive") === "false";
    const searchInput = page.locator("#node-search");
    const results = page.locator("#definition-results");
    const rootResult = results
      .locator(".definition-result", { hasText: "class · Root" })
      .filter({ hasText: "feature/root.ts:2" });
    const rootFile = treeRow(page, "feature/root.ts");
    const filesHeading = page.locator(".sidebar-head h2");

    const committed = page.waitForResponse((response) => isRootSearch(new URL(response.url())));
    await searchInput.fill("Root");
    await searchInput.press("Enter");
    const committedResponse = await committed;
    expect(committedResponse.status()).toBe(200);
    let searchVersion = (await committedResponse.json() as SearchResponse).version;
    await expect(rootResult).toBeVisible();
    await expect(rootFile).toHaveClass(/\bsearch-match\b/);

    const searchCalls = countRequests(page, (url) => url.pathname === "/api/search");
    try {
      // Dismissal is presentation-only: query, matches and highlight all survive it.
      await searchInput.click();
      await expect(rootResult).toBeVisible();
      await filesHeading.click();
      await expect(results).toBeHidden();
      await expect(searchInput).toHaveValue("Root");
      await expect(rootFile).toHaveClass(/\bsearch-match\b/);
      await searchInput.click();
      await expect(rootResult).toBeVisible();
      await afterTwoAnimationFrames(page);
      expect(searchCalls.count).toBe(0);

      // A file chevron stops click propagation; it must still expand while dismissing.
      await collapseTree(page, "feature/root.ts");
      await searchInput.click();
      await expect(rootResult).toBeVisible();
      const rootToggle = treeToggle(page, "feature/root.ts");
      await rootToggle.click();
      await expect(results).toBeHidden();
      await expect(rootToggle).toHaveAttribute("aria-expanded", "true");
      expect(searchCalls.count).toBe(0);
    } finally {
      searchCalls.stop();
    }

    // A dismissal taken while the search is in flight survives the response landing.
    const gate = createResponseGate(isRootSearch);
    await page.route("**/api/search?*", gate.handler);
    try {
      const held = page.waitForResponse((response) => isRootSearch(new URL(response.url())));
      await searchInput.click();
      await searchInput.press("Enter");
      await withBound(gate.captured, 30_000, "held Root search");
      await expect(results.locator(".definition-result")).toHaveCount(0);
      await filesHeading.click();
      gate.release();
      await withBound(gate.finished, 15_000, "released Root search");
      const heldResponse = await held;
      expect(heldResponse.status()).toBe(200);
      await heldResponse.finished();
      await afterTwoAnimationFrames(page);
      await expect(rootFile).toHaveClass(/\bsearch-match\b/);
      await expect(searchInput).toHaveValue("Root");
      await expect(results).toBeHidden();
      searchVersion = (await heldResponse.json() as SearchResponse).version;
    } finally {
      gate.release();
      await page.unroute("**/api/search?*", gate.handler);
    }

    // The watcher-shared refresh re-runs the committed search; it must not reopen the popup.
    const refreshed = page.waitForResponse(async (response) => {
      if (!isRootSearch(new URL(response.url())) || response.status() !== 200) return false;
      return (await response.json() as SearchResponse).version > searchVersion;
    }, { timeout: 45_000 });
    await writeFile(join(fixtureRoot, "unrelated.ts"), "export class Unrelated { value = 1; }\n");
    await expect.poll(
      () =>
        watch.history
          .filter((message) =>
            message.type === "cache-ready" && message.version > searchVersion
          )
          .at(-1)?.version ?? searchVersion,
      {
        message: `a promoted cache-ready version after editing the dismissal fixture\n${describeCli(cli)}`,
        timeout: 45_000,
      },
    ).toBeGreaterThan(searchVersion);
    const refreshedResponse = await refreshed;
    await refreshedResponse.finished();
    await afterTwoAnimationFrames(page);
    await expect(searchInput).toHaveValue("Root");
    await expect(rootFile).toHaveClass(/\bsearch-match\b/);
    await expect(results).toBeHidden();

    const refreshCalls = countRequests(page, (url) => url.pathname === "/api/search");
    try {
      await searchInput.click();
      await expect(rootResult).toBeVisible();
      await afterTwoAnimationFrames(page);
      expect(refreshCalls.count).toBe(0);
    } finally {
      refreshCalls.stop();
    }

    // Emptying the query clears what dismissal deliberately kept.
    await searchInput.fill("");
    await expect(results).toBeHidden();
    // Clearing drops the search-forced expansion too, so assert on the highlight set itself.
    await expect(page.locator("#tree .tree-row.search-match")).toHaveCount(0);
  } finally {
    await cleanupResource(resource);
  }
});

test("pans and zooms the diagram viewport", async ({ browser }) => {
  test.setTimeout(150_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(browser, resource, "uml fixture cache-ready");
    await expandTree(page, "feature");
    await treeRow(page, "feature/root.ts").click();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
      { timeout: 60_000 },
    );

    const transform = () =>
      page.evaluate(() => {
        const holder = document.querySelector<HTMLElement>("#svg-holder");
        return holder ? new DOMMatrixReadOnly(getComputedStyle(holder).transform) : null;
      });
    expect(await transform()).toMatchObject({ a: 1, d: 1, e: 0, f: 0 });

    await page.locator("#zoom-in").click();
    expect((await transform())?.a).toBeCloseTo(1.25, 5);
    await page.locator("#zoom-out").click();
    expect((await transform())?.a).toBeCloseTo(1, 5);

    // A drag pans and suppresses activation of the link it started on.
    const start = await centreOf(definitionLink(page, "Root"));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 50, { steps: 8 });
    await page.mouse.up();
    await afterTwoAnimationFrames(page);
    const panned = await transform();
    expect(panned?.e).toBeCloseTo(80, 0);
    expect(panned?.f).toBeCloseTo(50, 0);
    await expect(page.locator("#editor-panel")).toBeHidden();
    await expect(frameHeadings(page)).toHaveText(
      ["Root · feature/root.ts", "Isolated · feature/root.ts"],
    );

    await page.locator("#zoom-reset").click();
    expect(await transform()).toMatchObject({ a: 1, d: 1, e: 0, f: 0 });
  } finally {
    await cleanupResource(resource);
  }
});

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

test("directories select import graphs while the Packages tab keeps the manifest graph", async ({ browser }) => {
  test.setTimeout(120_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createNestedPackagesFixture(resource);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    const runtimeRow = treeRow(page, "junco-runtime");
    await Promise.all([
      expect(page.locator("#source-label")).not.toHaveText("Loading source…", { timeout: 15_000 }),
      expect(runtimeRow).toBeVisible({ timeout: 15_000 }),
      withBound(watch.cacheReady, 60_000, "nested packages cache-ready"),
    ]);
    await expect(page.locator("#svg-holder")).toContainText("junco-runtime-demo", {
      timeout: 30_000,
    });
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 30_000 });
    const dsl = page.locator("#dsl-content");

    // A source directory selects its file-import view, not the package graph.
    const umlRequest = page.waitForRequest((request) =>
      isUmlDiagramUrl(new URL(request.url()), "directory", "junco-runtime")
    );
    await runtimeRow.click();
    expect((await (await umlRequest).response())?.status()).toBe(200);
    await expect(page.locator("#uml-mode")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#packages-mode")).not.toHaveClass(/\bactive\b/);
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 30_000 });
    await expect(frameHeadings(page)).toHaveText(["junco-runtime"]);
    await expect(dsl).toContainText("flowchart LR");
    expect(await diagramNodeNames(page)).toEqual([
      "junco-runtime/packages/demo/index.ts",
      "junco-runtime/packages/demo/package.json",
    ]);
    await expect(page.locator("#error-panel")).toBeHidden();

    // A package *container* directory is just another directory now.
    await expandTree(page, "junco-runtime");
    await treeRow(page, "junco-runtime/packages").click();
    await expect(frameHeadings(page)).toHaveText(["junco-runtime/packages"], { timeout: 30_000 });
    await expect(dsl).toContainText("flowchart LR");
    await expect(dsl).not.toContainText("classDiagram");

    // The manifest graph is reachable only through its own tab.
    const packagesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/diagram" &&
        url.searchParams.get("kind") === "packages" &&
        url.searchParams.get("path") === "";
    });
    await page.locator("#packages-mode").click();
    expect((await packagesResponse).status()).toBe(200);
    await expect(page.locator("#packages-mode")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 30_000 });
    await expect(page.locator("#svg-holder")).toContainText("junco-runtime-demo");
    await expect(page.locator("#error-panel")).toBeHidden();

    // A package node selects that package's directory import view.
    const packageNode = page.locator("#svg-holder .package-link").first();
    await expect(packageNode).toHaveAttribute("role", "link");
    await packageNode.click();
    await expect(page.locator("#uml-mode")).toHaveClass(/\bactive\b/);
    await expect(frameHeadings(page)).toHaveText(["junco-runtime/packages/demo"], {
      timeout: 30_000,
    });
  } finally {
    await cleanupResource(resource);
  }
});

test("a failed diagram shows the server error instead of mermaid output", async ({ browser }) => {
  test.setTimeout(120_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createUmlFixture(resource);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    const diagramRoute = (url: URL): boolean => url.pathname === "/api/diagram";
    const failUmlDiagram = async (route: Route): Promise<void> => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("kind") !== "uml") {
        await route.continue();
        return;
      }
      const path = url.searchParams.get("path") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          {
            kind: "uml",
            scopePath: path,
            version: 0,
            target: { kind: "file", path },
            status: "error",
            error: "forced failure",
            view: { kind: "definitions", nodes: [], edges: [], frames: [] },
          } satisfies DiagramResponse,
        ),
      });
    };
    await page.route(diagramRoute, failUmlDiagram);
    try {
      await navigateToCli(page, fixtureRoot, resource);
      await expect(treeRow(page, "unrelated.ts")).toBeVisible({ timeout: 15_000 });
      await withBound(watch.cacheReady, 60_000, "forced diagram failure cache-ready");

      await treeRow(page, "unrelated.ts").click();
      await expect(page.locator("#error-panel")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("#error-panel")).toContainText("forced failure");
      await expect(page.locator("#svg-holder .uml-frame.empty .uml-frame-body"))
        .toHaveText("No definitions");
      await expect(page.locator("#svg-holder")).not.toContainText("Parse error");
      await expect(page.locator("#status")).toHaveClass(/\berror\b/);
    } finally {
      await page.unroute(diagramRoute, failUmlDiagram);
    }
  } finally {
    await cleanupResource(resource);
  }
});

/**
 * Mermaid replaces any diagram whose preprocessed text exceeds `maxTextSize` with a one-node
 * "Maximum text size in diagram exceeded" graph and still resolves successfully, so a passing
 * render is no proof on its own. Both an oversized package graph and a genuinely oversized class
 * frame must paint their real content.
 */
test("oversized diagrams render complete content", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-large-diagram-e2e-"));
    resource.fixtureRoot = fixtureRoot;
    const memberType = "Alpha".repeat(32);
    const memberNames = Array.from(
      { length: 384 },
      (_, index) => `member${String(index).padStart(3, "0")}`,
    );
    // The annotation identifier never resolves: the explorer reads source syntax without
    // compiling the inspected project, and the type text is what makes one frame oversized.
    const source = [
      "export class HugeWidget {",
      ...memberNames.map((name) => `  ${name}: ${memberType};`),
      "}",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(
        join(fixtureRoot, "package.json"),
        `${JSON.stringify({ name: "huge-e2e", private: true })}\n`,
      ),
      writeFile(join(fixtureRoot, "index.ts"), source),
    ]);

    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    const holder = page.locator("#svg-holder");
    const sizeLimitMessage = "Maximum text size in diagram exceeded";

    // Padding the direction keyword is the only way to cross the limit without adding nodes,
    // edges or wide labels: comments, frontmatter and directives are stripped before Mermaid
    // measures the text, while `flowchart\s*LR` keeps lexing.
    const packagesRoute = (url: URL): boolean =>
      url.pathname === "/api/diagram" && url.searchParams.get("kind") === "packages";
    const padPackagesDiagram = async (route: Route): Promise<void> => {
      const response = await route.fetch();
      const diagram = await response.json() as Extract<DiagramResponse, { kind: "packages" }>;
      const dsl = diagram.dsl.replace("flowchart LR", `flowchart ${" ".repeat(60_000)}LR`);
      expect(dsl.length).toBeGreaterThan(60_000);
      // The upstream content-length measures the original body; Playwright recomputes it only
      // when the header is absent, and a stale one truncates the padded JSON.
      const headers = { ...response.headers() };
      delete headers["content-length"];
      await route.fulfill({
        response,
        headers,
        body: JSON.stringify({ ...diagram, dsl, dsls: [dsl] }),
      });
    };
    await page.route(packagesRoute, padPackagesDiagram);
    try {
      await navigateToCli(page, fixtureRoot, resource);
      await expect(treeRow(page, "index.ts")).toBeVisible({ timeout: 15_000 });
      await withBound(watch.cacheReady, 60_000, "oversized diagram cache-ready");
      await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 60_000 });
      await expect.poll(() => diagramNodeNames(page), { timeout: 60_000 }).toEqual(["huge-e2e"]);
      await expect(holder.locator(".package-link")).toHaveCount(1);
      await expect(holder).not.toContainText(sizeLimitMessage);
      await attachScreenshot(page, testInfo, "oversized-packages");
    } finally {
      await page.unroute(packagesRoute, padPackagesDiagram);
    }

    /** Every declared member, the full type text and a single-frame DSL past the old ceiling. */
    const expectCompleteWidget = async (): Promise<void> => {
      await expect.poll(() => diagramNodeNames(page, 0), { timeout: 60_000 })
        .toEqual(["HugeWidget"]);
      await expect
        .poll(async () => (await holder.textContent() ?? "").match(/\bmember\d{3}\b/g), {
          timeout: 60_000,
        })
        .toEqual(memberNames);
      await expect(holder).toContainText(memberType, { timeout: 60_000 });
      await expect
        .poll(
          async () =>
            (await page.locator("#dsl-content").textContent() ?? "")
              .replace(/^%%[^\n]*\n/, "")
              .length,
          { timeout: 60_000 },
        )
        .toBeGreaterThan(60_000);
      await expect(holder).not.toContainText(sizeLimitMessage);
      await expect(page.locator(".uml-frame.error")).toHaveCount(0);
      await expect(page.locator("#error-panel")).toBeHidden();
    };

    await treeRow(page, "index.ts").click();
    await expect(frameHeadings(page)).toHaveText(["HugeWidget · index.ts"], { timeout: 60_000 });
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 60_000 });
    await expectCompleteWidget();
    await attachScreenshot(page, testInfo, "oversized-definition");

    // The retained model repaints locally, so the threshold is crossed again without a request.
    await page.locator("#uml-show-attributes").uncheck();
    await expect.poll(() => diagramNodeNames(page, 0), { timeout: 60_000 })
      .toEqual(["HugeWidget"]);
    await expect(holder).not.toContainText("member383", { timeout: 60_000 });
    await page.locator("#uml-show-attributes").check();
    await expect(holder).toContainText("member383", { timeout: 60_000 });
    await expectCompleteWidget();
  } finally {
    await cleanupResource(resource);
  }
});

/**
 * Mermaid's flowchart DB throws `Edge limit exceeded` past `maxEdges`, another secure config only
 * `initialize` can raise. A directory whose files import each other densely must still paint every
 * node and every link.
 */
test("dense import graphs render every edge", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-dense-edges-e2e-"));
    resource.fixtureRoot = fixtureRoot;
    await writeFile(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ name: "dense-e2e", private: true })}\n`,
    );
    const { expectedNodes, edgeCount } = await addDenseImportFixture(fixtureRoot);

    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await expect(treeRow(page, "graph")).toBeVisible({ timeout: 15_000 });
    await withBound(watch.cacheReady, 60_000, "dense import graph cache-ready");

    await treeRow(page, "graph").click();
    await expect(frameHeadings(page)).toHaveText(["graph"], { timeout: 60_000 });
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 60_000 });

    // The generated DSL really does declare more links than Mermaid's default ceiling allows.
    const dsl = await page.locator("#dsl-content").textContent() ?? "";
    expect((dsl.match(/-->/g) ?? []).length).toBe(edgeCount);
    expect(edgeCount).toBeGreaterThan(500);

    await expect.poll(() => diagramNodeNames(page, 0), { timeout: 60_000 }).toEqual(expectedNodes);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.querySelectorAll("#svg-holder .edgePaths path, #svg-holder path.flowchart-link")
              .length
          ),
        { timeout: 60_000 },
      )
      .toBe(edgeCount);
    await expect(page.locator("#svg-holder")).not.toContainText("Edge limit exceeded");
    await expect(page.locator(".uml-frame.error")).toHaveCount(0);
    await expect(page.locator("#error-panel")).toBeHidden();
    await attachScreenshot(page, testInfo, "dense-edges");
  } finally {
    await cleanupResource(resource);
  }
});

/**
 * Loading may only withhold the selected diagram's own unfinished content. Both phases make one
 * diagram genuinely unavailable — first a held HTTP response, then an eight-second layout solve
 * burning worker CPU — while search, disclosure and the next file selection stay usable.
 */
test("keeps search and file navigation responsive during diagram loading", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createUmlFixture(resource);
    const dense = await addDenseImportFixture(fixtureRoot);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await expect(treeRow(page, "feature")).toBeVisible({ timeout: 15_000 });
    await withBound(watch.cacheReady, 60_000, "responsive fixture cache-ready");
    await commitRootSearch(page);

    const searchInput = page.locator("#node-search");
    const results = page.locator("#definition-results");
    const filesHeading = page.locator(".sidebar-head h2");
    const loading = page.locator("#diagram-loading");
    const stage = page.locator("#diagram-stage");
    const unrelatedRow = treeRow(page, "unrelated.ts");

    const gate = createResponseGate((url) => isUmlDiagramUrl(url, "file", "consumer.ts"));
    await page.route("**/api/diagram?*", gate.handler);
    try {
      await treeRow(page, "consumer.ts").click();
      await withBound(gate.captured, 30_000, "held consumer.ts diagram");
      await expect(loading).toBeVisible();
      await expect(stage).toHaveAttribute("aria-busy", "true");

      // Retained results still reopen and still dismiss while that one file is unavailable.
      await searchInput.click();
      await expect(results).toBeVisible({ timeout: 2_000 });
      await filesHeading.click();
      await expect(results).toBeHidden({ timeout: 2_000 });
      await expect(searchInput).toHaveValue("Root");
      await expect(loading).toBeVisible();

      // A chevron changes its own disclosure and dismisses the popup, both still under loading.
      await searchInput.click();
      await expect(results).toBeVisible({ timeout: 2_000 });
      const rootToggle = treeToggle(page, "feature/root.ts");
      const expandedBefore = await rootToggle.getAttribute("aria-expanded");
      await rootToggle.click();
      await expect(rootToggle)
        .toHaveAttribute("aria-expanded", expandedBefore === "true" ? "false" : "true", {
          timeout: 2_000,
        });
      await expect(results).toBeHidden({ timeout: 2_000 });
      await expect(loading).toBeVisible();
      await attachScreenshot(page, testInfo, "responsive-held-response");

      // The next file paints without waiting for the held one, and the held one never returns.
      await unrelatedRow.click();
      await expect(unrelatedRow).toHaveAttribute("aria-current", "true", { timeout: 30_000 });
      await expect(frameHeadings(page)).toHaveText(["Unrelated · unrelated.ts"], {
        timeout: 30_000,
      });
      gate.release();
      await withBound(gate.finished, 15_000, "released consumer.ts diagram");
      await afterTwoAnimationFrames(page);
      await expect(frameHeadings(page)).toHaveText(["Unrelated · unrelated.ts"]);
      await expect(results).toBeHidden();
      await expect(loading).toBeHidden();
      await expect(unrelatedRow).toHaveAttribute("aria-current", "true");
    } finally {
      gate.release();
      await page.unroute("**/api/diagram?*", gate.handler);
    }

    // Phase two exercises CPU, not latency: the prefix runs before the worker's real handler,
    // announces the dense layout request and then spins for eight seconds inside the worker.
    const workerScript = (url: URL): boolean => url.pathname === "/diagram-worker.js";
    const stallPrefix = [
      'self.addEventListener("message", (event) => {',
      "  const request = event.data;",
      `  if (!request || request.kind !== "layout") return;`,
      `  if (request.graph.edges.length !== ${dense.edgeCount}) return;`,
      '  self.postMessage({ kind: "__e2e-layout-started" });',
      "  const until = Date.now() + 8000;",
      "  while (Date.now() < until) {}",
      "});",
      "",
    ].join("\n");
    const prefixWorkerScript = async (route: Route): Promise<void> => {
      const response = await route.fetch();
      // The upstream content-length measures the original body; a stale one truncates the prefix.
      const headers = { ...response.headers() };
      delete headers["content-length"];
      await route.fulfill({ response, headers, body: `${stallPrefix}${await response.text()}` });
    };
    await page.route(workerScript, prefixWorkerScript);
    await page.evaluate(() => {
      const scope = window as DiagramWorkerProbeWindow;
      const NativeWorker = scope.Worker;
      scope.__e2eNativeWorker = NativeWorker;
      scope.__e2eLayoutStarted = false;
      class ProbeWorker extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          // Registered before the application's listener, so the marker never reaches it.
          this.addEventListener("message", (event: MessageEvent) => {
            if ((event.data as { kind?: string } | null)?.kind !== "__e2e-layout-started") return;
            event.stopImmediatePropagation();
            scope.__e2eLayoutStarted = true;
          });
        }
      }
      scope.Worker = ProbeWorker;
    });
    try {
      await treeRow(page, "graph").click();
      await withBound(
        page.waitForFunction(
          () => (window as DiagramWorkerProbeWindow).__e2eLayoutStarted === true,
          undefined,
          { polling: "raf", timeout: 30_000 },
        ),
        30_000,
        "dense layout solve started inside the diagram worker",
      );
      await expect(loading).toBeVisible();
      await expect(stage).toHaveAttribute("aria-busy", "true");

      // The popup opens and closes *while* the worker is still burning CPU on the old diagram.
      await searchInput.click();
      await expect(results).toBeVisible({ timeout: 2_000 });
      await filesHeading.click();
      await expect(results).toBeHidden({ timeout: 2_000 });
      await expect(loading).toBeVisible();
      await attachScreenshot(page, testInfo, "responsive-busy-worker");

      // The obsolete eight-second solve must not delay the replacement selection.
      await unrelatedRow.click();
      await expect(unrelatedRow).toHaveAttribute("aria-current", "true", { timeout: 2_000 });
      await expect(frameHeadings(page)).toHaveText(["Unrelated · unrelated.ts"], { timeout: 2_000 });
      await expect(loading).toBeHidden({ timeout: 10_000 });

      // Outliving the abandoned solve: it reports no error and repaints nothing.
      await delay(9_000);
      await expect(frameHeadings(page)).toHaveText(["Unrelated · unrelated.ts"]);
      await expect(page.locator(".uml-frame.error")).toHaveCount(0);
      await expect(page.locator("#error-panel")).toBeHidden();
      await expect(loading).toBeHidden();
      await expect(unrelatedRow).toHaveAttribute("aria-current", "true");
      await attachScreenshot(page, testInfo, "responsive-replacement-selection");
    } finally {
      await page.unroute(workerScript, prefixWorkerScript);
      await page.evaluate(() => {
        const scope = window as DiagramWorkerProbeWindow;
        if (scope.__e2eNativeWorker) scope.Worker = scope.__e2eNativeWorker;
        delete scope.__e2eNativeWorker;
        delete scope.__e2eLayoutStarted;
      });
    }
  } finally {
    await cleanupResource(resource);
  }
});

/** A dead worker may cost its own diagram, never the retained search state or the next selection. */
test("keeps navigation usable after a diagram worker failure", async ({ browser }) => {
  test.setTimeout(180_000);
  const resource = registerResource();
  try {
    const { page } = await openUmlFixturePage(
      browser,
      resource,
      "worker failure fixture cache-ready",
    );
    await commitRootSearch(page);

    const searchInput = page.locator("#node-search");
    const results = page.locator("#definition-results");
    const loading = page.locator("#diagram-loading");
    const workerScript = (url: URL): boolean => url.pathname === "/diagram-worker.js";
    let broken = false;
    const breakNextWorker = async (route: Route): Promise<void> => {
      if (broken) {
        await route.continue();
        return;
      }
      broken = true;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8" },
        body: 'throw new Error("forced diagram worker failure");',
      });
    };
    await page.route(workerScript, breakNextWorker);
    try {
      await searchInput.click();
      await searchInput.press("Enter");
      await expect(page.locator("#error-panel")).toContainText("forced diagram worker failure", {
        timeout: 60_000,
      });
      await expect(loading).toBeHidden({ timeout: 60_000 });
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");

      // The failure costs the diagram, not the committed search.
      await expect(searchInput).toHaveValue("Root");
      await expect(treeRow(page, "feature/root.ts")).toHaveClass(/\bsearch-match\b/);
      await searchInput.click();
      await expect(results.locator(".definition-result", { hasText: "class · Root" }))
        .toHaveCount(1);

      // A later selection gets a fresh worker; no retry of the failed operation is expected.
      await treeRow(page, "unrelated.ts").click();
      await expect(frameHeadings(page)).toHaveText(["Unrelated · unrelated.ts"], {
        timeout: 60_000,
      });
      await expect(page.locator("#error-panel")).toBeHidden();
      await expect(page.locator(".uml-frame.error")).toHaveCount(0);
      await expect(loading).toBeHidden();
    } finally {
      await page.unroute(workerScript, breakNextWorker);
    }
  } finally {
    await cleanupResource(resource);
  }
});

// ---------------------------------------------------------------------------
// Tree, search and editor lifecycle
// ---------------------------------------------------------------------------

test("renders a live tree independently and observes cache completion", async ({ browser }) => {
  test.setTimeout(150_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await createBulkFixture(resource);
    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);

    await Promise.all([
      expect(page.locator("#source-label")).not.toHaveText("Loading source…", { timeout: 10_000 }),
      expect(treeRow(page, "bulk-00")).toBeVisible({ timeout: 10_000 }),
    ]);
    await expandTree(page, "bulk-00");
    await expect(treeRow(page, "bulk-00/generated-00.ts")).toBeVisible();

    const filter = page.locator("#tree-filter");
    await filter.fill("generated-09.ts");
    await expect(treeRow(page, "bulk-23/generated-09.ts")).toBeVisible();
    await filter.fill("");

    await withBound(watch.cacheReady, 60_000, "cache-ready");

    await openDefinitionSource(page, "marker.ts", "marker");
    await expect(page.locator("#editor-path")).toHaveText("marker.ts", { timeout: 30_000 });
    await expect(page.locator(".cm-content")).toContainText("TREE_READY_BEFORE_CACHE");

    const search = await page.evaluate(async () => {
      const response = await fetch("/api/search?q=E2E_UNIQUE_SEARCH_TOKEN");
      const body = await response.json() as { files?: string[] };
      return { status: response.status, files: body.files };
    });
    expect(search).toEqual({ status: 200, files: ["bulk-23/generated-09.ts"] });

    await page.locator("#editor-close").click();
    await expect(page.locator("#graph-panel")).toBeVisible();
    await collapseTree(page, "bulk-00");
    await expect(treeRow(page, "bulk-00/generated-00.ts")).toHaveCount(0);
    await expandTree(page, "bulk-00");
    await expect(treeRow(page, "bulk-00/generated-00.ts")).toBeVisible();

    await treeRow(page, "bulk-00/generated-00.ts").click();
    await expect(page.locator("#diagram-loading")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator("#status")).not.toHaveClass(/\berror\b/);
    await expect(page.locator(".uml-frame.error")).toHaveCount(0);
    await expect(frameHeadings(page)).toHaveText([
      "SessionStorage · bulk-00/generated-00.ts",
      "DurableSessionStorage · bulk-00/generated-00.ts",
      "JuncoAgent · bulk-00/generated-00.ts",
      "generated_00_00 · bulk-00/generated-00.ts",
    ]);
    await expect(page.locator("#svg-holder")).toContainText("SessionStorage⟨TMetadata⟩");
    await expect(page.locator("#svg-holder")).toContainText("JuncoAgent⟨TSkill,TTool,Ctx⟩");

    const dsl = page.locator("#dsl-content");
    await expect(dsl).toContainText('class d0["SessionStorage⟨TMetadata⟩"]');
    await expect(dsl).not.toContainText("~");
    // The implementing class reaches its interface; the interface frame does not reach back.
    expect(await diagramNodeNames(page, 1)).toEqual(["DurableSessionStorage", "SessionStorage⟨TMetadata⟩"]);
    expect(await diagramNodeNames(page, 0)).toEqual(["SessionStorage⟨TMetadata⟩"]);

    const agentLink = definitionLink(page, "JuncoAgent");
    await expect(agentLink).toBeVisible();
    await expect(agentLink).toHaveAttribute("role", "link");
    await markPressedLink(page, "JuncoAgent");
    const point = await centreOf(agentLink);
    await tap(page, point);
    await page.waitForFunction(
      () =>
        document.querySelector("[data-pressed-link]") === null &&
        document.querySelectorAll("#svg-holder .uml-frame svg").length === 1 &&
        document.querySelector("#diagram-stage")?.getAttribute("aria-busy") === "false",
      undefined,
      { polling: "raf", timeout: 15_000 },
    );
    await tap(page, point);
    await expect(page.locator("#editor-path")).toHaveText("bulk-00/generated-00.ts", {
      timeout: 30_000,
    });
    await expect(page.locator(".cm-content")).toContainText(
      "export class JuncoAgent<TSkill, TTool, Ctx>",
    );
  } finally {
    await cleanupResource(resource);
  }
});

test("submits case-insensitive search only after Enter", async ({ browser }) => {
  test.setTimeout(150_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-search-mode-e2e-"));
    resource.fixtureRoot = fixtureRoot;
    const fixturePath = join(fixtureRoot, "index.ts");
    const initialSource = [
      "export class MixedCaseWidget {",
      '  value(): string { return "MixedCaseWidget"; }',
      "}",
      "",
    ].join("\n");
    await writeFile(fixturePath, initialSource);

    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    const cli = resource.clis.at(-1);
    if (!cli) throw new Error("managed CLI was not registered");
    await expectCliOutput(cli, "TS explorer listening at", 30_000);
    const initialReady = await withBound(
      watch.cacheReady,
      45_000,
      "case-insensitive search cache-ready",
    );
    await expect(treeRow(page, "index.ts")).toBeVisible({ timeout: 10_000 });

    const query = "mixedcasewidget";
    const searchInput = page.locator("#node-search");
    const checkbox = page.locator("#search-case-insensitive");
    const definitionResult = page.locator("#definition-results .definition-result", {
      hasText: "class · MixedCaseWidget",
    }).filter({ hasText: "index.ts:1" });
    const matchedTreeRow = page.locator('.tree-row.search-match[data-tree-path="index.ts"]');
    const isSearchRequest = (request: Request, caseInsensitive: boolean): boolean => {
      const url = new URL(request.url());
      return url.pathname === "/api/search" &&
        url.searchParams.get("q") === query &&
        url.searchParams.get("caseInsensitive") === String(caseInsensitive);
    };
    const isSearchResponse = (response: Response, caseInsensitive: boolean): boolean =>
      isSearchRequest(response.request(), caseInsensitive);
    const observedSearchRequests: Request[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/search") {
        observedSearchRequests.push(request);
      }
    });
    const readSearchDom = () =>
      page.evaluate(() => ({
        definitions: [...document.querySelectorAll("#definition-results .definition-result")]
          .map((element) => element.textContent),
        matchedTreePaths: [...document.querySelectorAll<HTMLElement>("#tree .tree-row.search-match")]
          .map((element) => element.dataset.treePath),
        invalid: document.querySelector("#node-search")?.getAttribute("aria-invalid") ?? null,
      }));

    await expect(checkbox).not.toBeChecked();
    const initialFalseResponse = page.waitForResponse(
      (response) => isSearchResponse(response, false),
    );
    await searchInput.fill(query);
    await searchInput.press("Enter");
    const falseResponse = await initialFalseResponse;
    expect(falseResponse.status()).toBe(200);
    await falseResponse.finished();
    await afterTwoAnimationFrames(page);
    await expect(definitionResult).toHaveCount(0);
    await expect(matchedTreeRow).toHaveCount(0);
    await expect(searchInput).toHaveAttribute("aria-invalid", "true");

    const falseDom = await readSearchDom();
    const requestsBeforeCheckedToggle = observedSearchRequests.length;
    await checkbox.check();
    await afterTwoAnimationFrames(page);
    expect(observedSearchRequests).toHaveLength(requestsBeforeCheckedToggle);
    expect(await readSearchDom()).toEqual(falseDom);

    const initialTrueResponse = page.waitForResponse(
      (response) => isSearchResponse(response, true),
    );
    await searchInput.press("Enter");
    expect((await initialTrueResponse).status()).toBe(200);
    await expect(definitionResult).toBeVisible();
    await expect(matchedTreeRow).toBeVisible();
    await expect(searchInput).not.toHaveAttribute("aria-invalid");
    await expect(page.locator("#dsl-content")).toContainText("%% Scope: .");
    await expect(page.locator("#svg-holder.stacked .uml-frame")).toHaveCount(1);
    await expect(page.locator("#svg-holder")).toContainText("index.ts");
    await expect(page.locator("#status")).toContainText("Search · 1 files");

    const trueDom = await readSearchDom();
    const requestsBeforeUncheckedToggle = observedSearchRequests.length;
    await checkbox.uncheck();
    await afterTwoAnimationFrames(page);
    expect(observedSearchRequests).toHaveLength(requestsBeforeUncheckedToggle);
    expect(await readSearchDom()).toEqual(trueDom);

    let resolveFalseCaptured!: (request: Request) => void;
    const falseCaptured = new Promise<Request>((resolve) => {
      resolveFalseCaptured = resolve;
    });
    let releaseFalse!: () => void;
    const falseRelease = new Promise<void>((resolve) => {
      releaseFalse = resolve;
    });
    let gatedFalseRequest: Request | undefined;
    const falseGate = async (route: Route): Promise<void> => {
      const request = route.request();
      if (gatedFalseRequest || !isSearchRequest(request, false)) {
        await route.continue();
        return;
      }
      gatedFalseRequest = request;
      resolveFalseCaptured(request);
      await falseRelease;
      await route.continue();
    };
    await page.route("**/api/search?*", falseGate);

    await searchInput.press("Enter");
    expect(await withBound(falseCaptured, 10_000, "captured stale false-mode search"))
      .toBe(gatedFalseRequest);
    await expect(definitionResult).toHaveCount(0);
    await expect(matchedTreeRow).toHaveCount(0);

    await checkbox.check();
    const racingTrueResponse = page.waitForResponse(
      (response) => isSearchResponse(response, true),
    );
    await searchInput.press("Enter");
    expect((await racingTrueResponse).status()).toBe(200);
    await expect(definitionResult).toBeVisible();
    await expect(matchedTreeRow).toBeVisible();
    const winningTrueDom = await readSearchDom();

    const staleFalseResponse = page.waitForResponse(
      (response) => isSearchResponse(response, false),
    );
    releaseFalse();
    const releasedFalseResponse = await staleFalseResponse;
    expect(releasedFalseResponse.status()).toBe(200);
    await releasedFalseResponse.finished();
    await page.unroute("**/api/search?*", falseGate);
    await afterTwoAnimationFrames(page);
    expect(await readSearchDom()).toEqual(winningTrueDom);
    await expect(definitionResult).toBeVisible();
    await expect(matchedTreeRow).toBeVisible();

    let forcedFailureCount = 0;
    const forceNextFalseFailure = async (route: Route): Promise<void> => {
      if (forcedFailureCount > 0 || !isSearchRequest(route.request(), false)) {
        await route.continue();
        return;
      }
      forcedFailureCount += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced search failure" }),
      });
    };
    await page.route("**/api/search?*", forceNextFalseFailure);
    await checkbox.uncheck();
    const failedFalseResponse = page.waitForResponse(
      (response) => isSearchResponse(response, false) && response.status() === 503,
    );
    await searchInput.press("Enter");
    expect((await failedFalseResponse).status()).toBe(503);
    await expect(page.locator("#status")).toHaveText("forced search failure");
    await expect(definitionResult).toHaveCount(0);
    await expect(matchedTreeRow).toHaveCount(0);
    await expect(searchInput).toHaveAttribute("aria-invalid", "true");
    expect(forcedFailureCount).toBe(1);
    await page.unroute("**/api/search?*", forceNextFalseFailure);

    const failedDom = await readSearchDom();
    const requestsBeforePendingRefreshToggle = observedSearchRequests.length;
    await checkbox.check();
    await afterTwoAnimationFrames(page);
    expect(observedSearchRequests).toHaveLength(requestsBeforePendingRefreshToggle);
    expect(await readSearchDom()).toEqual(failedDom);
    await expect(page.locator("#status")).toHaveText("forced search failure");

    const automaticRefreshRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/search",
      { timeout: 45_000 },
    );
    const refreshedFalseResponse = page.waitForResponse(async (response) => {
      if (!isSearchResponse(response, false) || response.status() !== 200) return false;
      const body = await response.json() as SearchResponse;
      return body.caseInsensitive === false && body.version > initialReady.version;
    }, { timeout: 45_000 });
    await writeFile(
      fixturePath,
      initialSource.replace(
        'return "MixedCaseWidget";',
        'return "MixedCaseWidgetAfterRefresh";',
      ),
    );
    await expectCliOutput(cli, "[sync] invalidate watch", 15_000);
    expect(isSearchRequest(await automaticRefreshRequest, false)).toBe(true);
    await expect.poll(
      () =>
        watch.history
          .filter((message) =>
            message.type === "cache-ready" && message.version > initialReady.version
          )
          .at(-1)?.version ?? initialReady.version,
      {
        message: `a promoted cache-ready version after editing the search fixture\n${describeCli(cli)}`,
        timeout: 45_000,
      },
    ).toBeGreaterThan(initialReady.version);
    const refreshResponse = await refreshedFalseResponse;
    const refreshBody = await refreshResponse.json() as SearchResponse;
    expect(refreshBody.caseInsensitive).toBe(false);
    expect(refreshBody.files).toEqual([]);
    expect(refreshBody.definitions).toEqual([]);
    await expect(checkbox).toBeChecked();
    await expect(definitionResult).toHaveCount(0);
    await expect(matchedTreeRow).toHaveCount(0);
    await expect(searchInput).toHaveAttribute("aria-invalid", "true");
  } finally {
    await cleanupResource(resource);
  }
});

test("prints the open file with light syntax colors", async ({ browser }) => {
  const resource = registerResource();
  try {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-print-e2e-"));
    resource.fixtureRoot = fixtureRoot;
    await writeFile(
      join(fixtureRoot, "index.ts"),
      [
        "export class PrintableWidget {",
        '  label(): string { return "printable"; }',
        "}",
        "",
      ].join("\n"),
    );

    const page = await openPage(browser, resource);
    await page.addInitScript(() => {
      const counter: PrintCounterWindow = window;
      counter.printCalls = 0;
      window.print = () => {
        counter.printCalls = (counter.printCalls ?? 0) + 1;
      };
    });
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await withBound(watch.cacheReady, 45_000, "print fixture cache-ready");

    await expect(page.locator("#editor-print")).toBeHidden();
    await expect(page.locator("#editor-empty")).toHaveText(
      "Double-click a file or definition to open its source.",
    );
    await openDefinitionSource(page, "index.ts", "PrintableWidget");
    await expect(page.locator("#editor-path")).toHaveText("index.ts", { timeout: 30_000 });
    await expect(page.locator("#editor-print")).toBeVisible();

    await page.locator("#editor-print").click();
    const printCalls = await page.evaluate(() => {
      const counter: PrintCounterWindow = window;
      return counter.printCalls;
    });
    expect(printCalls).toBe(1);

    await page.emulateMedia({ media: "print" });
    const printStyles = await page.evaluate(() => {
      const read = (selector: string, property: "color" | "backgroundColor" | "display") => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element)[property] : null;
      };
      return {
        keyword: read(".cm-content .tok-keyword", "color"),
        editor: read("#editor-panel .cm-editor", "backgroundColor"),
        topbar: read(".topbar", "display"),
        sidebar: read("#sidebar", "display"),
        close: read("#editor-close", "display"),
      };
    });
    expect(printStyles).toEqual({
      keyword: "rgb(215, 58, 73)",
      editor: "rgb(255, 255, 255)",
      topbar: "none",
      sidebar: "none",
      close: "none",
    });
    await page.emulateMedia({ media: null });
  } finally {
    await cleanupResource(resource);
  }
});

test("resolves concurrent file outlines independently and discards superseded ones", async ({ browser }) => {
  test.setTimeout(150_000);
  const resource = registerResource();
  try {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ts-explorer-outline-e2e-"));
    resource.fixtureRoot = fixtureRoot;
    await writeFile(join(fixtureRoot, "package.json"), JSON.stringify({ name: "outline-e2e" }));
    await writeFile(join(fixtureRoot, "alpha.ts"), "export const ALPHA: number = 1;\n");
    await writeFile(join(fixtureRoot, "beta.ts"), 'export const BETA: string = "b";\n');
    await writeFile(join(fixtureRoot, "gamma.ts"), "export const GAMMA: boolean = true;\n");

    const page = await openPage(browser, resource);
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await withBound(watch.cacheReady, 45_000, "outline fixture cache-ready");

    const outlineRoute = "**/api/file-definitions?*";

    /**
     * Holds only the *first* outline response for each named path; every later request passes
     * straight through, so a watcher-driven refetch can overtake a response that is still held.
     */
    const createOutlineGate = (paths: readonly string[]) => {
      type Signal = { promise: Promise<void>; resolve: () => void };
      const seen = new Map<string, Signal>();
      const held = new Map<string, Signal>();
      for (const path of paths) {
        seen.set(path, Promise.withResolvers<void>());
        held.set(path, Promise.withResolvers<void>());
      }
      const holding = new Set<string>();
      const handler = async (route: Route): Promise<void> => {
        const requested = new URL(route.request().url()).searchParams.get("path") ?? "";
        const gate = held.get(requested);
        if (!gate || holding.has(requested)) {
          await route.continue();
          return;
        }
        holding.add(requested);
        seen.get(requested)?.resolve();
        await gate.promise;
        await route.continue();
      };
      return {
        handler,
        captured: (path: string): Promise<void> =>
          seen.get(path)?.promise ?? Promise.reject(new Error(`ungated outline path: ${path}`)),
        release: (path: string) => held.get(path)?.resolve(),
      };
    };

    // Two outlines in flight, delivered in reverse order: each file settles on its own.
    const reverseGate = createOutlineGate(["alpha.ts", "beta.ts"]);
    await page.route(outlineRoute, reverseGate.handler);
    await treeToggle(page, "alpha.ts").click();
    await treeToggle(page, "beta.ts").click();
    await withBound(reverseGate.captured("alpha.ts"), 15_000, "alpha outline request");
    await withBound(reverseGate.captured("beta.ts"), 15_000, "beta outline request");
    await expect(outlineMessage(page, "alpha.ts")).toHaveText("Loading definitions…");
    await expect(outlineMessage(page, "beta.ts")).toHaveText("Loading definitions…");
    reverseGate.release("beta.ts");
    await expect(definitionNames(page, "beta.ts")).toHaveText(["BETA"]);
    await expect(outlineMessage(page, "alpha.ts")).toHaveText("Loading definitions…");
    reverseGate.release("alpha.ts");
    await expect(definitionNames(page, "alpha.ts")).toHaveText(["ALPHA"]);
    await expect(definitionNames(page, "beta.ts")).toHaveText(["BETA"]);
    await page.unroute(outlineRoute, reverseGate.handler);

    // Collapsing before delivery must neither re-expand the file nor open Editor.
    const collapseGate = createOutlineGate(["gamma.ts"]);
    await page.route(outlineRoute, collapseGate.handler);
    await treeToggle(page, "gamma.ts").click();
    await withBound(collapseGate.captured("gamma.ts"), 15_000, "held gamma outline");
    await treeToggle(page, "gamma.ts").click();
    await expect(treeToggle(page, "gamma.ts")).toHaveAttribute("aria-expanded", "false");
    await expect(definitionNames(page, "beta.ts")).toHaveText(["BETA"]);
    collapseGate.release("gamma.ts");
    await expect(treeToggle(page, "gamma.ts")).toHaveAttribute("aria-expanded", "false");
    await expect(definitionNames(page, "gamma.ts")).toHaveCount(0);
    await expect(definitionNames(page, "beta.ts")).toHaveText(["BETA"]);
    await expect(page.locator("#editor-panel")).toBeHidden();
    await page.unroute(outlineRoute, collapseGate.handler);

    // Re-expansion reuses the settled result instead of issuing another request.
    let requestsAfterSettle = 0;
    const countOutlineRequests = async (route: Route): Promise<void> => {
      requestsAfterSettle += 1;
      await route.continue();
    };
    await page.route(outlineRoute, countOutlineRequests);
    await treeToggle(page, "gamma.ts").click();
    await expect(definitionNames(page, "gamma.ts")).toHaveText(["GAMMA"]);
    expect(requestsAfterSettle).toBe(0);
    await page.unroute(outlineRoute, countOutlineRequests);

    // A response held from before a watcher invalidation must not overwrite the fresh list.
    const staleGate = createOutlineGate(["alpha.ts"]);
    await page.route(outlineRoute, staleGate.handler);
    await writeFile(join(fixtureRoot, "alpha.ts"), "export const ALPHA_TWO: number = 2;\n");
    await withBound(staleGate.captured("alpha.ts"), 45_000, "stale alpha outline");
    await writeFile(join(fixtureRoot, "alpha.ts"), "export const ALPHA_THREE: boolean = true;\n");
    await expect(definitionNames(page, "alpha.ts")).toHaveText(["ALPHA_THREE"], { timeout: 45_000 });
    staleGate.release("alpha.ts");
    await expect(definitionNames(page, "alpha.ts")).toHaveText(["ALPHA_THREE"]);
    await page.unroute(outlineRoute, staleGate.handler);

    // A failing outline reports its error inline; collapse and re-expand recovers the real list.
    let failBeta = true;
    const failOutline = async (route: Route): Promise<void> => {
      if (!failBeta || new URL(route.request().url()).searchParams.get("path") !== "beta.ts") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced outline failure" }),
      });
    };
    await page.route(outlineRoute, failOutline);
    await writeFile(join(fixtureRoot, "beta.ts"), 'export const BETA_TWO: string = "c";\n');
    await expect(outlineMessage(page, "beta.ts")).toHaveText("forced outline failure", {
      timeout: 45_000,
    });
    failBeta = false;
    await page.unroute(outlineRoute, failOutline);
    await treeToggle(page, "beta.ts").click();
    await treeToggle(page, "beta.ts").click();
    await expect(definitionNames(page, "beta.ts")).toHaveText(["BETA_TWO"], { timeout: 30_000 });
    await expect(page.locator("#editor-panel")).toBeHidden();
  } finally {
    await cleanupResource(resource);
  }
});
