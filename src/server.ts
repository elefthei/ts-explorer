import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import { ExplorerStore, InputError } from "./store.ts";
import { PathError } from "./paths.ts";
import type { PreprocessProgressEvent } from "./preprocess-protocol.ts";
import type { PreprocessControlRequest, WatchEventName, WatchMessage } from "./types.ts";

type ServerOptions = {
  sourceDir: string;
  host: string;
  port: number;
  onSyncProgress?: (event: PreprocessProgressEvent) => void;
  onWatchBatch?: (paths: readonly string[], events: readonly WatchEventName[], version: number) => void;
};

type Socket = ServerWebSocket<undefined>;

export class ExplorerServer {
  private readonly options: ServerOptions;
  private readonly mainJs: ArrayBuffer;
  private readonly clients: Set<Socket>;
  private readonly store: ExplorerStore;
  private server: Server<undefined> | undefined;
  private cacheReadyVersion: number | undefined;
  private stopPromise: Promise<void> | undefined;

  static async start(options: ServerOptions): Promise<ExplorerServer> {
    const bundle = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./web/main.ts", import.meta.url)),
      ],
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (!bundle.success) {
      throw new AggregateError(bundle.logs, "client bundle failed");
    }
    const output = bundle.outputs[0];
    if (!output) throw new Error("client bundle produced no output");
    const explorerServer = new ExplorerServer(
      options,
      await output.arrayBuffer(),
    );
    try {
      explorerServer.listen();
      await explorerServer.store.ready();
      return explorerServer;
    } catch (error) {
      try {
        await explorerServer.cleanupFailedStart();
      } catch {
        // Preserve the original startup failure.
      }
      throw error;
    }
  }

  private constructor(options: ServerOptions, mainJs: ArrayBuffer) {
    this.options = options;
    this.mainJs = mainJs;
    this.clients = new Set<Socket>();
    this.cacheReadyVersion = undefined;
    this.stopPromise = undefined;
    this.store = new ExplorerStore(
      options.sourceDir,
      (error, version) =>
        this.broadcast({
          type: "watch-error",
          version,
          error: error.message,
        }),
      (version) => {
        this.cacheReadyVersion = version;
        this.broadcast({ type: "cache-ready", version });
      },
      options.onSyncProgress,
      (paths, events, version) => {
        this.cacheReadyVersion = undefined;
        this.broadcast({ type: "changed", version, paths, events });
        try {
          options.onWatchBatch?.(paths, events, version);
        } catch {
          // Diagnostics must not interrupt watcher or client delivery.
        }
      },
    );
  }

  get port(): number {
    return this.server?.port ?? this.options.port;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      try {
        await this.store.close();
      } finally {
        await this.server?.stop(true);
      }
    })();
    return this.stopPromise;
  }

  private listen(): void {
    this.server = Bun.serve<undefined>({
      hostname: this.options.host,
      port: this.options.port,
      fetch: (request) => this.fetch(request),
      websocket: {
        open: (socket) => this.openSocket(socket),
        message: () => undefined,
        close: (socket) => this.closeSocket(socket),
      },
    });
  }

  private broadcast(message: WatchMessage): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) client.send(text);
  }

  private async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (this.server?.upgrade(request, { data: undefined })) return undefined;
      return new Response("websocket upgrade required", { status: 426 });
    }
    if (url.pathname.startsWith("/api/")) this.server?.timeout(request, 0);
    try {
      if (url.pathname === "/") {
        return new Response(
          Bun.file(new URL("./web/index.html", import.meta.url)),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/main.js") {
        return new Response(this.mainJs, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      if (url.pathname === "/style.css") {
        return new Response(
          Bun.file(new URL("./web/style.css", import.meta.url)),
          { headers: { "content-type": "text/css; charset=utf-8" } },
        );
      }
      if (url.pathname === "/api/tree") {
        return Response.json({
          version: this.store.getVersion(),
          root: await this.store.getTree(),
        });
      }
      if (url.pathname === "/api/packages") {
        return Response.json({
          version: this.store.getVersion(),
          packages: await this.store.getPackages(),
        });
      }
      if (url.pathname === "/api/search") {
        const caseInsensitiveValue = url.searchParams.get("caseInsensitive");
        if (
          caseInsensitiveValue !== null
          && caseInsensitiveValue !== "true"
          && caseInsensitiveValue !== "false"
        ) {
          throw new InputError("caseInsensitive must be true or false");
        }
        return Response.json(
          await this.store.search(
            url.searchParams.get("q") ?? "",
            caseInsensitiveValue === "true",
          ),
        );
      }
      if (url.pathname === "/api/diagram") {
        const kind = url.searchParams.get("kind");
        if (kind !== "packages" && kind !== "uml") {
          throw new InputError("kind must be packages or uml");
        }
        return Response.json(
          await this.store.getDiagram(
            kind,
            url.searchParams.get("path") ?? "",
          ),
        );
      }
      if (url.pathname === "/api/preprocess" && request.method === "POST") {
        const control =
          await ExplorerServer.parsePreprocessControlRequest(request);
        return Response.json(
          control.action === "prioritize"
            ? await this.store.prioritize(control.resource)
            : await this.store.poll(control.requestId),
        );
      }
      if (
        url.pathname === "/api/goto-definition" &&
        request.method === "GET"
      ) {
        const path = url.searchParams.get("path");
        const location = ExplorerServer.parseFileLocation(url.searchParams);
        if (path === null || location === undefined) {
          throw new InputError("path, line, and column are required");
        }
        return Response.json(await this.store.getDefinition(path, location));
      }
      if (url.pathname === "/api/file" && request.method === "GET") {
        return Response.json(
          await this.store.readFile(
            url.searchParams.get("path") ?? "",
            ExplorerServer.parseFileLocation(url.searchParams),
          ),
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return ExplorerServer.jsonError(error);
    }
  }

  private openSocket(socket: Socket): void {
    this.clients.add(socket);
    const version = this.store.getVersion();
    socket.send(
      JSON.stringify({
        type: "changed",
        version,
        paths: [],
        events: [],
      } satisfies WatchMessage),
    );
    if (this.cacheReadyVersion === version) {
      socket.send(
        JSON.stringify({ type: "cache-ready", version } satisfies WatchMessage),
      );
    }
  }

  private closeSocket(socket: Socket): void {
    this.clients.delete(socket);
  }

  private async cleanupFailedStart(): Promise<void> {
    try {
      await this.store.close();
    } finally {
      if (this.server) await this.server.stop(true);
    }
  }

  private static jsonError(error: unknown): Response {
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

  private static parseFileLocation(
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

  private static isRecord(
    value: unknown,
  ): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static async parsePreprocessControlRequest(
    request: Request,
  ): Promise<PreprocessControlRequest> {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      throw new InputError("request body must be valid JSON");
    }
    if (
      !ExplorerServer.isRecord(value) ||
      typeof value.action !== "string"
    ) {
      throw new InputError(
        "preprocess request must be an object with an action",
      );
    }
    if (value.action === "prioritize") {
      if (
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "resource") ||
        typeof value.resource !== "string"
      ) {
        throw new InputError(
          "prioritize request must contain only action and resource",
        );
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
        throw new InputError(
          "poll request must contain a positive safe requestId",
        );
      }
      return { action: "poll", requestId: value.requestId };
    }
    throw new InputError("preprocess action must be prioritize or poll");
  }
}
