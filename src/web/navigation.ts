export type FuzzyMatch = { score: number; positions: readonly number[] };

const BOUNDARY_CHARACTERS = new Set(["/", "-", "_", ".", " "]);
const MAX_SKIP_PENALTY = -30;

function isBoundary(candidate: string, index: number): boolean {
  if (index === 0) return true;
  const previous = candidate[index - 1];
  return previous !== undefined && BOUNDARY_CHARACTERS.has(previous);
}

function isCamelBoundary(candidate: string, index: number): boolean {
  const current = candidate[index];
  const previous = candidate[index - 1];
  if (current === undefined || previous === undefined) return false;
  return current !== current.toLowerCase() && previous === previous.toLowerCase()
    && previous !== previous.toUpperCase();
}

export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | undefined {
  if (query === "") return { score: 0, positions: [] };
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let skipped = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return undefined;
    skipped += index - cursor;
    score += 10;
    if (index === previous + 1) score += 8;
    if (isBoundary(candidate, index)) score += 12;
    if (isCamelBoundary(candidate, index)) score += 6;
    positions.push(index);
    previous = index;
    cursor = index + 1;
  }
  return { score: score + Math.max(MAX_SKIP_PENALTY, -skipped), positions };
}

export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit: number,
): readonly { item: T; match: FuzzyMatch }[] {
  const ranked: { item: T; match: FuzzyMatch; text: string }[] = [];
  for (const item of items) {
    const value = text(item);
    const match = fuzzyMatch(value, query);
    if (match) ranked.push({ item, match, text: value });
  }
  ranked.sort((left, right) =>
    right.match.score - left.match.score
    || left.text.length - right.text.length
    || left.text.localeCompare(right.text)
  );
  return ranked.slice(0, Math.max(0, limit)).map(({ item, match }) => ({ item, match }));
}
