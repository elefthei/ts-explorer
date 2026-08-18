export const HIGHLIGHT_QUERY_SOURCE = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  rust: "rust",
} as const;

/** Every language the highlighter and the definition parser can handle. */
export type LanguageId = keyof typeof HIGHLIGHT_QUERY_SOURCE;

/** Every viewable file extension, and the language that owns it. */
const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".rs": "rust",
};

export function highlightLanguageForPath(path: string): LanguageId | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : HIGHLIGHT_LANGUAGE_BY_EXTENSION[path.slice(dot)];
}

export function definitionLanguageForPath(path: string): "typescript" | "tsx" | undefined {
  const id = highlightLanguageForPath(path);
  return id === "typescript" || id === "tsx" ? id : undefined;
}

/** The language whose UML/definition extractor owns `path`, or `undefined` when none does. */
export function analysisLanguageForPath(
  path: string,
): "typescript" | "tsx" | "rust" | undefined {
  const id = highlightLanguageForPath(path);
  return id === "javascript" ? undefined : id;
}
