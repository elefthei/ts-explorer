import { dirname, join, normalize } from "node:path/posix";
import type { Node } from "@vscode/tree-sitter-wasm";
import type { ParsedFileDefinition } from "../goto-definition.ts";
import { children, namedChildren } from "../lang/ast.ts";
import { highlightLanguageForPath } from "../lang/registry.ts";
import { rustVisibility } from "../lang/rust.ts";
import { rustBareTypeName } from "./rust-parse.ts";
import { canonicalScopeKey, pairKey, unpairKey } from "./keys.ts";
import type { FileDefinitionKind, PackageInfo, TreeNode } from "../types.ts";
import type {
  DefinitionBinding,
  DefinitionBindingSpace,
  DefinitionBindingTarget,
  DefinitionContributor,
  DefinitionIndexSnapshot,
  FileImportEdge,
  IndexedFileDefinition,
} from "./model.ts";

/**
 * Which name spaces a declaration occupies. A declaration available in both spaces produces two
 * binding rows, so a type position and a value position resolve independently.
 */
const BINDING_SPACES: Record<FileDefinitionKind, readonly DefinitionBindingSpace[]> = {
  class: ["type", "value"],
  interface: ["type"],
  trait: ["type"],
  struct: ["type", "value"],
  union: ["type", "value"],
  enum: ["type", "value"],
  type: ["type"],
  namespace: ["type", "value"],
  module: ["type", "value"],
  function: ["value"],
  constant: ["value"],
  variable: ["value"],
  property: ["value"],
  method: ["value"],
  constructor: ["value"],
  getter: ["value"],
  setter: ["value"],
  "enum-member": ["value"],
  macro: ["value"],
};

type ScriptImportBinding = { local: string; imported: string };
type ScriptImport = { specifier: string; bindings: ScriptImportBinding[] };
/** `scopeKey` is `""` for file scope, otherwise the enclosing inline module's definition key. */
type RustUseLeaf = { segments: string[]; local: string; exported: boolean; scopeKey: string };
type RustModuleDeclaration = { key: string; name: string; inline: boolean; pathAttribute?: string };

/**
 * One file's import/export/module/impl facts, copied out of the syntax tree while it is alive.
 * Nothing here holds a `Node`, so the project-wide pass runs long after every tree is disposed.
 */
export type FileFacts = {
  path: string;
  rust: boolean;
  definitions: IndexedFileDefinition[];
  exportedKeys: string[];
  /** Rust `impl` members awaiting their owning type's catalogue key. */
  implMembers: { key: string; ownerName: string }[];
  implBlocks: { targetName: string }[];
  scriptImports: ScriptImport[];
  namedExports: { exported: string; local: string }[];
  reexports: { exported: string; imported: string; specifier: string }[];
  namespaceReexports: { exported: string; specifier: string }[];
  starExports: string[];
  /** Every static module path written in this file, for the file-import graph. */
  moduleSpecifiers: string[];
  rustUses: RustUseLeaf[];
  rustModules: RustModuleDeclaration[];
};

function emptyFacts(path: string, rust: boolean): FileFacts {
  return {
    path,
    rust,
    definitions: [],
    exportedKeys: [],
    implMembers: [],
    implBlocks: [],
    scriptImports: [],
    namedExports: [],
    reexports: [],
    namespaceReexports: [],
    starExports: [],
    moduleSpecifiers: [],
    rustUses: [],
    rustModules: [],
  };
}

function stringLiteralText(node: Node): string {
  if (node.type !== "string") return node.text;
  return namedChildren(node).find((child) => child.type === "string_fragment")?.text ?? "";
}

