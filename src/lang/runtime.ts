import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as TreeSitterModule from "@vscode/tree-sitter-wasm";
import type { Language, Query, Tree } from "@vscode/tree-sitter-wasm";
import type { LanguageId } from "./registry.ts";

const nodeRequire = createRequire(import.meta.url);
// The package declares no `exports`, only `main`/`types`, so the wasm directory is resolved from
// its manifest and every artifact is addressed by absolute path from there.
const WASM_DIR = join(
  dirname(nodeRequire.resolve("@vscode/tree-sitter-wasm/package.json")),
  "wasm",
);
const TreeSitter = nodeRequire(join(WASM_DIR, "tree-sitter.js")) as typeof TreeSitterModule;
const runtime = TreeSitter.Parser.init({ locateFile: (file: string) => join(WASM_DIR, file) });

const languages = new Map<LanguageId, Promise<Language>>();

export function loadLanguage(id: LanguageId): Promise<Language> {
  let pending = languages.get(id);
  if (!pending) {
    pending = runtime
      .then(() => readFile(join(WASM_DIR, `tree-sitter-${id}.wasm`)))
      .then((bytes) => TreeSitter.Language.load(bytes));
    languages.set(id, pending);
  }
  return pending;
}

const queries = new Map<string, Promise<Query>>();

/** Compiles `queries/highlights/<source>.scm` against `<id>`'s grammar. */
export function loadHighlightQuery(id: LanguageId, source: LanguageId): Promise<Query> {
  const key = `${id}\0${source}`;
  let pending = queries.get(key);
  if (!pending) {
    pending = (async () => {
      const path = join(import.meta.dir, "queries", "highlights", `${source}.scm`);
      return new TreeSitter.Query(await loadLanguage(id), await readFile(path, "utf8"));
    })();
    queries.set(key, pending);
  }
  return pending;
}

/** Explicit-lifetime parse: WASM memory is manual, so the caller must `dispose()`. */
export function parseTree(language: Language, source: string): { tree: Tree; dispose(): void } {
  const parser = new TreeSitter.Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) throw new Error("tree-sitter returned no parse tree");
    return {
      tree,
      dispose() {
        tree.delete();
        parser.delete();
      },
    };
  } catch (error) {
    parser.delete();
    throw error;
  }
}
