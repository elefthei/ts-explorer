import { basicSetup, EditorView } from "codemirror";
import { Decoration } from "@codemirror/view";
import { EditorSelection, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { DEFAULT_UML_DEPTH } from "../types.ts";
import type {
  DiagramResponse,
  FileDefinition,
  FileDefinitionsResponse,
  FileResponse,
  GotoDefinition,
  LookupResponse,
  PackageDiagramNode,
  SearchResponse,
  TreeNode,
  UmlSourceLocation,
  UmlTarget,
  WatchMessage,
} from "../types.ts";
import { FULL_UML_VISIBILITY } from "../uml/model.ts";
import type { RenderedUmlFrame } from "../uml/view.ts";
import {
  adjacentTreeRowIndex,
  DiagramClickSequence,
  type DiagramPointerTarget,
  RequestSequence,
  fileNodeIdFromNodeId,
  formatUmlMethodReturnLabel,
  hasDiagramBody,
  hasPassedDragThreshold,
  matchesSearchQuery,
  packageNodeIdFromNodeId,
  panViewport,
  treeScrollTopForRow,
  zoomViewportAt,
  type ViewportState,
} from "./diagram-interactions.ts";
import { prepareUmlView, renderDiagramSvg } from "./diagram-renderer.ts";

function $<T extends Element = HTMLInputElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

type UmlDiagramResponse = Extract<DiagramResponse, { kind: "uml" }>;
type PackageDiagramResponse = Extract<DiagramResponse, { kind: "packages" }>;

/** Per-file outline lifecycle. Entry identity is the guard against stale responses committing. */
type FileDefinitionEntry =
  | { status: "loading" }
  | { status: "ready"; definitions: FileDefinition[] }
  | { status: "error"; error: string };

const ROOT_TARGET: UmlTarget = { kind: "directory", path: "" };

const state = {
  tree: null as TreeNode | null,
  mode: "packages" as "packages" | "uml",
  activeView: "packages" as "packages" | "uml" | "editor",
  /** The full UML selection, including a definition root; retained across tab switches. */
  umlTarget: ROOT_TARGET as UmlTarget,
  search: "",
  searchCaseInsensitive: false,
  searchFiles: new Set<string>(),
  searchDirs: new Set<string>(),
  searchDefinitions: [] as GotoDefinition[],
  /** Presentation-only dropdown visibility; retained matches survive a dismissal. */
  searchResultsOpen: false,
  version: 0,
  file: null as FileResponse | null,
  view: null as EditorView | null,
  retry: 250,
  expandedDirs: new Set<string>(),
  expandedFiles: new Set<string>(),
  fileDefinitions: new Map<string, FileDefinitionEntry>(),
  umlVisibility: { ...FULL_UML_VISIBILITY },
  /** Outgoing dependency levels requested for definition and file selections. */
  umlDepth: DEFAULT_UML_DEPTH,
  umlRenders: [] as { target: UmlTarget; depth: number; diagram: UmlDiagramResponse }[],
  umlRenderVersion: -1,
  umlScopedErrors: false,
};

const ZOOM_IN_FACTOR = 1.25;
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
const EMPTY_DIAGRAM_MESSAGE = "No diagram content for this scope";

const viewport: ViewportState & {
  apply(): void;
  reset(): void;
  zoomAt(factor: number, x: number, y: number): void;
} = {
  scale: 1,
  x: 0,
  y: 0,
  apply() {
    $("#svg-holder").style.transform = `translate(${this.x}px,${this.y}px) scale(${this.scale})`;
  },
  reset() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.apply();
    const stage = $("#diagram-stage");
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  },
  zoomAt(factor, x, y) {
    zoomViewportAt(this, factor, x, y);
    this.apply();
  },
};

const diagramRequests = new RequestSequence();
const searchRequests = new RequestSequence();
const definitionRequests = new RequestSequence();
const editorRequests = new RequestSequence();
const clickSequence = new DiagramClickSequence();
let diagramLoading = false;
/** Cancels the current diagram operation's preparation and rendering; replaced on every change. */
let diagramController = new AbortController();
let diagramError: string | undefined;
let pendingDiagram: { key: string; token: number } | undefined;
let paintedUmlKey: string | undefined;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

/** A directory import graph ignores depth, so its identity stays depth-free. */
function diagramKey(target: UmlTarget, depth: number): string {
  return JSON.stringify(
    target.kind === "definition"
      ? ["definition", target.path, target.definitionKey, depth]
      : target.kind === "file"
        ? ["file", target.path, depth]
        : ["directory", target.path],
  );
}

