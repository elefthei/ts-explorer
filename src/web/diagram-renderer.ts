import mermaid from "mermaid";
import type { InternalHelpers, LayoutData, LayoutLoaderDefinition, MermaidConfig, SVG } from "mermaid";
import type { UmlTarget } from "../types.ts";
import type { UmlVisibility } from "../uml/model.ts";
import type { RenderedUmlView, UmlViewModel } from "../uml/view.ts";
import type {
  DiagramLayoutInput,
  DiagramLayoutOutput,
  DiagramWorkerRequest,
  DiagramWorkerResponse,
} from "./diagram-worker-protocol.ts";

// ---------------------------------------------------------------------------
// Worker ownership
// ---------------------------------------------------------------------------

const WORKER_URL = "/diagram-worker.js";
const WORKER_FAILURE_MESSAGE = "Diagram worker failed";

type PendingReply = {
  resolve: (reply: DiagramWorkerResponse) => void;
  reject: (error: Error) => void;
};

/**
 * One diagram operation's worker. Replies are owned by the operation object *and* the request id,
 * so a superseded operation's late message or abort can never settle or terminate the worker its
 * replacement created.
 */
type WorkerOperation = {
  worker: Worker | undefined;
  pending: Map<number, PendingReply>;
  /** Set exactly once by `failOperation`; every later request for this operation reuses it. */
  failure: Error | undefined;
  release: () => void;
};

const operations = new WeakMap<AbortSignal, WorkerOperation>();
/** The adapter's fallback owner: never aborted, so a stray render still has a live signal. */
const IDLE_SIGNAL = new AbortController().signal;
let nextRequestId = 1;

function cancelled(): Error {
  return new DOMException("Diagram render cancelled", "AbortError");
}

function workerFailure(message: string | undefined): Error {
  return new Error(message && message.length > 0 ? message : WORKER_FAILURE_MESSAGE);
}

/**
 * The single disposal path for both cancellation and fatal worker failure: terminating, detaching
 * listeners and rejecting the pending map must never drift apart between those two branches.
 */
function failOperation(signal: AbortSignal, operation: WorkerOperation, failure: Error): void {
  if (operations.get(signal) === operation) operations.delete(signal);
  if (operation.failure) return;
  operation.failure = failure;
  operation.release();
  operation.worker?.terminate();
  const pending = [...operation.pending.values()];
  operation.pending.clear();
  for (const reply of pending) reply.reject(failure);
}

function acquireOperation(signal: AbortSignal): WorkerOperation {
  const existing = operations.get(signal);
  if (existing) {
    if (existing.failure) throw existing.failure;
    return existing;
  }
  const operation: WorkerOperation = {
    worker: undefined,
    pending: new Map(),
    failure: undefined,
    release: () => undefined,
  };
  operations.set(signal, operation);
  const onAbort = (): void => failOperation(signal, operation, cancelled());
  signal.addEventListener("abort", onAbort);
  operation.release = () => signal.removeEventListener("abort", onAbort);
  let worker: Worker;
  try {
    worker = new Worker(WORKER_URL, { type: "module" });
  } catch (error) {
    const failure = workerFailure(error instanceof Error ? error.message : undefined);
    failOperation(signal, operation, failure);
    throw failure;
  }
  const onMessage = (event: MessageEvent<DiagramWorkerResponse>): void => {
    const reply = event.data;
    const entry = operation.pending.get(reply.id);
    if (!entry) return;
    operation.pending.delete(reply.id);
    // A per-request failure stays scoped to its own request: one bad frame is not a dead worker.
    if (reply.kind === "error") entry.reject(new Error(reply.error));
    else entry.resolve(reply);
  };
  const onFatal = (event: Event): void => {
    event.preventDefault();
    const message = event instanceof ErrorEvent ? event.message : undefined;
    failOperation(signal, operation, workerFailure(message));
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onFatal);
  worker.addEventListener("messageerror", onFatal);
  operation.worker = worker;
  operation.release = () => {
    signal.removeEventListener("abort", onAbort);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onFatal);
    worker.removeEventListener("messageerror", onFatal);
  };
  return operation;
}

