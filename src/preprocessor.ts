import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRelativePath } from "./paths.ts";
import {
  isPreprocessProgressEvent,
  isPreprocessResponse,
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

export type Preprocessor = {
  ready(): Promise<void>;
  whenIdle(): Promise<void>;
  getTree(): Promise<TreeNode>;
  getPackages(): Promise<readonly PackageInfo[]>;
  search(query: string): Promise<Omit<SearchResponse, "version">>;
  getDiagram(kind: DiagramKind, scopePath: string): Promise<Omit<DiagramResponse, "version">>;
  readFile(relativePath: string, location?: { line: number; column: number }): Promise<FileResponse>;
  getDefinition(
    path: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinition | null>;
  prioritize(resource: string): Promise<PreprocessPriorityResponse>;
  poll(requestId: number): Promise<PreprocessPriorityResponse>;
  rebuild(cause: "watch"): void;
  close(): Promise<void>;
};

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
  crashRetries: number;
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
  exitSignal: Deferred<void>;
  retirement?: Promise<void>;
  recovery?: Promise<void>;
  expectedShutdown: boolean;
}

interface ScopeRecord {
  readonly scope: PreprocessScope;
  readonly job: QueueJob;
  readonly promise: Promise<PreprocessResultMap["preprocess-scope"]>;
}

interface GenerationState {
  readonly id: number;
  readonly cause: "startup" | "watch";
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
  while (stack.length) {
    const node = stack.pop()!;
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

export function createPreprocessor(
  sourceDir: string,
  onReady: () => void,
  onError: (error: Error) => void,
  processCount?: number,
  onProgress: (event: PreprocessProgressEvent) => void = () => undefined,
): Preprocessor {
  const poolSize = processCountOrDefault(processCount);
  const dbPath = join(sourceDir, ".explore", "explore.db");
  const slots: SubprocessSlot[] = [];
  const pendingCalls = new Map<number, PendingCall>();
  const interactiveQueue: QueueJob[] = [];
  const backgroundQueue: QueueJob[] = [];
  const queryDedupe = new Map<string, Promise<unknown>>();
  const generations = new Map<number, GenerationState>();
  const priorityRequests = new Map<number, PriorityRequest>();
  const priorityRequestByResource = new Map<string, PriorityRequest>();
  const priorityControllers = new Set<Promise<void>>();
  const readyDeferred = createDeferred<void>();
  let idleDeferred = createDeferred<void>();
  let buildingSignal = createDeferred<void>();
  let nextRequestId = 1;
  let nextPriorityRequestId = 1;
  let activeGenerationId: number | null = null;
  let building: GenerationState | undefined;
  let latestBuildError: Error | undefined;
  let poolReady = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let watchRebuilding = false;
  let watchRequested = false;
  let watchLoop: Promise<void> | undefined;

  const closedError = (): PreprocessorError => new PreprocessorError("INTERNAL", "preprocessor is closed");

  function prioritySnapshot(request: PriorityRequest): PreprocessPriorityResponse {
    return {
      status: request.status,
      resource: request.resource,
      requestId: request.requestId,
    };
  }

  function isTerminalPriorityRequest(request: PriorityRequest): boolean {
    return request.status === "done" || request.error !== undefined;
  }

  function releasePriorityResource(request: PriorityRequest): void {
    if (priorityRequestByResource.get(request.resource) === request) {
      priorityRequestByResource.delete(request.resource);
    }
  }

  function completePriorityRequest(request: PriorityRequest): void {
    if (request.error || request.status === "done") return;
    request.status = "done";
    request.job = undefined;
    releasePriorityResource(request);
  }

  function failPriorityRequest(request: PriorityRequest, error: unknown): void {
    if (request.error || request.status === "done") return;
    request.error = asError(error);
    request.job = undefined;
    releasePriorityResource(request);
  }

  function resetPriorityBinding(request: PriorityRequest): number {
    request.bindingToken += 1;
    request.generationId = undefined;
    request.job = undefined;
    request.status = "queued";
    return request.bindingToken;
  }

  function bindPriorityJob(
    request: PriorityRequest,
    bindingToken: number,
    generationId: number,
    job: QueueJob,
  ): boolean {
    if (request.bindingToken !== bindingToken || isTerminalPriorityRequest(request)) return false;
    request.generationId = generationId;
    request.job = job;
    if (!job.cancelled && (job.state === "queued" || job.state === "processing")) {
      request.status = job.state;
    }
    return true;
  }

  function resetPriorityRequestsForJob(job: QueueJob): void {
    for (const request of priorityRequests.values()) {
      if (request.job === job && !isTerminalPriorityRequest(request)) {
        request.status = "queued";
      }
    }
  }

  function evictTerminalPriorityRequests(): void {
    if (priorityRequests.size < 256) return;
    for (const [requestId, request] of priorityRequests) {
      if (!isTerminalPriorityRequest(request)) continue;
      priorityRequests.delete(requestId);
      if (priorityRequests.size < 256) return;
    }
  }

  function allocatePriorityRequestId(): number {
    while (priorityRequests.has(nextPriorityRequestId)) {
      nextPriorityRequestId = nextPriorityRequestId === Number.MAX_SAFE_INTEGER
        ? 1
        : nextPriorityRequestId + 1;
    }
    const requestId = nextPriorityRequestId;
    nextPriorityRequestId = nextPriorityRequestId === Number.MAX_SAFE_INTEGER
      ? 1
      : nextPriorityRequestId + 1;
    return requestId;
  }

  function notifyError(error: unknown): void {
    try {
      onError(asError(error));
    } catch {
      // A reporting callback must not break queue or subprocess lifecycle handling.
    }
  }

  function notifyProgress(event: PreprocessProgressEvent): void {
    try {
      onProgress(event);
    } catch {
      // A progress callback must not break queue or subprocess lifecycle handling.
    }
  }

  function resolveReadyCallback(): void {
    try {
      onReady();
    } catch (error) {
      notifyError(error);
    }
  }

  function rejectCallsForSlot(slot: SubprocessSlot, error: Error): void {
    for (const [id, pending] of pendingCalls) {
      if (pending.slot !== slot) continue;
      pendingCalls.delete(id);
      pending.reject(error);
    }
  }

  function subprocessFailureMessage(
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

  function markSubprocessDead(
    slot: SubprocessSlot,
    token: number,
    subprocess: Bun.Subprocess | undefined,
    error: Error,
  ): void {
    if (slot.token !== token || slot.state === "closed" || slot.state === "dead") return;
    if (slot.expectedShutdown || closed) return;

    const wasIdle = slot.state === "idle";
    slot.state = "dead";
    if (slot.subprocess === subprocess) slot.subprocess = undefined;
    slot.token += 1;
    rejectCallsForSlot(slot, error);
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
    if (wasIdle) void recoverIdleSlot(slot, error);
  }

  function attachSubprocess(
    slot: SubprocessSlot,
  ): { subprocess: Bun.Subprocess; token: number } {
    const token = ++slot.token;
    const exitSignal = createDeferred<void>();
    slot.exitSignal = exitSignal;
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
        ipc(message, source) {
          if (slot.token !== token) return;
          if (isPreprocessProgressEvent(message)) {
            notifyProgress(message);
            return;
          }
          if (!isPreprocessResponse(message)) {
            markSubprocessDead(
              slot,
              token,
              source,
              new SubprocessExitedError("preprocess child returned an invalid response"),
            );
            return;
          }
          const pending = pendingCalls.get(message.id);
          if (!pending || pending.slot !== slot) return;
          pendingCalls.delete(message.id);
          if (message.ok) pending.resolve(message.value);
          else pending.reject(new PreprocessorError(message.error.code, message.error.message));
        },
        onDisconnect() {
          if (slot.expectedShutdown || closed) return;
          markSubprocessDead(
            slot,
            token,
            spawned,
            new SubprocessExitedError(
              subprocessFailureMessage(spawned, undefined, true),
            ),
          );
        },
      },
    );
    spawned = subprocess;
    if (slot.token === token) slot.subprocess = subprocess;
    void subprocess.exited.then(
      (exitCode) => {
        exitSignal.resolve(undefined);
        if (slot.token !== token) return;
        if (slot.expectedShutdown || closed) {
          slot.state = "closed";
          if (slot.subprocess === subprocess) slot.subprocess = undefined;
          rejectCallsForSlot(slot, closedError());
          return;
        }
        markSubprocessDead(
          slot,
          token,
          subprocess,
          new SubprocessExitedError(
            subprocessFailureMessage(subprocess, exitCode),
          ),
        );
      },
      (error) => {
        exitSignal.resolve(undefined);
        markSubprocessDead(
          slot,
          token,
          subprocess,
          new SubprocessExitedError(asError(error).message),
        );
      },
    );
    return { subprocess, token };
  }

  function sendToSlot<Type extends RequestType>(
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
    const id = nextRequestId++;
    const message = { ...request, id } as PreprocessRequest;
    return new Promise<PreprocessResultMap[Type]>((resolve, reject) => {
      pendingCalls.set(id, {
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
        markSubprocessDead(slot, token, subprocess, failure);
        if (pendingCalls.delete(id)) reject(failure);
      }
    });
  }

  async function initializeSlot(
    slot: SubprocessSlot,
    recover: boolean,
  ): Promise<number | null> {
    if (slot.retirement) await slot.retirement;
    if (closed) throw closedError();
    slot.state = "initializing";
    let attached: { subprocess: Bun.Subprocess; token: number };
    try {
      attached = attachSubprocess(slot);
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
      const result = await sendToSlot<"init">(slot, {
        type: "init",
        sourceDir,
        dbPath,
        recover,
      });
      if (closed) throw closedError();
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
      slot.exitSignal.resolve(undefined);
      throw error;
    }
  }

  async function initializeSlotWithRetry(
    slot: SubprocessSlot,
    recover: boolean,
  ): Promise<number | null> {
    try {
      return await initializeSlot(slot, recover);
    } catch (firstError) {
      if (closed) throw firstError;
      return initializeSlot(slot, recover);
    }
  }

  function ensureSlotRecovery(slot: SubprocessSlot): Promise<void> {
    if (slot.recovery) return slot.recovery;
    const recovery = (async () => {
      if (slot.retirement) await slot.retirement;
      await initializeSlot(slot, false);
    })();
    slot.recovery = recovery.finally(() => {
      slot.recovery = undefined;
    });
    return slot.recovery;
  }

  async function recoverIdleSlot(
    slot: SubprocessSlot,
    failure: Error,
  ): Promise<void> {
    try {
      await ensureSlotRecovery(slot);
      dispatch();
    } catch (error) {
      const terminal = new PreprocessorError(
        "INTERNAL",
        `preprocess child ${slot.index} failed to respawn: ${asError(error).message || failure.message}`,
      );
      if (building) failGeneration(building, terminal, true);
      else notifyError(terminal);
    }
  }

  function queueFor(priority: QueuePriority): QueueJob[] {
    return priority === "interactive" ? interactiveQueue : backgroundQueue;
  }

  function enqueueRequest<Type extends RequestType>(
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
      crashRetries: 0,
      cancelled: false,
    };
    if (closed) {
      job.cancelled = true;
      deferred.reject(closedError());
      finished.resolve(undefined);
    } else {
      queueFor(priority).push(job);
      dispatch();
    }
    return {
      job,
      promise: deferred.promise as Promise<PreprocessResultMap[Type]>,
    };
  }

  function repositionQueuedJob(job: QueueJob): void {
    if (job.cancelled || job.state !== "queued") return;
    let index = backgroundQueue.indexOf(job);
    if (index >= 0) {
      backgroundQueue.splice(index, 1);
    } else {
      index = interactiveQueue.indexOf(job);
      if (index < 0) return;
      interactiveQueue.splice(index, 1);
    }
    job.priority = "interactive";
    interactiveQueue.unshift(job);
    dispatch();
  }

  function nextJob(): QueueJob | undefined {
    while (interactiveQueue.length) {
      const job = interactiveQueue.shift()!;
      if (!job.cancelled) return job;
    }
    while (backgroundQueue.length) {
      const job = backgroundQueue.shift()!;
      if (!job.cancelled) return job;
    }
    return undefined;
  }

  function dispatch(): void {
    if (!poolReady || closed) return;
    for (const slot of slots) {
      if (slot.state !== "idle") continue;
      const job = nextJob();
      if (!job) return;
      runJob(slot, job);
    }
  }

  function finishSlotJob(
    slot: SubprocessSlot,
    job: QueueJob,
    completed = true,
  ): void {
    if (slot.current === job) slot.current = undefined;
    if (
      !closed &&
      slot.subprocess &&
      slot.state !== "initializing" &&
      slot.state !== "dead"
    ) {
      slot.state = "idle";
    } else if (closed) {
      slot.state = "closing";
    }
    if (completed) job.finished.resolve(undefined);
  }

  function runJob(slot: SubprocessSlot, job: QueueJob): void {
    job.state = "processing";
    slot.state = "busy";
    slot.current = job;
    void sendToSlot(slot, job.request).then((value) => {
      job.state = "done";
      finishSlotJob(slot, job);
      if (!job.cancelled) job.deferred.resolve(value);
      dispatch();
    }).catch(async (error) => {
      if (error instanceof SubprocessExitedError) {
        if (job.cancelled || closed) {
          if (slot.retirement) await slot.retirement;
          finishSlotJob(slot, job);
          if (!job.cancelled) job.deferred.reject(closedError());
          if (!closed) {
            void ensureSlotRecovery(slot)
              .then(dispatch)
              .catch((recoveryError) => notifyError(recoveryError));
          }
          return;
        }
        if (job.crashRetries === 0) {
          job.crashRetries = 1;
          try {
            await ensureSlotRecovery(slot);
            finishSlotJob(slot, job, false);
            job.state = "queued";
            resetPriorityRequestsForJob(job);
            queueFor(job.priority).unshift(job);
            dispatch();
            return;
          } catch (recoveryError) {
            error = new SubprocessExitedError(
              `preprocess child failed during respawn: ${asError(recoveryError).message}`,
            );
          }
        } else {
          void ensureSlotRecovery(slot)
            .then(dispatch)
            .catch((recoveryError) => notifyError(recoveryError));
        }
        if (slot.retirement) await slot.retirement;
        finishSlotJob(slot, job);
        job.deferred.reject(error);
        const generation =
          job.generationId === undefined
            ? undefined
            : generations.get(job.generationId);
        if (generation && !generation.superseded && !generation.failed) {
          failGeneration(generation, asError(error), true);
        } else {
          notifyError(error);
        }
        dispatch();
        return;
      }

      finishSlotJob(slot, job);
      if (!job.cancelled) job.deferred.reject(error);
      dispatch();
    });
  }

  function removeQueuedGenerationJobs(
    generationId: number,
    error: Error,
  ): void {
    for (const queue of [interactiveQueue, backgroundQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index]!;
        if (job.generationId !== generationId) continue;
        queue.splice(index, 1);
        job.cancelled = true;
        job.deferred.reject(error);
        job.finished.resolve(undefined);
      }
    }
    for (const slot of slots) {
      const job = slot.current;
      if (!job || job.generationId !== generationId) continue;
      job.cancelled = true;
      job.deferred.reject(error);
    }
  }

  function drainGenerationJobs(generationId: number): Promise<void> {
    const active = slots.flatMap((slot) => {
      const job = slot.current;
      return job?.generationId === generationId ? [job.finished.promise] : [];
    });
    return Promise.all(active).then(() => undefined);
  }

  function rejectScopeWaiters(
    generation: GenerationState,
    error: Error,
  ): void {
    for (const waiters of generation.scopeWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    generation.scopeWaiters.clear();
  }

  function failGeneration(
    generation: GenerationState,
    cause: Error,
    processFailure: boolean,
  ): void {
    if (generation.failed || generation.superseded) return;
    generation.failed = true;
    generation.failure = cause;
    latestBuildError = cause;
    removeQueuedGenerationJobs(generation.id, cause);
    rejectScopeWaiters(generation, cause);
    generation.discovered.reject(cause);
    generation.promoted.reject(cause);
    if (building === generation) {
      building = undefined;
      buildingSignal = createDeferred<void>();
      watchRebuilding = false;
    }
    idleDeferred.reject(cause);
    void drainGenerationJobs(generation.id).then(() => {
      const discard = enqueueRequest<"discard-generation">(
        {
          type: "discard-generation",
          generationId: generation.id,
          mode: processFailure ? "failed" : "delete",
        },
        "interactive",
      ).promise;
      void discard.catch(() => undefined);
    });
    notifyError(cause);
  }

  function mutationFinished(generation: GenerationState): void {
    generation.pendingMutations = Math.max(0, generation.pendingMutations - 1);
    maybeSchedulePromotion(generation);
  }

  function wakeScopeWaiters(generation: GenerationState, path: string, record: ScopeRecord): void {
    const waiters = generation.scopeWaiters.get(path);
    if (!waiters) return;
    generation.scopeWaiters.delete(path);
    for (const waiter of waiters) waiter.resolve(record);
  }

  function enqueueScope(
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
      if (priority === "interactive") repositionQueuedJob(existing.job);
      return existing;
    }

    generation.pendingMutations += 1;
    const queued = enqueueRequest<"preprocess-scope">(
      {
        type: "preprocess-scope",
        generationId: generation.id,
        scope,
        packages: generation.packages,
      },
      priority,
      generation.id,
    );
    const record: ScopeRecord = { scope, job: queued.job, promise: queued.promise };
    generation.scopes.set(scope.path, record);
    wakeScopeWaiters(generation, scope.path, record);
    void record.promise.then((result) => {
      if (generation.superseded || generation.failed) return;
      for (const child of result.children) enqueueScope(generation, child, "background", true);
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      if (requiredTraversal) failGeneration(generation, asError(error), false);
    }).finally(() => mutationFinished(generation));
    return record;
  }

  function seedTraversal(generation: GenerationState, packages: readonly PackageInfo[]): void {
    for (const pkg of packages) {
      enqueueScope(generation, { path: pkg.path, kind: "package" }, "background", true);
    }
    enqueueScope(generation, { path: "", kind: "directory" }, "background", true);
  }

  function enqueueDiscovery(generation: GenerationState): void {
    generation.pendingMutations += 1;
    const discovery = enqueueRequest<"discover-packages">(
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
      seedTraversal(generation, packages);
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      failGeneration(generation, asError(error), false);
    }).finally(() => mutationFinished(generation));
  }

  function maybeSchedulePromotion(generation: GenerationState): void {
    if (
      generation.superseded ||
      generation.failed ||
      generation.promotionScheduled ||
      !generation.discoveryComplete ||
      generation.pendingMutations !== 0
    ) return;

    generation.promotionScheduled = true;
    const promotion = enqueueRequest<"promote-generation">(
      { type: "promote-generation", generationId: generation.id },
      "background",
      generation.id,
    ).promise;
    void promotion.then(() => {
      if (generation.superseded || generation.failed) return;
      activeGenerationId = generation.id;
      latestBuildError = undefined;
      if (building === generation) building = undefined;
      generation.promoted.resolve(undefined);
      idleDeferred.resolve(undefined);
      watchRebuilding = false;
      queryDedupe.clear();
      resolveReadyCallback();
    }).catch((error) => {
      if (generation.superseded || generation.failed || error instanceof SupersededGenerationError) return;
      failGeneration(generation, asError(error), false);
    });
  }

  async function beginGeneration(cause: "startup" | "watch"): Promise<GenerationState> {
    const result = await enqueueRequest<"begin-generation">({ type: "begin-generation", cause }, "interactive").promise;
    if (closed) throw closedError();
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
    generations.set(generation.id, generation);
    building = generation;
    latestBuildError = undefined;
    buildingSignal.resolve(undefined);
    enqueueDiscovery(generation);
    return generation;
  }

  async function supersedeGeneration(
    generation: GenerationState,
  ): Promise<void> {
    if (generation.superseded || generation.failed) return;
    generation.superseded = true;
    const error = new SupersededGenerationError();
    removeQueuedGenerationJobs(generation.id, error);
    rejectScopeWaiters(generation, error);
    generation.discovered.reject(error);
    generation.promoted.reject(error);
    if (building === generation) {
      building = undefined;
      buildingSignal = createDeferred<void>();
    }
    await drainGenerationJobs(generation.id);
    await enqueueRequest<"discard-generation">(
      {
        type: "discard-generation",
        generationId: generation.id,
        mode: "delete",
      },
      "interactive",
    ).promise;
  }

  async function awaitBuildingGeneration(): Promise<GenerationState> {
    while (!closed) {
      if (building && !building.superseded && !building.failed) return building;
      if (latestBuildError) throw latestBuildError;
      await buildingSignal.promise;
    }
    throw closedError();
  }

  async function runWatchLoop(): Promise<void> {
    try {
      await readyDeferred.promise;
      while (watchRequested && !closed) {
        watchRequested = false;
        if (idleDeferred.settled) idleDeferred = createDeferred<void>();
        const previous = building;
        if (previous) await supersedeGeneration(previous);
        if (closed) return;
        await beginGeneration("watch");
      }
    } catch (error) {
      if (!closed && !(error instanceof SupersededGenerationError)) {
        watchRebuilding = false;
        latestBuildError = asError(error);
        idleDeferred.reject(error);
        notifyError(error);
      }
    } finally {
      watchLoop = undefined;
      if (watchRequested && !closed) {
        watchLoop = runWatchLoop();
        void watchLoop.catch(() => undefined);
      }
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      const initializer: SubprocessSlot = {
        index: 0,
        token: 0,
        state: "new",
        exitSignal: createDeferred<void>(),
        expectedShutdown: false,
      };
      slots.push(initializer);
      activeGenerationId = await initializeSlotWithRetry(initializer, true);

      const additional: SubprocessSlot[] = [];
      for (let index = 1; index < poolSize; index += 1) {
        const slot: SubprocessSlot = {
          index,
          token: 0,
          state: "new",
          exitSignal: createDeferred<void>(),
          expectedShutdown: false,
        };
        slots.push(slot);
        additional.push(slot);
      }
      await Promise.all(additional.map((slot) => initializeSlotWithRetry(slot, false)));
      if (closed) throw closedError();
      poolReady = true;
      dispatch();
      await beginGeneration("startup");
      readyDeferred.resolve(undefined);
    } catch (error) {
      const failure = asError(error);
      readyDeferred.reject(failure);
      idleDeferred.reject(failure);
      notifyError(failure);
    }
  }

  function dedupe<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const existing = queryDedupe.get(key);
    if (existing) return existing as Promise<Value>;
    let promise: Promise<Value>;
    try {
      promise = operation();
    } catch (error) {
      promise = Promise.reject(error);
    }
    queryDedupe.set(key, promise);
    void promise.finally(() => {
      if (queryDedupe.get(key) === promise) queryDedupe.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  async function readStable<Type extends "read-tree" | "read-packages" | "search">(
    request: Omit<RequestFor<Type>, "generationId">,
  ): Promise<PreprocessResultMap[Type]> {
    await readyDeferred.promise;
    while (!closed) {
      if (watchRebuilding) {
        const generation = await awaitBuildingGeneration();
        try {
          await generation.promoted.promise;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
        continue;
      }
      if (activeGenerationId !== null) {
        return enqueueRequest<Type>(
          { ...request, generationId: activeGenerationId } as RequestFor<Type>,
          "interactive",
        ).promise;
      }
      const generation = await awaitBuildingGeneration();
      try {
        await generation.promoted.promise;
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw closedError();
  }

  async function readPackages(): Promise<readonly PackageInfo[]> {
    await readyDeferred.promise;
    while (!closed) {
      if (watchRebuilding) {
        const generation = await awaitBuildingGeneration();
        try {
          await generation.promoted.promise;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
        continue;
      }
      if (activeGenerationId !== null) {
        return enqueueRequest<"read-packages">(
          { type: "read-packages", generationId: activeGenerationId },
          "interactive",
        ).promise;
      }
      const generation = await awaitBuildingGeneration();
      try {
        await generation.discovered.promise;
        return await enqueueRequest<"read-packages">(
          { type: "read-packages", generationId: generation.id },
          "interactive",
          generation.id,
        ).promise;
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw closedError();
  }

  async function inferBuildingScopeKind(path: string): Promise<"directory" | "file" | undefined> {
    if (path === "") return "directory";
    if (activeGenerationId === null) return undefined;
    try {
      const tree = await enqueueRequest<"read-tree">(
        { type: "read-tree", generationId: activeGenerationId },
        "interactive",
      ).promise;
      return findTreeKind(tree, path);
    } catch {
      return undefined;
    }
  }

  async function prioritizeScope(
    generation: GenerationState,
    path: string,
    knownKind?: "directory" | "file",
  ): Promise<ScopeRecord | undefined> {
    await generation.discovered.promise;
    if (generation.superseded) throw new SupersededGenerationError();
    if (generation.failed) throw generation.failure ?? new PreprocessorError("INTERNAL", "generation failed");

    const existing = generation.scopes.get(path);
    if (existing) {
      repositionQueuedJob(existing.job);
      return existing;
    }

    if (generation.promotionScheduled) {
      await generation.promoted.promise;
      return undefined;
    }

    const inferred = knownKind ?? await inferBuildingScopeKind(path);
    if (generation.superseded) throw new SupersededGenerationError();
    if (generation.failed) throw generation.failure ?? new PreprocessorError("INTERNAL", "generation failed");
    const discoveredWhileInferring = generation.scopes.get(path);
    if (discoveredWhileInferring) {
      repositionQueuedJob(discoveredWhileInferring.job);
      return discoveredWhileInferring;
    }
    if (generation.promotionScheduled) {
      await generation.promoted.promise;
      return undefined;
    }
    if (inferred) {
      return enqueueScope(generation, { path, kind: inferred }, "interactive", false);
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

  async function readPriorityDiagram(
    generation: GenerationState,
    kind: DiagramKind,
    scopePath: string,
  ): Promise<Omit<DiagramResponse, "version">> {
    if (kind === "packages") {
      await generation.discovered.promise;
    } else {
      const record = await prioritizeScope(generation, scopePath);
      if (record) await record.promise;
    }
    return enqueueRequest<"read-diagram">(
      { type: "read-diagram", generationId: generation.id, kind, scopePath },
      "interactive",
      generation.id,
    ).promise;
  }

  async function getDiagram(
    kind: DiagramKind,
    scopePath: string,
  ): Promise<Omit<DiagramResponse, "version">> {
    await readyDeferred.promise;
    while (!closed) {
      if (watchRebuilding) {
        const generation = await awaitBuildingGeneration();
        try {
          return await readPriorityDiagram(generation, kind, scopePath);
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }

      const selectedGenerationId = activeGenerationId;
      if (selectedGenerationId !== null) {
        try {
          return await enqueueRequest<"read-diagram">(
            { type: "read-diagram", generationId: selectedGenerationId, kind, scopePath },
            "interactive",
          ).promise;
        } catch (error) {
          if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
          if (activeGenerationId !== selectedGenerationId) continue;
          if (!building) throw error;
        }
      }

      const generation = await awaitBuildingGeneration();
      try {
        return await readPriorityDiagram(generation, kind, scopePath);
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw closedError();
  }

  async function getDefinition(
    path: string,
    location: { line: number; column: number },
  ): Promise<GotoDefinition | null> {
    const read = (generationId: number, generation?: GenerationState) =>
      enqueueRequest<"read-definition">(
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

    await readyDeferred.promise;
    while (!closed) {
      try {
        if (watchRebuilding) {
          const generation = await awaitBuildingGeneration();
          const definition = await read(generation.id, generation);
          if (generation.superseded || generation.failed) continue;
          if (watchRebuilding && building === generation) return definition;
          if (!watchRebuilding && activeGenerationId === generation.id) return definition;
          continue;
        }

        const selectedGenerationId = activeGenerationId;
        if (selectedGenerationId !== null) {
          const definition = await read(selectedGenerationId);
          if (watchRebuilding || activeGenerationId !== selectedGenerationId) continue;
          const selectedGeneration = generations.get(selectedGenerationId);
          if (selectedGeneration?.superseded || selectedGeneration?.failed) continue;
          if (definition || !building) return definition;
        }

        const generation = await awaitBuildingGeneration();
        const definition = await read(generation.id, generation);
        if (generation.superseded || generation.failed) continue;
        if (watchRebuilding) {
          if (building === generation) return definition;
          continue;
        }
        if (activeGenerationId === generation.id) return definition;
        if (activeGenerationId === selectedGenerationId && building === generation) {
          return definition;
        }
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw closedError();
  }

  function activePrioritySelectionIsCurrent(
    request: PriorityRequest,
    bindingToken: number,
    generationId: number,
  ): boolean {
    if (
      request.bindingToken !== bindingToken ||
      watchRebuilding ||
      activeGenerationId !== generationId
    ) return false;
    const generation = generations.get(generationId);
    return !generation || (!generation.superseded && !generation.failed);
  }

  function buildingPrioritySelectionIsCurrent(
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
    if (watchRebuilding) return building === generation;
    if (activeGenerationId === generation.id) return true;
    return activeGenerationId === fallbackActiveGenerationId && building === generation;
  }

  async function processPriorityGeneration(
    request: PriorityRequest,
    bindingToken: number,
    generation: GenerationState,
    fallbackActiveGenerationId: number | null,
  ): Promise<boolean> {
    request.generationId = generation.id;
    request.job = undefined;
    request.status = "queued";
    const scope = await prioritizeScope(generation, request.resource);
    if (
      !buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;
    if (!scope) return false;
    if (!bindPriorityJob(request, bindingToken, generation.id, scope.job)) return false;
    await scope.promise;
    if (
      !buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;

    const read = enqueueRequest<"read-diagram">(
      {
        type: "read-diagram",
        generationId: generation.id,
        kind: "uml",
        scopePath: request.resource,
      },
      "interactive",
      generation.id,
    );
    if (!bindPriorityJob(request, bindingToken, generation.id, read.job)) return false;
    await read.promise;
    if (
      !buildingPrioritySelectionIsCurrent(
        request,
        bindingToken,
        generation,
        fallbackActiveGenerationId,
      )
    ) return false;
    completePriorityRequest(request);
    return true;
  }

  async function controlPriorityRequest(request: PriorityRequest): Promise<void> {
    try {
      await readyDeferred.promise;
      while (!closed && !isTerminalPriorityRequest(request)) {
        let bindingToken = resetPriorityBinding(request);

        if (watchRebuilding) {
          const generation = await awaitBuildingGeneration();
          if (
            !watchRebuilding ||
            building !== generation ||
            generation.superseded ||
            generation.failed ||
            request.bindingToken !== bindingToken
          ) continue;
          try {
            if (await processPriorityGeneration(request, bindingToken, generation, activeGenerationId)) return;
          } catch (error) {
            if (error instanceof SupersededGenerationError) continue;
            throw error;
          }
          continue;
        }

        const selectedGenerationId = activeGenerationId;
        if (selectedGenerationId !== null) {
          request.generationId = selectedGenerationId;
          const read = enqueueRequest<"read-diagram">(
            {
              type: "read-diagram",
              generationId: selectedGenerationId,
              kind: "uml",
              scopePath: request.resource,
            },
            "interactive",
          );
          if (!bindPriorityJob(request, bindingToken, selectedGenerationId, read.job)) continue;
          try {
            await read.promise;
            if (!activePrioritySelectionIsCurrent(request, bindingToken, selectedGenerationId)) continue;
            completePriorityRequest(request);
            return;
          } catch (error) {
            if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
            if (!activePrioritySelectionIsCurrent(request, bindingToken, selectedGenerationId)) continue;
            const fallback = building;
            if (!fallback) throw error;
            bindingToken = resetPriorityBinding(request);
            try {
              if (
                await processPriorityGeneration(
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

        const generation = await awaitBuildingGeneration();
        if (
          !watchRebuilding &&
          activeGenerationId !== null &&
          activeGenerationId !== generation.id
        ) continue;
        try {
          if (await processPriorityGeneration(request, bindingToken, generation, null)) return;
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }
      if (closed && !isTerminalPriorityRequest(request)) throw closedError();
    } catch (error) {
      failPriorityRequest(request, error);
    }
  }

  function prioritizeResource(rawResource: string): Promise<PreprocessPriorityResponse> {
    let resource: string;
    try {
      resource = normalizeRelativePath(rawResource);
    } catch (error) {
      return Promise.reject(error);
    }

    const existing = priorityRequestByResource.get(resource);
    if (existing) {
      if (existing.job) {
        repositionQueuedJob(existing.job);
        if (
          !existing.job.cancelled &&
          (existing.job.state === "queued" || existing.job.state === "processing")
        ) {
          existing.status = existing.job.state;
        }
      }
      return Promise.resolve(prioritySnapshot(existing));
    }

    evictTerminalPriorityRequests();
    if (priorityRequests.size >= 256) {
      return Promise.reject(
        new PreprocessorError("INVALID_INPUT", "too many pending priority requests"),
      );
    }
    const request: PriorityRequest = {
      requestId: allocatePriorityRequestId(),
      resource,
      status: "queued",
      bindingToken: 0,
    };
    priorityRequests.set(request.requestId, request);
    priorityRequestByResource.set(resource, request);
    const controller = controlPriorityRequest(request);
    priorityControllers.add(controller);
    void controller.finally(() => priorityControllers.delete(controller)).catch(() => undefined);
    return Promise.resolve(prioritySnapshot(request));
  }

  function pollPriorityRequest(requestId: number): Promise<PreprocessPriorityResponse> {
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return Promise.reject(
        new PreprocessorError("INVALID_INPUT", "requestId must be a positive safe integer"),
      );
    }
    const request = priorityRequests.get(requestId);
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
    return Promise.resolve(prioritySnapshot(request));
  }

  async function readPriorityFile(
    generation: GenerationState,
    path: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    const record = await prioritizeScope(generation, path, "file");
    if (record) await record.promise;
    return enqueueRequest<"read-file">(
      { type: "read-file", generationId: generation.id, path, ...(location ? { location } : {}) },
      "interactive",
      generation.id,
    ).promise;
  }

  async function readFile(
    path: string,
    location?: { line: number; column: number },
  ): Promise<FileResponse> {
    await readyDeferred.promise;
    while (!closed) {
      if (watchRebuilding) {
        const generation = await awaitBuildingGeneration();
        try {
          return await readPriorityFile(generation, path, location);
        } catch (error) {
          if (error instanceof SupersededGenerationError) continue;
          throw error;
        }
      }

      const selectedGenerationId = activeGenerationId;
      if (selectedGenerationId !== null) {
        try {
          return await enqueueRequest<"read-file">(
            { type: "read-file", generationId: selectedGenerationId, path, ...(location ? { location } : {}) },
            "interactive",
          ).promise;
        } catch (error) {
          if (!(error instanceof PreprocessorError) || error.code !== "NOT_FOUND") throw error;
          if (activeGenerationId !== selectedGenerationId) continue;
          if (!building) throw error;
        }
      }

      const generation = await awaitBuildingGeneration();
      try {
        return await readPriorityFile(generation, path, location);
      } catch (error) {
        if (error instanceof SupersededGenerationError) continue;
        throw error;
      }
    }
    throw closedError();
  }

  async function closeSubprocesses(): Promise<void> {
    const error = closedError();
    readyDeferred.reject(error);
    idleDeferred.reject(error);
    buildingSignal.reject(error);
    if (building) {
      building.discovered.reject(error);
      building.promoted.reject(error);
      rejectScopeWaiters(building, error);
    }
    for (const promise of queryDedupe.values()) {
      void promise.catch(() => undefined);
    }
    for (const queue of [interactiveQueue, backgroundQueue]) {
      for (const job of queue.splice(0)) {
        job.cancelled = true;
        job.deferred.reject(error);
        job.finished.resolve(undefined);
      }
    }
    for (const slot of slots) {
      if (slot.current) {
        slot.current.cancelled = true;
        slot.current.deferred.reject(error);
      }
    }

    const live = slots.flatMap((slot) =>
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
      void sendToSlot<"shutdown">(slot, { type: "shutdown" }).catch(
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

  const preprocessor: Preprocessor = {
    ready() {
      return readyDeferred.promise;
    },
    whenIdle() {
      return idleDeferred.promise;
    },
    getTree() {
      return dedupe("read-tree", () => readStable<"read-tree">({ type: "read-tree" }));
    },
    getPackages() {
      return dedupe("read-packages", readPackages);
    },
    search(query) {
      return dedupe(`search:${query}`, () => readStable<"search">({ type: "search", query }));
    },
    getDiagram(kind, rawScopePath) {
      let scopePath: string;
      try {
        scopePath = normalizeRelativePath(rawScopePath);
      } catch (error) {
        return Promise.reject(error);
      }
      return dedupe(`read-diagram:${kind}:${scopePath}`, () => getDiagram(kind, scopePath));
    },
    readFile(rawPath, location) {
      let path: string;
      try {
        path = normalizeRelativePath(rawPath);
      } catch (error) {
        return Promise.reject(error);
      }
      const locationKey = location ? `${location.line}:${location.column}` : "";
      return dedupe(`read-file:${path}:${locationKey}`, () => readFile(path, location));
    },
    getDefinition(rawPath, location) {
      let path: string;
      try {
        path = normalizeRelativePath(rawPath);
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
      return dedupe(
        `read-definition:${path}:${location.line}:${location.column}`,
        () => getDefinition(path, location),
      );
    },
    prioritize(resource) {
      return prioritizeResource(resource);
    },
    poll(requestId) {
      return pollPriorityRequest(requestId);
    },
    rebuild(cause) {
      if (cause !== "watch" || closed) return;
      watchRebuilding = true;
      watchRequested = true;
      latestBuildError = undefined;
      queryDedupe.clear();
      if (idleDeferred.settled) idleDeferred = createDeferred<void>();
      if (!watchLoop) {
        watchLoop = runWatchLoop();
        void watchLoop.catch(() => undefined);
      }
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      watchRequested = false;
      closePromise = closeSubprocesses()
        .then(() => Promise.all([...priorityControllers]).then(() => undefined))
        .finally(() => {
          for (const pending of pendingCalls.values()) pending.reject(closedError());
          pendingCalls.clear();
        });
      return closePromise;
    },
  };

  void bootstrap();
  return preprocessor;
}
