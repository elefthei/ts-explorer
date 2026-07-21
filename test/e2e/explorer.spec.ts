import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
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
  FileResponse,
  GotoDefinitionLookupResponse,
  PreprocessControlRequest,
  PreprocessPriorityResponse,
  WatchMessage,
} from "../../src/types.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputTailLimit = 64 * 1024;
const bindErrorPattern = /EADDRINUSE|port\b.*\bin use/i;
const retryableNavigationPattern = /ERR_CONNECTION_(?:REFUSED|RESET)|page\.goto: Timeout \d+ms exceeded/;

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

function withBound<Value>(
  promise: Promise<Value>,
  timeout: number,
  description: string,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeout}ms: ${description}`)),
      timeout,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
      "--dir",
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
  pending.forEach((resource) => resources.delete(resource));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "E2E cleanup failed");
}

async function createFixture(resource: TestResource): Promise<string> {
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
          `export const generated_${directory}_${file} = ${JSON.stringify(value)};\n`,
        );
      }),
    ).flat(),
  );
  return fixtureRoot;
}

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

function watchCacheReady(page: Page): {
  history: readonly WatchMessage[];
  cacheReady: Promise<WatchMessage>;
} {
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
    if (!settled && parsed.type === "cache-ready" && parsed.version === 0) {
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
    const retained = history.find(
      (message) => message.type === "cache-ready" && message.version === 0,
    );
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

type DefinitionRequestObservation = {
  path: string;
  line: number;
  column: number;
};

type DefinitionResponseObservation = DefinitionRequestObservation & {
  status: number;
  body: GotoDefinitionLookupResponse;
};

type PreprocessResponseObservation = {
  request: PreprocessControlRequest;
  status: number;
  body: PreprocessPriorityResponse;
};

function observeDefinitionApi(page: Page): {
  definitionRequests: DefinitionRequestObservation[];
  definitionResponses: DefinitionResponseObservation[];
  preprocessRequests: PreprocessControlRequest[];
  preprocessResponses: PreprocessResponseObservation[];
  flush(): Promise<void>;
  stop(): Promise<void>;
} {
  const definitionRequests: DefinitionRequestObservation[] = [];
  const definitionResponses: DefinitionResponseObservation[] = [];
  const preprocessRequests: PreprocessControlRequest[] = [];
  const preprocessResponses: PreprocessResponseObservation[] = [];
  const pending = new Set<Promise<void>>();

  const locationFromUrl = (url: URL): DefinitionRequestObservation => ({
    path: url.searchParams.get("path") ?? "",
    line: Number(url.searchParams.get("line")),
    column: Number(url.searchParams.get("column")),
  });
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/goto-definition") {
      definitionRequests.push(locationFromUrl(url));
      return;
    }
    if (url.pathname !== "/api/preprocess" || request.method() !== "POST") return;
    const body = request.postDataJSON() as PreprocessControlRequest;
    preprocessRequests.push(body);
  };
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/goto-definition" && url.pathname !== "/api/preprocess") return;
    let capture!: Promise<void>;
    capture = (async () => {
      if (url.pathname === "/api/goto-definition") {
        definitionResponses.push({
          ...locationFromUrl(url),
          status: response.status(),
          body: await response.json() as GotoDefinitionLookupResponse,
        });
        return;
      }
      preprocessResponses.push({
        request: response.request().postDataJSON() as PreprocessControlRequest,
        status: response.status(),
        body: await response.json() as PreprocessPriorityResponse,
      });
    })().finally(() => pending.delete(capture));
    pending.add(capture);
    void capture.catch(() => undefined);
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  const flush = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return {
    definitionRequests,
    definitionResponses,
    preprocessRequests,
    preprocessResponses,
    flush,
    async stop() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      await flush();
    },
  };
}

async function readDefinition(
  page: Page,
  location: DefinitionRequestObservation,
): Promise<{ status: number; body: GotoDefinitionLookupResponse }> {
  return page.evaluate(async (requested) => {
    const query = new URLSearchParams({
      path: requested.path,
      line: String(requested.line),
      column: String(requested.column),
    });
    const response = await fetch(`/api/goto-definition?${query}`);
    return {
      status: response.status,
      body: await response.json() as GotoDefinitionLookupResponse,
    };
  }, location);
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

test.afterEach(async ({}, testInfo) => {
  testInfo.setTimeout(20_000);
  await cleanupAll();
});

test("renders a live tree independently and observes cache completion", async ({ browser }) => {
  const resource = registerResource();
  try {
    const fixtureRoot = await createFixture(resource);
    resource.context = await browser.newContext();
    resource.page = await resource.context.newPage();
    const page = resource.page;
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);

    const bulk00 = page.locator('.tree-row[data-tree-path="bulk-00"]');
    await Promise.all([
      expect(page.locator("#source-label")).not.toHaveText("Loading source…", {
        timeout: 5_000,
      }),
      expect(bulk00).toBeVisible({ timeout: 5_000 }),
    ]);
    await bulk00.click();
    await expect(
      page.locator('.tree-row[data-tree-path="bulk-00/generated-00.ts"]'),
    ).toBeVisible();

    const filter = page.locator("#tree-filter");
    await filter.fill("generated-09.ts");
    await expect(
      page.locator('.tree-row[data-tree-path="bulk-23/generated-09.ts"]'),
    ).toBeVisible();
    await filter.fill("");

    await withBound(watch.cacheReady, 45_000, "cache-ready version 0");

    await page.locator('.tree-row[data-tree-path="marker.ts"]').click();
    await expect(page.locator("#editor-path")).toHaveText("marker.ts");
    await expect(page.locator(".cm-content")).toContainText("TREE_READY_BEFORE_CACHE");

    const search = await page.evaluate(async () => {
      const response = await fetch("/api/search?q=E2E_UNIQUE_SEARCH_TOKEN");
      const body = await response.json() as { files?: string[] };
      return { status: response.status, files: body.files };
    });
    expect(search).toEqual({
      status: 200,
      files: ["bulk-23/generated-09.ts"],
    });

    await bulk00.click();
    await expect(bulk00).toHaveAttribute("aria-expanded", "false");
    await bulk00.click();
    await expect(bulk00).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator('.tree-row[data-tree-path="bulk-00/generated-00.ts"]'),
    ).toBeVisible();
  } finally {
    await cleanupResource(resource);
  }
});

test("navigates definitions within the active surface and cancels stale priority work", async ({ browser }) => {
  const resource = registerResource();
  try {
    const fixtureRoot = await createFixture(resource);
    resource.context = await browser.newContext();
    resource.page = await resource.context.newPage();
    const page = resource.page;
    const watch = watchCacheReady(page);
    await navigateToCli(page, fixtureRoot, resource);
    await Promise.all([
      expect(page.locator("#source-label")).not.toHaveText("Loading source…", {
        timeout: 10_000,
      }),
      expect(page.locator('.tree-row[data-tree-path="00-ready.ts"]')).toBeVisible({
        timeout: 10_000,
      }),
    ]);
    const cli = resource.clis.at(-1);
    if (!cli) throw new Error("managed CLI was not registered");

    const immediateLocation = {
      path: "00-ready.ts",
      line: 1,
      column: 14,
    };
    const lateLocation = {
      path: "z-late/late-definition.ts",
      line: 1,
      column: 14,
    };
    await expect.poll(
      async () => (await readDefinition(page, immediateLocation)).body.definition?.qualifiedName,
      {
        message: "the early fixture definition to be indexed before the late source",
        timeout: 15_000,
      },
    ).toBe("ImmediateDefinition");
    expect(await readDefinition(page, lateLocation)).toMatchObject({
      status: 200,
      body: { definition: null },
    });

    const observation = observeDefinitionApi(page);
    try {
      const directoryPriorityRequest = page.waitForRequest((request) => {
        if (new URL(request.url()).pathname !== "/api/preprocess") return false;
        const body = request.postDataJSON() as PreprocessControlRequest;
        return body.action === "prioritize" && body.resource === "./z-late";
      });
      const directoryPriorityResponse = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== "/api/preprocess") return false;
        const body = response.request().postDataJSON() as PreprocessControlRequest;
        return body.action === "prioritize" && body.resource === "./z-late";
      });
      await page.locator('.tree-row[data-tree-path="z-late"]').click();

      expect((await directoryPriorityRequest).postDataJSON()).toEqual({
        action: "prioritize",
        resource: "./z-late",
      });
      await expect(page.locator("#diagram-loading")).toBeVisible();
      await expect(page.locator("#diagram-loading")).toHaveText("Loading...");
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "true");

      const directoryPriorityBody = await (await directoryPriorityResponse).json() as
        PreprocessPriorityResponse;
      expect(directoryPriorityBody.status).not.toBe("done");
      const lateLink = page.locator(
        '#svg-holder .uml-definition-link[data-source-path="z-late/late-definition.ts"]' +
        '[data-source-line="1"][data-source-column="14"]',
      );
      await expect(lateLink).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("#diagram-loading")).toBeHidden();
      await expect(page.locator("#diagram-stage")).toHaveAttribute("aria-busy", "false");
      await observation.flush();
      const directoryPolls = observation.preprocessResponses.filter(
        (response) => response.request.action === "poll" &&
          response.request.requestId === directoryPriorityBody.requestId,
      );
      expect(directoryPolls.length).toBeGreaterThan(0);
      expect(directoryPolls.at(-1)?.body.status).toBe("done");
      await expect(lateLink).toHaveAttribute("role", "link");
      await expect(lateLink).toHaveAttribute(
        "aria-label",
        "Open LateDefinition UML definition",
      );

      const firstLookup = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/goto-definition" &&
          url.searchParams.get("path") === lateLocation.path &&
          url.searchParams.get("line") === String(lateLocation.line) &&
          url.searchParams.get("column") === String(lateLocation.column);
      });
      const firstPriority = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== "/api/preprocess") return false;
        const body = response.request().postDataJSON() as PreprocessControlRequest;
        return body.action === "prioritize" &&
          body.resource === `./${lateLocation.path}`;
      });
      await lateLink.focus();
      await lateLink.press("Space");

      const firstLookupBody = await (await firstLookup).json() as GotoDefinitionLookupResponse;
      expect(firstLookupBody.definition).toBeNull();
      await expect(page.locator("#diagram-loading")).toBeVisible();
      await expect(page.locator("#diagram-loading")).toHaveText("Loading...");

      const priorityBody = await (await firstPriority).json() as PreprocessPriorityResponse;
      await expect.poll(
        () => observation.preprocessRequests.filter(
          (request) => request.action === "poll" &&
            request.requestId === priorityBody.requestId,
        ).length,
        {
          message: "a correlated browser poll for the late definition priority request",
          timeout: 15_000,
        },
      ).toBeGreaterThan(0);

      const canonicalTarget = page.locator(
        '#svg-holder .definition-target[data-source-path="z-late/late-definition.ts"]' +
        '[data-source-line="1"][data-source-column="14"]',
      );
      await expect(canonicalTarget).toBeVisible({ timeout: 30_000 });
      await expect(canonicalTarget).toBeFocused();
      await expect(page.locator("#uml-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#graph-panel")).toBeVisible();
      await expect(page.locator("#editor-panel")).toBeHidden();
      await expect(page.locator("#diagram-loading")).toBeHidden();

      await observation.flush();
      const lateDefinitionResponses = observation.definitionResponses.filter(
        (response) => response.path === lateLocation.path &&
          response.line === lateLocation.line &&
          response.column === lateLocation.column,
      );
      expect(lateDefinitionResponses.map((response) => ({
        status: response.status,
        definition: response.body.definition?.qualifiedName ?? null,
      }))).toEqual([
        { status: 200, definition: null },
        { status: 200, definition: "LateDefinition" },
      ]);
      const latePriorities = observation.preprocessResponses.filter(
        (response) => response.request.action === "prioritize" &&
          response.request.resource === `./${lateLocation.path}`,
      );
      expect(latePriorities).toHaveLength(1);
      expect(latePriorities[0]?.body.requestId).toBe(priorityBody.requestId);
      const latePolls = observation.preprocessResponses.filter(
        (response) => response.request.action === "poll" &&
          response.request.requestId === priorityBody.requestId,
      );
      expect(latePolls.length).toBeGreaterThan(0);
      expect(latePolls.every(
        (response) => response.status === 200 &&
          response.body.requestId === priorityBody.requestId,
      )).toBe(true);
      expect(latePolls.at(-1)?.body.status).toBe("done");

      const immediateTreeRow = page.locator('.tree-row[data-tree-path="00-ready.ts"]');
      await page.locator('.tree-row[data-tree-path="zz-stale"]').click();
      const staleLocation = {
        path: "zz-stale/stale-definition.ts",
        line: 1,
        column: 14,
      };
      const staleLink = page.locator(
        '#svg-holder .uml-definition-link[data-source-path="zz-stale/stale-definition.ts"]' +
        '[data-source-line="1"][data-source-column="14"]',
      );
      await expect(staleLink).toBeVisible({ timeout: 30_000 });
      expect(await readDefinition(page, staleLocation)).toMatchObject({
        status: 200,
        body: { definition: null },
      });

      await page.locator("#tree-filter").fill("00-ready.ts");
      await expect(immediateTreeRow).toBeVisible();
      const staleLookup = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/goto-definition" &&
          url.searchParams.get("path") === staleLocation.path &&
          url.searchParams.get("line") === String(staleLocation.line) &&
          url.searchParams.get("column") === String(staleLocation.column);
      });
      const stalePriority = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== "/api/preprocess") return false;
        const body = response.request().postDataJSON() as PreprocessControlRequest;
        return body.action === "prioritize" &&
          body.resource === `./${staleLocation.path}`;
      });
      await staleLink.focus();
      await staleLink.press("Enter");
      expect(
        (await (await staleLookup).json() as GotoDefinitionLookupResponse).definition,
      ).toBeNull();
      await expect(page.locator("#diagram-loading")).toBeVisible();
      const stalePriorityBody = await (await stalePriority).json() as PreprocessPriorityResponse;

      await immediateTreeRow.click();
      await expect(page.locator("#editor-path")).toHaveText("00-ready.ts");
      await expect(page.locator("#editor-panel")).toBeVisible();
      const staleLookupsAtCancellation = observation.definitionRequests.filter(
        (request) => request.path === staleLocation.path &&
          request.line === staleLocation.line &&
          request.column === staleLocation.column,
      ).length;
      const stalePollsAtCancellation = observation.preprocessRequests.filter(
        (request) => request.action === "poll" &&
          request.requestId === stalePriorityBody.requestId,
      ).length;

      await expectCliOutput(
        cli,
        "[sync] done code ./zz-stale/stale-definition.ts",
        30_000,
      );
      await observation.flush();
      expect(observation.definitionRequests.filter(
        (request) => request.path === staleLocation.path &&
          request.line === staleLocation.line &&
          request.column === staleLocation.column,
      )).toHaveLength(staleLookupsAtCancellation);
      expect(observation.preprocessRequests.filter(
        (request) => request.action === "poll" &&
          request.requestId === stalePriorityBody.requestId,
      )).toHaveLength(stalePollsAtCancellation);
      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#editor-panel")).toBeVisible();
      await expect(page.locator("#graph-panel")).toBeHidden();
      await expect(page.locator("#editor-path")).toHaveText("00-ready.ts");
      await expect(page.locator(
        '#svg-holder .definition-target[data-source-path="zz-stale/stale-definition.ts"]',
      )).toHaveCount(0);
      await withBound(watch.cacheReady, 45_000, "cache-ready before structured search");
      await immediateTreeRow.click();
      await expect(page.locator("#editor-path")).toHaveText("00-ready.ts");
      await expect(page.locator("#editor-panel")).toBeVisible();

      const searchInput = page.locator("#node-search");
      const searchResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/search" &&
          url.searchParams.get("q") === "ImmediateDefinition";
      });
      await searchInput.fill("ImmediateDefinition");
      await searchInput.press("Enter");
      expect((await searchResponse).status()).toBe(200);

      const immediateResult = page.locator("#definition-results .definition-result", {
        hasText: "class · ImmediateDefinition",
      }).filter({ hasText: "00-ready.ts:1" });
      await expect(immediateResult).toBeVisible();
      await expect(immediateResult).toHaveAttribute("role", "option");
      const resultLookup = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/goto-definition" &&
          url.searchParams.get("path") === immediateLocation.path &&
          url.searchParams.get("line") === String(immediateLocation.line) &&
          url.searchParams.get("column") === String(immediateLocation.column);
      });
      const resultFile = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/file" &&
          url.searchParams.get("path") === immediateLocation.path &&
          url.searchParams.get("line") === String(immediateLocation.line) &&
          url.searchParams.get("column") === String(immediateLocation.column);
      });
      await immediateResult.focus();
      await immediateResult.press("Enter");
      expect(
        (await (await resultLookup).json() as GotoDefinitionLookupResponse)
          .definition?.qualifiedName,
      ).toBe("ImmediateDefinition");
      const resultFileResponse = await resultFile;
      expect(resultFileResponse.status()).toBe(200);
      const resultFileBody = await resultFileResponse.json() as FileResponse;
      const immediateFileDefinition = resultFileBody.definitions.find(
        (definition) => definition.source.path === immediateLocation.path &&
          definition.source.line === immediateLocation.line &&
          definition.source.column === immediateLocation.column,
      );
      expect(immediateFileDefinition?.qualifiedName).toBe("ImmediateDefinition");
      expect(resultFileBody.cursorOffset).toBe(immediateFileDefinition?.displayFrom);

      await expect(page.locator("#editor-mode")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#editor-panel")).toBeVisible();
      await expect(page.locator("#graph-panel")).toBeHidden();
      await expect(page.locator("#editor-path")).toHaveText("00-ready.ts");
      const immediateMark = page.locator(
        '.editor-definition-link[data-source-path="00-ready.ts"]' +
        '[data-source-line="1"][data-source-column="14"]',
      );
      await expect(immediateMark).toHaveText("ImmediateDefinition");
      await expect(immediateMark).toBeVisible();
      await expect(page.locator(".cm-activeLine")).toContainText(
        "export class ImmediateDefinition",
      );
      await expect(page.locator(
        '.cm-activeLine .editor-definition-link[data-source-path="00-ready.ts"]' +
        '[data-source-line="1"][data-source-column="14"]',
      )).toHaveText("ImmediateDefinition");
    } finally {
      await observation.stop();
    }
  } finally {
    await cleanupResource(resource);
  }
});