async function requestFromWorker(
  signal: AbortSignal,
  build: (id: number) => DiagramWorkerRequest,
): Promise<DiagramWorkerResponse> {
  if (signal.aborted) throw cancelled();
  const operation = acquireOperation(signal);
  const id = nextRequestId++;
  const request = build(id);
  return await new Promise<DiagramWorkerResponse>((resolve, reject) => {
    operation.pending.set(id, { resolve, reject });
    try {
      operation.worker?.postMessage(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      failOperation(signal, operation, workerFailure(message));
    }
  });
}

/** Prepares one selection's Mermaid DSL and link metadata off the browser's UI thread. */
export async function prepareUmlView(
  model: UmlViewModel,
  visibility: UmlVisibility,
  target: UmlTarget,
  signal: AbortSignal,
): Promise<RenderedUmlView> {
  const reply = await requestFromWorker(
    signal,
    (id) => ({ id, kind: "uml-view", model, visibility, target }),
  );
  if (reply.kind !== "uml-view") throw new Error("Unexpected diagram worker reply");
  return reply.view;
}

async function requestLayout(
  graph: DiagramLayoutInput,
  signal: AbortSignal,
): Promise<DiagramLayoutOutput> {
  const reply = await requestFromWorker(signal, (id) => ({ id, kind: "layout", graph }));
  if (reply.kind !== "layout") throw new Error("Unexpected diagram worker reply");
  return reply.layout;
}

// ---------------------------------------------------------------------------
// Cooperative scheduling
// ---------------------------------------------------------------------------

const YIELD_BUDGET_MS = 8;

/** A real task boundary. A resolved promise only drains the microtask queue; input never runs. */
function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Bounds one uninterrupted DOM batch, and makes every item boundary a cancellation point. */
class RenderBudget {
  private deadline = performance.now() + YIELD_BUDGET_MS;

  constructor(private readonly signal: AbortSignal) {}

  async step(): Promise<void> {
    if (this.signal.aborted) throw cancelled();
    if (performance.now() < this.deadline) return;
    await nextTask();
    if (this.signal.aborted) throw cancelled();
    this.deadline = performance.now() + YIELD_BUDGET_MS;
  }
}

// ---------------------------------------------------------------------------
// Mermaid layout adapter
// ---------------------------------------------------------------------------

type LayoutNode = Extract<LayoutData["nodes"][number], { isGroup: false }>;
/** Mermaid's helpers write measurements and Dagre geometry back onto the records handed to them. */
type LayoutEdge = LayoutData["edges"][number] & {
  width?: number;
  height?: number;
  weight?: number;
  labeloffset?: number;
  x?: number;
  y?: number;
};
/** The measured node element Mermaid returns; this adapter only sets its transform. */
type PlacedNodeElement = { attr(name: string, value: string): unknown };
type SpacingConfig = MermaidConfig & {
  nodeSpacing?: number;
  rankSpacing?: number;
};

let activeRenderSignal: AbortSignal | undefined;

/**
 * Mermaid's own presentation with its layout computation moved into the worker. The element,
 * marker, measurement and edge-drawing steps are the upstream Dagre adapter's; only the graph
 * solve leaves the thread. Mermaid's private per-render `clear()` hooks are unreachable through
 * `InternalHelpers`, and are not needed here: every cache they reset is keyed by node or edge id
 * and rewritten by this render before it is read.
 */
async function renderDagreLayout(
  layoutData: LayoutData,
  svg: SVG,
  helpers: InternalHelpers,
): Promise<void> {
  const signal = activeRenderSignal ?? IDLE_SIGNAL;
  const budget = new RenderBudget(signal);
  const config = helpers.getConfig();
  const element = svg.select<SVGGElement>("g");
  helpers.insertMarkers(element, layoutData.markers, layoutData.type, layoutData.diagramId);
  const root = element.insert<SVGGElement>("g").attr("class", "root");
  root.insert<SVGGElement>("g").attr("class", "clusters");
  const edgePaths = root.insert<SVGGElement>("g").attr("class", "edgePaths");
  const edgeLabels = root.insert<SVGGElement>("g").attr("class", "edgeLabels");
  const nodeGroup = root.insert<SVGGElement>("g").attr("class", "nodes");

  const byId = new Map<string, LayoutNode>();
  const placed: { node: LayoutNode; selection: PlacedNodeElement }[] = [];
  for (const node of layoutData.nodes) {
    // No emitter produces groups. Refusing one is honest; dropping it would lose diagram content.
    if (node.isGroup === true || (node.parentId !== undefined && node.parentId !== null)) {
      throw new Error("Unsupported grouped diagram layout");
    }
    const measured: LayoutNode = { ...node };
    byId.set(measured.id, measured);
    const selection = await helpers.insertNode(nodeGroup, measured, {
      config,
      dir: layoutData.direction,
    });
    placed.push({ node: measured, selection });
    await budget.step();
  }

  const edges: LayoutEdge[] = [];
  for (const edge of layoutData.edges) {
    const measured: LayoutEdge = { ...edge };
    edges.push(measured);
    await helpers.insertEdgeLabel(edgeLabels, measured);
    await budget.step();
  }

  const spacing = config as SpacingConfig;
  const solved = await requestLayout({
    graph: {
      rankdir: layoutData.direction,
      nodesep: spacing.nodeSpacing || spacing.flowchart?.nodeSpacing || layoutData.nodeSpacing,
      ranksep: spacing.rankSpacing || spacing.flowchart?.rankSpacing || layoutData.rankSpacing,
      marginx: 8,
      marginy: 8,
    },
    nodes: placed.map(({ node }) => ({
      id: node.id,
      width: node.width ?? 0,
      height: node.height ?? 0,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      start: String(edge.start),
      end: String(edge.end),
      width: edge.width,
      height: edge.height,
      minlen: edge.minlen,
      weight: edge.weight,
      labeloffset: edge.labeloffset,
      labelpos: edge.labelpos,
    })),
  }, signal);

  for (const [index, { node, selection }] of placed.entries()) {
    const position = solved.nodes[index];
    if (position) {
      node.x = position.x;
      node.y = position.y;
      selection.attr("transform", `translate(${position.x}, ${position.y})`);
    }
    await budget.step();
  }

  // Flat graphs only: no cluster is ever inserted, so no edge can be cut against one.
  const clusters = new Map<string, unknown>();
  for (const [index, edge] of edges.entries()) {
    const routed = solved.edges[index];
    if (routed) {
      edge.points = routed.points;
      if (routed.x !== undefined) {
        edge.x = routed.x;
        edge.y = routed.y;
      }
    }
    const paths = helpers.insertEdge(
      edgePaths,
      edge,
      clusters,
      layoutData.type,
      byId.get(String(edge.start)),
      byId.get(String(edge.end)),
      layoutData.diagramId,
    );
    helpers.positionEdgeLabel(edge, paths);
    await budget.step();
  }
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  // Never replace or reject a diagram merely because it is large: Mermaid substitutes a
  // one-node graph past `maxTextSize` and throws past `maxEdges`, and both are secure configs
  // that only `initialize` can raise.
  maxTextSize: Number.MAX_SAFE_INTEGER,
  maxEdges: Number.MAX_SAFE_INTEGER,
  // The application renders its own diagram errors; an aborted render must not leave Mermaid's
  // temporary error SVG behind in the offscreen host.
  suppressErrorRendering: true,
});

