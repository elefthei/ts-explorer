import type { Node } from "@vscode/tree-sitter-wasm";
import { firstAncestor, namedChildren } from "../lang/ast.ts";
import type { UmlRelationKind } from "../diagram-graph.ts";
import type { DefinitionBindingSpace, DefinitionBindingTarget } from "./model.ts";
import type { ReferenceContext, UmlReferenceEdge } from "./usage.ts";

const RUST_SKIPPED_SUBTREES: Record<string, true> = {
  use_declaration: true,
  attribute_item: true,
  inner_attribute_item: true,
  line_comment: true,
  block_comment: true,
};

const RUST_DECLARATION_NAME_PARENTS: Record<string, true> = {
  struct_item: true,
  union_item: true,
  enum_item: true,
  trait_item: true,
  type_item: true,
  mod_item: true,
  function_item: true,
  function_signature_item: true,
  const_item: true,
  static_item: true,
  field_declaration: true,
  enum_variant: true,
  type_parameter: true,
  associated_type: true,
  macro_definition: true,
  let_declaration: true,
  parameter: true,
  closure_parameter: true,
};

type RustScopeFrame = { values: Set<string>; types: Set<string> };

function collectRustPatternNames(pattern: Node, out: Set<string>): void {
  if (pattern.type === "identifier") {
    out.add(pattern.text);
    return;
  }
  for (const child of namedChildren(pattern)) collectRustPatternNames(child, out);
}

function rustScopeFrame(node: Node): RustScopeFrame | undefined {
  const values = new Set<string>();
  const types = new Set<string>();
  const typeParameters = node.childForFieldName("type_parameters");
  for (const parameter of typeParameters ? namedChildren(typeParameters) : []) {
    if (parameter.type === "type_identifier") types.add(parameter.text);
    else {
      const name = parameter.childForFieldName("name")?.text;
      if (name) types.add(name);
    }
  }
  if (node.type === "function_item" || node.type === "function_signature_item") {
    const parameters = node.childForFieldName("parameters");
    for (const parameter of parameters ? namedChildren(parameters) : []) {
      const pattern = parameter.childForFieldName("pattern");
      if (pattern) collectRustPatternNames(pattern, values);
    }
  } else if (node.type === "closure_expression") {
    const parameters = node.childForFieldName("parameters");
    for (const parameter of parameters ? namedChildren(parameters) : []) {
      collectRustPatternNames(parameter, values);
    }
  } else if (node.type === "block") {
    for (const statement of namedChildren(node)) {
      if (statement.type !== "let_declaration") continue;
      const pattern = statement.childForFieldName("pattern");
      if (pattern) collectRustPatternNames(pattern, values);
    }
  } else if (node.type === "for_expression") {
    const pattern = node.childForFieldName("pattern");
    if (pattern) collectRustPatternNames(pattern, values);
  }
  return values.size || types.size ? { values, types } : undefined;
}

function rustShadowed(
  frames: readonly RustScopeFrame[],
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

function rustIsUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "field_expression") return parent.childForFieldName("field")?.id !== node.id;
  if (parent.type === "scoped_type_identifier" || parent.type === "scoped_identifier") return false;
  if (parent.type === "attribute" || parent.type === "lifetime") return false;
  if (RUST_DECLARATION_NAME_PARENTS[parent.type] === true) {
    if (parent.childForFieldName("name")?.id === node.id) return false;
    if (parent.childForFieldName("pattern")?.id === node.id) return false;
  }
  return true;
}