function collectScriptImport(statement: Node, facts: FileFacts): void {
  for (const clause of namedChildren(statement)) {
    if (clause.type !== "import_require_clause") continue;
    // `import X = require("m")` carries its own source and binds the whole module object.
    const source = clause.childForFieldName("source");
    const local = namedChildren(clause).find((child) => child.type === "identifier");
    if (!source || !local) continue;
    const specifier = stringLiteralText(source);
    facts.moduleSpecifiers.push(specifier);
    facts.scriptImports.push({ specifier, bindings: [{ local: local.text, imported: "*" }] });
  }
  const sourceNode = statement.childForFieldName("source");
  if (!sourceNode) return;
  const specifier = stringLiteralText(sourceNode);
  facts.moduleSpecifiers.push(specifier);
  const bindings: ScriptImportBinding[] = [];
  for (const clause of namedChildren(statement)) {
    if (clause.type !== "import_clause") continue;
    for (const binding of namedChildren(clause)) {
      if (binding.type === "identifier") {
        bindings.push({ local: binding.text, imported: "default" });
        continue;
      }
      if (binding.type === "namespace_import") {
        const name = namedChildren(binding).find((child) => child.type === "identifier");
        if (name) bindings.push({ local: name.text, imported: "*" });
        continue;
      }
      if (binding.type !== "named_imports") continue;
      for (const specifierNode of namedChildren(binding)) {
        if (specifierNode.type !== "import_specifier") continue;
        const imported = specifierNode.childForFieldName("name")?.text;
        const alias = specifierNode.childForFieldName("alias")?.text;
        if (imported === undefined) continue;
        bindings.push({ local: alias ?? imported, imported });
      }
    }
  }
  if (bindings.length) facts.scriptImports.push({ specifier, bindings });
}

function collectScriptExport(statement: Node, facts: FileFacts): void {
  const sourceNode = statement.childForFieldName("source");
  const specifier = sourceNode ? stringLiteralText(sourceNode) : undefined;
  if (specifier !== undefined) facts.moduleSpecifiers.push(specifier);
  const clause = namedChildren(statement).find((child) => child.type === "export_clause");
  if (clause) {
    for (const specifierNode of namedChildren(clause)) {
      if (specifierNode.type !== "export_specifier") continue;
      const name = specifierNode.childForFieldName("name")?.text;
      const alias = specifierNode.childForFieldName("alias")?.text;
      if (name === undefined) continue;
      if (specifier === undefined) facts.namedExports.push({ exported: alias ?? name, local: name });
      else facts.reexports.push({ exported: alias ?? name, imported: name, specifier });
    }
    return;
  }
  const namespaceExport = namedChildren(statement).find((child) => child.type === "namespace_export");
  if (namespaceExport && specifier !== undefined) {
    const nameNode = namedChildren(namespaceExport)
      .find((child) => child.type === "identifier" || child.type === "string");
    const exported = nameNode ? stringLiteralText(nameNode) : undefined;
    if (exported) facts.namespaceReexports.push({ exported, specifier });
    return;
  }
  if (specifier !== undefined) facts.starExports.push(specifier);
}

/** Wrappers an `export` keyword reaches through without introducing a scope of its own. */
const EXPORT_TRANSPARENT_PARENTS: Record<string, true> = {
  lexical_declaration: true,
  variable_declaration: true,
  using_declaration: true,
  variable_declarator: true,
  ambient_declaration: true,
  export_statement: true,
};

/**
 * Exportedness is an AST fact, not a source range: a namespace body sits inside its own
 * `export namespace` statement, and its unexported members must stay private.
 */
function isExportedNode(node: Node, exportedNodeIds: ReadonlySet<number>): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (exportedNodeIds.has(current.id)) return true;
    const parent: Node | undefined = current.parent ?? undefined;
    if (!parent || EXPORT_TRANSPARENT_PARENTS[parent.type] !== true) return false;
    current = parent;
  }
  return false;
}

function collectScriptFacts(root: Node, facts: FileFacts, exportedNodeIds: Set<number>): void {
  const visit = (node: Node): void => {
    if (node.type === "import_statement") collectScriptImport(node, facts);
    else if (node.type === "export_statement") {
      collectScriptExport(node, facts);
      const declaration = node.childForFieldName("declaration")
        ?? node.childForFieldName("value");
      if (declaration) exportedNodeIds.add(declaration.id);
    } else if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee && (callee.type === "import" || callee.text === "require")) {
        const args = node.childForFieldName("arguments");
        const first = args ? namedChildren(args)[0] : undefined;
        if (first?.type === "string") facts.moduleSpecifiers.push(stringLiteralText(first));
      }
    }
    for (const child of namedChildren(node)) visit(child);
  };
  visit(root);
}

