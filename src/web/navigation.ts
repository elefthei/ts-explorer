import type { SearchMode } from "../types.ts";

export type ExplorerView = "packages" | "uml" | "editor";

export type ExplorerLocation = {
  view: ExplorerView;
  scope: string;
  file: string;
  line?: number;
  column?: number;
  query: string;
  mode: SearchMode;
  caseInsensitive: boolean;
};

export const DEFAULT_EXPLORER_LOCATION: ExplorerLocation = {
  view: "packages",
  scope: "",
  file: "",
  query: "",
  mode: "content",
  caseInsensitive: false,
};

function normalizeLocationPath(value: string): string {
  if (value.includes("\\")) return "";
  let normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+|\/+$/g, "");
  return normalized.split("/").includes("..") ? "" : normalized;
}

function positiveSafeInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function parseExplorerLocation(search: string): ExplorerLocation {
  const params = new URLSearchParams(search);
  const rawView = params.get("view");
  const rawMode = params.get("m");
  const file = normalizeLocationPath(params.get("file") ?? "");
  const line = positiveSafeInteger(params.get("line"));
  const column = positiveSafeInteger(params.get("col"));
  const location: ExplorerLocation = {
    view: rawView === "uml" || rawView === "editor" ? rawView : "packages",
    scope: normalizeLocationPath(params.get("scope") ?? ""),
    file,
    query: params.get("q") ?? "",
    mode: rawMode === "path" || rawMode === "regex" ? rawMode : "content",
    caseInsensitive: params.get("ci") === "1",
  };
  if (file && line !== undefined && column !== undefined) {
    location.line = line;
    location.column = column;
  }
  return location;
}

export function serializeExplorerLocation(location: ExplorerLocation): string {
  const params = new URLSearchParams();
  params.append("view", location.view);
  if (location.scope) params.append("scope", location.scope);
  if (location.file) {
    params.append("file", location.file);
    if (
      location.line !== undefined
      && Number.isInteger(location.line)
      && location.line >= 1
      && location.column !== undefined
      && Number.isInteger(location.column)
      && location.column >= 1
    ) {
      params.append("line", String(location.line));
      params.append("col", String(location.column));
    }
  }
  if (location.query) params.append("q", location.query);
  if (location.mode !== "content") params.append("m", location.mode);
  if (location.caseInsensitive) params.append("ci", "1");
  return `?${params.toString()}`;
}

export function explorerLocationsEqual(
  left: ExplorerLocation,
  right: ExplorerLocation,
): boolean {
  return left.view === right.view
    && left.scope === right.scope
    && left.file === right.file
    && left.line === right.line
    && left.column === right.column
    && left.query === right.query
    && left.mode === right.mode
    && left.caseInsensitive === right.caseInsensitive;
}

export type FuzzyMatch = { score: number; positions: readonly number[] };

const FUZZY_BOUNDARIES = "/-_. ";

export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | undefined {
  if (query.length === 0) return { score: 0, positions: [] };
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let searchFrom = 0;
  let previousMatchIndex = -1;
  for (const queryCharacter of normalizedQuery) {
    const index = normalizedCandidate.indexOf(queryCharacter, searchFrom);
    if (index === -1) return undefined;
    score += 10;
    if (positions.length > 0 && index === previousMatchIndex + 1) score += 8;
    if (index === 0 || FUZZY_BOUNDARIES.includes(candidate.charAt(index - 1))) score += 12;
    if (
      candidate.charAt(index) !== candidate.charAt(index).toLowerCase()
      && candidate.charAt(index - 1) !== candidate.charAt(index - 1).toUpperCase()
    ) {
      score += 6;
    }
    positions.push(index);
    previousMatchIndex = index;
    searchFrom = index + 1;
  }
  score -= Math.min(30, candidate.length - positions.length);
  return { score, positions };
}

export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit: number,
): readonly { item: T; match: FuzzyMatch }[] {
  const matches: { item: T; match: FuzzyMatch; candidate: string }[] = [];
  for (const item of items) {
    const candidate = text(item);
    const match = fuzzyMatch(candidate, query);
    if (match) matches.push({ item, match, candidate });
  }
  matches.sort(
    (left, right) =>
      right.match.score - left.match.score
      || left.candidate.length - right.candidate.length
      || left.candidate.localeCompare(right.candidate),
  );
  return matches
    .slice(0, Math.max(0, limit))
    .map(({ item, match }) => ({ item, match }));
}
