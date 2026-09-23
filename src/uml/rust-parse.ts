import type { Node } from "@vscode/tree-sitter-wasm";
import { rustFunctionModifiers, rustVisibility } from "../lang/rust.ts";
import { orderUmlModifiers, type UmlModifier } from "./model.ts";

const RUST_ASSOCIATED_CONSTANT_TYPES: Record<string, true> = { const_item: true, static_item: true };

/** Visibility plus `async`/`unsafe`/`const`, in canonical modifier order. */
export function rustMemberModifiers(node: Node): UmlModifier[] {
  if (RUST_ASSOCIATED_CONSTANT_TYPES[node.type] === true) {
    return orderUmlModifiers([rustVisibility(node), "const", "static"]);
  }
  if (node.type === "function_item" || node.type === "function_signature_item") {
    return orderUmlModifiers([rustVisibility(node), ...rustFunctionModifiers(node)]);
  }
  return orderUmlModifiers([rustVisibility(node)]);
}

/** Bare name of a possibly generic/reference/scoped type node. */
export function rustBareTypeName(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "generic_type" || current.type === "reference_type") {
      current = current.childForFieldName("type") ?? undefined;
      continue;
    }
    if (current.type === "scoped_type_identifier" || current.type === "scoped_identifier") {
      current = current.childForFieldName("name") ?? undefined;
      continue;
    }
    return current.text || undefined;
  }
  return undefined;
}
