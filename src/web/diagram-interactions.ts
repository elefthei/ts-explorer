import {
  UML_METHOD_RETURN_MARKER,
  type DiagramKind,
  type UmlSourceLocation,
} from "../types.ts";

export type ViewportState = {
  scale: number;
  x: number;
  y: number;
};


export function shouldStackDiagram(kind: DiagramKind): boolean {
  return kind === "uml";
}

export function createRequestSequence(): {
  next(): number;
  isCurrent(token: number): boolean;
} {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token) => token > 0 && token === latest,
  };
}

export function panViewport(viewport: ViewportState, dx: number, dy: number): void {
  viewport.x += dx;
  viewport.y += dy;
}

export function hasPassedDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = 5,
): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return dx * dx + dy * dy >= threshold * threshold;
}

export function externalUserIdFromNodeId(id: string): string | undefined {
  return /classId-(extern\d+)-\d+$/.exec(id)?.[1];
}

export function localUserIdFromNodeId(id: string): string | undefined {
  return /classId-(local\d+)-\d+$/.exec(id)?.[1];
}

export function packageNodeIdFromNodeId(id: string): string | undefined {
  return /(?:^|-)flowchart-(p\d+)-\d+$/.exec(id)?.[1];
}

export function formatUmlMethodReturnLabel(text: string): string | undefined {
  const normalized = text.trim();
  const prefix = `${UML_METHOD_RETURN_MARKER}()`;
  if (!normalized.startsWith(prefix)) return undefined;
  const returnType = normalized.slice(prefix.length).replace(/^\s*:\s*/, "").trim();
  return returnType ? `\u00a0\u00a0${returnType}` : undefined;
}

export function matchesSearchQuery(candidate: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length > 0 && candidate.toLowerCase().includes(normalized);
}

export function adjacentTreeRowIndex(
  currentIndex: number,
  direction: -1 | 1,
  rowCount: number,
): number {
  if (currentIndex < 0 || currentIndex >= rowCount || rowCount <= 0) return -1;
  return Math.min(rowCount - 1, Math.max(0, currentIndex + direction));
}

export function treeScrollTopForRow(
  currentScrollTop: number,
  maxScrollTop: number,
  viewportTop: number,
  viewportBottom: number,
  rowTop: number,
  rowBottom: number,
): number {
  let nextScrollTop = currentScrollTop;
  if (rowTop < viewportTop) {
    nextScrollTop -= viewportTop - rowTop;
  } else if (rowBottom > viewportBottom) {
    nextScrollTop += rowBottom - viewportBottom;
  }
  return Math.min(Math.max(0, maxScrollTop), Math.max(0, nextScrollTop));
}

export function zoomViewportAt(
  viewport: ViewportState,
  factor: number,
  originX: number,
  originY: number,
): void {
  const nextScale = viewport.scale * factor;
  if (!Number.isFinite(nextScale) || nextScale <= 0 || nextScale === viewport.scale) return;
  const worldX = (originX - viewport.x) / viewport.scale;
  const worldY = (originY - viewport.y) / viewport.scale;
  viewport.scale = nextScale;
  viewport.x = originX - worldX * nextScale;
  viewport.y = originY - worldY * nextScale;
}


type TextDocument = {
  lines: number;
  line(number: number): { from: number; to: number };
};

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export function editorOffset(doc: TextDocument, location: UmlSourceLocation): number {
  const lineNumber = Math.min(positiveInteger(location.line), Math.max(1, doc.lines));
  const line = doc.line(lineNumber);
  const columnOffset = positiveInteger(location.column) - 1;
  return Math.min(line.from + columnOffset, line.to);
}
