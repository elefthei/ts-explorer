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

/** Rust keeps the bare return type under `return_type`; tuple fields have none. */
export function rustMemberReturnType(node: Node): string | undefined {
  return node.childForFieldName("return_type")?.text;
}
