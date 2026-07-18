import {
  UML_METHOD_RETURN_MARKER,
  type DiagramKind,
  type UmlEntitySource,
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

export function formatUmlMethodReturnLabel(text: string): string | undefined {
  const normalized = text.trim();
  const prefix = `${UML_METHOD_RETURN_MARKER}()`;
  if (!normalized.startsWith(prefix)) return undefined;
  const returnType = normalized.slice(prefix.length).replace(/^\s*:\s*/, "").trim();
  return returnType ? `\u00a0\u00a0${returnType}` : undefined;
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

function bareUmlName(name: string): string {
  const genericStart = name.indexOf("<");
  return genericStart === -1 ? name : name.slice(0, genericStart);
}

function compareLocations(left: UmlSourceLocation, right: UmlSourceLocation): number {
  return left.path.localeCompare(right.path)
    || left.line - right.line
    || left.column - right.column;
}

export function resolveUmlSource(
  sources: readonly UmlEntitySource[],
  entityName: string,
  methodName?: string,
  occurrence = 0,
): UmlSourceLocation | undefined {
  let entity: UmlEntitySource | undefined;
  for (const candidate of sources) {
    if (bareUmlName(candidate.name) !== entityName) continue;
    if (!entity || compareLocations(candidate, entity) < 0) entity = candidate;
  }
  if (!entity || methodName === undefined) return entity;

  let currentOccurrence = 0;
  for (const method of entity.methods) {
    if (method.name !== methodName) continue;
    if (currentOccurrence === occurrence) return method;
    currentOccurrence += 1;
  }
  return undefined;
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
