import { PathError } from "./paths.ts";
import { Preprocessor } from "./preprocessor.ts";
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

export class ExplorerStore {
  private readonly sourceDir: string;
  private readonly onError: (error: Error, version: number) => void;
  private readonly onCacheReady: (version: number) => void;
  private readonly onProgress: (event: PreprocessProgressEvent) => void;
  private readonly onWatchBatch: (
    paths: string[],
    events: WatchEventName[],
    version: number,
  ) => void;
  private readonly preprocessor: Preprocessor;
  private readonly watcherPromise: Promise<{ close(): Promise<void> }>;
  private version = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private treePromise: Promise<TreeNode> | undefined;

  constructor(
    sourceDir: string,
    onError: (error: Error, version: number) => void = () => undefined,
    onCacheReady: (version: number) => void = () => undefined,
    onProgress: (event: PreprocessProgressEvent) => void = () => undefined,
    onWatchBatch: (
      paths: string[],
      events: WatchEventName[],
      version: number,
    ) => void = () => undefined,
  ) {
    this.sourceDir = sourceDir;
    this.onError = onError;
    this.onCacheReady = onCacheReady;
    this.onProgress = onProgress;
    this.onWatchBatch = onWatchBatch;
    this.preprocessor = new Preprocessor(
      this.sourceDir,
      () => this.onCacheReady(this.version),
      (error) => this.reportError(error),
      undefined,
      this.onProgress,
    );
    this.watcherPromise = startSourceWatcher(
      this.sourceDir,
      (paths, events) => this.applyWatchBatch(paths, events),
      (error) => this.reportError(error),
    );
  }

  getVersion(): number {
    return this.version;
  }

  async ready(): Promise<void> {
    await Promise.all([this.watcherPromise, this.preprocessor.ready()]);
  }

  getTree(): Promise<TreeNode> {
    if (this.treePromise) return this.treePromise;
    const pendingTree: Promise<TreeNode> = readTree(this.sourceDir).catch(
      (error) => {
        if (this.treePromise === pendingTree) this.treePromise = undefined;
        throw error;
      },
    );
    this.treePromise = pendingTree;
    return pendingTree;
  }

  async getPackages(): Promise<readonly PackageInfo[]> {
    return this.fromPreprocessor(() => this.preprocessor.getPackages());
  }

  async search(query: string): Promise<SearchResponse> {
    const normalized = query.trim();
    if (!normalized) throw new InputError("search query is required");
    if (/[\r\n]/.test(normalized)) {
      throw new InputError("search query must be one line");
    }
    const result = await this.fromPreprocessor(() =>
      this.preprocessor.search(normalized),
    );
    return { version: this.version, ...result };
  }

  async getDiagram(
    kind: DiagramKind,
    scopePath: string,
  ): Promise<DiagramResponse> {
    const requestedVersion = this.version;
    const result = await this.fromPreprocessor(() =>
      this.preprocessor.getDiagram(kind, scopePath),
    );
    return { version: requestedVersion, ...result };
  }

  async readFile(
    relativePath: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    return this.fromPreprocessor(() =>
      this.preprocessor.readFile(relativePath, location),
    );
  }

  async getDefinition(
    relativePath: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinitionLookupResponse> {
    const requestedVersion = this.version;
    const definition = await this.fromPreprocessor(() =>
      this.preprocessor.getDefinition(relativePath, location),
    );
    return { version: requestedVersion, definition };
  }

  prioritize(resource: string): Promise<PreprocessPriorityResponse> {
    return this.fromPreprocessor(() => this.preprocessor.prioritize(resource));
  }

  poll(requestId: number): Promise<PreprocessPriorityResponse> {
    return this.fromPreprocessor(() => this.preprocessor.poll(requestId));
  }

  applyWatchBatch(paths: string[], events: WatchEventName[]): void {
    if (this.closed) return;
    this.version += 1;
    this.treePromise = undefined;
    this.preprocessor.rebuild("watch");
    this.onWatchBatch(paths, events, this.version);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.all([
      this.watcherPromise.then(
        (watcher) => watcher.close(),
        () => undefined,
      ),
      this.preprocessor.close(),
    ]).then(() => undefined);
    return this.closePromise;
  }

  private reportError(error: Error): void {
    this.onError(error, this.version);
  }

  private mapPreprocessorError(error: unknown): never {
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

  private async fromPreprocessor<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.mapPreprocessorError(error);
    }
  }
}
