import { layout } from "dagre-d3-es/src/dagre/index.js";
import { Graph } from "dagre-d3-es/src/graphlib/index.js";
import { renderUmlView } from "../uml/view.ts";
import type {
  DiagramLayoutInput,
  DiagramLayoutOutput,
  DiagramWorkerRequest,
  DiagramWorkerResponse,
} from "./diagram-worker-protocol.ts";

/**
 * The dedicated-worker global. `lib.dom` types `self` as a window, so the two members this
 * entrypoint actually uses are named here instead of pulling the whole worker lib into a project
 * whose every other module is a document script.
 */
const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DiagramWorkerRequest>) => void,
  ): void;
  postMessage(message: DiagramWorkerResponse): void;
};

/**
 * Dagre reads its whitelisted attributes with `_.pick`, so a present-but-undefined key becomes
 * `NaN` and beats the documented default. Only defined values may be handed over.
 */
function defined(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function runLayout(input: DiagramLayoutInput): DiagramLayoutOutput {
  if (input.nodes.length === 0) {
    return { graph: { width: 0, height: 0 }, nodes: [], edges: [] };
  }
  const graph = new Graph({ multigraph: true, compound: true });
  graph.setGraph(defined({ ...input.graph }));
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of input.nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of input.edges) {
    const { id, start, end, ...attributes } = edge;
    // Named edges keep parallel links distinct; collapsing them would silently drop diagram content.
    graph.setEdge(start, end, defined(attributes), id);
  }
  layout(graph, undefined);
  const label = graph.graph() as { width?: number; height?: number } | undefined;
  return {
    graph: { width: label?.width ?? 0, height: label?.height ?? 0 },
    nodes: input.nodes.map((node) => {
      const positioned = graph.node(node.id) as { x?: number; y?: number } | undefined;
      return { id: node.id, x: positioned?.x ?? 0, y: positioned?.y ?? 0 };
    }),
    edges: input.edges.map((edge) => {
      const routed = graph.edge(edge.start, edge.end, edge.id) as
        | { points?: { x: number; y: number }[]; x?: number; y?: number }
        | undefined;
      const points = (routed?.points ?? []).map((point) => ({ x: point.x, y: point.y }));
      return routed !== undefined && routed.x !== undefined
        ? { id: edge.id, points, x: routed.x, y: routed.y }
        : { id: edge.id, points };
    }),
  };
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    if (request.kind === "uml-view") {
      scope.postMessage({
        id: request.id,
        kind: "uml-view",
        view: renderUmlView(request.model, request.visibility, request.target),
      });
      return;
    }
    scope.postMessage({ id: request.id, kind: "layout", layout: runLayout(request.graph) });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
