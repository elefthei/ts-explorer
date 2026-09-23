import type { DiagramPayload, FileDefinition, UmlDiagramPayload } from "../../src/types.ts";
import type { UmlDefinitionEdge, UmlViewModel } from "../../src/uml/view.ts";

/**
 * Readable identity of one graph node: `qualifiedName@path`. Tests assert these instead of raw
 * catalogue keys, whose serialization is deliberately not part of the contract.
 */
export function umlLabel(definition: FileDefinition): string {
  return `${definition.qualifiedName}@${definition.source.path}`;
}

/** The bare declaration name, for suites whose fixtures declare each name exactly once. */
export function qualifiedNameLabel(definition: FileDefinition): string {
  return definition.qualifiedName;
}

/** How a suite chooses to identify one node in an assertion. */
export type NodeLabeller = (definition: FileDefinition) => string;

export type DefinitionsView = Extract<UmlViewModel, { kind: "definitions" }>;
export type FilesView = Extract<UmlViewModel, { kind: "files" }>;

/** Narrows a diagram to its rooted definition graph; throws on any other payload or view. */
export function definitionsView(diagram: DiagramPayload): DefinitionsView {
  if (diagram.kind !== "uml") throw new Error(`expected a uml diagram, received ${diagram.kind}`);
  const { view } = diagram;
  if (view.kind !== "definitions") {
    throw new Error(`expected a definitions view, received ${view.kind}`);
  }
  return view;
}

/** Narrows a diagram to its file-import graph; throws on any other payload or view. */
export function filesView(diagram: DiagramPayload): FilesView {
  if (diagram.kind !== "uml") throw new Error(`expected a uml diagram, received ${diagram.kind}`);
  const { view } = diagram;
  if (view.kind !== "files") {
    throw new Error(`expected a files view, received ${view.kind}`);
  }
  return view;
}

/**
 * Edges as `source -kind-> target` rows, sorted so assertions never pin a key serialization or the
 * order the view happened to emit.
 */
export function edgeRows(view: DefinitionsView, label: NodeLabeller): string[] {
  const names = new Map(view.nodes.map((node) => [node.definition.key, label(node.definition)]));
  return view.edges
    .map((edge) =>
      `${names.get(edge.sourceKey) ?? edge.sourceKey} -${edge.kind}-> ${
        names.get(edge.targetKey) ?? edge.targetKey
      }`
    )
    .sort();
}

/** One row per frame, in the view's own order, each frame's closure sorted by label. */
export function frameRows(
  view: DefinitionsView,
  label: NodeLabeller,
): { root: string; nodes: string[] }[] {
  const names = new Map(view.nodes.map((node) => [node.definition.key, label(node.definition)]));
  return view.frames.map((frame) => ({
    root: names.get(frame.rootKey) ?? frame.rootKey,
    nodes: frame.nodeKeys.map((key) => names.get(key) ?? key).sort(),
  }));
}

export type ContractEdge = {
  kind: UmlDefinitionEdge["kind"];
  source: string;
  target: string;
};

/** A rooted definition selection, projected onto labels. */
export type UmlContract = {
  status: "ready" | "error";
  error?: string;
  /** Every visible node, in the view's own source-position order. */
  nodes: string[];
  edges: ContractEdge[];
  /** One frame per root, each frame's closure sorted by label. */
  frames: { root: string; nodeKeys: string[] }[];
};

export type FileContract = {
  status: "ready" | "error";
  error?: string;
  nodes: { path: string; boundary: boolean; test: boolean }[];
  edges: { source: string; target: string }[];
};

/** Projects a definition selection; throws when the payload carries the `files` view. */
export function toUmlContract(diagram: UmlDiagramPayload): UmlContract {
  const { view } = diagram;
  if (view.kind !== "definitions") {
    throw new Error(`expected a definitions view, received ${view.kind}`);
  }
  const labels = new Map(view.nodes.map((node) => [node.definition.key, umlLabel(node.definition)]));
  const label = (key: string): string => labels.get(key) ?? `<unknown ${key}>`;
  return {
    status: diagram.status,
    ...(diagram.error === undefined ? {} : { error: diagram.error }),
    nodes: view.nodes.map((node) => umlLabel(node.definition)),
    edges: view.edges
      .map((edge) => ({
        kind: edge.kind,
        source: label(edge.sourceKey),
        target: label(edge.targetKey),
      }))
      // Sorted by label so assertions never depend on how a catalogue key serializes.
      .sort((left, right) =>
        left.source.localeCompare(right.source)
        || left.target.localeCompare(right.target)
        || left.kind.localeCompare(right.kind)
      ),
    frames: view.frames.map((frame) => ({
      root: label(frame.rootKey),
      nodeKeys: frame.nodeKeys.map(label).sort((left, right) => left.localeCompare(right)),
    })),
  };
}

/** Projects a directory selection; throws when the payload carries the `definitions` view. */
export function toFileContract(diagram: UmlDiagramPayload): FileContract {
  const { view } = diagram;
  if (view.kind !== "files") {
    throw new Error(`expected a files view, received ${view.kind}`);
  }
  return {
    status: diagram.status,
    ...(diagram.error === undefined ? {} : { error: diagram.error }),
    nodes: view.nodes.map((node) => ({
      path: node.path,
      boundary: node.boundary,
      test: node.test,
    })),
    edges: view.edges.map((edge) => ({ source: edge.sourcePath, target: edge.targetPath })),
  };
}

/** The compartment rows one node displays, by member label, for member-identity assertions. */
export function memberLabels(diagram: UmlDiagramPayload, node: string): string[] {
  const { view } = diagram;
  if (view.kind !== "definitions") {
    throw new Error(`expected a definitions view, received ${view.kind}`);
  }
  const found = view.nodes.find((candidate) => umlLabel(candidate.definition) === node);
  if (!found) throw new Error(`no node ${node} in selection`);
  return found.memberDefinitions.map(umlLabel);
}
