export const HIGHLIGHT_QUERY_SOURCE = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "javascript",
} as const;

/** Every language the highlighter and the definition parser can handle. */
export type LanguageId = keyof typeof HIGHLIGHT_QUERY_SOURCE;

// Mirrors SOURCE_EXTENSIONS in src/source.ts: only those files are ever viewable.
const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
};

export function highlightLanguageForPath(path: string): LanguageId | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : HIGHLIGHT_LANGUAGE_BY_EXTENSION[path.slice(dot)];
}

export function definitionLanguageForPath(path: string): "typescript" | "tsx" | undefined {
  const id = highlightLanguageForPath(path);
  return id === "javascript" ? undefined : id;
}
