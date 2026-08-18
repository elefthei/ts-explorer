import type { Node } from "@vscode/tree-sitter-wasm";
import { firstAncestor, namedChildren } from "../lang/ast.ts";
import { rustBodyMethods, rustImplTargetName, rustTypeBaseName } from "../lang/rust.ts";
import type { UmlExternalUserKind } from "../types.ts";
import { formatSignatureType } from "./mermaid.ts";

export type RustReferenceOwner = {
  signature: string;
  kind: UmlExternalUserKind;
  source: Node;
  ownerName?: string;
};

const RUST_OWNER_TYPES: ReadonlySet<string> = new Set([
  "field_declaration",
  "function_item",
  "function_signature_item",
  "const_item",
  "static_item",
  "type_item",
  "impl_item",
  "trait_item",
  "struct_item",
  "union_item",
  "enum_item",
  "macro_definition",
]);

function parameterTypes(node: Node): string {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return "";
  return namedChildren(parameters)
    .map((parameter) => {
      if (parameter.type === "self_parameter") return parameter.text;
      return formatSignatureType(parameter.childForFieldName("type")?.text);
    })
    .join(", ");
}

function implLabel(node: Node): string {
  const target = rustImplTargetName(node) ?? "?";
  const trait = node.childForFieldName("trait");
  return trait ? `impl ${rustTypeBaseName(trait).text} for ${target}` : `impl ${target}`;
}

/**
 * Who "uses" a Rust reference: the nearest enclosing member, or the file-scope item that becomes a
 * local-user node. `ownerName` is the bare name of the entity that owns the member, when there is
 * one; the caller maps it to an entity id exactly as the TypeScript classifier's owner does.
 */
export function classifyRustReferenceOwner(reference: Node): RustReferenceOwner | undefined {
  const owner = firstAncestor(reference, (candidate) => RUST_OWNER_TYPES.has(candidate.type));
  if (!owner) return undefined;

  if (owner.type === "field_declaration") {
    const parent = firstAncestor(owner, (candidate) =>
      candidate.type === "struct_item" || candidate.type === "union_item");
    const ownerName = parent ? parent.childForFieldName("name")?.text : undefined;
    const nameNode = owner.childForFieldName("name");
    if (!ownerName || !nameNode) return undefined;
    return {
      signature: `${ownerName}.${nameNode.text}: ${
        formatSignatureType(owner.childForFieldName("type")?.text)
      }`,
      kind: "property",
      source: nameNode,
      ownerName,
    };
  }

  if (owner.type === "function_item" || owner.type === "function_signature_item") {
    const nameNode = owner.childForFieldName("name");
    if (!nameNode) return undefined;
    const container = firstAncestor(owner, (candidate) =>
      candidate.type === "trait_item" || candidate.type === "impl_item");
    if (!container) {
      return {
        signature: `${nameNode.text}(${parameterTypes(owner)})`,
        kind: "function",
        source: nameNode,
      };
    }
    const ownerName = container.type === "trait_item"
      ? container.childForFieldName("name")?.text
      : rustImplTargetName(container);
    if (ownerName === undefined) return undefined;
    return {
      signature: `${ownerName}.${nameNode.text}(${parameterTypes(owner)})`,
      kind: "method",
      source: nameNode,
      ownerName,
    };
  }

  if (owner.type === "impl_item") {
    // When the target is an entity in the same file the caller resolves `ownerName` and the
    // reference becomes an entity-to-entity edge; otherwise the impl block itself is a local user.
    const ownerName = rustImplTargetName(owner);
    return {
      signature: implLabel(owner),
      kind: "type",
      source: owner.child(0) ?? owner,
      ...(ownerName === undefined ? {} : { ownerName }),
    };
  }

  const nameNode = owner.childForFieldName("name");
  if (!nameNode) return undefined;
  if (owner.type === "const_item" || owner.type === "static_item") {
    return {
      signature: `${nameNode.text}: ${
        formatSignatureType(owner.childForFieldName("type")?.text)
      }`,
      kind: "variable",
      source: nameNode,
    };
  }
  if (owner.type === "type_item" || owner.type === "macro_definition") {
    return { signature: nameNode.text, kind: "type", source: nameNode };
  }
  // A reference in a `struct`/`trait`/`enum` header (generic bounds, supertraits) belongs to the
  // entity itself, which `analyzeUmlTypes` turns into an entity-to-entity usage edge.
  return {
    signature: nameNode.text,
    kind: "class",
    source: nameNode,
    ownerName: nameNode.text,
  };
}

/** Return-type annotations of every method a Rust entity owns, keyed by the entity's bare name. */
export function rustMethodReturnAnnotations(
  items: readonly Node[],
): { ownerName: string; annotation: Node }[] {
  const result: { ownerName: string; annotation: Node }[] = [];
  const collect = (ownerName: string, body: Node | null | undefined): void => {
    for (const member of rustBodyMethods(body)) {
      const annotation = member.childForFieldName("return_type");
      if (annotation) result.push({ ownerName, annotation });
    }
  };
  for (const item of items) {
    if (item.type === "trait_item") {
      const name = item.childForFieldName("name")?.text;
      if (name !== undefined) collect(name, item.childForFieldName("body"));
      continue;
    }
    if (item.type !== "impl_item") continue;
    const name = rustImplTargetName(item);
    if (name !== undefined) collect(name, item.childForFieldName("body"));
  }
  return result;
}