function rustPathSegments(node: Node): string[] | undefined {
  if (node.type === "identifier" || node.type === "type_identifier") return [node.text];
  if (node.type === "self" || node.type === "super" || node.type === "crate") return [node.type];
  if (node.type === "scoped_identifier") {
    const path = node.childForFieldName("path");
    const name = node.childForFieldName("name");
    if (!name) return undefined;
    if (!path) return [name.text];
    const prefix = rustPathSegments(path);
    return prefix ? [...prefix, name.text] : undefined;
  }
  return undefined;
}

/** Flattens a `use` tree into `(segments, localName)` leaves; a glob leaf uses the name `*`. */
function rustUseLeaves(
  node: Node,
  prefix: readonly string[],
  exported: boolean,
  scopeKey: string,
  out: RustUseLeaf[],
): void {
  if (node.type === "use_wildcard") {
    const path = node.namedChild(0);
    const segments = path ? rustPathSegments(path) : [];
    if (segments) out.push({ segments: [...prefix, ...segments], local: "*", exported, scopeKey });
    return;
  }
  if (node.type === "use_as_clause") {
    const path = node.childForFieldName("path");
    const alias = node.childForFieldName("alias");
    const segments = path ? rustPathSegments(path) : undefined;
    if (!segments || !alias) return;
    out.push({ segments: [...prefix, ...segments], local: alias.text, exported, scopeKey });
    return;
  }
  if (node.type === "scoped_use_list") {
    const path = node.childForFieldName("path");
    const list = node.childForFieldName("list");
    const segments = path ? rustPathSegments(path) ?? [] : [];
    if (!list) return;
    for (const entry of namedChildren(list)) {
      rustUseLeaves(entry, [...prefix, ...segments], exported, scopeKey, out);
    }
    return;
  }
  if (node.type === "use_list") {
    for (const entry of namedChildren(node)) rustUseLeaves(entry, prefix, exported, scopeKey, out);
    return;
  }
  const segments = rustPathSegments(node);
  const local = segments?.[segments.length - 1];
  if (!segments?.length || local === undefined) return;
  out.push({ segments: [...prefix, ...segments], local, exported, scopeKey });
}

/** A literal `#[path = "..."]` attribute directly preceding `node`, if any. */
function rustPathAttribute(node: Node): string | undefined {
  let sibling = node.previousNamedSibling;
  while (sibling?.type === "attribute_item") {
    const match = /^#\[\s*path\s*=\s*"([^"]*)"\s*\]$/.exec(sibling.text);
    if (match?.[1]) return match[1];
    sibling = sibling.previousNamedSibling;
  }
  return undefined;
}

function collectRustFacts(
  root: Node,
  facts: FileFacts,
  moduleKeyByNode: ReadonlyMap<number, string>,
): void {
  const visit = (node: Node, scopeKey: string): void => {
    if (node.type === "use_declaration") {
      const exported = children(node).some((child) =>
        child.type === "visibility_modifier" && child.text.startsWith("pub")
      );
      const argument = node.childForFieldName("argument");
      if (argument) rustUseLeaves(argument, [], exported, scopeKey, facts.rustUses);
      return;
    }
    let childScope = scopeKey;
    if (node.type === "mod_item") {
      const key = moduleKeyByNode.get(node.id);
      const name = node.childForFieldName("name")?.text;
      const inline = node.childForFieldName("body") !== null;
      if (key !== undefined && name !== undefined) {
        const pathAttribute = rustPathAttribute(node);
        facts.rustModules.push({
          key,
          name,
          inline,
          ...(pathAttribute === undefined ? {} : { pathAttribute }),
        });
        // A `use` inside `mod m { … }` binds in `m`'s scope, not the file's.
        if (inline) childScope = key;
      }
    } else if (node.type === "impl_item") {
      const target = node.childForFieldName("type");
      if (target) {
        const targetName = rustBareTypeName(target);
        if (targetName !== undefined) facts.implBlocks.push({ targetName });
      }
    }
    for (const child of namedChildren(node)) visit(child, childScope);
  };
  visit(root, "");
}

/**
 * Copies one file's catalogue facts out of a live syntax tree. `definitions` must come from
 * `collectFileDefinitionNodes` on the same tree.
 */
