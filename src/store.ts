import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { buildPackageDiagram, discoverPackages } from "./packages.ts";
import { ensureRegularFile, resolveInside } from "./paths.ts";
import { readTree } from "./tree.ts";
import { isEditablePath, isTypeScriptPath, type DiagramKind, type DiagramResponse, type FileResponse, type PackageInfo, type TreeNode, type WatchEventName } from "./types.ts";
import { buildUmlDiagrams } from "./uml.ts";
import { startSourceWatcher } from "./watcher.ts";

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor() {
    super("file changed on disk; reload before saving");
    this.name = "ConflictError";
  }
}

export class InputError extends Error {
  readonly code = "INVALID_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

type ExplorerStore = {
  readonly sourceDir: string;
  getVersion(): number;
  ready(): Promise<void>;
  getTree(): Promise<TreeNode>;
  getPackages(): Promise<readonly PackageInfo[]>;
  getDiagram(kind: DiagramKind, scopePath: string): Promise<DiagramResponse>;
  readFile(relativePath: string): Promise<FileResponse>;
  formatFile(relativePath: string, content: string): Promise<string>;
  writeFile(relativePath: string, content: string, baseHash: string): Promise<FileResponse>;
  applyWatchBatch(paths: string[], events: WatchEventName[]): void;
  close(): Promise<void>;
};

type DiagramPayload = Pick<
  DiagramResponse,
  "dsl" | "dsls" | "sources" | "externalUsers" | "localUsers"
>;

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function decodeUtf8(buffer: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new InputError("file is not valid UTF-8 text");
  }
}

export function createExplorerStore(sourceDir: string, onWatcherError?: (error: Error) => void): ExplorerStore {
  let version = 0;
  let treeCache: TreeNode | undefined;
  let packagesCache: readonly PackageInfo[] | undefined;
  const diagramCache = new Map<string, DiagramResponse>();
  const lastGood = new Map<string, DiagramPayload>();
  let closed = false;
  const watcherPromise = startSourceWatcher(sourceDir, (paths, events) => store.applyWatchBatch(paths, events), onWatcherError ?? (() => undefined));

  const store: ExplorerStore = {
    sourceDir,
    getVersion: () => version,
    ready: async () => { await watcherPromise; },
    async getTree() {
      if (!treeCache) treeCache = await readTree(sourceDir);
      return treeCache;
    },
    async getPackages() {
      if (!packagesCache) packagesCache = await discoverPackages(sourceDir);
      return packagesCache;
    },
    async getDiagram(kind, scopePath) {
      const cacheKey = `${kind}:${scopePath}`;
      const cached = diagramCache.get(cacheKey);
      if (cached && cached.version === version) return cached;
      const requestedVersion = version;
      try {
        let diagram: DiagramPayload;
        if (kind === "packages") {
          const dsl = buildPackageDiagram(await store.getPackages());
          diagram = { dsl, dsls: [dsl], sources: [], externalUsers: [], localUsers: [] };
        } else {
          const uml = await buildUmlDiagrams(sourceDir, scopePath, await store.getPackages());
          diagram = {
            dsl: uml.dsl,
            dsls: uml.dsls,
            sources: uml.sources,
            externalUsers: uml.externalUsers,
            localUsers: uml.localUsers,
          };
        }
        const response: DiagramResponse = { kind, scopePath, version: requestedVersion, status: "ready", ...diagram };
        if (requestedVersion === version) {
          diagramCache.set(cacheKey, response);
          lastGood.set(cacheKey, diagram);
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = kind === "packages" ? "flowchart LR" : "classDiagram";
        const diagram = lastGood.get(cacheKey) ?? {
          dsl: fallback,
          dsls: [fallback],
          sources: [],
          externalUsers: [],
          localUsers: [],
        };
        const response: DiagramResponse = {
          kind,
          scopePath,
          version,
          status: "error",
          ...diagram,
          error: message,
        };
        diagramCache.set(cacheKey, response);
        return response;
      }
    },
    async readFile(relativePath) {
      const absolute = await resolveInside(sourceDir, relativePath, true);
      const content = decodeUtf8(await readFile(absolute));
      return { path: relativePath.replaceAll("\\", "/"), content, hash: hashContent(content), editable: isEditablePath(relativePath) };
    },
    async formatFile(relativePath, content) {
      if (!isTypeScriptPath(relativePath) || typeof content !== "string" || content.includes("\0")) {
        throw new InputError("only UTF-8 TypeScript text can be formatted");
      }
      const absolute = await resolveInside(sourceDir, relativePath, true);
      await ensureRegularFile(absolute);
      try {
        return await format(content, { filepath: absolute, parser: "typescript" });
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : String(error));
      }
    },
    async writeFile(relativePath, content, baseHash) {
      if (!isEditablePath(relativePath) || typeof content !== "string" || content.includes("\0") || typeof baseHash !== "string") {
        throw new InputError("only editable UTF-8 TypeScript files can be saved");
      }
      const absolute = await resolveInside(sourceDir, relativePath, true);
      await ensureRegularFile(absolute);
      const current = decodeUtf8(await readFile(absolute));
      if (hashContent(current) !== baseHash) throw new ConflictError();
      await writeFile(absolute, content, "utf8");
      return store.readFile(relativePath);
    },
    applyWatchBatch(paths, _events) {
      if (closed) return;
      version += 1;
      treeCache = undefined;
      packagesCache = undefined;
      diagramCache.clear();
      for (const key of [...lastGood.keys()]) {
        if (paths.some((path) => key.includes(path))) lastGood.delete(key);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const watcher = await watcherPromise;
      await watcher.close();
    },
  };
  return store;
}

export type { ExplorerStore };
