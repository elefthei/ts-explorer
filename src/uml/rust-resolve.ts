import { basename, dirname } from "node:path/posix";
import type { Node } from "@vscode/tree-sitter-wasm";
import { namedChildren } from "../lang/ast.ts";
import { rustTopLevelItems } from "../lang/rust.ts";
import { posix, umlEntityKey, umlFileKey } from "./keys.ts";
import { bareUmlName } from "./mermaid.ts";
import type { SourceUnit, UmlReference } from "./model.ts";

/** `mod.rs`/`lib.rs`/`main.rs` own their directory; every other file owns `<dir>/<stem>`. */
const MODULE_ROOT_FILES = new Set(["mod.rs", "lib.rs", "main.rs"]);

function moduleDirectory(file: string): string {
  const path = posix(file);
  const name = basename(path);
  if (MODULE_ROOT_FILES.has(name)) return dirname(path);
  return `${dirname(path)}/${name.slice(0, name.length - ".rs".length)}`;
}

/** Deepest ancestor directory of `file` that holds a crate root, or `undefined`. */
function crateRootDirectory(file: string, unitsByKey: ReadonlyMap<string, SourceUnit>): string | undefined {
  let directory = dirname(posix(file));
  let previous = "";
  while (directory !== previous) {
    if (
      unitsByKey.has(umlFileKey(`${directory}/lib.rs`))
      || unitsByKey.has(umlFileKey(`${directory}/main.rs`))
    ) {
      return directory;
    }
    previous = directory;
    directory = dirname(directory);
  }
  return undefined;
}

/** The file that holds module `base/m1/../mk`, using Rust's file/`mod.rs` lookup order. */
function moduleFile(
  base: string,
  segments: readonly string[],
  unitsByKey: ReadonlyMap<string, SourceUnit>,
): SourceUnit | undefined {
  const directory = segments.length ? `${base}/${segments.join("/")}` : base;
  const candidates = segments.length
    ? [`${directory}.rs`, `${directory}/mod.rs`]
    : [`${base}/lib.rs`, `${base}/main.rs`, `${base}/mod.rs`];
  for (const candidate of candidates) {
    const unit = unitsByKey.get(umlFileKey(candidate));
    if (unit) return unit;
  }
  return undefined;
}

type UseLeaf = { segments: string[]; local: string };

function pathSegments(node: Node): string[] | undefined {
  if (node.type === "identifier" || node.type === "type_identifier") return [node.text];
  if (node.type === "self" || node.type === "super" || node.type === "crate") return [node.type];
  if (node.type === "scoped_identifier") {
    const path = node.childForFieldName("path");
    const name = node.childForFieldName("name");
    if (!name) return undefined;
    if (!path) return [name.text];
    const prefix = pathSegments(path);
    return prefix ? [...prefix, name.text] : undefined;
  }
  return undefined;
}

/** Flattens `use` trees into `(segments, localName)` leaves; wildcards are unresolvable. */
function useLeaves(node: Node, prefix: readonly string[], out: UseLeaf[]): void {
  if (node.type === "use_wildcard") return;
  if (node.type === "use_as_clause") {
    const path = node.childForFieldName("path");
    const alias = node.childForFieldName("alias");
    const segments = path ? pathSegments(path) : undefined;
    if (!segments || !alias) return;
    out.push({ segments: [...prefix, ...segments], local: alias.text });
    return;
  }
  if (node.type === "scoped_use_list") {
    const path = node.childForFieldName("path");
    const list = node.childForFieldName("list");
    const segments = path ? pathSegments(path) ?? [] : [];
    if (!list) return;
    for (const entry of namedChildren(list)) useLeaves(entry, [...prefix, ...segments], out);
    return;
  }
  if (node.type === "use_list") {
    for (const entry of namedChildren(node)) useLeaves(entry, prefix, out);
    return;
  }
  const segments = pathSegments(node);
  if (!segments?.length) return;
  const local = segments[segments.length - 1];
  if (local === undefined) return;
  out.push({ segments: [...prefix, ...segments], local });
}

function useDeclarationLeaves(statement: Node): UseLeaf[] {
  const argument = statement.childForFieldName("argument");
  if (!argument) return [];
  const leaves: UseLeaf[] = [];
  useLeaves(argument, [], leaves);
  return leaves;
}

