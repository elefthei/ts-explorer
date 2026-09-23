import type { UmlTarget } from "../types.ts";
import type { UmlVisibility } from "../uml/model.ts";
import type { RenderedUmlView, UmlViewModel } from "../uml/view.ts";

/**
 * The structured-clonable slice of a Dagre graph. Only the attributes Dagre's own whitelist reads
 * cross the worker boundary; DOM nodes, D3 selections and intersection callbacks stay in the
 * browser because they are neither clonable nor meaningful off the main thread.
 */
export type DiagramLayoutInput = {
  graph: {
    rankdir: string;
    nodesep?: number;
    ranksep?: number;
    marginx: number;
    marginy: number;
  };
  nodes: { id: string; width: number; height: number }[];
  edges: {
    id: string;
    start: string;
    end: string;
    width?: number;
    height?: number;
    minlen?: number;
    weight?: number;
    labeloffset?: number;
    labelpos?: string;
  }[];
};

/** Geometry only: the browser merges these back into the records it measured. */
export type DiagramLayoutOutput = {
  graph: { width: number; height: number };
  nodes: { id: string; x: number; y: number }[];
  edges: { id: string; points: { x: number; y: number }[]; x?: number; y?: number }[];
};

export type DiagramWorkerRequest =
  | { id: number; kind: "uml-view"; model: UmlViewModel; visibility: UmlVisibility; target: UmlTarget }
  | { id: number; kind: "layout"; graph: DiagramLayoutInput };

export type DiagramWorkerResponse =
  | { id: number; kind: "uml-view"; view: RenderedUmlView }
  | { id: number; kind: "layout"; layout: DiagramLayoutOutput }
  | { id: number; kind: "error"; error: string };
