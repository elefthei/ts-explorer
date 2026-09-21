import type { UmlCategoryKind } from "../diagram-graph.ts";
import type { FileDefinition, UmlTarget } from "../types.ts";
import { emitMermaidClassBlock } from "./emit.ts";
import { FILE_STYLE_DEFS, STYLE_DEFS, escapeMermaidLabel } from "./mermaid.ts";
import type { UmlEntityModel, UmlVisibility } from "./model.ts";

export type UmlDefinitionEdge = {
  sourceKey: string;
  targetKey: string;
  kind: "extends" | "implements" | "references";
};

export type UmlDefinitionNode = {
  definition: FileDefinition;
  detail: UmlEntityModel | null;
  category: UmlCategoryKind | null;
  /** The definitions the node's unfiltered compartment rows address, in row order. */
  memberDefinitions: FileDefinition[];
  test: boolean;
};

export type UmlFileNode = { path: string; boundary: boolean; test: boolean };

export type UmlViewModel =
  | {
    kind: "definitions";
    nodes: UmlDefinitionNode[];
    edges: UmlDefinitionEdge[];
    frames: { rootKey: string; nodeKeys: string[] }[];
  }
  | {
    kind: "files";
    nodes: UmlFileNode[];
    edges: { sourcePath: string; targetPath: string }[];
  };

export const EMPTY_UML_VIEW_MODEL: UmlViewModel = {
  kind: "definitions",
  nodes: [],
  edges: [],
  frames: [],
};

export type RenderedUmlFrame = {
  dsl: string;
  title: string;
  rootKey: string | null;
  emptyMessage?: string;
  definitionLinks: {
    nodeId: string;
    definition: FileDefinition;
    attributes: FileDefinition[];
    methods: FileDefinition[];
  }[];
  fileLinks: { nodeId: string; path: string }[];
};

export type RenderedUmlView = { dsl: string; frames: RenderedUmlFrame[] };

const HIDDEN_ROOT_MESSAGE = "Selected definition is hidden by the Tests filter.";
const NO_VISIBLE_DEFINITIONS = "No visible definitions";
const NO_DEFINITIONS = "No definitions";
const NO_FILES = "No files";

const RELATION_ROWS: Record<UmlDefinitionEdge["kind"], (source: string, target: string) => string> = {
  extends: (source, target) => `${target} <|-- ${source}`,
  implements: (source, target) => `${target} <|.. ${source}`,
  references: (source, target) => `${source} --> ${target}`,
};

function categoryClass(node: UmlDefinitionNode): string {
  const category = node.category ?? "plain";
  return node.test ? `test${category[0]?.toUpperCase()}${category.slice(1)}` : category;
}

function styleBlock(): string {
  return STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n");
}

function renderDefinitionFrame(
  model: Extract<UmlViewModel, { kind: "definitions" }>,
  frame: { rootKey: string; nodeKeys: string[] },
  visibility: UmlVisibility,
  nodeIds: ReadonlyMap<string, string>,
  byKey: ReadonlyMap<string, UmlDefinitionNode>,
): RenderedUmlFrame | undefined {
  const root = byKey.get(frame.rootKey);
  if (!root) return undefined;
  const title = `${root.definition.qualifiedName} · ${root.definition.source.path}`;
  const candidates = new Set(
    frame.nodeKeys.filter((key) => {
      const node = byKey.get(key);
      return node !== undefined && (visibility.tests || !node.test);
    }),
  );
  if (!candidates.has(frame.rootKey)) {
    return {
      dsl: "",
      title,
      rootKey: frame.rootKey,
      emptyMessage: HIDDEN_ROOT_MESSAGE,
      definitionLinks: [],
      fileLinks: [],
    };
  }
  const frameEdges = model.edges.filter((edge) =>
    candidates.has(edge.sourceKey) && candidates.has(edge.targetKey)
  );
  // A hidden intermediary must not leave disconnected transitive nodes behind.
  const reachable = new Set<string>([frame.rootKey]);
  const queue = [frame.rootKey];
  while (queue.length) {
    const key = queue.shift();
    if (key === undefined) continue;
    for (const edge of frameEdges) {
      if (edge.sourceKey !== key || reachable.has(edge.targetKey)) continue;
      reachable.add(edge.targetKey);
      queue.push(edge.targetKey);
    }
  }

  const lines = ["classDiagram"];
  const labels: string[] = [];
  const classes: string[] = [];
  const definitionLinks: RenderedUmlFrame["definitionLinks"] = [];
  for (const node of model.nodes) {
    if (!reachable.has(node.definition.key)) continue;
    const nodeId = nodeIds.get(node.definition.key);
    if (nodeId === undefined) continue;
    const block = emitMermaidClassBlock({
      nodeId,
      definition: node.definition,
      detail: node.detail,
      visibility,
    });
    lines.push(block.dsl);
    labels.push(`class ${nodeId}["${block.label}"]`);
    classes.push(`cssClass "${nodeId}" ${categoryClass(node)}`);
    if (node.definition.key === frame.rootKey) classes.push(`cssClass "${nodeId}" rootNode`);
    const memberByKey = new Map(node.memberDefinitions.map((member) => [member.key, member]));
    definitionLinks.push({
      nodeId,
      definition: node.definition,
      attributes: block.attributes.flatMap((row) => {
        const member = row.definitionKey === null ? undefined : memberByKey.get(row.definitionKey);
        return member ? [member] : [];
      }),
      methods: block.methods.flatMap((row) => {
        if (row.definitionKey === null) return [];
        const member = memberByKey.get(row.definitionKey);
        return member ? [member] : [];
      }),
    });
  }
  for (const edge of frameEdges) {
    if (edge.sourceKey === edge.targetKey) continue;
    if (!reachable.has(edge.sourceKey) || !reachable.has(edge.targetKey)) continue;
    const source = nodeIds.get(edge.sourceKey);
    const target = nodeIds.get(edge.targetKey);
    if (source === undefined || target === undefined) continue;
    lines.push(RELATION_ROWS[edge.kind](source, target));
  }
  lines.push(...labels, styleBlock(), ...classes);
  return { dsl: `${lines.join("\n")}\n`, title, rootKey: frame.rootKey, definitionLinks, fileLinks: [] };
}