/** Bare name of a possibly generic/reference/scoped type node. */
function rustBareTypeName(node: Node): string | undefined {
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

function rustRelationKind(node: Node): UmlRelationKind {
  const bounds = firstAncestor(node, (candidate) => candidate.type === "trait_bounds");
  return bounds?.parent?.type === "trait_item" ? "extends" : "references";
}

type RustVisitState = {
  context: ReferenceContext;
  frames: RustScopeFrame[];
  implOwner: string | undefined;
  /** `impl` header nodes already consumed as heritage; they are not generic references too. */
  skipped: Set<number>;
};

function ownersAt(state: RustVisitState, node: Node): readonly string[] {
  const owners = state.context.ownersOf(node);
  if (owners.length) return owners;
  return state.implOwner === undefined ? [] : [state.implOwner];
}

function rustReceiverTargets(
  state: RustVisitState,
  node: Node,
  chain: readonly string[],
): DefinitionBindingTarget[] {
  if (node.type === "self" || node.text === "Self") {
    const owner = state.implOwner ?? state.context.enclosingNominal(node);
    return owner === undefined ? [] : [{ kind: "definition", key: owner }];
  }
  if (node.type === "identifier" || node.type === "type_identifier") {
    if (rustShadowed(state.frames, node.text, "value") && rustShadowed(state.frames, node.text, "type")) {
      return [];
    }
    const types = state.context.resolveName(node.text, "type", chain);
    if (types.length) return types;
    return state.context.resolveName(node.text, "value", chain);
  }
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    const path = node.childForFieldName("path");
    const name = node.childForFieldName("name");
    if (!path || !name) return [];
    const receivers = rustReceiverTargets(state, path, chain);
    const keys = new Set<string>();
    for (const receiver of receivers) {
      for (const space of ["type", "value"] as const) {
        for (const key of state.context.resolveMember(receiver, name.text, space)) keys.add(key);
      }
    }
    return [...keys].map((key) => ({ kind: "definition", key } as const));
  }
  if (node.type === "field_expression") {
    const value = node.childForFieldName("value");
    const field = node.childForFieldName("field");
    if (!value || !field) return [];
    const receivers = rustReceiverTargets(state, value, chain);
    const keys = new Set<string>();
    for (const receiver of receivers) {
      for (const key of state.context.resolveMember(receiver, field.text, "value")) keys.add(key);
    }
    return [...keys].map((key) => ({ kind: "definition", key } as const));
  }
  return [];
}

function visitRust(state: RustVisitState, node: Node): void {
  if (RUST_SKIPPED_SUBTREES[node.type] === true || state.skipped.has(node.id)) return;
  const frame = rustScopeFrame(node);
  if (frame) state.frames.push(frame);
  const previousImplOwner = state.implOwner;
  try {
    if (node.type === "impl_item") {
      const targetNode = node.childForFieldName("type");
      const targetName = targetNode ? rustBareTypeName(targetNode) : undefined;
      const resolved = targetName === undefined
        ? []
        : state.context.resolveName(targetName, "type", [""]);
      const owner = resolved.find((entry) => entry.kind === "definition");
      state.implOwner = owner?.kind === "definition" ? owner.key : undefined;
      if (targetNode) state.skipped.add(targetNode.id);
      const traitNode = node.childForFieldName("trait");
      if (traitNode) state.skipped.add(traitNode.id);
      if (traitNode && state.implOwner !== undefined) {
        const traitName = rustBareTypeName(traitNode);
        const traitTargets = traitName === undefined
          ? []
          : state.context.resolveName(traitName, "type", [""]);
        for (const target of traitTargets) {
          if (target.kind === "definition") state.context.add([state.implOwner], target.key, "implements");
        }
      }
    }
    const owners = ownersAt(state, node);
    const chain = state.context.scopeChain(owners[0]);
    if (node.type === "scoped_type_identifier" || node.type === "scoped_identifier") {
      const path = node.childForFieldName("path");
      const name = node.childForFieldName("name");
      if (path && name && owners.length) {
        const receivers = rustReceiverTargets(state, path, chain);
        const keys = new Set<string>();
        for (const receiver of receivers) {
          for (const space of ["type", "value"] as const) {
            for (const key of state.context.resolveMember(receiver, name.text, space)) keys.add(key);
          }
        }
        if (keys.size) {
          const kind = rustRelationKind(node);
          for (const key of keys) state.context.add(owners, key, kind);
          return;
        }
        // An unresolved qualifier still lets its leading name resolve on its own.
      }
    }
    if (node.type === "field_expression") {
      const value = node.childForFieldName("value");
      const field = node.childForFieldName("field");
      if (value && field && owners.length) {
        const receivers = rustReceiverTargets(state, value, chain);
        const keys = new Set<string>();
        for (const receiver of receivers) {
          for (const key of state.context.resolveMember(receiver, field.text, "value")) keys.add(key);
        }
        for (const key of keys) state.context.add(owners, key, "references");
        if (value.type !== "identifier" && value.type !== "self") visitRust(state, value);
        return;
      }
    }
    if (node.type === "type_identifier" || node.type === "identifier") {
      if (rustIsUsage(node) && owners.length) {
        const kind = rustRelationKind(node);
        for (const space of ["type", "value"] as const) {
          if (rustShadowed(state.frames, node.text, space)) continue;
          for (const target of state.context.resolveName(node.text, space, chain)) {
            if (target.kind === "definition") state.context.add(owners, target.key, kind);
          }
        }
      }
      return;
    }
    for (const child of namedChildren(node)) visitRust(state, child);
  } finally {
    state.implOwner = previousImplOwner;
    if (frame) state.frames.pop();
  }
}

export function collectRustReferences(context: ReferenceContext, root: Node): UmlReferenceEdge[] {
  visitRust({ context, frames: [], implOwner: undefined, skipped: new Set() }, root);
  return context.result();
}
