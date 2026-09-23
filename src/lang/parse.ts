import type { Node } from "@vscode/tree-sitter-wasm";
import type { LanguageId } from "./registry.ts";
import { parseRustSource } from "./rust.ts";
import { parseTypeScriptSource } from "./typescript.ts";

/**
 * The single language-to-grammar dispatch. `language` is the caller's *already resolved* answer and
 * is never re-derived here: `analysisLanguageForPath` rejects JavaScript while
 * `highlightLanguageForPath` accepts it, and resolving internally would silently change which files
 * produce outlines and UML edges.
 *
 * Lives beside the parsers rather than in `registry.ts` because that module is a dependency-free
 * leaf `typescript.ts` itself imports; importing the grammars back into it would cycle.
 *
 * `undefined` when a script `path` carries no TypeScript/TSX/JavaScript extension. The caller owns
 * the returned tree and MUST `dispose()` it.
 */
export function parseSourceForLanguage(
  language: LanguageId,
  path: string,
  source: string,
): { root: Node; dispose(): void } | undefined {
  return language === "rust" ? parseRustSource(source) : parseTypeScriptSource(path, source);
}
