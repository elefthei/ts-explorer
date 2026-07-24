import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRelativePath } from "./paths.ts";
import {
  isPreprocessProgressEvent,
  isPreprocessResponse,
  type PreprocessCause,
  type PreprocessErrorCode,
  type PreprocessProgressEvent,
  type PreprocessRequest,
  type PreprocessResultMap,
  type PreprocessScope,
} from "./preprocess-protocol.ts";
import type {
  DiagramKind,
  DiagramResponse,
  FileResponse,
  GotoDefinition,
  PackageInfo,
  PreprocessPriorityResponse,
  PreprocessPriorityStatus,
  SearchResponse,
  TreeNode,
} from "./types.ts";

type RequestType = PreprocessRequest["type"];
type RequestMap = {
  [Type in RequestType]: Omit<Extract<PreprocessRequest, { type: Type }>, "id">;
};
type RequestFor<Type extends RequestType> = RequestMap[Type];
type QueuedRequest = RequestMap[RequestType];
type QueuePriority = "interactive" | "background";
type QueueJobState = "queued" | "processing" | "done";
type SlotState = "new" | "initializing" | "idle" | "busy" | "dead" | "closing" | "closed";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly settled: boolean;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

interface QueueJob {
  readonly request: QueuedRequest;
  priority: QueuePriority;
  state: QueueJobState;
  readonly generationId?: number;
  readonly deferred: Deferred<unknown>;
  readonly finished: Deferred<void>;
  retriedAfterCrash: boolean;
  retriedAfterSchemaRepair: boolean;
  cancelled: boolean;
}

interface PendingCall {
  readonly slot: SubprocessSlot;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface SubprocessSlot {
  readonly index: number;
  subprocess?: Bun.Subprocess;
  token: number;
  state: SlotState;
  current?: QueueJob;
  retirement?: Promise<void>;
  recovery?: Promise<void>;
  expectedShutdown: boolean;
}

interface ScopeRecord {
  readonly job: QueueJob;
  readonly promise: Promise<PreprocessResultMap["preprocess-scope"]>;
}

interface GenerationState {
  readonly id: number;
  readonly cause: PreprocessCause;
  readonly promoted: Deferred<void>;
  readonly discovered: Deferred<readonly PackageInfo[]>;
  readonly scopes: Map<string, ScopeRecord>;
  readonly scopeWaiters: Map<string, Deferred<ScopeRecord>[]>;
  packages: PackageInfo[];
  pendingMutations: number;
  discoveryComplete: boolean;
  promotionScheduled: boolean;
  superseded: boolean;
  failed: boolean;
  failure?: Error;
}

interface PriorityRequest {
  readonly requestId: number;
  readonly resource: string;
  status: PreprocessPriorityStatus;
  bindingToken: number;
  generationId?: number;
  job?: QueueJob;
  error?: Error;
}

class PreprocessorError extends Error {
  constructor(public readonly code: PreprocessErrorCode, message: string) {
    super(message);
    this.name = "PreprocessorError";
  }
}

class SubprocessExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubprocessExitedError";
  }
}

class SupersededGenerationError extends Error {
  constructor() {
    super("preprocessing generation was superseded");
    this.name = "SupersededGenerationError";
  }
}

function createDeferred<Value>(): Deferred<Value> {
  let settled = false;
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function findTreeKind(tree: TreeNode, path: string): "directory" | "file" | undefined {
  const stack = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.path === path) return node.kind;
    if (node.children) stack.push(...node.children);
  }
  return undefined;
}

function processCountOrDefault(value: number | undefined): number {
  const fallback = Math.max(1, Math.min(4, availableParallelism() - 1));
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(4, Math.floor(value)));
}

export class Preprocessor {
  private readonly sourceDir: string;
  private readonly onReady: () => void;
  private readonly onError: (error: Error) => void;
  private readonly poolSize: number;
  private readonly dbPath: string;
  private readonly onProgress: (event: PreprocessProgressEvent) => void;
  private readonly slots: SubprocessSlot[] = [];
  private readonly pendingCalls = new Map<number, PendingCall>();
  private readonly interactiveQueue: QueueJob[] = [];
  private readonly backgroundQueue: QueueJob[] = [];
  private readonly queryDedupe = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<number, GenerationState>();
  private readonly priorityRequests = new Map<number, PriorityRequest>();
  private readonly priorityRequestByResource = new Map<string, PriorityRequest>();
  private readonly priorityControllers = new Set<Promise<void>>();
  private readonly readyDeferred = createDeferred<void>();
  private idleDeferred = createDeferred<void>();
  private buildingSignal = createDeferred<void>();
  private nextRequestId = 1;
  private nextPriorityRequestId = 1;
  private activeGenerationId: number | null = null;
  private building: GenerationState | undefined;
  private latestBuildError: Error | undefined;
  private poolReady = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private watchRebuilding = false;
  private watchRequested = false;
  private watchLoop: Promise<void> | undefined;

  constructor(
    sourceDir: string,
    onReady: () => void,
    onError: (error: Error) => void,
    processCount?: number,
    onProgress: (event: PreprocessProgressEvent) => void = () => undefined,
  ) {
    this.sourceDir = sourceDir;
    this.onReady = onReady;
    this.onError = onError;
    this.poolSize = processCountOrDefault(processCount);
    this.dbPath = join(sourceDir, ".explore", "explore.db");
    this.onProgress = onProgress;
    void this.bootstrap();
  }

  public ready(): Promise<void> {
    return this.readyDeferred.promise;
  }
  
  public whenIdle(): Promise<void> {
    return this.idleDeferred.promise;
  }
  
  public getTree(): Promise<TreeNode> {
    return this.dedupe("read-tree", () => this.readStable<"read-tree">({ type: "read-tree" }));
  }
  
  public getPackages(): Promise<readonly PackageInfo[]> {
    return this.dedupe("read-packages", () => this.readPackagesAcrossGenerations());
  }
  
  public search(
    query: string,
    caseInsensitive: boolean,
  ): Promise<Omit<SearchResponse, "version">> {
    return this.dedupe(
      `search:${caseInsensitive ? "i" : "s"}:${query}`,
      () => this.readStable<"search">({ type: "search", query, caseInsensitive }),
    );
  }
  
