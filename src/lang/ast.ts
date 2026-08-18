import type { Node } from "@vscode/tree-sitter-wasm";

export function namedChildren(node: Node): Node[] {
  const result: Node[] = [];
  for (const child of node.namedChildren) {
    if (child) result.push(child);
  }
  return result;
}

export function children(node: Node): Node[] {
  const result: Node[] = [];
  for (const child of node.children) {
    if (child) result.push(child);
  }
  return result;
}

export function firstAncestor(node: Node, match: (candidate: Node) => boolean): Node | undefined {
  let current = node.parent;
  while (current) {
    if (match(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * `Foo` plus its declared type parameters, e.g. `Foo<T,U>`. Both grammars name the field
 * `type_parameters` and the node `type_parameter`; Rust lifetimes and const generics are skipped.
 */
export function renderedTypeName(bare: string, declaration: Node): string {
  const parameters = declaration.childForFieldName("type_parameters");
  if (!parameters) return bare;
  const rendered: string[] = [];
  for (const parameter of namedChildren(parameters)) {
    if (parameter.type !== "type_parameter") continue;
    rendered.push(parameter.childForFieldName("name")?.text ?? "");
  }
  return rendered.length ? `${bare}<${rendered.join(",")}>` : bare;
}
