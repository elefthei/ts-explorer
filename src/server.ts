import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import { createExplorerStore, InputError } from "./store.ts";
import { PathError } from "./paths.ts";
import type { PreprocessProgressEvent } from "./preprocess-protocol.ts";
import type { PreprocessControlRequest, WatchMessage } from "./types.ts";

export type ServerOptions = {
  sourceDir: string;
  host: string;
  port: number;
  onSyncProgress?: (event: PreprocessProgressEvent) => void;
};

type Socket = ServerWebSocket<undefined>;

function jsonError(error: unknown): Response {
  const status =
    error instanceof InputError
      ? 422
      : error instanceof PathError
        ? ({ BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404 }[error.code] ??
          400)
        : 500;
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

function parseFileLocation(
  searchParams: URLSearchParams,
): { line: number; column: number } | undefined {
  const lineValue = searchParams.get("line");
  const columnValue = searchParams.get("column");
  if (lineValue === null && columnValue === null) return undefined;
  if (lineValue === null || columnValue === null) {
    throw new InputError("line and column must be provided together");
  }
  if (!/^[1-9]\d*$/.test(lineValue) || !/^[1-9]\d*$/.test(columnValue)) {
    throw new InputError("line and column must be positive integers");
  }
  const line = Number(lineValue);
  const column = Number(columnValue);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
    throw new InputError("line and column must be positive integers");
  }
  return { line, column };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parsePreprocessControlRequest(request: Request): Promise<PreprocessControlRequest> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InputError("request body must be valid JSON");
  }
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new InputError("preprocess request must be an object with an action");
  }
  if (value.action === "prioritize") {
    if (
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "resource") ||
      typeof value.resource !== "string"
    ) {
      throw new InputError("prioritize request must contain only action and resource");
    }
    return { action: "prioritize", resource: value.resource };
  }
  if (value.action === "poll") {
    if (
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "requestId") ||
      typeof value.requestId !== "number" ||
      !Number.isSafeInteger(value.requestId) ||
      value.requestId <= 0
    ) {
      throw new InputError("poll request must contain a positive safe requestId");
    }
    return { action: "poll", requestId: value.requestId };
  }
  throw new InputError("preprocess action must be prioritize or poll");
}

export async function startServer(options: ServerOptions): Promise<{ port: number; stop(): Promise<void> }> {
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL("./web/main.ts", import.meta.url))], target: "browser", format: "esm", minify: false });
  if (!bundle.success) throw new AggregateError(bundle.logs, "client bundle failed");
  const output = bundle.outputs[0];
  if (!output) throw new Error("client bundle produced no output");
  const mainJs = await output.arrayBuffer();
  const clients = new Set<Socket>();
  let server: Server<undefined>;
  const broadcast = (message: WatchMessage) => {
    const text = JSON.stringify(message);
    for (const client of clients) client.send(text);
  };
  let cacheReadyVersion: number | undefined;
  const store = createExplorerStore(
    options.sourceDir,
    (error, version) =>
      broadcast({
        type: "watch-error",
        version,
        error: error.message,
      }),
    (version) => {
      cacheReadyVersion = version;
      broadcast({ type: "cache-ready", version });
    },
    options.onSyncProgress,
  );
  server = Bun.serve<undefined>({
    hostname: options.host,
    port: options.port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request, { data: undefined })) return undefined;
        return new Response("websocket upgrade required", { status: 426 });
      }
      if (url.pathname.startsWith("/api/")) server.timeout(request, 0);
      try {
        if (url.pathname === "/") return new Response(Bun.file(new URL("./web/index.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/main.js") return new Response(mainJs, { headers: { "content-type": "application/javascript; charset=utf-8" } });
        if (url.pathname === "/style.css") return new Response(Bun.file(new URL("./web/style.css", import.meta.url)), { headers: { "content-type": "text/css; charset=utf-8" } });
        if (url.pathname === "/api/tree") return Response.json({ version: store.getVersion(), root: await store.getTree() });
        if (url.pathname === "/api/packages") return Response.json({ version: store.getVersion(), packages: await store.getPackages() });
        if (url.pathname === "/api/search") return Response.json(await store.search(url.searchParams.get("q") ?? ""));
        if (url.pathname === "/api/diagram") {
          const kind = url.searchParams.get("kind");
          if (kind !== "packages" && kind !== "uml") throw new InputError("kind must be packages or uml");
          return Response.json(await store.getDiagram(kind, url.searchParams.get("path") ?? ""));
        }
        if (url.pathname === "/api/preprocess" && request.method === "POST") {
          const control = await parsePreprocessControlRequest(request);
          return Response.json(
            control.action === "prioritize"
              ? await store.prioritize(control.resource)
              : await store.poll(control.requestId),
          );
        }
        if (url.pathname === "/api/goto-definition" && request.method === "GET") {
          const path = url.searchParams.get("path");
          const location = parseFileLocation(url.searchParams);
          if (path === null || location === undefined) {
            throw new InputError("path, line, and column are required");
          }
          return Response.json(await store.getDefinition(path, location));
        }
        if (url.pathname === "/api/file" && request.method === "GET") {
          return Response.json(
            await store.readFile(
              url.searchParams.get("path") ?? "",
              parseFileLocation(url.searchParams),
            ),
          );
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (error) {
        return jsonError(error);
      }
    },
    websocket: {
      open(socket) {
        clients.add(socket);
        const version = store.getVersion();
        socket.send(
          JSON.stringify({
            type: "changed",
            version,
            paths: [],
            events: [],
          } satisfies WatchMessage),
        );
        if (cacheReadyVersion === version) {
          socket.send(
            JSON.stringify({ type: "cache-ready", version } satisfies WatchMessage),
          );
        }
      },
      message() {},
      close(socket) { clients.delete(socket); },
    },
  });
  const originalApply = store.applyWatchBatch;
  store.applyWatchBatch = (paths, events) => {
    cacheReadyVersion = undefined;
    originalApply(paths, events);
    broadcast({ type: "changed", version: store.getVersion(), paths, events });
  };
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        await store.close();
      } finally {
        await server.stop(true);
      }
    })();
    return stopPromise;
  };
  try {
    await store.ready();
  } catch (error) {
    await stop();
    throw error;
  }
  return { port: server.port ?? options.port, stop };
}