  public getDiagram(
    kind: DiagramKind,
    scopePath: string,
  ): Promise<Omit<DiagramResponse, "version">> {
    let normalizedScopePath: string;
    try {
      normalizedScopePath = normalizeRelativePath(scopePath);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.dedupe(
      `read-diagram:${kind}:${normalizedScopePath}`,
      () => this.readDiagramAcrossGenerations(kind, normalizedScopePath),
    );
  }
  
  public readFile(
    relativePath: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    let path: string;
    try {
      path = normalizeRelativePath(relativePath);
    } catch (error) {
      return Promise.reject(error);
    }
    const locationKey = location ? `${location.line}:${location.column}` : "";
    return this.dedupe(
      `read-file:${path}:${locationKey}`,
      () => this.readFileAcrossGenerations(path, location),
    );
  }
  
  public getDefinition(
    path: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinition | null> {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelativePath(path);
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      !Number.isSafeInteger(location.line) ||
      location.line <= 0 ||
      !Number.isSafeInteger(location.column) ||
      location.column <= 0
    ) {
      return Promise.reject(
        new PreprocessorError("INVALID_INPUT", "line and column must be positive safe integers"),
      );
    }
    return this.dedupe(
      `read-definition:${normalizedPath}:${location.line}:${location.column}`,
      () => this.readDefinitionAcrossGenerations(normalizedPath, location),
    );
  }

  private closedError(): PreprocessorError {
    return new PreprocessorError("INTERNAL", "preprocessor is closed");
  }

  private prioritySnapshot(request: PriorityRequest): PreprocessPriorityResponse {
    return {
      status: request.status,
      resource: request.resource,
      requestId: request.requestId,
    };
  }
  
  private isTerminalPriorityRequest(request: PriorityRequest): boolean {
    return request.status === "done" || request.error !== undefined;
  }
  
  private releasePriorityResource(request: PriorityRequest): void {
    if (this.priorityRequestByResource.get(request.resource) === request) {
      this.priorityRequestByResource.delete(request.resource);
    }
  }
  
  private completePriorityRequest(request: PriorityRequest): void {
    if (request.error || request.status === "done") return;
    request.status = "done";
    request.job = undefined;
    this.releasePriorityResource(request);
  }
  
  private failPriorityRequest(request: PriorityRequest, error: unknown): void {
    if (request.error || request.status === "done") return;
    request.error = asError(error);
    request.job = undefined;
    this.releasePriorityResource(request);
  }
  
  private resetPriorityBinding(request: PriorityRequest): number {
    request.bindingToken += 1;
    request.generationId = undefined;
    request.job = undefined;
    request.status = "queued";
    return request.bindingToken;
  }
  
  private bindPriorityJob(
    request: PriorityRequest,
    bindingToken: number,
    generationId: number,
    job: QueueJob,
  ): boolean {
    if (request.bindingToken !== bindingToken || this.isTerminalPriorityRequest(request)) return false;
    request.generationId = generationId;
    request.job = job;
    if (!job.cancelled && (job.state === "queued" || job.state === "processing")) {
      request.status = job.state;
    }
    return true;
  }
  
  private resetPriorityRequestsForJob(job: QueueJob): void {
    for (const request of this.priorityRequests.values()) {
      if (request.job === job && !this.isTerminalPriorityRequest(request)) {
        request.status = "queued";
      }
    }
  }
  
  private evictTerminalPriorityRequests(): void {
    if (this.priorityRequests.size < 256) return;
    for (const [requestId, request] of this.priorityRequests) {
      if (!this.isTerminalPriorityRequest(request)) continue;
      this.priorityRequests.delete(requestId);
      if (this.priorityRequests.size < 256) return;
    }
  }
  
  private allocatePriorityRequestId(): number {
    while (this.priorityRequests.has(this.nextPriorityRequestId)) {
      this.nextPriorityRequestId = this.nextPriorityRequestId === Number.MAX_SAFE_INTEGER
        ? 1
        : this.nextPriorityRequestId + 1;
    }
    const requestId = this.nextPriorityRequestId;
    this.nextPriorityRequestId = this.nextPriorityRequestId === Number.MAX_SAFE_INTEGER
      ? 1
      : this.nextPriorityRequestId + 1;
    return requestId;
  }
  
  private notifyError(error: unknown): void {
    try {
      this.onError(asError(error));
    } catch {
      // A reporting callback must not break queue or subprocess lifecycle handling.
    }
  }
  
  private notifyProgress(event: PreprocessProgressEvent): void {
    try {
      this.onProgress(event);
    } catch {
      // A progress callback must not break queue or subprocess lifecycle handling.
    }
  }
  
  private resolveReadyCallback(): void {
    try {
      this.onReady();
    } catch (error) {
      this.notifyError(error);
    }
  }
  
  private rejectCallsForSlot(slot: SubprocessSlot, error: Error): void {
    for (const [id, pending] of this.pendingCalls) {
      if (pending.slot !== slot) continue;
      this.pendingCalls.delete(id);
      pending.reject(error);
    }
  }
  
  private subprocessFailureMessage(
    subprocess: Bun.Subprocess | undefined,
    exitCode?: number,
    disconnected = false,
  ): string {
    if (disconnected) return "preprocess child IPC disconnected unexpectedly";
    if (subprocess?.signalCode) {
      return `preprocess child exited with signal ${subprocess.signalCode}`;
    }
    if (exitCode !== undefined) return `preprocess child exited with code ${exitCode}`;
    return "preprocess child exited unexpectedly";
  }
  
  private markSubprocessDead(
    slot: SubprocessSlot,
    token: number,
    subprocess: Bun.Subprocess | undefined,
    error: Error,
  ): void {
    if (slot.token !== token || slot.state === "closed" || slot.state === "dead") return;
    if (slot.expectedShutdown || this.closed) return;
  
    const wasIdle = slot.state === "idle";
    slot.state = "dead";
    if (slot.subprocess === subprocess) slot.subprocess = undefined;
    slot.token += 1;
    this.rejectCallsForSlot(slot, error);
    if (subprocess) {
      if (subprocess.exitCode === null && !subprocess.killed) {
        try {
          subprocess.kill();
        } catch {
          // The subprocess may have exited between the checks and kill.
        }
      }
      slot.retirement = subprocess.exited.then(
        () => undefined,
        () => undefined,
      );
    }
    if (wasIdle) void this.recoverIdleSlot(slot, error);
  }
  
  private attachSubprocess(
    slot: SubprocessSlot,
  ): { subprocess: Bun.Subprocess; token: number } {
    const token = ++slot.token;
    slot.expectedShutdown = false;
    let spawned: Bun.Subprocess | undefined;
    const subprocess = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./preprocess-child.ts", import.meta.url)),
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        windowsHide: true,
        ipc: (message, source) => {
          if (slot.token !== token) return;
          if (isPreprocessProgressEvent(message)) {
            this.notifyProgress(message);
            return;
          }
          if (!isPreprocessResponse(message)) {
            this.markSubprocessDead(
              slot,
              token,
              source,
              new SubprocessExitedError("preprocess child returned an invalid response"),
            );
            return;
          }
          const pending = this.pendingCalls.get(message.id);
          if (!pending || pending.slot !== slot) return;
          this.pendingCalls.delete(message.id);
          if (message.ok) pending.resolve(message.value);
          else pending.reject(new PreprocessorError(message.error.code, message.error.message));
        },
        onDisconnect: () => {
          if (slot.expectedShutdown || this.closed) return;
          this.markSubprocessDead(
            slot,
            token,
            spawned,
            new SubprocessExitedError(
              this.subprocessFailureMessage(spawned, undefined, true),
            ),
          );
        },
      },
    );
    spawned = subprocess;
    if (slot.token === token) slot.subprocess = subprocess;
    void subprocess.exited.then(
      (exitCode) => {
        if (slot.token !== token) return;
        if (slot.expectedShutdown || this.closed) {
          slot.state = "closed";
          if (slot.subprocess === subprocess) slot.subprocess = undefined;
          this.rejectCallsForSlot(slot, this.closedError());
          return;
        }
        this.markSubprocessDead(
          slot,
          token,
          subprocess,
          new SubprocessExitedError(
            this.subprocessFailureMessage(subprocess, exitCode),
          ),
        );
      },
      (error) => {
        this.markSubprocessDead(
          slot,
          token,
          subprocess,
          new SubprocessExitedError(asError(error).message),
        );
      },
    );
    return { subprocess, token };
  }
  
  private sendToSlot<Type extends RequestType>(
    slot: SubprocessSlot,
    request: RequestFor<Type>,
  ): Promise<PreprocessResultMap[Type]> {
    const subprocess = slot.subprocess;
    const token = slot.token;
    if (!subprocess || slot.state === "dead" || slot.state === "closed") {
      return Promise.reject(
        new SubprocessExitedError("preprocess child is not available"),
      );
    }
    const id = this.nextRequestId++;
    const message = { ...request, id } as PreprocessRequest;
    return new Promise<PreprocessResultMap[Type]>((resolve, reject) => {
      this.pendingCalls.set(id, {
        slot,
        resolve(value) {
          resolve(value as PreprocessResultMap[Type]);
        },
        reject,
      });
      try {
        subprocess.send(message);
      } catch (error) {
        const failure = new SubprocessExitedError(asError(error).message);
        this.markSubprocessDead(slot, token, subprocess, failure);
        if (this.pendingCalls.delete(id)) reject(failure);
      }
    });
  }
  
  private async initializeSlot(
    slot: SubprocessSlot,
    recover: boolean,
  ): Promise<number | null> {
    if (slot.retirement) await slot.retirement;
    if (this.closed) throw this.closedError();
    slot.state = "initializing";
    let attached: { subprocess: Bun.Subprocess; token: number };
    try {
      attached = this.attachSubprocess(slot);
    } catch (error) {
      slot.state = "dead";
      throw asError(error);
    }
    const { subprocess, token } = attached;
    if (slot.token !== token || slot.subprocess !== subprocess) {
      if (subprocess.exitCode === null && !subprocess.killed) subprocess.kill();
      await subprocess.exited;
      slot.state = "dead";
      throw new SubprocessExitedError("preprocess child exited during spawn");
    }
    try {
      const result = await this.sendToSlot<"init">(slot, {
        type: "init",
        sourceDir: this.sourceDir,
        dbPath: this.dbPath,
        recover,
      });
      if (this.closed) throw this.closedError();
      slot.state = "idle";
      slot.retirement = undefined;
      return result.activeGenerationId;
    } catch (error) {
      slot.state = "dead";
      if (slot.subprocess === subprocess) {
        slot.subprocess = undefined;
        slot.token += 1;
      }
      if (subprocess.exitCode === null && !subprocess.killed) {
        try {
          subprocess.kill();
        } catch {
          // The subprocess may already have exited.
        }
      }
      await subprocess.exited;
      throw error;
    }
  }
  
  private async initializeSlotWithRetry(
    slot: SubprocessSlot,
    recover: boolean,
  ): Promise<number | null> {
    try {
      return await this.initializeSlot(slot, recover);
    } catch (firstError) {
      if (this.closed) throw firstError;
      return this.initializeSlot(slot, recover);
    }
  }
  
  private ensureSlotRecovery(slot: SubprocessSlot): Promise<void> {
    if (slot.recovery) return slot.recovery;
    const recovery = (async () => {
      if (slot.retirement) await slot.retirement;
      await this.initializeSlot(slot, false);
    })();
    slot.recovery = recovery.finally(() => {
      slot.recovery = undefined;
    });
    return slot.recovery;
  }
  
  private async recoverIdleSlot(
    slot: SubprocessSlot,
    failure: Error,
  ): Promise<void> {
    try {
      await this.ensureSlotRecovery(slot);
      this.dispatch();
    } catch (error) {
      const terminal = new PreprocessorError(
        "INTERNAL",
        `preprocess child ${slot.index} failed to respawn: ${asError(error).message || failure.message}`,
      );
      if (this.building) this.failGeneration(this.building, terminal, true);
      else this.notifyError(terminal);
    }
  }
  
  private queueFor(priority: QueuePriority): QueueJob[] {
    return priority === "interactive" ? this.interactiveQueue : this.backgroundQueue;
  }
  
  private enqueueRequest<Type extends RequestType>(
    request: RequestFor<Type>,
    priority: QueuePriority,
    generationId?: number,
  ): { job: QueueJob; promise: Promise<PreprocessResultMap[Type]> } {
    const deferred = createDeferred<unknown>();
    const finished = createDeferred<void>();
    const job: QueueJob = {
      request,
      priority,
      state: "queued",
      generationId,
      deferred,
      finished,
      retriedAfterCrash: false,
      retriedAfterSchemaRepair: false,
      cancelled: false,
    };
    if (this.closed) {
      job.cancelled = true;
      deferred.reject(this.closedError());
      finished.resolve(undefined);
    } else {
      this.queueFor(priority).push(job);
      this.dispatch();
    }
    return {
      job,
      promise: deferred.promise as Promise<PreprocessResultMap[Type]>,
    };
  }
  
  private repositionQueuedJob(job: QueueJob): void {
    if (job.cancelled || job.state !== "queued") return;
    let index = this.backgroundQueue.indexOf(job);
    if (index >= 0) {
      this.backgroundQueue.splice(index, 1);
    } else {
      index = this.interactiveQueue.indexOf(job);
      if (index < 0) return;
      this.interactiveQueue.splice(index, 1);
    }
    job.priority = "interactive";
    this.interactiveQueue.unshift(job);
    this.dispatch();
  }
  
  private nextJob(): QueueJob | undefined {
    let job = this.interactiveQueue.shift();
    while (job) {
      if (!job.cancelled) return job;
      job = this.interactiveQueue.shift();
    }
    job = this.backgroundQueue.shift();
    while (job) {
      if (!job.cancelled) return job;
      job = this.backgroundQueue.shift();
    }
    return undefined;
  }
  
  private dispatch(): void {
    if (!this.poolReady || this.closed) return;
    for (const slot of this.slots) {
      if (slot.state !== "idle") continue;
      const job = this.nextJob();
      if (!job) return;
      this.runJob(slot, job);
    }
  }
  
  private finishSlotJob(
    slot: SubprocessSlot,
    job: QueueJob,
    completed = true,
  ): void {
    if (slot.current === job) slot.current = undefined;
    if (
      !this.closed &&
      slot.subprocess &&
      slot.state !== "initializing" &&
      slot.state !== "dead"
    ) {
      slot.state = "idle";
    } else if (this.closed) {
      slot.state = "closing";
    }
    if (completed) job.finished.resolve(undefined);
  }

  private requeueJobForRetry(slot: SubprocessSlot, job: QueueJob): void {
    this.finishSlotJob(slot, job, false);
    job.state = "queued";
    this.resetPriorityRequestsForJob(job);
    this.queueFor(job.priority).unshift(job);
    this.dispatch();
  }
  
  private runJob(slot: SubprocessSlot, job: QueueJob): void {
    job.state = "processing";
    slot.state = "busy";
    slot.current = job;
    void this.sendToSlot(slot, job.request).then((value) => {
      job.state = "done";
      this.finishSlotJob(slot, job);
      if (!job.cancelled) job.deferred.resolve(value);
      this.dispatch();
    }).catch(async (error) => {
      if (
        error instanceof PreprocessorError
        && error.code === "SCHEMA_RETRY"
        && !job.retriedAfterSchemaRepair
        && !job.cancelled
        && !this.closed
      ) {
        job.retriedAfterSchemaRepair = true;
        this.requeueJobForRetry(slot, job);
        return;
      }

      if (error instanceof SubprocessExitedError) {
        if (job.cancelled || this.closed) {
          if (slot.retirement) await slot.retirement;
          this.finishSlotJob(slot, job);
          if (!job.cancelled) job.deferred.reject(this.closedError());
          if (!this.closed) {
            void this.ensureSlotRecovery(slot)
              .then(() => this.dispatch())
              .catch((recoveryError) => this.notifyError(recoveryError));
          }
          return;
        }
        if (!job.retriedAfterCrash) {
          job.retriedAfterCrash = true;
          try {
            await this.ensureSlotRecovery(slot);
            this.requeueJobForRetry(slot, job);
            return;
          } catch (recoveryError) {
            error = new SubprocessExitedError(
              `preprocess child failed during respawn: ${asError(recoveryError).message}`,
            );
          }
        } else {
          void this.ensureSlotRecovery(slot)
            .then(() => this.dispatch())
            .catch((recoveryError) => this.notifyError(recoveryError));
        }
        if (slot.retirement) await slot.retirement;
        this.finishSlotJob(slot, job);
        job.deferred.reject(error);
        const generation =
          job.generationId === undefined
            ? undefined
            : this.generations.get(job.generationId);
        if (generation && !generation.superseded && !generation.failed) {
          this.failGeneration(generation, asError(error), true);
        } else {
          this.notifyError(error);
        }
        this.dispatch();
        return;
      }
  
      this.finishSlotJob(slot, job);
      if (!job.cancelled) job.deferred.reject(error);
      this.dispatch();
    });
  }
  
  private removeQueuedGenerationJobs(
    generationId: number,
    error: Error,
  ): void {
    for (const queue of [this.interactiveQueue, this.backgroundQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index];
        if (!job) {
          throw new PreprocessorError("INTERNAL", "preprocessor queue is inconsistent");
        }
        if (job.generationId !== generationId) continue;
        queue.splice(index, 1);
        job.cancelled = true;
        job.deferred.reject(error);
        job.finished.resolve(undefined);
      }
    }
    for (const slot of this.slots) {
      const job = slot.current;
      if (!job || job.generationId !== generationId) continue;
      job.cancelled = true;
      job.deferred.reject(error);
    }
  }
  
  private drainGenerationJobs(generationId: number): Promise<void> {
    const active = this.slots.flatMap((slot) => {
      const job = slot.current;
      return job?.generationId === generationId ? [job.finished.promise] : [];
    });
    return Promise.all(active).then(() => undefined);
  }
  
  private rejectScopeWaiters(
    generation: GenerationState,
    error: Error,
  ): void {
    for (const waiters of generation.scopeWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    generation.scopeWaiters.clear();
  }
  
  private failGeneration(
    generation: GenerationState,
    cause: Error,
    processFailure: boolean,
  ): void {
    if (generation.failed || generation.superseded) return;
    generation.failed = true;
    generation.failure = cause;
    this.latestBuildError = cause;
    this.removeQueuedGenerationJobs(generation.id, cause);
    this.rejectScopeWaiters(generation, cause);
    generation.discovered.reject(cause);
    generation.promoted.reject(cause);
    if (this.building === generation) {
      this.building = undefined;
      this.buildingSignal = createDeferred<void>();
      this.watchRebuilding = false;
    }
    this.idleDeferred.reject(cause);
    void this.drainGenerationJobs(generation.id).then(() => {
      const discard = this.enqueueRequest<"discard-generation">(
        {
          type: "discard-generation",
          generationId: generation.id,
          mode: processFailure ? "failed" : "delete",
        },
        "interactive",
      ).promise;
      void discard.catch(() => undefined);
    });
    this.notifyError(cause);
  }
  
  private mutationFinished(generation: GenerationState): void {
    generation.pendingMutations = Math.max(0, generation.pendingMutations - 1);
    this.maybeSchedulePromotion(generation);
  }
  
  private wakeScopeWaiters(generation: GenerationState, path: string, record: ScopeRecord): void {
    const waiters = generation.scopeWaiters.get(path);
    if (!waiters) return;
    generation.scopeWaiters.delete(path);
    for (const waiter of waiters) waiter.resolve(record);
  }
  
  private enqueueScope(
    generation: GenerationState,
    rawScope: PreprocessScope,
    priority: QueuePriority,
    requiredTraversal: boolean,
  ): ScopeRecord {
    const scope: PreprocessScope = {
      path: normalizeRelativePath(rawScope.path),
      kind: rawScope.kind,
    };
    const existing = generation.scopes.get(scope.path);
    if (existing) {
      if (priority === "interactive") this.repositionQueuedJob(existing.job);
      return existing;
    }
  
    generation.pendingMutations += 1;
    const queued = this.enqueueRequest<"preprocess-scope">(
      {
        type: "preprocess-scope",
        generationId: generation.id,
        cause: generation.cause,
        scope,
        packages: generation.packages,
      },
      priority,
      generation.id,
    );
    const record: ScopeRecord = { job: queued.job, promise: queued.promise };
    generation.scopes.set(scope.path, record);
    this.wakeScopeWaiters(generation, scope.path, record);
    void record.promise.then((result) => {
      if (generation.superseded || generation.failed) return;
      for (const child of result.children) this.enqueueScope(generation, child, "background", true);
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      if (requiredTraversal) this.failGeneration(generation, asError(error), false);
    }).finally(() => this.mutationFinished(generation));
    return record;
  }
  
  private seedTraversal(generation: GenerationState, packages: readonly PackageInfo[]): void {
    for (const pkg of packages) {
      this.enqueueScope(generation, { path: pkg.path, kind: "package" }, "background", true);
    }
    this.enqueueScope(generation, { path: "", kind: "directory" }, "background", true);
  }
  
  private enqueueDiscovery(generation: GenerationState): void {
    generation.pendingMutations += 1;
    const discovery = this.enqueueRequest<"discover-packages">(
      { type: "discover-packages", generationId: generation.id },
      "background",
      generation.id,
    ).promise;
    void discovery.then((result) => {
      if (generation.superseded || generation.failed) return;
      const packages = result.packages.map((pkg) => ({ ...pkg, path: normalizeRelativePath(pkg.path) }));
      generation.packages = packages;
      generation.discoveryComplete = true;
      generation.discovered.resolve(packages);
      this.seedTraversal(generation, packages);
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      this.failGeneration(generation, asError(error), false);
    }).finally(() => this.mutationFinished(generation));
  }
  
  private maybeSchedulePromotion(generation: GenerationState): void {
    if (
      generation.superseded ||
      generation.failed ||
      generation.promotionScheduled ||
      !generation.discoveryComplete ||
      generation.pendingMutations !== 0
    ) return;
  
    generation.promotionScheduled = true;
    const promotion = this.enqueueRequest<"promote-generation">(
      { type: "promote-generation", generationId: generation.id },
      "background",
      generation.id,
    ).promise;
    void promotion.then(() => {
      if (generation.superseded || generation.failed) return;
      this.activeGenerationId = generation.id;
      this.latestBuildError = undefined;
      if (this.building === generation) {
        this.building = undefined;
        this.buildingSignal = createDeferred<void>();
      }
      generation.promoted.resolve(undefined);
      this.idleDeferred.resolve(undefined);
      this.watchRebuilding = false;
      this.queryDedupe.clear();
      this.resolveReadyCallback();
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      this.failGeneration(generation, asError(error), false);
    });
  }
  
  private async beginGeneration(cause: PreprocessCause): Promise<GenerationState> {
    const result = await this.enqueueRequest<"begin-generation">({ type: "begin-generation", cause }, "interactive").promise;
    if (this.closed) throw this.closedError();
    const generation: GenerationState = {
      id: result.generationId,
      cause,
      promoted: createDeferred<void>(),
      discovered: createDeferred<readonly PackageInfo[]>(),
      scopes: new Map(),
      scopeWaiters: new Map(),
      packages: [],
      pendingMutations: 0,
      discoveryComplete: false,
      promotionScheduled: false,
      superseded: false,
      failed: false,
    };
    this.generations.set(generation.id, generation);
    this.building = generation;
    this.latestBuildError = undefined;
    this.buildingSignal.resolve(undefined);
    this.enqueueDiscovery(generation);
    return generation;
  }
  
  private async supersedeGeneration(
    generation: GenerationState,
  ): Promise<void> {
    if (generation.superseded || generation.failed) return;
    generation.superseded = true;
    const error = new SupersededGenerationError();
    this.removeQueuedGenerationJobs(generation.id, error);
    this.rejectScopeWaiters(generation, error);
    generation.discovered.reject(error);
    generation.promoted.reject(error);
    if (this.building === generation) {
      this.building = undefined;
      this.buildingSignal = createDeferred<void>();
    }
    await this.drainGenerationJobs(generation.id);
    await this.enqueueRequest<"discard-generation">(
      {
        type: "discard-generation",
        generationId: generation.id,
        mode: "delete",
      },
      "interactive",
    ).promise;
  }
  
  private async awaitBuildingGeneration(): Promise<GenerationState> {
    while (!this.closed) {
      if (this.building && !this.building.superseded && !this.building.failed) return this.building;
      if (this.latestBuildError) throw this.latestBuildError;
      await this.buildingSignal.promise;
    }
    throw this.closedError();
  }
  
  private async runWatchLoop(): Promise<void> {
    try {
      await this.readyDeferred.promise;
      while (this.watchRequested && !this.closed) {
        this.watchRequested = false;
        if (this.idleDeferred.settled) this.idleDeferred = createDeferred<void>();
        const previous = this.building;
        if (previous) await this.supersedeGeneration(previous);
        if (this.closed) return;
        await this.beginGeneration("watch");
      }
    } catch (error) {
      if (!this.closed && !(error instanceof SupersededGenerationError)) {
        this.watchRebuilding = false;
        this.latestBuildError = asError(error);
        this.idleDeferred.reject(error);
        this.notifyError(error);
      }
    } finally {
      this.watchLoop = undefined;
      if (this.watchRequested && !this.closed) {
        this.watchLoop = this.runWatchLoop();
        void this.watchLoop.catch(() => undefined);
      }
    }
  }
  
  private async bootstrap(): Promise<void> {
    try {
      const initializer: SubprocessSlot = {
        index: 0,
        token: 0,
        state: "new",
        expectedShutdown: false,
      };
      this.slots.push(initializer);
      this.activeGenerationId = await this.initializeSlotWithRetry(initializer, true);
  
      const additional: SubprocessSlot[] = [];
      for (let index = 1; index < this.poolSize; index += 1) {
        const slot: SubprocessSlot = {
          index,
          token: 0,
          state: "new",
          expectedShutdown: false,
        };
        this.slots.push(slot);
        additional.push(slot);
      }
      await Promise.all(additional.map((slot) => this.initializeSlotWithRetry(slot, false)));
      if (this.closed) throw this.closedError();
      this.poolReady = true;
      this.dispatch();
      if (this.activeGenerationId === null) {
        await this.beginGeneration("startup");
      }
      this.readyDeferred.resolve(undefined);
      if (
        this.activeGenerationId !== null
        && !this.watchRebuilding
        && !this.watchRequested
      ) {
        this.idleDeferred.resolve(undefined);
        this.resolveReadyCallback();
      }
    } catch (error) {
      const failure = asError(error);
      this.readyDeferred.reject(failure);
      this.idleDeferred.reject(failure);
      this.notifyError(failure);
    }
  }
  
  private dedupe<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const existing = this.queryDedupe.get(key);
    if (existing) return existing as Promise<Value>;
    let promise: Promise<Value>;
    try {
      promise = operation();
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.queryDedupe.set(key, promise);
    void promise.finally(() => {
      if (this.queryDedupe.get(key) === promise) this.queryDedupe.delete(key);
    }).catch(() => undefined);
    return promise;
  }
  
  private async readStable<Type extends "read-tree" | "read-packages" | "search">(
    request: Omit<RequestFor<Type>, "generationId">,
  ): Promise<PreprocessResultMap[Type]> {
    await this.readyDeferred.promise;
    while (!this.closed) {
      if (this.watchRebuilding) {
        const generation = await this.awaitBuildingGeneration();
        try {
          await generation.promoted.promise;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
        continue;
      }
      if (this.activeGenerationId !== null) {
        return this.enqueueRequest<Type>(
          { ...request, generationId: this.activeGenerationId } as RequestFor<Type>,
          "interactive",
        ).promise;
      }
      const generation = await this.awaitBuildingGeneration();
      try {
        await generation.promoted.promise;
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw this.closedError();
  }
  
  private async readPackagesAcrossGenerations(): Promise<readonly PackageInfo[]> {
    await this.readyDeferred.promise;
    while (!this.closed) {
      if (this.watchRebuilding) {
        const generation = await this.awaitBuildingGeneration();
        try {
          await generation.promoted.promise;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
        continue;
      }
      if (this.activeGenerationId !== null) {
        return this.enqueueRequest<"read-packages">(
          { type: "read-packages", generationId: this.activeGenerationId },
          "interactive",
        ).promise;
      }
      const generation = await this.awaitBuildingGeneration();
      try {
        await generation.discovered.promise;
        return await this.enqueueRequest<"read-packages">(
          { type: "read-packages", generationId: generation.id },
          "interactive",
          generation.id,
        ).promise;
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw this.closedError();
  }
  
  private async inferBuildingScopeKind(path: string): Promise<"directory" | "file" | undefined> {
    if (path === "") return "directory";
    if (this.activeGenerationId === null) return undefined;
    try {
      const tree = await this.enqueueRequest<"read-tree">(
        { type: "read-tree", generationId: this.activeGenerationId },
        "interactive",
      ).promise;
      return findTreeKind(tree, path);
    } catch {
      return undefined;
    }
  }
  
  private async prioritizeScope(
    generation: GenerationState,
    path: string,
    knownKind?: "directory" | "file",
  ): Promise<ScopeRecord | undefined> {
    await generation.discovered.promise;
    if (generation.superseded) throw new SupersededGenerationError();
    if (generation.failed) throw generation.failure ?? new PreprocessorError("INTERNAL", "generation failed");
  
    const existing = generation.scopes.get(path);
    if (existing) {
      this.repositionQueuedJob(existing.job);
      return existing;
    }
  
    if (generation.promotionScheduled) {
      await generation.promoted.promise;
      return undefined;
    }
  
    const inferred = knownKind ?? await this.inferBuildingScopeKind(path);
    if (generation.superseded) throw new SupersededGenerationError();
    if (generation.failed) throw generation.failure ?? new PreprocessorError("INTERNAL", "generation failed");
    const discoveredWhileInferring = generation.scopes.get(path);
    if (discoveredWhileInferring) {
      this.repositionQueuedJob(discoveredWhileInferring.job);
      return discoveredWhileInferring;
    }
    if (generation.promotionScheduled) {
      await generation.promoted.promise;
      return undefined;
    }
    if (inferred) {
      return this.enqueueScope(generation, { path, kind: inferred }, "interactive", false);
    }
  
    const waiter = createDeferred<ScopeRecord>();
    const waiters = generation.scopeWaiters.get(path) ?? [];
    waiters.push(waiter);
    generation.scopeWaiters.set(path, waiters);
    void generation.promoted.promise.then(() => {
      if (!generation.scopes.has(path)) {
        waiter.reject(new PreprocessorError("NOT_FOUND", `path not found: ${path}`));
      }
    }, (error) => waiter.reject(error));
    return waiter.promise;
  }
  
  private async readPriorityDiagram(
    generation: GenerationState,
    kind: DiagramKind,
    scopePath: string,
  ): Promise<Omit<DiagramResponse, "version">> {
    if (kind === "packages") {
      await generation.discovered.promise;
    } else {
      const record = await this.prioritizeScope(generation, scopePath);
      if (record) await record.promise;
    }
    return this.enqueueRequest<"read-diagram">(
      { type: "read-diagram", generationId: generation.id, kind, scopePath },
      "interactive",
      generation.id,
    ).promise;
  }
  
  private async readDiagramAcrossGenerations(
    kind: DiagramKind,
    scopePath: string,
  ): Promise<Omit<DiagramResponse, "version">> {
    await this.readyDeferred.promise;
    while (!this.closed) {
      if (this.watchRebuilding) {
        const generation = await this.awaitBuildingGeneration();
        try {
          return await this.readPriorityDiagram(generation, kind, scopePath);
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }
  
      const selectedGenerationId = this.activeGenerationId;
      if (selectedGenerationId !== null) {
        try {
          return await this.enqueueRequest<"read-diagram">(
            { type: "read-diagram", generationId: selectedGenerationId, kind, scopePath },
            "interactive",
          ).promise;
        } catch (error) {
          if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
          if (this.activeGenerationId !== selectedGenerationId) continue;
          if (!this.building) throw error;
        }
      }
  
      const generation = await this.awaitBuildingGeneration();
      try {
        return await this.readPriorityDiagram(generation, kind, scopePath);
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw this.closedError();
  }
  
  private async readDefinitionAcrossGenerations(
    path: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinition | null> {
    const read = (generationId: number, generation?: GenerationState) =>
      this.enqueueRequest<"read-definition">(
        {
          type: "read-definition",
          generationId,
          path,
          line: location.line,
          column: location.column,
        },
        "interactive",
        generation?.id,
      ).promise;
  
    await this.readyDeferred.promise;
    while (!this.closed) {
      try {
        if (this.watchRebuilding) {
          const generation = await this.awaitBuildingGeneration();
          const definition = await read(generation.id, generation);
          if (generation.superseded || generation.failed) continue;
          if (this.watchRebuilding && this.building === generation) return definition;
          if (!this.watchRebuilding && this.activeGenerationId === generation.id) return definition;
          continue;
        }
  
        const selectedGenerationId = this.activeGenerationId;
        if (selectedGenerationId !== null) {
          const definition = await read(selectedGenerationId);
          if (this.watchRebuilding || this.activeGenerationId !== selectedGenerationId) continue;
          const selectedGeneration = this.generations.get(selectedGenerationId);
          if (selectedGeneration?.superseded || selectedGeneration?.failed) continue;
          if (definition || !this.building) return definition;
        }
  
        const generation = await this.awaitBuildingGeneration();
        const definition = await read(generation.id, generation);
        if (generation.superseded || generation.failed) continue;
        if (this.watchRebuilding) {
          if (this.building === generation) return definition;
          continue;
        }
        if (this.activeGenerationId === generation.id) return definition;
        if (this.activeGenerationId === selectedGenerationId && this.building === generation) {
          return definition;
        }
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw this.closedError();
  }
  
  private activePrioritySelectionIsCurrent(
    request: PriorityRequest,
    bindingToken: number,
    generationId: number,
  ): boolean {
    if (
      request.bindingToken !== bindingToken ||
      this.watchRebuilding ||
      this.activeGenerationId !== generationId
    ) return false;
    const generation = this.generations.get(generationId);
    return !generation || (!generation.superseded && !generation.failed);
  }
  
  private buildingPrioritySelectionIsCurrent(
    request: PriorityRequest,
    bindingToken: number,
    generation: GenerationState,
    fallbackActiveGenerationId: number | null,
  ): boolean {
    if (
      request.bindingToken !== bindingToken ||
      generation.superseded ||
      generation.failed
    ) return false;
    if (this.watchRebuilding) return this.building === generation;
    if (this.activeGenerationId === generation.id) return true;
    return this.activeGenerationId === fallbackActiveGenerationId && this.building === generation;
  }
  
  private async processPriorityGeneration(
    request: PriorityRequest,
    bindingToken: number,
    generation: GenerationState,
    fallbackActiveGenerationId: number | null,
  ): Promise<boolean> {
    request.generationId = generation.id;
    request.job = undefined;
    request.status = "queued";
    const scope = await this.prioritizeScope(generation, request.resource);
    if (
      !this.buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;
    if (!scope) return false;
    if (!this.bindPriorityJob(request, bindingToken, generation.id, scope.job)) return false;
    await scope.promise;
    if (
      !this.buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;
  
    const read = this.enqueueRequest<"read-diagram">(
      {
        type: "read-diagram",
        generationId: generation.id,
        kind: "uml",
        scopePath: request.resource,
      },
      "interactive",
      generation.id,
    );
    if (!this.bindPriorityJob(request, bindingToken, generation.id, read.job)) return false;
    await read.promise;
    if (
      !this.buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;
    this.completePriorityRequest(request);
    return true;
  }
  
  private async controlPriorityRequest(request: PriorityRequest): Promise<void> {
    try {
      await this.readyDeferred.promise;
      while (!this.closed && !this.isTerminalPriorityRequest(request)) {
        let bindingToken = this.resetPriorityBinding(request);
  
        if (this.watchRebuilding) {
          const generation = await this.awaitBuildingGeneration();
          if (
            !this.watchRebuilding ||
            this.building !== generation ||
            generation.superseded ||
            generation.failed ||
            request.bindingToken !== bindingToken
          ) continue;
          try {
            if (await this.processPriorityGeneration(request, bindingToken, generation, this.activeGenerationId)) return;
          } catch (error) {
            if (error instanceof SupersededGenerationError) continue;
            throw error;
          }
          continue;
        }
  
        const selectedGenerationId = this.activeGenerationId;
        if (selectedGenerationId !== null) {
          request.generationId = selectedGenerationId;
          const read = this.enqueueRequest<"read-diagram">(
            {
              type: "read-diagram",
              generationId: selectedGenerationId,
              kind: "uml",
              scopePath: request.resource,
            },
            "interactive",
          );
          if (!this.bindPriorityJob(request, bindingToken, selectedGenerationId, read.job)) continue;
          try {
            await read.promise;
            if (!this.activePrioritySelectionIsCurrent(request, bindingToken, selectedGenerationId)) continue;
            this.completePriorityRequest(request);
            return;
          } catch (error) {
            if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
            if (!this.activePrioritySelectionIsCurrent(request, bindingToken, selectedGenerationId)) continue;
            const fallback = this.building;
            if (!fallback) throw error;
            bindingToken = this.resetPriorityBinding(request);
            try {
              if (
                await this.processPriorityGeneration(
                  request,
                  bindingToken,
                  fallback,
                  selectedGenerationId,
                )
              ) return;
            } catch (fallbackError) {
              if (fallbackError instanceof SupersededGenerationError) continue;
              throw fallbackError;
            }
            continue;
          }
        }
  
        const generation = await this.awaitBuildingGeneration();
        if (
          !this.watchRebuilding &&
          this.activeGenerationId !== null &&
          this.activeGenerationId !== generation.id
        ) continue;
        try {
          if (await this.processPriorityGeneration(request, bindingToken, generation, null)) return;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }
      if (this.closed && !this.isTerminalPriorityRequest(request)) throw this.closedError();
    } catch (error) {
      this.failPriorityRequest(request, error);
    }
  }
  
  public prioritize(resource: string): Promise<PreprocessPriorityResponse> {
    let normalizedResource: string;
    try {
      normalizedResource = normalizeRelativePath(resource);
    } catch (error) {
      return Promise.reject(error);
    }
  
    const existing = this.priorityRequestByResource.get(normalizedResource);
    if (existing) {
      if (existing.job) {
        this.repositionQueuedJob(existing.job);
        if (
          !existing.job.cancelled &&
          (existing.job.state === "queued" || existing.job.state === "processing")
        ) {
          existing.status = existing.job.state;
        }
      }
      return Promise.resolve(this.prioritySnapshot(existing));
    }
  
    this.evictTerminalPriorityRequests();
    if (this.priorityRequests.size >= 256) {
      return Promise.reject(
        new PreprocessorError("INVALID_INPUT", "too many pending priority requests"),
      );
    }
    const request: PriorityRequest = {
      requestId: this.allocatePriorityRequestId(),
      resource: normalizedResource,
      status: "queued",
      bindingToken: 0,
    };
    this.priorityRequests.set(request.requestId, request);
    this.priorityRequestByResource.set(normalizedResource, request);
    const controller = this.controlPriorityRequest(request);
    this.priorityControllers.add(controller);
    void controller.finally(() => this.priorityControllers.delete(controller)).catch(() => undefined);
    return Promise.resolve(this.prioritySnapshot(request));
  }
  
  public poll(requestId: number): Promise<PreprocessPriorityResponse> {
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return Promise.reject(
        new PreprocessorError("INVALID_INPUT", "requestId must be a positive safe integer"),
      );
    }
    const request = this.priorityRequests.get(requestId);
    if (!request) {
      return Promise.reject(
        new PreprocessorError("NOT_FOUND", `priority request not found: ${requestId}`),
      );
    }
    if (request.error) return Promise.reject(request.error);
    if (
      request.job &&
      !request.job.cancelled &&
      (request.job.state === "queued" || request.job.state === "processing")
    ) {
      request.status = request.job.state;
    }
    return Promise.resolve(this.prioritySnapshot(request));
  }
  
  private async readPriorityFile(
    generation: GenerationState,
    path: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    const record = await this.prioritizeScope(generation, path, "file");
    if (record) await record.promise;
    return this.enqueueRequest<"read-file">(
      { type: "read-file", generationId: generation.id, path, ...(location ? { location } : {}) },
      "interactive",
      generation.id,
    ).promise;
  }
  
  private async readFileAcrossGenerations(
    path: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    await this.readyDeferred.promise;
    while (!this.closed) {
      if (this.watchRebuilding) {
        const generation = await this.awaitBuildingGeneration();
        try {
          return await this.readPriorityFile(generation, path, location);
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }
  
      const selectedGenerationId = this.activeGenerationId;
      if (selectedGenerationId !== null) {
        try {
          return await this.enqueueRequest<"read-file">(
            { type: "read-file", generationId: selectedGenerationId, path, ...(location ? { location } : {}) },
            "interactive",
          ).promise;
        } catch (error) {
          if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
          if (this.activeGenerationId !== selectedGenerationId) continue;
          if (!this.building) throw error;
        }
      }
  
      const generation = await this.awaitBuildingGeneration();
      try {
        return await this.readPriorityFile(generation, path, location);
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw this.closedError();
  }
  
  private async closeSubprocesses(): Promise<void> {
    const error = this.closedError();
    this.readyDeferred.reject(error);
    this.idleDeferred.reject(error);
    this.buildingSignal.reject(error);
    if (this.building) {
      this.building.discovered.reject(error);
      this.building.promoted.reject(error);
      this.rejectScopeWaiters(this.building, error);
    }
    for (const promise of this.queryDedupe.values()) {
      void promise.catch(() => undefined);
    }
    for (const queue of [this.interactiveQueue, this.backgroundQueue]) {
      for (const job of queue.splice(0)) {
        job.cancelled = true;
        job.deferred.reject(error);
        job.finished.resolve(undefined);
      }
    }
    for (const slot of this.slots) {
      if (slot.current) {
        slot.current.cancelled = true;
        slot.current.deferred.reject(error);
      }
    }
  
    const live = this.slots.flatMap((slot) =>
      slot.subprocess && slot.state !== "closed"
        ? [{ slot, subprocess: slot.subprocess }]
        : [],
    );
    const exitPromises = live.map(({ subprocess }) =>
      subprocess.exited.then(() => undefined),
    );
    for (const { slot } of live) {
      slot.expectedShutdown = true;
      slot.state = "closing";
      void this.sendToSlot<"shutdown">(slot, { type: "shutdown" }).catch(
        () => undefined,
      );
    }
    if (!live.length) return;
  
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      Promise.all(exitPromises).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!graceful) {
      for (const { subprocess } of live) {
        if (subprocess.exitCode !== null || subprocess.killed) continue;
        try {
          subprocess.kill();
        } catch {
          // The subprocess may already have exited.
        }
      }
    }
    await Promise.all(exitPromises);
  }

  public rebuild(cause: "watch"): void {
    if (cause !== "watch" || this.closed) return;
    this.watchRebuilding = true;
    this.watchRequested = true;
    this.latestBuildError = undefined;
    this.queryDedupe.clear();
    if (this.idleDeferred.settled) this.idleDeferred = createDeferred<void>();
    if (!this.watchLoop) {
      this.watchLoop = this.runWatchLoop();
      void this.watchLoop.catch(() => undefined);
    }
  }
  
  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.watchRequested = false;
    this.closePromise = this.closeSubprocesses()
      .then(() => Promise.all([...this.priorityControllers]).then(() => undefined))
      .finally(() => {
        for (const pending of this.pendingCalls.values()) pending.reject(this.closedError());
        this.pendingCalls.clear();
      });
    return this.closePromise;
  }
}