export function collectFileFacts(
  path: string,
  root: Node,
  parsed: readonly ParsedFileDefinition[],
): FileFacts {
  const rust = highlightLanguageForPath(path) === "rust";
  const facts = emptyFacts(path, rust);
  for (const entry of parsed) {
    facts.definitions.push({ ...entry.definition, hasBody: entry.hasBody });
    if (entry.implOwnerName !== undefined) {
      facts.implMembers.push({ key: entry.definition.key, ownerName: entry.implOwnerName });
    }
  }
  if (rust) {
    const moduleKeyByNode = new Map<number, string>();
    for (const entry of parsed) {
      if (entry.definition.kind === "module") moduleKeyByNode.set(entry.declaration.id, entry.definition.key);
    }
    collectRustFacts(root, facts, moduleKeyByNode);
    for (const entry of parsed) {
      if (rustVisibility(entry.declaration) !== "private") facts.exportedKeys.push(entry.definition.key);
    }
    return facts;
  }
  const exportedNodeIds = new Set<number>();
  collectScriptFacts(root, facts, exportedNodeIds);
  for (const entry of parsed) {
    if (isExportedNode(entry.declaration, exportedNodeIds)) {
      facts.exportedKeys.push(entry.definition.key);
    }
  }
  return facts;
}

const SCRIPT_MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const SCRIPT_INDEX_FILES = SCRIPT_MODULE_EXTENSIONS.map((extension) => `index${extension}`);

const JS_SPECIFIER_SUFFIX = /\.(?:js|mjs|cjs|jsx)$/;

const RUST_MODULE_ROOT_FILES: Record<string, true> = { "mod.rs": true, "lib.rs": true, "main.rs": true };

/** `mod.rs`/`lib.rs`/`main.rs` own their directory; every other file owns `<dir>/<stem>`. */
function rustModuleDirectory(path: string): string {
  const directory = dirname(path);
  const name = path.slice(directory === "." ? 0 : directory.length + 1);
  if (RUST_MODULE_ROOT_FILES[name] === true) return directory === "." ? "" : directory;
  const stem = name.endsWith(".rs") ? name.slice(0, -3) : name;
  return directory === "." ? stem : `${directory}/${stem}`;
}

function joinModulePath(base: string, relativePath: string): string | undefined {
  const joined = normalize(base ? join(base, relativePath) : relativePath);
  if (joined === "." || joined.startsWith("../") || joined === "..") return undefined;
  return joined;
}

type Catalogue = ReadonlyMap<string, FileFacts>;

function canonicalModule(catalogue: Catalogue, candidate: string | undefined): string | undefined {
  return candidate !== undefined && catalogue.has(candidate) ? candidate : undefined;
}