const dagreLoader: LayoutLoaderDefinition = {
  name: "dagre",
  loader: async () => ({ render: renderDagreLayout }),
};
mermaid.registerLayoutLoaders([dagreLoader]);

// ---------------------------------------------------------------------------
// Serialized rendering
// ---------------------------------------------------------------------------

/** Mermaid keeps shared parser and render state, so exactly one render may be in flight. */
let renderTail: Promise<unknown> = Promise.resolve();

async function renderSerially(id: string, dsl: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw cancelled();
  const failure = operations.get(signal)?.failure;
  if (failure) throw failure;
  const host = document.createElement("div");
  host.className = "diagram-render-host";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  document.body.append(host);
  activeRenderSignal = signal;
  try {
    await nextTask();
    if (signal.aborted) throw cancelled();
    const rendered = await mermaid.render(id, dsl, host);
    await nextTask();
    if (signal.aborted) throw cancelled();
    return rendered.svg;
  } finally {
    activeRenderSignal = undefined;
    host.remove();
  }
}

/** Renders one diagram into an offscreen host and returns its SVG markup. */
export function renderDiagramSvg(id: string, dsl: string, signal: AbortSignal): Promise<string> {
  const render = renderTail.then(
    () => renderSerially(id, dsl, signal),
    () => renderSerially(id, dsl, signal),
  );
  // A rejected render must leave the tail usable for the next selection.
  renderTail = render.catch(() => undefined);
  return render;
}
