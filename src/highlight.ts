import type { Language, Query } from "@vscode/tree-sitter-wasm";
import {
  HIGHLIGHT_QUERY_SOURCE,
  type LanguageId,
  highlightLanguageForPath,
} from "./lang/registry.ts";
import { loadHighlightQuery, loadLanguage, parseTree } from "./lang/runtime.ts";
import { HIGHLIGHT_TOKENS, type HighlightSpan } from "./types.ts";

const HIGHLIGHT_MAX_LENGTH = 2_000_000;

const TOKEN_INDEX: Record<string, number> = Object.fromEntries(
  HIGHLIGHT_TOKENS.map((token, index) => [token, index]),
);

type Highlighter = { language: Language; query: Query };

async function loadHighlighter(id: LanguageId): Promise<Highlighter> {
  const [language, query] = await Promise.all([
    loadLanguage(id),
    loadHighlightQuery(id, HIGHLIGHT_QUERY_SOURCE[id]),
  ]);
  return { language, query };
}

// Resolved at module scope so `computeHighlightSpans` stays synchronous.
const [typescript, tsx, javascript, rust] = await Promise.all([
  loadHighlighter("typescript"),
  loadHighlighter("tsx"),
  loadHighlighter("javascript"),
  loadHighlighter("rust"),
]);
const HIGHLIGHTERS: Record<LanguageId, Highlighter> = { typescript, tsx, javascript, rust };

export function computeHighlightSpans(path: string, content: string): HighlightSpan[] {
  if (content.length > HIGHLIGHT_MAX_LENGTH) return [];
  const id = highlightLanguageForPath(path);
  if (!id) return [];
  const { language, query } = HIGHLIGHTERS[id];
  const parsed = parseTree(language, content);
  try {
    // Per-character ownership: captures arrive generic-first, so a later capture overwrites an
    // earlier one and the run-length encoding below is sorted and non-overlapping by construction.
    const owner = new Int32Array(content.length).fill(-1);
    for (const capture of query.captures(parsed.tree.rootNode)) {
      const token = TOKEN_INDEX[capture.name];
      if (token === undefined) continue;
      owner.fill(token, capture.node.startIndex, capture.node.endIndex);
    }
    const spans: HighlightSpan[] = [];
    let start = 0;
    let current = -1;
    for (let index = 0; index <= owner.length; index += 1) {
      const value = index < owner.length ? owner[index] ?? -1 : -1;
      if (value === current) continue;
      const token = HIGHLIGHT_TOKENS[current];
      if (token) spans.push({ from: start, to: index, token });
      current = value;
      start = index;
    }
    return spans;
  } finally {
    parsed.dispose();
  }
}
