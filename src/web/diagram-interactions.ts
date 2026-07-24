import { UML_METHOD_RETURN_MARKER, type DiagramKind } from "../types.ts";

export type ViewportState = {
  scale: number;
  x: number;
  y: number;
};


export function shouldStackDiagram(kind: DiagramKind): boolean {
  return kind === "uml";
}

export class RequestSequence {
  #latest = 0;

  next(): number {
    return ++this.#latest;
  }

  isCurrent(token: number): boolean {
    return token > 0 && token === this.#latest;
  }
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

export function matchesSearchQuery(candidate: string, query: string, caseInsensitive: boolean): boolean {
  const comparisonQuery = query.trim();
  if (comparisonQuery.length === 0) return false;
  return caseInsensitive
    ? candidate.toLowerCase().includes(comparisonQuery.toLowerCase())
    : candidate.includes(comparisonQuery);
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