function renderFileView(
  model: Extract<UmlViewModel, { kind: "files" }>,
  visibility: UmlVisibility,
  target: UmlTarget,
): RenderedUmlView {
  const title = target.path || ".";
  const visible = new Map<string, UmlFileNode>();
  for (const node of model.nodes) {
    if (!visibility.tests && node.test) continue;
    visible.set(node.path, node);
  }
  const edges = model.edges.filter((edge) =>
    visible.has(edge.sourcePath) && visible.has(edge.targetPath)
  );
  // An outside leaf survives only while a visible in-scope file still imports it.
  for (const [path, node] of visible) {
    if (!node.boundary) continue;
    if (!edges.some((edge) => edge.targetPath === path)) visible.delete(path);
  }
  const retained = model.nodes.filter((node) => visible.has(node.path));
  if (!retained.length) {
    return {
      dsl: "",
      frames: [{
        dsl: "",
        title,
        rootKey: null,
        emptyMessage: NO_FILES,
        definitionLinks: [],
        fileLinks: [],
      }],
    };
  }
  const nodeIds = new Map(retained.map((node, index) => [node.path, `f${index}`] as const));
  const lines = ["flowchart LR"];
  const fileLinks: RenderedUmlFrame["fileLinks"] = [];
  for (const node of retained) {
    const nodeId = nodeIds.get(node.path);
    if (nodeId === undefined) continue;
    lines.push(`  ${nodeId}["${escapeMermaidLabel(node.path)}"]`);
    fileLinks.push({ nodeId, path: node.path });
  }
  for (const edge of edges) {
    const source = nodeIds.get(edge.sourcePath);
    const target = nodeIds.get(edge.targetPath);
    if (source === undefined || target === undefined || source === target) continue;
    lines.push(`  ${source} --> ${target}`);
  }
  lines.push(...FILE_STYLE_DEFS.map(([name, style]) => `  classDef ${name} ${style}`));
  for (const node of retained) {
    const nodeId = nodeIds.get(node.path);
    if (nodeId === undefined) continue;
    const style = node.boundary ? "boundaryFile" : node.test ? "testFile" : "file";
    lines.push(`  class ${nodeId} ${style}`);
  }
  const dsl = `${lines.join("\n")}\n`;
  return { dsl, frames: [{ dsl, title, rootKey: null, definitionLinks: [], fileLinks }] };
}

/**
 * Renders one already-fetched selection. Checkbox changes re-enter here with the same model and
 * never mutate it, so repeated renders and shared frames stay identical.
 */
export function renderUmlView(
  model: UmlViewModel,
  visibility: UmlVisibility,
  target: UmlTarget,
): RenderedUmlView {
  if (model.kind === "files") return renderFileView(model, visibility, target);
  const byKey = new Map(model.nodes.map((node) => [node.definition.key, node] as const));
  const nodeIds = new Map(model.nodes.map((node, index) => [node.definition.key, `d${index}`] as const));
  const frames: RenderedUmlFrame[] = [];
  for (const frame of model.frames) {
    const rendered = renderDefinitionFrame(model, frame, visibility, nodeIds, byKey);
    if (!rendered) continue;
    // A file selection simply omits a root the Tests filter hides; a definition says so.
    if (rendered.emptyMessage === HIDDEN_ROOT_MESSAGE && target.kind !== "definition") continue;
    frames.push(rendered);
  }
  if (!frames.length) {
    const emptyMessage = model.frames.length ? NO_VISIBLE_DEFINITIONS : NO_DEFINITIONS;
    return {
      dsl: "",
      frames: [{
        dsl: "",
        title: target.path || ".",
        rootKey: null,
        emptyMessage,
        definitionLinks: [],
        fileLinks: [],
      }],
    };
  }
  const dsl = frames
    .map((frame) => `%% ${frame.title}\n${frame.dsl}`)
    .join("\n");
  return { dsl, frames };
}
