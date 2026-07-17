import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import { createExplorerStore, ConflictError, InputError } from "./store.ts";
import { PathError } from "./paths.ts";
import type { WatchMessage } from "./types.ts";

export type ServerOptions = { sourceDir: string; host: string; port: number };

type Socket = ServerWebSocket<undefined>;

function jsonError(error: unknown): Response {
  const status = error instanceof ConflictError ? 409 : error instanceof InputError ? 422 : error instanceof PathError ? ({ BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404 }[error.code] ?? 400) : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "invalid JSON body");
  }
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
  const store = createExplorerStore(options.sourceDir, (error) => broadcast({ type: "watch-error", version: store.getVersion(), error: error.message }));
  server = Bun.serve<undefined>({
    hostname: options.host,
    port: options.port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request, { data: undefined })) return undefined;
        return new Response("websocket upgrade required", { status: 426 });
      }
      try {
        if (url.pathname === "/") return new Response(Bun.file(new URL("./web/index.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/main.js") return new Response(mainJs, { headers: { "content-type": "application/javascript; charset=utf-8" } });
        if (url.pathname === "/style.css") return new Response(Bun.file(new URL("./web/style.css", import.meta.url)), { headers: { "content-type": "text/css; charset=utf-8" } });
        if (url.pathname === "/api/tree") return Response.json({ version: store.getVersion(), root: await store.getTree() });
        if (url.pathname === "/api/packages") return Response.json({ version: store.getVersion(), packages: await store.getPackages() });
        if (url.pathname === "/api/diagram") {
          const kind = url.searchParams.get("kind");
          if (kind !== "packages" && kind !== "uml") throw new InputError("kind must be packages or uml");
          return Response.json(await store.getDiagram(kind, url.searchParams.get("path") ?? ""));
        }
        if (url.pathname === "/api/file" && request.method === "GET") return Response.json(await store.readFile(url.searchParams.get("path") ?? ""));
        if (url.pathname === "/api/file/format" && request.method === "POST") {
          const body = await parseBody(request);
          if (typeof body.path !== "string" || typeof body.content !== "string") throw new InputError("path and content are required");
          return Response.json({ path: body.path, content: await store.formatFile(body.path, body.content) });
        }
        if (url.pathname === "/api/file" && request.method === "PUT") {
          const body = await parseBody(request);
          if (typeof body.path !== "string" || typeof body.content !== "string" || typeof body.baseHash !== "string") throw new InputError("path, content, and baseHash are required");
          return Response.json(await store.writeFile(body.path, body.content, body.baseHash));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (error) {
        return jsonError(error);
      }
    },
    websocket: {
      open(socket) { clients.add(socket); socket.send(JSON.stringify({ type: "changed", version: store.getVersion(), paths: [], events: [] } satisfies WatchMessage)); },
      message() {},
      close(socket) { clients.delete(socket); },
    },
  });
  const originalApply = store.applyWatchBatch;
  store.applyWatchBatch = (paths, events) => { originalApply(paths, events); broadcast({ type: "changed", version: store.getVersion(), paths, events }); };
  await store.ready();
  return { port: server.port ?? options.port, async stop() { await store.close(); await server.stop(true); } };
}