/** Project-contained relative script specifiers only; anything else is intentionally unresolved. */
function resolveScriptModule(
  catalogue: Catalogue,
  fromPath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const directory = dirname(fromPath);
  const base = joinModulePath(directory === "." ? "" : directory, specifier);
  if (base === undefined) return undefined;
  const bases = [base];
  const stripped = base.replace(JS_SPECIFIER_SUFFIX, "");
  if (stripped !== base) bases.push(stripped);
  for (const candidate of bases) {
    const exact = canonicalModule(catalogue, candidate);
    if (exact) return exact;
    for (const extension of SCRIPT_MODULE_EXTENSIONS) {
      const resolved = canonicalModule(catalogue, `${candidate}${extension}`);
      if (resolved) return resolved;
    }
    for (const indexFile of SCRIPT_INDEX_FILES) {
      const resolved = canonicalModule(catalogue, `${candidate}/${indexFile}`);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/** Deepest ancestor directory of `path` that holds a crate root, or `undefined`. */
function crateRootDirectory(catalogue: Catalogue, path: string): string | undefined {
  let directory = dirname(path);
  if (directory === ".") directory = "";
  for (;;) {
    if (
      catalogue.has(directory ? `${directory}/lib.rs` : "lib.rs")
      || catalogue.has(directory ? `${directory}/main.rs` : "main.rs")
    ) return directory;
    if (!directory) return undefined;
    const parent = dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}

/** The file holding module `base::m1::…::mk`, using Rust's `name.rs` then `name/mod.rs` order. */
function rustModuleFile(
  catalogue: Catalogue,
  base: string,
  segments: readonly string[],
): string | undefined {
  const directory = segments.length
    ? (base ? `${base}/${segments.join("/")}` : segments.join("/"))
    : base;
  const candidates = segments.length
    ? [`${directory}.rs`, `${directory}/mod.rs`]
    : [
      directory ? `${directory}/lib.rs` : "lib.rs",
      directory ? `${directory}/main.rs` : "main.rs",
      directory ? `${directory}/mod.rs` : "mod.rs",
    ];
  for (const candidate of candidates) {
    const resolved = canonicalModule(catalogue, candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

/** The body file of a `mod name;` declaration, honoring a literal `#[path = "..."]`. */
function rustModuleBodyFile(
  catalogue: Catalogue,
  facts: FileFacts,
  declaration: RustModuleDeclaration,
): string | undefined {
  if (declaration.pathAttribute !== undefined) {
    // A `path` attribute outside an inline module block is relative to the file's own directory,
    // not to the module directory `<stem>/` that a bare `mod name;` would search.
    const directory = dirname(facts.path);
    return canonicalModule(
      catalogue,
      joinModulePath(directory === "." ? "" : directory, declaration.pathAttribute),
    );
  }
  return rustModuleFile(catalogue, rustModuleDirectory(facts.path), [declaration.name]);
}

type NameTable = Map<string, string[]>;

function nameKey(name: string, space: DefinitionBindingSpace): string {
  return `${name}\u0000${space}`;
}

function splitNameKey(key: string): { name: string; space: DefinitionBindingSpace } {
  const separator = key.lastIndexOf("\u0000");
  return { name: key.slice(0, separator), space: key.slice(separator + 1) as DefinitionBindingSpace };
}

function pushName(table: NameTable, key: string, definitionKey: string): void {
  const existing = table.get(key);
  if (existing) existing.push(definitionKey);
  else table.set(key, [definitionKey]);
}

type FileScopes = {
  /** Every lexical scope of one file: `""` plus each namespace/module definition key. */
  local: Map<string, NameTable>;
  exported: Map<string, NameTable>;
};

function buildFileScopes(
  facts: FileFacts,
  byKey: ReadonlyMap<string, IndexedFileDefinition>,
): FileScopes {
  const exportedKeys = new Set(facts.exportedKeys);
  const local = new Map<string, NameTable>();
  const exported = new Map<string, NameTable>();
  const tableFor = (scopes: Map<string, NameTable>, scopeKey: string): NameTable => {
    let table = scopes.get(scopeKey);
    if (!table) {
      table = new Map();
      scopes.set(scopeKey, table);
    }
    return table;
  };
  tableFor(local, "");
  tableFor(exported, "");
  for (const definition of facts.definitions) {
    let scopeKey: string | undefined;
    if (definition.parentKey === null) scopeKey = "";
    else {
      const parent = byKey.get(definition.parentKey);
      if (parent && (parent.kind === "namespace" || parent.kind === "module")) scopeKey = parent.key;
    }
    if (scopeKey === undefined) continue;
    for (const space of BINDING_SPACES[definition.kind]) {
      pushName(tableFor(local, scopeKey), nameKey(definition.name, space), definition.key);
      if (!exportedKeys.has(definition.key)) continue;
      const canonical = scopeKey === "" ? "" : canonicalScopeKey(scopeKey);
      pushName(tableFor(exported, canonical), nameKey(definition.name, space), definition.key);
    }
  }
  // `export { local as exported }` republishes an existing file-scope declaration.
  const fileLocal = local.get("") ?? new Map<string, string[]>();
  for (const alias of facts.namedExports) {
    for (const space of ["type", "value"] as const) {
      const targets = fileLocal.get(nameKey(alias.local, space));
      if (!targets) continue;
      for (const target of targets) {
        pushName(tableFor(exported, ""), nameKey(alias.exported, space), target);
      }
    }
  }
  return { local, exported };
}

function serializeTargets(targets: readonly DefinitionBindingTarget[]): string {
  return JSON.stringify(
    targets
      .map((target) => (target.kind === "definition" ? `d:${target.key}` : `m:${target.path}`))
      .sort(),
  );
}

function dedupeTargets(targets: readonly DefinitionBindingTarget[]): DefinitionBindingTarget[] {
  const seen = new Set<string>();
  const out: DefinitionBindingTarget[] = [];
  for (const target of targets) {
    const key = target.kind === "definition" ? `d:${target.key}` : `m:${target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * Resolves every project declaration, binding, file import and contribution for one generation.
 * `entries` is the visible tree published alongside the catalogue.
 */
export function buildCatalogue(
  files: readonly FileFacts[],
  entries: readonly TreeNode[],
  packages: readonly PackageInfo[],
): DefinitionIndexSnapshot {
  const catalogue: Catalogue = new Map(files.map((facts) => [facts.path, facts] as const));
  // `use rmux_server::io::Foo` — a workspace crate name roots a path at that crate's lib target.
  // Cargo replaces `-` with `_` in the crate identifier; a package with no `src/lib.rs` (a
  // binary-only crate, or an npm package sharing the directory) is not addressable this way.
  const crateRoots = new Map<string, string>();
  for (const pkg of packages) {
    const directory = pkg.path ? `${pkg.path}/src` : "src";
    if (!catalogue.has(`${directory}/lib.rs`)) continue;
    crateRoots.set(pkg.name.replaceAll("-", "_"), directory);
  }
  const byKey = new Map<string, IndexedFileDefinition>();
  for (const facts of files) {
    for (const definition of facts.definitions) byKey.set(definition.key, definition);
  }
  const scopes = new Map<string, FileScopes>();
  for (const facts of files) scopes.set(facts.path, buildFileScopes(facts, byKey));

  const exportedTable = (path: string): NameTable =>
    scopes.get(path)?.exported.get("") ?? new Map<string, string[]>();

  const resolveRustBase = (
    facts: FileFacts,
    segments: readonly string[],
  ): { base: string; rest: string[] } | undefined => {
    const [root, ...rest] = segments;
    if (root === undefined) return undefined;
    if (root === "crate") {
      const base = crateRootDirectory(catalogue, facts.path);
      return base === undefined ? undefined : { base, rest };
    }
    if (root === "self") return { base: rustModuleDirectory(facts.path), rest };
    if (root === "super") {
      let base = rustModuleDirectory(facts.path);
      let remaining = segments;
      while (remaining[0] === "super") {
        const parent = dirname(base);
        base = parent === "." ? "" : parent;
        remaining = remaining.slice(1);
      }
      return { base, rest: [...remaining] };
    }
    if (facts.rustModules.some((module) => module.name === root)) {
      return { base: rustModuleDirectory(facts.path), rest: [...segments] };
    }
    const crate = crateRoots.get(root);
    if (crate !== undefined) return { base: crate, rest };
    return undefined;
  };

  const resolveExport = (
    path: string,
    name: string,
    space: DefinitionBindingSpace,
    visited: Set<string>,
  ): DefinitionBindingTarget[] => {
    const guard = `${path}\u0000${name}\u0000${space}`;
    if (visited.has(guard)) return [];
    visited.add(guard);
    const facts = catalogue.get(path);
    if (!facts) return [];
    const own = exportedTable(path).get(nameKey(name, space));
    if (own?.length) return own.map((key) => ({ kind: "definition", key } as const));
    if (facts.rust) {
      for (const leaf of facts.rustUses) {
        if (!leaf.exported || leaf.local !== name) continue;
        const resolved = resolveRustUse(facts, leaf, name, space, visited);
        if (resolved.length) return resolved;
      }
      for (const leaf of facts.rustUses) {
        if (!leaf.exported || leaf.local !== "*") continue;
        const base = resolveRustBase(facts, leaf.segments);
        if (!base) continue;
        const target = rustModuleFile(catalogue, base.base, base.rest);
        if (!target) continue;
        const resolved = resolveExport(target, name, space, visited);
        if (resolved.length) return resolved;
      }
      return [];
    }
    const reexports = facts.reexports.filter((entry) => entry.exported === name);
    if (reexports.length) {
      const out: DefinitionBindingTarget[] = [];
      for (const entry of reexports) {
        const target = resolveScriptModule(catalogue, path, entry.specifier);
        if (!target) continue;
        out.push(...resolveExport(target, entry.imported, space, visited));
      }
      return dedupeTargets(out);
    }
    const namespaceReexport = facts.namespaceReexports.find((entry) => entry.exported === name);
    if (namespaceReexport) {
      const target = resolveScriptModule(catalogue, path, namespaceReexport.specifier);
      return target ? [{ kind: "module", path: target }] : [];
    }
    const candidates: DefinitionBindingTarget[][] = [];
    for (const specifier of facts.starExports) {
      const target = resolveScriptModule(catalogue, path, specifier);
      if (!target) continue;
      const resolved = resolveExport(target, name, space, visited);
      if (resolved.length) candidates.push(resolved);
    }
    const first = candidates[0];
    if (!first) return [];
    // A genuinely ambiguous star binding is unresolved rather than an arbitrary first match.
    const signature = serializeTargets(first);
    return candidates.every((entry) => serializeTargets(entry) === signature) ? first : [];
  };

  function resolveRustUse(
    facts: FileFacts,
    leaf: RustUseLeaf,
    name: string,
    space: DefinitionBindingSpace,
    visited: Set<string>,
  ): DefinitionBindingTarget[] {
    const base = resolveRustBase(facts, leaf.segments);
    if (!base || base.rest.length === 0) return [];
    const imported = base.rest[base.rest.length - 1];
    if (imported === undefined) return [];
    const target = rustModuleFile(catalogue, base.base, base.rest.slice(0, -1));
    if (!target) return [];
    if (target === facts.path && imported === name) return [];
    return resolveExport(target, imported, space, visited);
  }

  const bindings: DefinitionBinding[] = [];
  const importEdges = new Set<string>();
  const contributors: DefinitionContributor[] = [];
  const contributorKeys = new Set<string>();

  const addContributor = (
    definitionKey: string,
    sourcePath: string,
    kind: DefinitionContributor["kind"],
  ): void => {
    const key = `${definitionKey}\u0000${sourcePath}\u0000${kind}`;
    if (contributorKeys.has(key)) return;
    contributorKeys.add(key);
    contributors.push({ definitionKey, sourcePath, kind });
  };

  const ordinals = new Map<string, number>();
  const addBinding = (
    sourcePath: string,
    scopeKey: string,
    name: string,
    space: DefinitionBindingSpace,
    bindingKind: DefinitionBinding["bindingKind"],
    target: DefinitionBindingTarget,
  ): void => {
    const counter = `${sourcePath}\u0000${scopeKey}\u0000${name}\u0000${space}\u0000${bindingKind}`;
    const ordinal = ordinals.get(counter) ?? 0;
    ordinals.set(counter, ordinal + 1);
    bindings.push({ sourcePath, scopeKey, name, space, bindingKind, ordinal, target });
  };

  // Rust `impl` ownership, resolved against the whole catalogue so a cross-file block still binds.
  for (const facts of files) {
    if (!facts.rust) continue;
    const fileScope = scopes.get(facts.path)?.local.get("");
    const ownerKeyOf = (ownerName: string): string | undefined => {
      const local = fileScope?.get(nameKey(ownerName, "type"))?.[0];
      if (local !== undefined) return local;
      for (const leaf of facts.rustUses) {
        if (leaf.local !== ownerName) continue;
        const resolved = resolveRustUse(facts, leaf, ownerName, "type", new Set());
        const target = resolved.find((entry) => entry.kind === "definition");
        if (target?.kind === "definition") return target.key;
      }
      return undefined;
    };
    for (const member of facts.implMembers) {
      const owner = ownerKeyOf(member.ownerName);
      const definition = byKey.get(member.key);
      if (owner !== undefined && definition) definition.parentKey = owner;
    }
    for (const block of facts.implBlocks) {
      const owner = ownerKeyOf(block.targetName);
      if (owner !== undefined) addContributor(owner, facts.path, "implementation");
    }
  }

  for (const facts of files) {
    for (const definition of facts.definitions) {
      addContributor(definition.key, definition.source.path, "declaration");
    }
    const fileScopes = scopes.get(facts.path);
    if (!fileScopes) continue;
    const bindingScopes = [["local", fileScopes.local], ["export", fileScopes.exported]] as const;
    for (const [bindingKind, tables] of bindingScopes) {
      for (const [scopeKey, table] of tables) {
        for (const [key, targets] of table) {
          const { name, space } = splitNameKey(key);
          for (const target of targets) {
            addBinding(facts.path, scopeKey, name, space, bindingKind, {
              kind: "definition",
              key: target,
            });
          }
        }
      }
    }

    if (facts.rust) {
      for (const module of facts.rustModules) {
        if (module.inline) continue;
        const body = rustModuleBodyFile(catalogue, facts, module);
        if (!body) continue;
        addContributor(module.key, body, "module");
        importEdges.add(pairKey(facts.path, body));
      }
      for (const leaf of facts.rustUses) {
        const base = resolveRustBase(facts, leaf.segments);
        if (!base) continue;
        const importScope = leaf.scopeKey;
        const exportScope = leaf.scopeKey === "" ? "" : canonicalScopeKey(leaf.scopeKey);
        if (leaf.local === "*") {
          const target = rustModuleFile(catalogue, base.base, base.rest);
          if (!target) continue;
          importEdges.add(pairKey(facts.path, target));
          for (const [key, definitionKeys] of exportedTable(target)) {
            const { name, space } = splitNameKey(key);
            for (const definitionKey of definitionKeys) {
              const bound = { kind: "definition", key: definitionKey } as const;
              addBinding(facts.path, importScope, name, space, "import", bound);
              // `pub use` is both an in-file binding and part of the module's public surface.
              if (leaf.exported) addBinding(facts.path, exportScope, name, space, "export", bound);
            }
          }
          continue;
        }
        const moduleTarget = rustModuleFile(catalogue, base.base, base.rest.slice(0, -1));
        if (moduleTarget) importEdges.add(pairKey(facts.path, moduleTarget));
        for (const space of ["type", "value"] as const) {
          for (const target of resolveRustUse(facts, leaf, leaf.local, space, new Set())) {
            addBinding(facts.path, importScope, leaf.local, space, "import", target);
            if (leaf.exported) {
              addBinding(facts.path, exportScope, leaf.local, space, "export", target);
            }
          }
        }
      }
      continue;
    }

    for (const specifier of facts.moduleSpecifiers) {
      const target = resolveScriptModule(catalogue, facts.path, specifier);
      if (target && target !== facts.path) importEdges.add(pairKey(facts.path, target));
    }
    for (const entry of facts.scriptImports) {
      const target = resolveScriptModule(catalogue, facts.path, entry.specifier);
      if (!target) continue;
      for (const binding of entry.bindings) {
        if (binding.imported === "*") {
          for (const space of ["type", "value"] as const) {
            addBinding(facts.path, "", binding.local, space, "import", {
              kind: "module",
              path: target,
            });
          }
          continue;
        }
        for (const space of ["type", "value"] as const) {
          for (const resolved of resolveExport(target, binding.imported, space, new Set())) {
            addBinding(facts.path, "", binding.local, space, "import", resolved);
          }
        }
      }
    }
    for (const entry of facts.reexports) {
      for (const space of ["type", "value"] as const) {
        for (const resolved of resolveExport(facts.path, entry.exported, space, new Set())) {
          addBinding(facts.path, "", entry.exported, space, "export", resolved);
        }
      }
    }
    for (const entry of facts.namespaceReexports) {
      const target = resolveScriptModule(catalogue, facts.path, entry.specifier);
      if (!target) continue;
      for (const space of ["type", "value"] as const) {
        addBinding(facts.path, "", entry.exported, space, "export", { kind: "module", path: target });
      }
    }
    for (const specifier of facts.starExports) {
      const target = resolveScriptModule(catalogue, facts.path, specifier);
      if (!target) continue;
      for (const [key] of exportedTable(target)) {
        const { name, space } = splitNameKey(key);
        if (exportedTable(facts.path).has(key)) continue;
        for (const resolved of resolveExport(facts.path, name, space, new Set())) {
          addBinding(facts.path, "", name, space, "export", resolved);
        }
      }
    }
  }

  const definitions: IndexedFileDefinition[] = [];
  for (const facts of files) definitions.push(...facts.definitions);
  const imports: FileImportEdge[] = [...importEdges].map((serialized) => {
    const [sourcePath, targetPath] = unpairKey(serialized);
    return { sourcePath, targetPath };
  });
  imports.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
    || left.targetPath.localeCompare(right.targetPath)
  );
  return { entries, definitions, bindings, contributors, imports };
}
