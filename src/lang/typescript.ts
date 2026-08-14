import type { Node } from "@vscode/tree-sitter-wasm";
import { namedChildren } from "./ast.ts";
import { definitionLanguageForPath } from "./registry.ts";
import { loadLanguage, parseTree } from "./runtime.ts";

export const ENTITY_KIND_BY_NODE: Record<string, "class" | "interface" | "enum" | "type"> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
};

export const METHOD_NODE_TYPES: ReadonlySet<string> = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);

export const TYPE_REFERENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "type_identifier",
  "identifier",
]);

// Declared after the tables above and awaited last on purpose: the top-level `await` suspends this
// module mid-evaluation, and `src/uml/resolve.ts` / `src/uml/usage.ts` read the tables at *their*
// module scope. Anything declared below this point is still in TDZ for them.
const GRAMMARS = {
  typescript: await loadLanguage("typescript"),
  tsx: await loadLanguage("tsx"),
};

/** `undefined` when `path` is not TypeScript/TSX. Caller MUST `dispose()`. */
export function parseTypeScriptSource(
  path: string,
  source: string,
): { root: Node; dispose(): void } | undefined {
  const language = definitionLanguageForPath(path);
  if (!language) return undefined;
  const parsed = parseTree(GRAMMARS[language], source);
  return { root: parsed.tree.rootNode, dispose: parsed.dispose };
}

/**
 * Direct `program` children with their `export` / `declare` wrappers removed. Namespaces surface as
 * `expression_statement > internal_module` and are never unwrapped, so nested declarations stay out.
 */
export function topLevelDeclarations(root: Node): Node[] {
  const result: Node[] = [];
  for (const statement of namedChildren(root)) {
    if (statement.type === "ambient_declaration") {
      const inner = statement.namedChild(0);
      if (inner) result.push(inner);
      continue;
    }
    if (statement.type !== "export_statement") {
      result.push(statement);
      continue;
    }
    const declaration = statement.childForFieldName("declaration");
    if (declaration) {
      if (declaration.type === "ambient_declaration") {
        const inner = declaration.namedChild(0);
        if (inner) result.push(inner);
      } else {
        result.push(declaration);
      }
      continue;
    }
    // `export default class {}` keeps the class under `value` and has no name.
    const value = statement.childForFieldName("value");
    if (value?.type === "class") result.push(value);
  }
  return result;
}

/** Bare declared name of any named declaration node. */
export function declarationName(node: Node): string | undefined {
  return node.childForFieldName("name")?.text;
}

/** Canonical member name and the node carrying it, or `undefined` for computed names. */
export function memberName(node: Node): { name: string; node: Node } | undefined {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;
  if (
    nameNode.type === "property_identifier"
    || nameNode.type === "private_property_identifier"
    || nameNode.type === "number"
  ) {
    return { name: nameNode.text, node: nameNode };
  }
  if (nameNode.type === "string") {
    const fragment = namedChildren(nameNode).find((child) => child.type === "string_fragment");
    return { name: fragment?.text ?? "", node: nameNode };
  }
  return undefined;
}

export function isAccessor(node: Node): boolean {
  const first = node.child(0)?.type;
  return first === "get" || first === "set";
}

/** The annotated type node behind a `type` / `return_type` field, without the leading `:`. */
export function annotationType(node: Node, field: "type" | "return_type"): Node | undefined {
  return node.childForFieldName(field)?.namedChild(0) ?? undefined;
}

/** Every type reference inside an annotation, in source order. */
export function typeReferenceNodes(node: Node): Node[] {
  const result: Node[] = [];
  const visit = (current: Node): void => {
    if (TYPE_REFERENCE_NODE_TYPES.has(current.type)) result.push(current);
    for (const child of namedChildren(current)) visit(child);
  };
  visit(node);
  return result;
}
