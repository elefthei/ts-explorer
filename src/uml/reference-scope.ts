import type { Node } from "@vscode/tree-sitter-wasm";
import type { DefinitionBindingSpace, DefinitionBindingTarget } from "./model.ts";
import type { ReferenceContext } from "./usage.ts";

/** Names a lexical scope binds, split by the space they resolve in. */
export type ScopeFrame = { values: Set<string>; types: Set<string> };

/** `true` when an enclosing frame binds `name`, so it never resolves to a file declaration. */
export function shadowed(
  frames: readonly ScopeFrame[],
  name: string,
  space: DefinitionBindingSpace,
): boolean {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (space === "value" ? frame.values.has(name) : frame.types.has(name)) return true;
  }
  return false;
}

/** `true` when `node` is the name or binding pattern its declaring parent is identified by. */
export function isDeclarationName(node: Node, parents: Record<string, true>): boolean {
  const parent = node.parent;
  if (!parent || parents[parent.type] !== true) return false;
  return parent.childForFieldName("name")?.id === node.id
    || parent.childForFieldName("pattern")?.id === node.id;
}

/** Members every resolved receiver exposes under `name`, deduplicated in receiver order. */
export function memberKeys(
  context: ReferenceContext,
  receivers: readonly DefinitionBindingTarget[],
  name: string,
  spaces: readonly DefinitionBindingSpace[],
): string[] {
  const keys = new Set<string>();
  for (const receiver of receivers) {
    for (const space of spaces) {
      for (const key of context.resolveMember(receiver, name, space)) keys.add(key);
    }
  }
  return [...keys];
}