function diagramQuery(target: UmlTarget, depth: number): string {
  const params = new URLSearchParams({ kind: "uml", target: target.kind, path: target.path });
  if (target.kind === "definition") params.set("definition", target.definitionKey);
  if (target.kind !== "directory") params.set("depth", String(depth));
  return params.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(text: string, error = false): void {
  const node = $("#status");
  node.textContent = text;
  node.classList.toggle("error", error);
}

function renderErrorPanel(): void {
  const panel = $("#error-panel");
  const text = diagramLoading ? undefined : diagramError;
  panel.textContent = text ?? "";
  panel.hidden = !text;
}

function showError(error: string | undefined): void {
  diagramError = error;
  renderErrorPanel();
}

function reportFailure(error: unknown, status?: string): void {
  const message = errorMessage(error);
  showError(message);
  setStatus(status ?? message, true);
}

function applyDiagramLoading(): void {
  $("#diagram-loading").hidden = !diagramLoading;
  const stage = $("#diagram-stage");
  stage.setAttribute("aria-busy", String(diagramLoading));
  // Scoped to the selected diagram: its stale links leave the tab order, the shell never does.
  $("#svg-holder").inert = diagramLoading;
  renderErrorPanel();
}

function setDiagramLoading(loading: boolean): void {
  diagramLoading = loading;
  applyDiagramLoading();
}

/**
 * Supersedes the in-flight diagram operation and releases its overlay. Every caller that abandons a
 * diagram request must go through here: a superseded operation never reaches its own finalizer, so
 * bumping the sequence alone would leave "Loading" painted over the workspace forever.
 */
function invalidateDiagramRequest(): number {
  // The token moves first: an abort listener must never observe the superseded generation as live.
  const token = diagramRequests.next();
  diagramController.abort();
  diagramController = new AbortController();
  pendingDiagram = undefined;
  setDiagramLoading(false);
  return token;
}

// ---------------------------------------------------------------------------
// Diagram link registry
// ---------------------------------------------------------------------------

const diagramLinks = new Map<string, DiagramPointerTarget>();
let nextDiagramLinkId = 0;

/** Returns the registry id so a caller can extend the hit area without a second registration. */
function registerDiagramLink(
  element: Element,
  target: DiagramPointerTarget,
  label: string,
): string {
  const id = String(nextDiagramLinkId++);
  diagramLinks.set(id, target);
  const html = element as HTMLElement;
  html.dataset.diagramLink = id;
  element.classList.add(target.kind === "definition" ? "uml-definition-link" : "uml-file-link");
  element.setAttribute("role", "link");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-label", `Select ${label}; double-click to open its source`);
  return id;
}

function diagramTargetFromElement(node: EventTarget | null): DiagramPointerTarget | undefined {
  if (!(node instanceof Element)) return undefined;
  // Nearest wins: a member row inside a box still selects that member, not its declaring node.
  const link = node.closest<HTMLElement>("[data-diagram-link], [data-diagram-node-link]");
  const id = link?.dataset.diagramLink ?? link?.dataset.diagramNodeLink;
  return id === undefined ? undefined : diagramLinks.get(id);
}

function parseMethodName(text: string): string {
  const normalized = text.trim().replace(/^\\?[+\-#~]/, "");
  const parenthesis = normalized.indexOf("(");
  return (parenthesis === -1 ? normalized : normalized.slice(0, parenthesis)).trim();
}

function decorateDefinitionFrame(root: Element, frame: RenderedUmlFrame): void {
  const byNodeId = new Map(frame.definitionLinks.map((link) => [link.nodeId, link] as const));
  for (const node of root.querySelectorAll<SVGGElement>("g.node")) {
    const match = /classId-(.+)-\d+$/.exec(node.id);
    const nodeId = match?.[1];
    const link = nodeId === undefined ? undefined : byNodeId.get(nodeId);
    if (!link) continue;
    const title = node.querySelector(".label-group .label, .classTitle");
    if (title) {
      (title as HTMLElement).dataset.searchText = (title.textContent ?? "").trim();
      // The whole box points at the same registry entry as its title; no second focusable link.
      node.dataset.diagramNodeLink = registerDiagramLink(
        title,
        { kind: "definition", definition: link.definition },
        link.definition.qualifiedName,
      );
    }
    const attributeRows = [...node.querySelectorAll(".members-group > .label")];
    for (const [index, row] of attributeRows.entries()) {
      const member = link.attributes[index];
      if (!member) continue;
      (row as HTMLElement).dataset.searchText = (row.textContent ?? "").trim();
      registerDiagramLink(row, { kind: "definition", definition: member }, member.qualifiedName);
    }
    let methodIndex = 0;
    for (const row of node.querySelectorAll(".methods-group > .label")) {
      const formattedReturn = formatUmlMethodReturnLabel(row.textContent ?? "");
      if (formattedReturn !== undefined) {
        const content = row.querySelector(".nodeLabel p, .nodeLabel") ?? row;
        content.textContent = formattedReturn;
        continue;
      }
      const member = link.methods[methodIndex];
      methodIndex += 1;
      if (!member) continue;
      (row as HTMLElement).dataset.searchText = parseMethodName(row.textContent ?? "");
      registerDiagramLink(row, { kind: "definition", definition: member }, member.qualifiedName);
    }
  }
}

function decorateFileFrame(root: Element, frame: RenderedUmlFrame): void {
  const byNodeId = new Map(frame.fileLinks.map((link) => [link.nodeId, link] as const));
  for (const node of root.querySelectorAll<SVGGElement>("g.node")) {
    const nodeId = fileNodeIdFromNodeId(node.id);
    const link = nodeId === undefined ? undefined : byNodeId.get(nodeId);
    if (!link) continue;
    const label = node.querySelector(".nodeLabel") ?? node;
    (label as HTMLElement).dataset.searchText = link.path;
    node.dataset.diagramNodeLink = registerDiagramLink(
      label,
      { kind: "file", path: link.path },
      link.path,
    );
  }
}

function decoratePackageNodes(root: Element, packageNodes: readonly PackageDiagramNode[]): void {
  const byId = new Map(packageNodes.map((pkg) => [pkg.nodeId, pkg] as const));
  for (const node of root.querySelectorAll<SVGGElement>("g.node")) {
    const nodeId = packageNodeIdFromNodeId(node.id);
    const pkg = nodeId === undefined ? undefined : byId.get(nodeId);
    if (!pkg) continue;
    node.classList.add("package-link");
    node.setAttribute("role", "link");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-label", `Open ${pkg.name} UML`);
    node.dataset.packageName = pkg.name;
    node.dataset.scopePath = pkg.path;
  }
}

function applySearchHighlights(): void {
  const input = $("#node-search");
  for (const element of document.querySelectorAll("#svg-holder .search-match")) {
    element.classList.remove("search-match");
  }
  if (!state.search) {
    input.classList.remove("no-match");
    input.removeAttribute("aria-invalid");
    return;
  }
  if (state.activeView === "uml") {
    for (const candidate of document.querySelectorAll<HTMLElement>("#svg-holder [data-search-text]")) {
      candidate.classList.toggle(
        "search-match",
        matchesSearchQuery(candidate.dataset.searchText ?? "", state.search, state.searchCaseInsensitive),
      );
    }
  }
  const failed = state.searchFiles.size === 0;
  input.classList.toggle("no-match", failed);
  if (failed) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

// ---------------------------------------------------------------------------
// File outline
// ---------------------------------------------------------------------------

/**
 * Loads one file's outline. The installed loading object is the request's identity: a response is
 * committed only while that exact object is still the file's entry, so a collapse, a re-expansion
 * or a watcher invalidation discards whatever was already in flight.
 */
async function loadFileDefinitions(path: string): Promise<void> {
  const pending: FileDefinitionEntry = { status: "loading" };
  state.fileDefinitions.set(path, pending);
  let settled: FileDefinitionEntry;
  try {
    const response = await api<FileDefinitionsResponse>(
      `/api/file-definitions?${new URLSearchParams({ path })}`,
    );
    settled = { status: "ready", definitions: response.definitions };
  } catch (error) {
    settled = { status: "error", error: errorMessage(error) };
  }
  if (state.fileDefinitions.get(path) !== pending) return;
  state.fileDefinitions.set(path, settled);
  // Never re-expand or steal focus: only repaint a file the user still has open.
  if (!state.expandedFiles.has(path)) return;
  renderTree();
}

async function readFileDefinitions(path: string): Promise<FileDefinition[]> {
  const entry = state.fileDefinitions.get(path);
  if (entry?.status === "ready") return entry.definitions;
  const pending: FileDefinitionEntry = { status: "loading" };
  state.fileDefinitions.set(path, pending);
  const response = await api<FileDefinitionsResponse>(
    `/api/file-definitions?${new URLSearchParams({ path })}`,
  );
  if (state.fileDefinitions.get(path) === pending) {
    state.fileDefinitions.set(path, { status: "ready", definitions: response.definitions });
  }
  return response.definitions;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type DesiredDefinition = { key: string; definition: FileDefinition; selected: boolean };

type DesiredRow = {
  key: string;
  node: TreeNode;
  expanded: boolean;
  searchMatch: boolean;
  selected: boolean;
  definitions: DesiredDefinition[] | { message: string; error: boolean } | undefined;
  children: DesiredRow[];
};

function targetForNode(node: TreeNode): UmlTarget {
  return node.kind === "directory"
    ? { kind: "directory", path: node.path }
    : { kind: "file", path: node.path };
}

function definitionRowKey(definition: FileDefinition): string {
  return JSON.stringify(["definition", definition.key]);
}

function desiredDefinitions(path: string): DesiredRow["definitions"] {
  const entry = state.fileDefinitions.get(path);
  if (entry === undefined || entry.status === "loading") {
    return { message: "Loading definitions…", error: false };
  }
  if (entry.status === "error") return { message: entry.error, error: true };
  if (!entry.definitions.length) return { message: "No definitions", error: false };
  return entry.definitions.map((definition) => ({
    key: definitionRowKey(definition),
    definition,
    selected: state.umlTarget.kind === "definition"
      && state.umlTarget.path === definition.source.path
      && state.umlTarget.definitionKey === definition.key,
  }));
}

function buildDesiredRow(node: TreeNode, filter: string): DesiredRow | null {
  const isDir = node.kind === "directory";
  const nodeSearchMatch = isDir ? state.searchDirs.has(node.path) : state.searchFiles.has(node.path);
  const children: DesiredRow[] = [];
  for (const childNode of node.children ?? []) {
    const child = buildDesiredRow(childNode, filter);
    if (child) children.push(child);
  }
  const hasSearchMatch = nodeSearchMatch || children.some((child) => child.searchMatch);
  const matching = !filter
    || node.name.toLowerCase().includes(filter)
    || node.path.toLowerCase().includes(filter);
  if (!matching && !children.length && !nodeSearchMatch) return null;
  const expanded = isDir
    ? state.expandedDirs.has(node.path) || Boolean(filter) || hasSearchMatch
    : state.expandedFiles.has(node.path);
  return {
    key: JSON.stringify(["path", node.path]),
    node,
    expanded,
    searchMatch: hasSearchMatch,
    selected: state.umlTarget.kind === node.kind && state.umlTarget.path === node.path,
    definitions: !isDir && expanded ? desiredDefinitions(node.path) : undefined,
    children,
  };
}

function reconcile(container: HTMLElement, keys: readonly string[], create: (key: string) => HTMLElement): HTMLElement[] {
  const existing = new Map<string, HTMLElement>();
  for (const child of [...container.children]) {
    const key = (child as HTMLElement).dataset.nodeKey;
    if (key !== undefined) existing.set(key, child as HTMLElement);
  }
  let cursor = container.firstChild;
  const result: HTMLElement[] = [];
  for (const key of keys) {
    let element = existing.get(key);
    if (element) existing.delete(key);
    else {
      element = create(key);
      element.dataset.nodeKey = key;
    }
    // Retained rows that already occupy their final position are never detached.
    if (element === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(element, cursor);
    result.push(element);
  }
  for (const element of existing.values()) element.remove();
  return result;
}

function createDefinitionRow(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-row tree-definition-row";
  const name = document.createElement("span");
  name.className = "tree-definition-name";
  const kind = document.createElement("span");
  kind.className = "tree-definition-kind";
  const type = document.createElement("span");
  type.className = "tree-definition-type";
  button.append(name, kind, type);
  return button;
}

function patchDefinitionRow(button: HTMLButtonElement, row: DesiredDefinition): void {
  const { definition } = row;
  const type = definition.type ?? "—";
  button.dataset.treeRowKey = row.key;
  button.dataset.sourcePath = definition.source.path;
  button.dataset.sourceLine = String(definition.source.line);
  button.dataset.sourceColumn = String(definition.source.column);
  button.dataset.definitionKey = definition.key;
  button.title =
    `${definition.qualifiedName} · ${definition.kind} · ${type}\n${definition.source.path}:${definition.source.line}:${definition.source.column}`;
  button.classList.toggle("selected", row.selected);
  if (row.selected) button.setAttribute("aria-current", "true");
  else button.removeAttribute("aria-current");
  // Names and types come from source text: build them as nodes, never as markup.
  const [name, kind, typeSpan] = [...button.children] as HTMLElement[];
  if (name) name.textContent = definition.qualifiedName;
  if (kind) kind.textContent = definition.kind;
  if (typeSpan) typeSpan.textContent = type;
  button.onclick = (event) => {
    if (event.detail > 1) return;
    void selectUmlTarget({
      kind: "definition",
      path: definition.source.path,
      definitionKey: definition.key,
    });
  };
  button.ondblclick = () => {
    void openFile(definition.source.path, definition.source);
  };
}

function createTreeRow(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";
  const line = document.createElement("div");
  line.className = "tree-line";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  toggle.tabIndex = -1;
  const label = document.createElement("button");
  label.type = "button";
  label.className = "tree-row";
  const name = document.createElement("span");
  label.append(name);
  line.append(toggle, label);
  wrap.append(line);
  return wrap;
}

function patchTreeRow(wrap: HTMLElement, row: DesiredRow): void {
  const line = wrap.firstElementChild as HTMLElement;
  const toggle = line.firstElementChild as HTMLButtonElement;
  const label = line.lastElementChild as HTMLButtonElement;
  const { node } = row;
  toggle.dataset.treePath = node.path;
  toggle.textContent = row.expanded ? "▾" : "▸";
  toggle.setAttribute("aria-label", row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`);
  toggle.setAttribute("aria-expanded", String(row.expanded));
  toggle.onclick = (event) => {
    event.stopPropagation();
    const set = node.kind === "directory" ? state.expandedDirs : state.expandedFiles;
    if (set.has(node.path)) set.delete(node.path);
    else {
      set.add(node.path);
      if (node.kind === "file" && state.fileDefinitions.get(node.path)?.status === "error") {
        state.fileDefinitions.delete(node.path);
      }
    }
    renderTree();
  };
  label.dataset.treePath = node.path;
  label.dataset.treeRowKey = row.key;
  label.classList.toggle("selected", row.selected);
  label.classList.toggle("search-match", row.searchMatch);
  label.setAttribute("aria-expanded", String(row.expanded));
  label.title = node.kind === "file"
    ? `${node.path}\nDouble-click to open its source.`
    : node.path || ".";
  if (row.selected) label.setAttribute("aria-current", "true");
  else label.removeAttribute("aria-current");
  const name = label.firstElementChild as HTMLElement;
  name.textContent = node.name;
  label.onclick = (event) => {
    if (event.detail > 1) return;
    void selectUmlTarget(targetForNode(node));
  };
  label.ondblclick = node.kind === "file"
    ? () => {
      void openFile(node.path);
    }
    : null;

  let definitionsGroup = wrap.querySelector<HTMLElement>(":scope > .tree-definitions");
  if (row.definitions === undefined) {
    definitionsGroup?.remove();
  } else {
    if (!definitionsGroup) {
      definitionsGroup = document.createElement("div");
      definitionsGroup.className = "tree-children tree-definitions";
      definitionsGroup.setAttribute("role", "group");
      wrap.append(definitionsGroup);
    }
    definitionsGroup.setAttribute("aria-label", `Definitions in ${node.path}`);
    if (Array.isArray(row.definitions)) {
      const rows = row.definitions;
      const elements = reconcile(definitionsGroup, rows.map((entry) => entry.key), () =>
        createDefinitionRow());
      for (const [index, element] of elements.entries()) {
        const definitionRow = rows[index];
        if (definitionRow) patchDefinitionRow(element as HTMLButtonElement, definitionRow);
      }
    } else {
      const message = row.definitions;
      const elements = reconcile(definitionsGroup, ["message"], () => {
        const div = document.createElement("div");
        div.className = "tree-definition-message";
        return div;
      });
      const element = elements[0];
      if (element) {
        element.className = `tree-definition-message${message.error ? " error" : ""}`;
        element.textContent = message.message;
      }
    }
  }

  let childrenGroup = wrap.querySelector<HTMLElement>(":scope > .tree-children:not(.tree-definitions)");
  if (!row.children.length || !row.expanded) {
    childrenGroup?.remove();
    return;
  }
  if (!childrenGroup) {
    childrenGroup = document.createElement("div");
    childrenGroup.className = "tree-children";
    wrap.append(childrenGroup);
  }
  patchRows(childrenGroup, row.children);
}

function patchRows(container: HTMLElement, rows: readonly DesiredRow[]): void {
  const elements = reconcile(container, rows.map((row) => row.key), () => createTreeRow());
  for (const [index, element] of elements.entries()) {
    const row = rows[index];
    if (row) patchTreeRow(element, row);
  }
}

function renderTree(): void {
  const root = $("#tree");
  if (!state.tree) {
    root.replaceChildren();
    applySearchHighlights();
    return;
  }
  const filter = $("#tree-filter").value.toLowerCase();
  const desired = buildDesiredRow(state.tree, filter);
  patchRows(root, desired ? [desired] : []);
  scheduleVisibleFileDefinitions();
  applySearchHighlights();
}

/** Fetches outlines only for expanded file rows actually painted in the tree. */
function scheduleVisibleFileDefinitions(): void {
  for (const row of $("#tree").querySelectorAll<HTMLButtonElement>(".tree-row[data-tree-path]")) {
    const path = row.dataset.treePath;
    if (path === undefined || !state.expandedFiles.has(path)) continue;
    if (state.fileDefinitions.has(path)) continue;
    void loadFileDefinitions(path);
  }
}

function collectTreePaths(
  node: TreeNode,
  paths = { directories: new Set<string>(), files: new Set<string>() },
): { directories: Set<string>; files: Set<string> } {
  if (node.kind === "directory") paths.directories.add(node.path);
  else paths.files.add(node.path);
  for (const child of node.children ?? []) collectTreePaths(child, paths);
  return paths;
}

let treeRefreshPromise: Promise<void> | undefined;
let treeRefreshRequested = false;

function loadTree(): Promise<void> {
  treeRefreshRequested = true;
  if (treeRefreshPromise) return treeRefreshPromise;
  treeRefreshPromise = (async () => {
    while (treeRefreshRequested) {
      treeRefreshRequested = false;
      try {
        const response = await api<{ version: number; root: TreeNode }>("/api/tree");
        if (treeRefreshRequested) continue;
        const firstTree = state.tree === null;
        const { directories, files } = collectTreePaths(response.root);
        state.expandedDirs = new Set([...state.expandedDirs].filter((path) => directories.has(path)));
        if (firstTree) state.expandedDirs.add(response.root.path);
        // Paths that no longer exist must not keep an expansion or a stale outline alive.
        state.expandedFiles = new Set([...state.expandedFiles].filter((path) => files.has(path)));
        for (const path of [...state.fileDefinitions.keys()]) {
          if (!files.has(path)) state.fileDefinitions.delete(path);
        }
        state.tree = response.root;
        state.version = response.version;
        $("#source-label").textContent = response.root.name;
        renderTree();
      } catch (error) {
        if (treeRefreshRequested) continue;
        throw error;
      }
    }
  })().finally(() => {
    treeRefreshPromise = undefined;
  });
  return treeRefreshPromise;
}

// ---------------------------------------------------------------------------
// Diagram painting
// ---------------------------------------------------------------------------

type UmlPaint = {
  holder: HTMLElement;
  token: number;
  isCurrent: () => boolean;
  scopedErrors: boolean;
  errors: string[];
  dslSections: string[];
  frameIndex: number;
  signal: AbortSignal;
};

function beginUmlPaint(
  token: number,
  isCurrent: () => boolean,
  scopedErrors: boolean,
  signal: AbortSignal,
): UmlPaint {
  const holder = $("#svg-holder");
  holder.replaceChildren();
  holder.classList.add("stacked");
  holder.setAttribute("role", "list");
  // The tap snapshot deliberately survives the first tap's own repaint.
  diagramLinks.clear();
  return {
    holder,
    token,
    isCurrent,
    scopedErrors,
    errors: [],
    dslSections: [],
    frameIndex: 0,
    signal,
  };
}

async function renderUmlFrames(request: {
  paint: UmlPaint;
  scope: string;
  frames: readonly RenderedUmlFrame[];
  directoryIndex: number;
}): Promise<boolean> {
  const { paint, scope, frames, directoryIndex } = request;
  for (const [frameIndex, rendered] of frames.entries()) {
    // Every resumed frame revalidates: a stale one must never be appended over a newer diagram.
    if (!paint.isCurrent()) return false;
    const frame = document.createElement("div");
    frame.className = "uml-frame";
    frame.setAttribute("role", "listitem");
    frame.dataset.index = String(paint.frameIndex);
    const heading = document.createElement("div");
    heading.className = "uml-frame-heading";
    heading.textContent = rendered.title;
    frame.append(heading);
    frame.setAttribute("aria-label", `UML diagram ${paint.frameIndex + 1}: ${rendered.title}`);
    const body = document.createElement("div");
    body.className = "uml-frame-body";
    frame.append(body);
    if (rendered.emptyMessage !== undefined || !hasDiagramBody(rendered.dsl)) {
      frame.classList.add("empty");
      body.textContent = rendered.emptyMessage ?? EMPTY_DIAGRAM_MESSAGE;
    } else {
      try {
        const svg = await renderDiagramSvg(
          `diagram-${paint.token}-${directoryIndex}-${frameIndex}`,
          rendered.dsl,
          paint.signal,
        );
        if (!paint.isCurrent()) return false;
        body.innerHTML = svg;
        decorateDefinitionFrame(body, rendered);
        decorateFileFrame(body, rendered);
      } catch (error) {
        if (!paint.isCurrent()) return false;
        const message = errorMessage(error);
        frame.classList.add("error");
        body.textContent = `Diagram ${frameIndex + 1}: ${message}`;
        paint.errors.push(
          paint.scopedErrors
            ? `[${scope}] diagram ${frameIndex + 1}: ${message}`
            : `Diagram ${frameIndex + 1}: ${message}`,
        );
      }
    }
    paint.holder.append(frame);
    paint.frameIndex++;
  }
  return true;
}

async function paintUmlScope(
  paint: UmlPaint,
  target: UmlTarget,
  diagram: UmlDiagramResponse,
  directoryIndex: number,
): Promise<boolean> {
  const scope = target.path || ".";
  const view = await prepareUmlView(diagram.view, { ...state.umlVisibility }, target, paint.signal);
  if (!paint.isCurrent()) return false;
  paint.dslSections.push(paint.scopedErrors ? `%% Scope: ${scope}\n${view.dsl}` : view.dsl);
  if (diagram.status === "error") {
    paint.errors.push(
      paint.scopedErrors
        ? `[${scope}] ${diagram.error ?? "Diagram error"}`
        : diagram.error ?? "Diagram error",
    );
  }
  return renderUmlFrames({ paint, scope, frames: view.frames, directoryIndex });
}

function finishUmlPaint(paint: UmlPaint, errorStatus: string, readyStatus: string): void {
  if (!paint.isCurrent()) return;
  $("#dsl-content").textContent = paint.dslSections.join("\n\n");
  applySearchHighlights();
  viewport.apply();
  if (paint.errors.length) {
    showError(paint.errors.join("\n"));
    setStatus(errorStatus, true);
  } else {
    showError(undefined);
    setStatus(readyStatus);
  }
}

async function loadUmlDiagram(target: UmlTarget, token: number, signal: AbortSignal): Promise<void> {
  const isCurrent = () => diagramRequests.isCurrent(token);
  // Captured once: every key, query and retained entry below must describe the depth actually
  // fetched, never whatever the input holds after an await.
  const depth = target.kind === "directory" ? DEFAULT_UML_DEPTH : state.umlDepth;
  setDiagramLoading(true);
  showError(undefined);
  // Drop the retained model before awaiting: a member-visibility repaint arriving during this fetch
  // must not mistake the previous search overview for this selection and cancel the request.
  state.umlRenders = [];
  state.umlRenderVersion = -1;
  state.umlScopedErrors = false;
  try {
    const diagram = await api<DiagramResponse>(`/api/diagram?${diagramQuery(target, depth)}`);
    if (!isCurrent()) return;
    if (diagram.kind !== "uml") throw new Error("Unexpected diagram kind");
    state.version = diagram.version;
    state.umlRenders = [{ target, depth, diagram }];
    state.umlRenderVersion = diagram.version;
    state.umlScopedErrors = false;
    const paint = beginUmlPaint(token, isCurrent, false, signal);
    const complete = await paintUmlScope(paint, target, diagram, 0);
    if (!complete || !isCurrent()) return;
    paintedUmlKey = diagramKey(target, depth);
    finishUmlPaint(paint, "Mermaid render error", `Updated · v${diagram.version}`);
  } finally {
    if (isCurrent()) setDiagramLoading(false);
  }
}

async function loadPackagesDiagram(token = invalidateDiagramRequest()): Promise<void> {
  const signal = diagramController.signal;
  const isCurrent = () => diagramRequests.isCurrent(token);
  state.mode = "packages";
  activateView("packages");
  viewport.reset();
  setDiagramLoading(true);
  showError(undefined);
  paintedUmlKey = undefined;
  try {
    const diagram = await api<DiagramResponse>("/api/diagram?kind=packages&path=");
    if (!isCurrent()) return;
    if (diagram.kind !== "packages") throw new Error("Unexpected diagram kind");
    state.version = diagram.version;
    await paintPackages(diagram, token, signal);
  } catch (error) {
    if (!isCurrent()) return;
    reportFailure(error, "Request failed");
  } finally {
    if (isCurrent()) setDiagramLoading(false);
  }
}

async function paintPackages(
  diagram: PackageDiagramResponse,
  token: number,
  signal: AbortSignal,
): Promise<void> {
  const holder = $("#svg-holder");
  holder.classList.remove("stacked");
  holder.removeAttribute("role");
  diagramLinks.clear();
  clickSequence.clear();
  $("#dsl-content").textContent = diagram.dsl;
  showError(diagram.status === "error" ? diagram.error : undefined);
  if (!hasDiagramBody(diagram.dsl)) {
    const frame = document.createElement("div");
    frame.className = "uml-frame empty";
    frame.textContent = EMPTY_DIAGRAM_MESSAGE;
    holder.replaceChildren(frame);
    viewport.apply();
    setStatus(`Updated · v${diagram.version}`);
    return;
  }
  // Awaited so the caller's loading overlay lasts until package rendering settles, not merely until
  // its HTTP response arrived.
  try {
    const rendered = await renderDiagramSvg(`diagram-${token}`, diagram.dsl, signal);
    if (!diagramRequests.isCurrent(token)) return;
    holder.innerHTML = rendered;
    decoratePackageNodes(holder, diagram.packageNodes);
    applySearchHighlights();
    viewport.apply();
    setStatus(`Updated · v${diagram.version}`);
  } catch (error) {
    if (!diagramRequests.isCurrent(token)) return;
    reportFailure(error, "Mermaid render error");
  }
}

function umlModelIsCurrent(target: UmlTarget): boolean {
  const render = state.umlRenders.length === 1 ? state.umlRenders[0] : undefined;
  return render !== undefined
    && state.umlRenderVersion === state.version
    && diagramKey(render.target, render.depth) === diagramKey(target, state.umlDepth);
}

/**
 * Supersedes every pending selection, activates UML and loads exactly `target`. It never opens the
 * editor, so a late graph response can never switch the workspace away from a double-click.
 */
async function selectUmlTarget(target: UmlTarget): Promise<void> {
  const key = diagramKey(target, state.umlDepth);
  if (pendingDiagram && pendingDiagram.key === key && diagramRequests.isCurrent(pendingDiagram.token)) {
    return;
  }
  if (state.activeView === "uml" && paintedUmlKey === key && umlModelIsCurrent(target)) return;
  definitionRequests.next();
  editorRequests.next();
  searchRequests.next();
  const token = invalidateDiagramRequest();
  const signal = diagramController.signal;
  const record = { key, token };
  pendingDiagram = record;
  state.mode = "uml";
  state.umlTarget = target;
  activateView("uml");
  viewport.reset();
  renderTree();
  try {
    await loadUmlDiagram(target, token, signal);
  } catch (error) {
    if (!diagramRequests.isCurrent(token)) return;
    setDiagramLoading(false);
    reportFailure(error, "Request failed");
  } finally {
    // Cleared by identity so a superseded record can never block a retry.
    if (pendingDiagram === record) pendingDiagram = undefined;
  }
}

async function rerenderUmlDiagrams(): Promise<void> {
  if (state.activeView !== "uml" || !state.umlRenders.length) return;
  // A single-selection repaint may only supersede the diagram sequence when the retained model still
  // belongs to the selected target; otherwise a checkbox would cancel another target's live request.
  if (!state.umlScopedErrors && !umlModelIsCurrent(state.umlTarget)) return;
  const token = invalidateDiagramRequest();
  const signal = diagramController.signal;
  const isCurrent = () => diagramRequests.isCurrent(token);
  setDiagramLoading(true);
  try {
    const paint = beginUmlPaint(token, isCurrent, state.umlScopedErrors, signal);
    for (const [directoryIndex, render] of state.umlRenders.entries()) {
      const complete = await paintUmlScope(paint, render.target, render.diagram, directoryIndex);
      if (!complete) return;
    }
    finishUmlPaint(paint, "Mermaid render error", `Updated · v${state.version}`);
    if (isCurrent() && !state.umlScopedErrors && umlModelIsCurrent(state.umlTarget)) {
      paintedUmlKey = diagramKey(state.umlTarget, state.umlDepth);
    }
  } catch (error) {
    if (!isCurrent()) return;
    reportFailure(error, "Mermaid render error");
  } finally {
    if (isCurrent()) setDiagramLoading(false);
  }
}

/** Restores the remembered UML selection, rerendering the retained model when it is still current. */
function restoreUmlView(): void {
  state.mode = "uml";
  if (
    umlModelIsCurrent(state.umlTarget)
    && paintedUmlKey === diagramKey(state.umlTarget, state.umlDepth)
  ) {
    activateView("uml");
    void rerenderUmlDiagrams();
    return;
  }
  void selectUmlTarget(state.umlTarget);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Toggles the definition-result popup; an empty result set always stays hidden. */
function setSearchResultsOpen(open: boolean): void {
  state.searchResultsOpen = open;
  $("#definition-results").hidden = !open || state.searchDefinitions.length === 0;
}

function renderDefinitionResults(): void {
  const results = $("#definition-results");
  const keys = state.searchDefinitions.map((definition) =>
    JSON.stringify([definition.source.path, definition.key])
  );
  const elements = reconcile(results, keys, () => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "definition-result";
    button.setAttribute("role", "option");
    const name = document.createElement("span");
    name.className = "definition-result-name";
    const location = document.createElement("span");
    location.className = "definition-result-location";
    button.append(name, location);
    return button;
  });
  for (const [index, element] of elements.entries()) {
    const definition = state.searchDefinitions[index];
    if (!definition) continue;
    const [name, location] = [...element.children] as HTMLElement[];
    if (name) name.textContent = `${definition.kind} · ${definition.qualifiedName}`;
    if (location) {
      location.textContent = `${definition.source.path}:${definition.source.line}`;
    }
    const button = element as HTMLButtonElement;
    button.onclick = (event) => {
      if (event.detail > 1) return;
      void selectSearchDefinition(definition);
    };
    button.ondblclick = () => {
      void openFile(definition.source.path, definition.source);
    };
  }
  setSearchResultsOpen(state.searchResultsOpen);
}

/** Resolves a search hit to its outline key by exact source position, name and qualified name. */
async function selectSearchDefinition(definition: GotoDefinition): Promise<void> {
  const token = definitionRequests.next();
  try {
    const definitions = await readFileDefinitions(definition.source.path);
    if (!definitionRequests.isCurrent(token)) return;
    const match = definitions.find((candidate) =>
      candidate.source.line === definition.source.line
      && candidate.source.column === definition.source.column
      && candidate.name === definition.name
      && candidate.qualifiedName === definition.qualifiedName
    );
    if (!match) throw new Error("Definition not found");
    if (!definitionRequests.isCurrent(token)) return;
    await selectUmlTarget({
      kind: "definition",
      path: definition.source.path,
      definitionKey: match.key,
    });
  } catch (error) {
    if (!definitionRequests.isCurrent(token)) return;
    reportFailure(error);
  }
}

function clearSearch(): void {
  setSearchResultsOpen(false);
  definitionRequests.next();
  searchRequests.next();
  state.search = "";
  state.searchFiles.clear();
  state.searchDirs.clear();
  state.searchDefinitions = [];
  renderDefinitionResults();
  renderTree();
}

async function renderSearchDiagrams(renderDirs: readonly string[], searchToken: number): Promise<void> {
  const renderToken = invalidateDiagramRequest();
  const signal = diagramController.signal;
  const isCurrent = () =>
    searchRequests.isCurrent(searchToken) && diagramRequests.isCurrent(renderToken);
  state.mode = "uml";
  activateView("uml");
  viewport.reset();
  setDiagramLoading(true);
  paintedUmlKey = undefined;
  const paint = beginUmlPaint(renderToken, isCurrent, true, signal);
  state.umlRenders = [];
  state.umlRenderVersion = state.version;
  state.umlScopedErrors = true;
  try {
    for (const [directoryIndex, renderDir] of renderDirs.entries()) {
      const target: UmlTarget = { kind: "directory", path: renderDir };
      let diagram: UmlDiagramResponse;
      try {
        const response = await api<DiagramResponse>(
          // A search overview is a directory import graph: the remembered depth never applies.
          `/api/diagram?${diagramQuery(target, DEFAULT_UML_DEPTH)}`,
        );
        if (!isCurrent()) return;
        if (response.kind !== "uml") throw new Error("Unexpected diagram kind");
        diagram = response;
      } catch (error) {
        if (!isCurrent()) return;
        const message = errorMessage(error);
        paint.errors.push(`[${renderDir || "."}] request: ${message}`);
        continue;
      }
      state.umlRenders.push({ target, depth: DEFAULT_UML_DEPTH, diagram });
      // A worker or preparation failure stays this scope's problem: escaping here would clear the
      // retained search results that every other scope still paints from.
      let complete: boolean;
      try {
        complete = await paintUmlScope(paint, target, diagram, directoryIndex);
      } catch (error) {
        if (!isCurrent()) return;
        paint.errors.push(`[${renderDir || "."}] render: ${errorMessage(error)}`);
        continue;
      }
      if (!complete) return;
    }
    finishUmlPaint(
      paint,
      "Search diagram render error",
      `Search · ${state.searchFiles.size} files · v${state.version}`,
    );
  } finally {
    if (diagramRequests.isCurrent(renderToken)) setDiagramLoading(false);
  }
}

async function commitSearch(query: string, caseInsensitive: boolean): Promise<void> {
  if (!query) {
    clearSearch();
    return;
  }
  definitionRequests.next();
  const activeView = state.activeView;
  const token = searchRequests.next();
  invalidateDiagramRequest();
  state.search = query;
  state.searchCaseInsensitive = caseInsensitive;
  state.searchFiles = new Set();
  state.searchDirs = new Set();
  state.searchDefinitions = [];
  renderDefinitionResults();
  renderTree();
  const input = $("#node-search");
  input.classList.remove("no-match");
  input.removeAttribute("aria-invalid");
  try {
    const params = new URLSearchParams({ q: query, caseInsensitive: String(caseInsensitive) });
    const response = await api<SearchResponse>(`/api/search?${params}`);
    if (!searchRequests.isCurrent(token)) return;
    if (response.caseInsensitive !== caseInsensitive) throw new Error("Search response mode mismatch");
    state.search = response.query;
    state.searchFiles = new Set(response.files);
    state.searchDirs = new Set(response.directories);
    state.searchDefinitions = response.definitions;
    state.searchCaseInsensitive = response.caseInsensitive;
    state.version = response.version;
    renderDefinitionResults();
    renderTree();
    if (activeView === "editor") {
      setStatus(`Search · ${response.definitions.length} definitions · v${response.version}`);
      return;
    }
    if (response.files.length === 0) return;
    await renderSearchDiagrams(response.renderDirs, token);
  } catch (error) {
    if (!searchRequests.isCurrent(token)) return;
    state.search = query;
    state.searchCaseInsensitive = caseInsensitive;
    state.searchFiles = new Set();
    state.searchDirs = new Set();
    state.searchDefinitions = [];
    renderDefinitionResults();
    renderTree();
    setStatus(errorMessage(error), true);
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function setEditorPanelVisible(hasFile: boolean): void {
  $("#editor-empty").hidden = hasFile;
  $("#editor-content").hidden = !hasFile;
}

function activateView(view: "packages" | "uml" | "editor"): void {
  state.activeView = view;
  const activeButtonId = view === "editor" ? "editor-mode" : `${state.mode}-mode`;
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.id === activeButtonId);
  });
  const editorActive = view === "editor";
  $("#graph-panel").hidden = editorActive;
  $("#editor-panel").hidden = !editorActive;
  $("#uml-visibility").hidden = view !== "uml";
  setEditorPanelVisible(state.file !== null);
  applySearchHighlights();
}

function destroyEditor(invalidate = true): void {
  if (invalidate) {
    definitionRequests.next();
    editorRequests.next();
  }
  state.view?.destroy();
  state.view = null;
  state.file = null;
  setEditorPanelVisible(false);
}

function revealEditorOffset(offset: number, focus = true): void {
  if (!state.view) return;
  const clamped = Math.max(0, Math.min(offset, state.view.state.doc.length));
  state.view.dispatch({
    selection: EditorSelection.cursor(clamped),
    effects: EditorView.scrollIntoView(clamped, { y: "center" }),
  });
  if (focus) state.view.focus();
}

function editorHighlightDecorations(file: FileResponse) {
  return Decoration.set(
    file.highlights.flatMap((span) => {
      if (span.from < 0 || span.to > file.content.length || span.from >= span.to) return [];
      return [Decoration.mark({ class: `tok-${span.token}` }).range(span.from, span.to)];
    }),
    true,
  );
}

function editorDefinitionDecorations(file: FileResponse) {
  return Decoration.set(
    file.definitions.flatMap((definition) => {
      if (
        definition.displayFrom < 0
        || definition.displayTo > file.content.length
        || definition.displayFrom >= definition.displayTo
      ) return [];
      return [Decoration.mark({
        class: "editor-definition-link",
        attributes: {
          role: "link",
          tabindex: "0",
          "aria-label": `Open ${definition.qualifiedName} editor definition`,
          "data-source-path": definition.source.path,
          "data-source-line": String(definition.source.line),
          "data-source-column": String(definition.source.column),
          "data-definition-name": definition.name,
          "data-qualified-name": definition.qualifiedName,
        },
      }).range(definition.displayFrom, definition.displayTo)];
    }),
    true,
  );
}

type EditorDefinitionTarget = { path: string; name: string; qualifiedName: string };

function editorTargetFromLink(link: Element): EditorDefinitionTarget | undefined {
  const data = (link as HTMLElement).dataset;
  if (!data.sourcePath || !data.definitionName || !data.qualifiedName) return undefined;
  return { path: data.sourcePath, name: data.definitionName, qualifiedName: data.qualifiedName };
}

function editorDefinitionHandlers() {
  const activate = (event: Event): boolean => {
    const link = event.target instanceof Element
      ? event.target.closest(".editor-definition-link")
      : null;
    if (!link) return false;
    const target = editorTargetFromLink(link);
    if (!target) return false;
    event.preventDefault();
    void navigateToEditorDefinition(target);
    return true;
  };
  return EditorView.domEventHandlers({
    click: (event) => activate(event),
    keydown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return false;
      return activate(event);
    },
  });
}

async function openFile(path: string, position?: UmlSourceLocation): Promise<boolean> {
  definitionRequests.next();
  // A late diagram response must never repaint over the editor this gesture opened.
  invalidateDiagramRequest();
  searchRequests.next();
  clickSequence.clear();
  const editorToken = editorRequests.next();
  const isCurrent = () => editorRequests.isCurrent(editorToken);
  try {
    const query = new URLSearchParams({ path });
    if (position) {
      query.set("line", String(position.line));
      query.set("column", String(position.column));
    }
    const file = await api<FileResponse>(`/api/file?${query}`);
    if (!isCurrent()) return false;
    destroyEditor(false);
    state.file = file;
    $("#editor-name").textContent = path.split("/").at(-1) ?? path;
    $("#editor-path").textContent = path;
    const extensions = [
      basicSetup,
      oneDark,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.decorations.of(editorHighlightDecorations(file)),
      EditorView.decorations.of(editorDefinitionDecorations(file)),
      editorDefinitionHandlers(),
    ];
    state.view = new EditorView({
      state: EditorState.create({ doc: file.content, extensions }),
      parent: $("#editor"),
    });
    if (!isCurrent()) {
      destroyEditor(false);
      return false;
    }
    activateView("editor");
    if (file.cursorOffset !== undefined) revealEditorOffset(file.cursorOffset);
    setStatus("Read-only preprocessed source");
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    setStatus(errorMessage(error), true);
    return false;
  }
}

async function lookupEditorDefinition(
  target: EditorDefinitionTarget,
): Promise<LookupResponse<UmlSourceLocation>> {
  const query = new URLSearchParams({
    path: target.path,
    name: target.name,
    qualifiedName: target.qualifiedName,
  });
  return api<LookupResponse<UmlSourceLocation>>(`/api/definition?${query}`);
}

async function navigateToEditorDefinition(target: EditorDefinitionTarget): Promise<void> {
  const token = editorRequests.next();
  try {
    const response = await lookupEditorDefinition(target);
    if (!editorRequests.isCurrent(token)) return;
    const location = response.definition;
    if (!location) throw new Error("Definition not found");
    await openFile(location.path, location);
  } catch (error) {
    reportFailure(error);
  }
}

async function reloadOpenFile(): Promise<void> {
  if (!state.file) return;
  const path = state.file.path;
  const activeView = state.activeView;
  await openFile(path);
  if (activeView !== "editor") activateView(activeView);
}

function refreshCachedViews(): void {
  definitionRequests.next();
  void loadTree().catch((error) => setStatus(errorMessage(error), true));
  if (state.file) void reloadOpenFile();
  if (state.search && state.mode === "uml") {
    void commitSearch(state.search, state.searchCaseInsensitive);
    return;
  }
  if (state.activeView === "editor") return;
  if (state.mode === "uml") {
    paintedUmlKey = undefined;
    void selectUmlTarget(state.umlTarget);
  } else void loadPackagesDiagram();
}

function handleWatch(message: WatchMessage): void {
  if (message.type === "watch-error") {
    setStatus(message.error, true);
    return;
  }
  state.version = message.version;
  // `cache-ready` keeps settled outlines: the outline read already waited for the immutable
  // definition index, so unrelated UML completion must not cause a second fetch and loading flash.
  if (message.type === "cache-ready") {
    if (state.activeView !== "editor") refreshCachedViews();
    setStatus(`Cache ready · v${message.version}`);
    return;
  }
  // Any source change invalidates every cached outline, including the reconnect refresh.
  state.fileDefinitions.clear();
  state.umlRenderVersion = -1;
  paintedUmlKey = undefined;
  invalidateDiagramRequest();
  if (message.paths.length === 0 && message.events.length === 0) {
    void loadTree().catch((error) => setStatus(errorMessage(error), true));
    return;
  }
  refreshCachedViews();
  setStatus(`Source changed · v${message.version}`);
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.onopen = () => {
    state.retry = 250;
    setStatus("Watcher connected");
  };
  ws.onmessage = (event) => {
    try {
      handleWatch(JSON.parse(event.data) as WatchMessage);
    } catch (error) {
      setStatus(String(error), true);
    }
  };
  ws.onclose = () => {
    setStatus("watcher disconnected", true);
    setTimeout(connect, state.retry);
    state.retry = Math.min(2000, state.retry * 2);
  };
}

function toggleSidebar(): void {
  const sidebar = $("#sidebar");
  const collapsed = sidebar.classList.toggle("collapsed");
  $(".workspace").classList.toggle("sidebar-collapsed", collapsed);
  const button = $("#sidebar-toggle");
  button.textContent = collapsed ? "›" : "‹";
  button.setAttribute("aria-label", collapsed ? "Expand file tree" : "Collapse file tree");
  button.setAttribute("aria-expanded", String(!collapsed));
}

// ---------------------------------------------------------------------------
// Diagram stage interaction
// ---------------------------------------------------------------------------

const diagramStage = $("#diagram-stage");
const dragState = {
  pointerId: null as number | null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  moved: false,
  suppressClick: false,
};
type PendingTap = {
  pointerId: number;
  x: number;
  y: number;
  target: DiagramPointerTarget | undefined;
  busy: boolean;
};
let pendingTap: PendingTap | undefined;

function zoomAtStageCenter(factor: number): void {
  const rect = diagramStage.getBoundingClientRect();
  viewport.zoomAt(factor, rect.width / 2, rect.height / 2);
}

function finishDrag(event: PointerEvent, suppressClick: boolean): void {
  if (dragState.pointerId !== event.pointerId) return;
  if (diagramStage.hasPointerCapture(event.pointerId)) {
    diagramStage.releasePointerCapture(event.pointerId);
  }
  const moved = dragState.moved;
  dragState.pointerId = null;
  dragState.moved = false;
  diagramStage.classList.remove("dragging");
  if (moved && suppressClick) suppressNextClick();
}

function suppressNextClick(): void {
  dragState.suppressClick = true;
  setTimeout(() => {
    dragState.suppressClick = false;
  }, 0);
}

function openDiagramTarget(target: DiagramPointerTarget): void {
  if (target.kind === "file") {
    void openFile(target.path);
    return;
  }
  void openFile(target.definition.source.path, target.definition.source);
}

function selectDiagramTarget(target: DiagramPointerTarget): void {
  if (target.kind === "file") {
    void selectUmlTarget({ kind: "file", path: target.path });
    return;
  }
  void selectUmlTarget({
    kind: "definition",
    path: target.definition.source.path,
    definitionKey: target.definition.key,
  });
}

function activateDiagramLink(event: MouseEvent | KeyboardEvent): void {
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return;
  if (event instanceof KeyboardEvent) {
    const target = diagramTargetFromElement(element);
    if (target) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) openDiagramTarget(target);
      else selectDiagramTarget(target);
      return;
    }
  }
  const pkg = element.closest<HTMLElement>(".package-link");
  if (!pkg) return;
  const path = pkg.dataset.scopePath;
  if (path === undefined) return;
  event.preventDefault();
  if (event instanceof MouseEvent && dragState.suppressClick) return;
  void selectUmlTarget({ kind: "directory", path });
}

diagramStage.addEventListener("wheel", (event) => {
  if (diagramStage.getAttribute("aria-busy") === "true") return;
  event.preventDefault();
  const rect = diagramStage.getBoundingClientRect();
  viewport.zoomAt(
    event.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_IN_FACTOR,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
}, { passive: false });

diagramStage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  // Captured before the busy early return: a matching second press stays eligible while loading.
  const busy = diagramStage.getAttribute("aria-busy") === "true";
  pendingTap = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    target: diagramTargetFromElement(event.target),
    busy,
  };
  if (busy || dragState.pointerId !== null) return;
  dragState.pointerId = event.pointerId;
  dragState.startX = dragState.lastX = event.clientX;
  dragState.startY = dragState.lastY = event.clientY;
  dragState.moved = false;
});

diagramStage.addEventListener("pointermove", (event) => {
  if (dragState.pointerId !== event.pointerId) return;
  if (!dragState.moved) {
    if (!hasPassedDragThreshold(dragState.startX, dragState.startY, event.clientX, event.clientY)) {
      return;
    }
    dragState.moved = true;
    diagramStage.setPointerCapture(event.pointerId);
    diagramStage.classList.add("dragging");
  }
  panViewport(viewport, event.clientX - dragState.lastX, event.clientY - dragState.lastY);
  dragState.lastX = event.clientX;
  dragState.lastY = event.clientY;
  viewport.apply();
});

window.addEventListener("pointerup", (event) => {
  const tap = pendingTap;
  pendingTap = undefined;
  const dragged = dragState.pointerId === event.pointerId && dragState.moved;
  finishDrag(event, true);
  if (!tap || tap.pointerId !== event.pointerId) return;
  if (dragged || hasPassedDragThreshold(tap.x, tap.y, event.clientX, event.clientY)) {
    clickSequence.clear();
    return;
  }
  const action = clickSequence.record(
    tap.busy ? undefined : tap.target,
    event.pointerId,
    event.timeStamp,
    event.clientX,
    event.clientY,
  );
  if (!action) return;
  if (action.action === "open") {
    suppressNextClick();
    openDiagramTarget(action.target);
    return;
  }
  selectDiagramTarget(action.target);
});

window.addEventListener("pointercancel", (event) => {
  pendingTap = undefined;
  clickSequence.clear();
  finishDrag(event, false);
});

$("#svg-holder").addEventListener("click", activateDiagramLink);
$("#svg-holder").addEventListener("keydown", activateDiagramLink);

// ---------------------------------------------------------------------------
// Tree keyboard
// ---------------------------------------------------------------------------

const tree = $("#tree");

function scrollTreeRowIntoView(row: HTMLButtonElement): void {
  const treeRect = tree.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  tree.scrollTop = treeScrollTopForRow(
    tree.scrollTop,
    tree.scrollHeight - tree.clientHeight,
    treeRect.top,
    treeRect.bottom,
    rowRect.top,
    rowRect.bottom,
  );
}

tree.addEventListener("keydown", (event) => {
  const current = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>(".tree-row")
    : null;
  if (!current || !tree.contains(current)) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const rows = [...tree.querySelectorAll<HTMLButtonElement>(".tree-row")];
    const nextIndex = adjacentTreeRowIndex(
      rows.indexOf(current),
      event.key === "ArrowUp" ? -1 : 1,
      rows.length,
    );
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = rows[nextIndex];
    if (!next) return;
    next.focus({ preventScroll: true });
    scrollTreeRowIntoView(next);
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    // Consumed so the native button click cannot select UML over the editor.
    event.preventDefault();
    event.stopPropagation();
    const definitionKey = current.dataset.definitionKey;
    const path = current.dataset.sourcePath ?? current.dataset.treePath;
    if (path === undefined) return;
    if (definitionKey !== undefined) {
      const line = Number(current.dataset.sourceLine);
      const column = Number(current.dataset.sourceColumn);
      void openFile(path, { path, line, column });
      return;
    }
    void openFile(path);
    return;
  }
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const path = current.dataset.treePath;
  if (path === undefined) return;
  const node = findTreeNode(state.tree, path);
  if (!node) return;
  event.preventDefault();
  const set = node.kind === "directory" ? state.expandedDirs : state.expandedFiles;
  if (event.key === "ArrowRight") set.add(path);
  else set.delete(path);
  renderTree();
});

function findTreeNode(root: TreeNode | null, path: string): TreeNode | undefined {
  if (!root) return undefined;
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.path === path) return node;
    if (node.children) stack.push(...node.children);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const nodeSearch = $("#node-search");
const definitionSearch = $<HTMLElement>(".definition-search");
// Capture phase: tree disclosure buttons stop click propagation, so a bubbling
// listener would never observe those dismissals.
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Node) || definitionSearch.contains(event.target)) return;
  setSearchResultsOpen(false);
}, true);
nodeSearch.onkeydown = (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  setSearchResultsOpen(true);
  void commitSearch(nodeSearch.value.trim(), $("#search-case-insensitive").checked);
};
// Refocusing or clicking the input reveals retained matches without refetching.
nodeSearch.onfocus = () => setSearchResultsOpen(true);
nodeSearch.onclick = () => setSearchResultsOpen(true);
nodeSearch.oninput = () => {
  if (nodeSearch.value !== "") return;
  clearSearch();
};
$("#packages-mode").onclick = () => void loadPackagesDiagram();
$("#uml-mode").onclick = () => restoreUmlView();
$("#editor-mode").onclick = () => {
  definitionRequests.next();
  invalidateDiagramRequest();
  activateView("editor");
};
$("#tree-filter").oninput = renderTree;
$("#zoom-in").onclick = () => zoomAtStageCenter(ZOOM_IN_FACTOR);
$("#zoom-out").onclick = () => zoomAtStageCenter(ZOOM_OUT_FACTOR);
$("#zoom-reset").onclick = () => viewport.reset();
$("#legend-toggle").onclick = () => {
  const legend = $("#legend");
  legend.hidden = !legend.hidden;
};
$("#sidebar-toggle").onclick = toggleSidebar;
$("#editor-close").onclick = () => {
  destroyEditor();
  if (state.mode === "uml") restoreUmlView();
  else void loadPackagesDiagram();
};
$("#editor-print").onclick = () => {
  if (state.view) window.print();
};
for (
  const [selector, key] of [
    ["#uml-show-attributes", "attributes"],
    ["#uml-show-methods", "methods"],
    ["#uml-show-types", "types"],
    ["#uml-show-tests", "tests"],
  ] as const
) {
  const input = $(selector);
  input.checked = state.umlVisibility[key];
  input.onchange = () => {
    state.umlVisibility[key] = input.checked;
    void rerenderUmlDiagrams();
  };
}

const umlDepthInput = $("#uml-depth");
umlDepthInput.value = String(state.umlDepth);

/**
 * Accepts a non-negative safe integer and reloads the current definition/file selection through the
 * ordinary depth-carrying request path. Anything else silently restores the last accepted value:
 * a typo must never blank the graph or spend a request.
 */
function commitUmlDepth(): void {
  const value = umlDepthInput.valueAsNumber;
  if (!Number.isSafeInteger(value) || value < 0) {
    umlDepthInput.value = String(state.umlDepth);
    return;
  }
  umlDepthInput.value = String(value);
  if (value === state.umlDepth) return;
  state.umlDepth = value;
  if (
    state.activeView !== "uml"
    || state.umlScopedErrors
    || state.umlTarget.kind === "directory"
  ) return;
  void selectUmlTarget(state.umlTarget);
}

umlDepthInput.onchange = commitUmlDepth;
umlDepthInput.onkeydown = (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  commitUmlDepth();
};

await loadTree();
connect();
void loadPackagesDiagram().catch((error) => reportFailure(error, "Request failed"));
