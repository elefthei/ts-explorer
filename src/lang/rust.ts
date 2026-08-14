import type { Node } from "@vscode/tree-sitter-wasm";
import type { UmlEntityKind } from "../diagram-graph.ts";
import type { UmlModifier } from "../uml/model.ts";
import { children, namedChildren } from "./ast.ts";
import { loadLanguage, parseTree } from "./runtime.ts";

export const RUST_ENTITY_KIND_BY_NODE: Record<string, UmlEntityKind> = {
  struct_item: "class",
  union_item: "class",
  trait_item: "interface",
  enum_item: "enum",
  type_item: "type",
};

export const RUST_METHOD_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_item",
  "function_signature_item",
]);

/** Item kinds that carry members when they appear inside a `declaration_list`. */
export const RUST_PROPERTY_NODE_TYPES: ReadonlySet<string> = new Set([
  "const_item",
  "static_item",
]);

const RUST_FUNCTION_MODIFIERS: Record<string, UmlModifier> = {
  async: "async",
  unsafe: "unsafe",
  const: "const",
};

/** Bare name of the type an `impl` block applies to, e.g. `Widget` for `impl Trait for Widget<T>`. */
export function rustImplTargetName(node: Node): string | undefined {
  const target = rustImplTarget(node);
  return target ? rustTypeBaseName(target).text : undefined;
}

/** Method items directly inside a `trait`/`impl` `declaration_list`, in source order. */
export function rustBodyMethods(body: Node | null | undefined): Node[] {
  const methods: Node[] = [];
  for (const member of body ? namedChildren(body) : []) {
    if (RUST_METHOD_NODE_TYPES.has(member.type)) methods.push(member);
  }
  return methods;
}

// Declared after the tables above and awaited last on purpose: the top-level `await` suspends this
// module mid-evaluation, and `src/uml/rust-*.ts` read the tables at *their* module scope. Anything
// declared below this point is still in TDZ for them. Mirrors src/lang/typescript.ts.
const GRAMMAR = await loadLanguage("rust");

/** Caller MUST `dispose()`. */
export function parseRustSource(source: string): { root: Node; dispose(): void } {
  const parsed = parseTree(GRAMMAR, source);
  return { root: parsed.tree.rootNode, dispose: parsed.dispose };
}

/**
 * Direct `source_file` children. Inline `mod` bodies are never descended into, mirroring the
 * TypeScript rule that namespace bodies stay out of the model.
 */
export function rustTopLevelItems(root: Node): Node[] {
  return namedChildren(root);
}

/** `pub` is public, every restricted `pub(...)` form is protected, no modifier is private. */
export function rustVisibility(node: Node): UmlModifier {
  const modifier = children(node).find((child) => child.type === "visibility_modifier");
  if (!modifier) return "private";
  return modifier.text === "pub" ? "public" : "protected";
}

/** `async`/`unsafe`/`const`, plus `abstract` for trait requirements and `static` for no `self`. */
export function rustFunctionModifiers(node: Node): UmlModifier[] {
  const modifiers: UmlModifier[] = [];
  const tokens = children(node).find((child) => child.type === "function_modifiers");
  for (const token of tokens ? children(tokens) : []) {
    const modifier = RUST_FUNCTION_MODIFIERS[token.type];
    if (modifier) modifiers.push(modifier);
  }
  if (node.type === "function_signature_item") modifiers.push("abstract");
  const parameters = node.childForFieldName("parameters");
  const hasSelf = parameters
    ? namedChildren(parameters).some((parameter) => parameter.type === "self_parameter")
    : false;
  if (!hasSelf) modifiers.push("static");
  return modifiers;
}

/** The named type an `impl` block applies to, unwrapped through `Foo<..>` and `&Foo`. */
export function rustImplTarget(node: Node): Node | undefined {
  let current = node.childForFieldName("type") ?? undefined;
  while (current) {
    if (current.type === "generic_type") {
      current = current.childForFieldName("type") ?? undefined;
      continue;
    }
    if (current.type === "reference_type") {
      current = current.childForFieldName("type") ?? undefined;
      continue;
    }
    return current;
  }
  return undefined;
}

/** Bare name of a possibly scoped type node: `fmt::Display` is `Display`, `Foo<T>` is `Foo`. */
export function rustTypeBaseName(node: Node): Node {
  if (node.type === "generic_type") {
    const inner = node.childForFieldName("type");
    return inner ? rustTypeBaseName(inner) : node;
  }
  if (node.type === "scoped_type_identifier" || node.type === "scoped_identifier") {
    return node.childForFieldName("name") ?? node;
  }
  return node;
}
