import { PathError } from "./paths.ts";
import { createPreprocessor } from "./preprocessor.ts";
import type { PreprocessProgressEvent } from "./preprocess-protocol.ts";
import { readTree } from "./tree.ts";
import type {
  DiagramKind,
  DiagramResponse,
  FileResponse,
  GotoDefinitionLookupResponse,
  PackageInfo,
  PreprocessPriorityResponse,
  SearchResponse,
  TreeNode,
  WatchEventName,
} from "./types.ts";
import { startSourceWatcher } from "./watcher.ts";

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
  search(query: string): Promise<SearchResponse>;
  getDiagram(kind: DiagramKind, scopePath: string): Promise<DiagramResponse>;
  readFile(
    relativePath: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse>;
  getDefinition(
    relativePath: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinitionLookupResponse>;
  prioritize(resource: string): Promise<PreprocessPriorityResponse>;
  poll(requestId: number): Promise<PreprocessPriorityResponse>;
  applyWatchBatch(paths: string[], events: WatchEventName[]): void;
  close(): Promise<void>;
};

function mapPreprocessorError(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "INVALID_INPUT") throw new InputError(message);
  if (
    code === "BAD_REQUEST" ||
    code === "FORBIDDEN" ||
    code === "NOT_FOUND"
  ) {
    throw new PathError(code, message);
  }
  throw error;
}

async function fromPreprocessor<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    mapPreprocessorError(error);
  }
}

export function createExplorerStore(
  sourceDir: string,
  onError: (error: Error, version: number) => void = () => undefined,
  onCacheReady: (version: number) => void = () => undefined,
  onProgress: (event: PreprocessProgressEvent) => void = () => undefined,
): ExplorerStore {
  let version = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let treePromise: Promise<TreeNode> | undefined;
  let store: ExplorerStore;

  const reportError = (error: Error) => onError(error, version);
  const preprocessor = createPreprocessor(
    sourceDir,
    () => onCacheReady(version),
    reportError,
    undefined,
    onProgress,
  );
  const watcherPromise = startSourceWatcher(
    sourceDir,
    (paths, events) => store.applyWatchBatch(paths, events),
    reportError,
  );

  store = {
    sourceDir,
    getVersion: () => version,
    async ready() {
      await Promise.all([watcherPromise, preprocessor.ready()]);
    },
    getTree() {
      if (treePromise) return treePromise;
      const pendingTree: Promise<TreeNode> = readTree(sourceDir).catch((error) => {
        if (treePromise === pendingTree) treePromise = undefined;
        throw error;
      });
      treePromise = pendingTree;
      return pendingTree;
    },
    async getPackages() {
      return fromPreprocessor(() => preprocessor.getPackages());
    },
    async search(query) {
      const normalized = query.trim();
      if (!normalized) throw new InputError("search query is required");
      if (/[\r\n]/.test(normalized)) {
        throw new InputError("search query must be one line");
      }
      const result = await fromPreprocessor(() =>
        preprocessor.search(normalized),
      );
      return { version, ...result };
    },
    async getDiagram(kind, scopePath) {
      const requestedVersion = version;
      const result = await fromPreprocessor(() =>
        preprocessor.getDiagram(kind, scopePath),
      );
      return { version: requestedVersion, ...result };
    },
    async readFile(relativePath, location) {
      return fromPreprocessor(() =>
        preprocessor.readFile(relativePath, location),
      );
    },
    async getDefinition(relativePath, location) {
      const requestedVersion = version;
      const definition = await fromPreprocessor(() =>
        preprocessor.getDefinition(relativePath, location),
      );
      return { version: requestedVersion, definition };
    },
    prioritize(resource) {
      return fromPreprocessor(() => preprocessor.prioritize(resource));
    },
    poll(requestId) {
      return fromPreprocessor(() => preprocessor.poll(requestId));
    },
    applyWatchBatch(_paths, _events) {
      if (closed) return;
      version += 1;
      treePromise = undefined;
      preprocessor.rebuild("watch");
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.all([
        watcherPromise.then(
          (watcher) => watcher.close(),
          () => undefined,
        ),
        preprocessor.close(),
      ]).then(() => undefined);
      return closePromise;
    },
  };
  return store;
}

export type { ExplorerStore };