/**
 * Name → entity for one Rust file: its own items plus every `use` leaf that resolves to an entity
 * declared by another file in the scanned tree. Unresolvable leaves are dropped, exactly like an
 * unresolved TypeScript import.
 */
export function collectRustFileScope(
  unit: SourceUnit,
  entities: ReadonlyMap<string, UmlReference>,
  unitsByKey: ReadonlyMap<string, SourceUnit>,
): Map<string, UmlReference> {
  const scope = new Map<string, UmlReference>();
  const items = rustTopLevelItems(unit.root);
  const declaredModules = new Set<string>();

  for (const item of items) {
    if (item.type === "mod_item") {
      const name = item.childForFieldName("name")?.text;
      if (name !== undefined) declaredModules.add(name);
      continue;
    }
    const name = item.childForFieldName("name")?.text;
    if (name === undefined) continue;
    const entity = entities.get(umlEntityKey(unit.path, bareUmlName(name)));
    if (entity) scope.set(name, entity);
  }

  const selfDirectory = moduleDirectory(unit.path);
  let crateDirectory: string | undefined | null = null;
  for (const item of items) {
    if (item.type !== "use_declaration") continue;
    for (const leaf of useDeclarationLeaves(item)) {
      const [root, ...rest] = leaf.segments;
      if (root === undefined || rest.length === 0) continue;
      let base: string | undefined;
      let segments: string[];
      if (root === "crate") {
        if (crateDirectory === null) crateDirectory = crateRootDirectory(unit.path, unitsByKey);
        base = crateDirectory;
        segments = rest;
      } else if (root === "self") {
        base = selfDirectory;
        segments = rest;
      } else if (root === "super") {
        base = dirname(selfDirectory);
        segments = rest;
      } else if (declaredModules.has(root)) {
        // `use model::Widget;` inside a file that declares `mod model;` means `self::model::…`.
        base = selfDirectory;
        segments = leaf.segments;
      } else {
        continue;
      }
      if (base === undefined) continue;
      const moduleSegments = segments.slice(0, -1);
      const target = moduleFile(base, moduleSegments, unitsByKey);
      if (!target) continue;
      const imported = segments[segments.length - 1];
      if (imported === undefined) continue;
      const entity = entities.get(umlEntityKey(target.path, bareUmlName(imported)));
      if (entity) scope.set(leaf.local, entity);
    }
  }
  return scope;
}

const RUST_DECLARATION_NAME_PARENTS: ReadonlySet<string> = new Set([
  "struct_item",
  "union_item",
  "enum_item",
  "trait_item",
  "type_item",
  "mod_item",
  "function_item",
  "function_signature_item",
  "const_item",
  "static_item",
  "field_declaration",
  "enum_variant",
  "type_parameter",
  "associated_type",
  "macro_definition",
  "let_declaration",
  "parameter",
  "closure_parameter",
]);

const RUST_REFERENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "type_identifier",
  "identifier",
]);

function isRustUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "field_expression") return parent.childForFieldName("field")?.id !== node.id;
  if (parent.type === "scoped_type_identifier" || parent.type === "scoped_identifier") return true;
  if (parent.type === "attribute" || parent.type === "lifetime") return false;
  if (RUST_DECLARATION_NAME_PARENTS.has(parent.type)) {
    if (parent.childForFieldName("name")?.id === node.id) return false;
    if (parent.childForFieldName("pattern")?.id === node.id) return false;
  }
  return true;
}

const RUST_REFERENCE_EXCLUDED_SUBTREES: ReadonlySet<string> = new Set([
  "use_declaration",
  "attribute_item",
  "inner_attribute_item",
  "line_comment",
  "block_comment",
]);

/** Every genuine type/value usage in a Rust unit, in source order. */
export function rustReferenceNodes(unit: SourceUnit): Node[] {
  const result: Node[] = [];
  const visit = (node: Node): void => {
    if (RUST_REFERENCE_EXCLUDED_SUBTREES.has(node.type)) return;
    if (RUST_REFERENCE_NODE_TYPES.has(node.type) && isRustUsage(node)) result.push(node);
    for (const child of namedChildren(node)) visit(child);
  };
  visit(unit.root);
  return result;
}
