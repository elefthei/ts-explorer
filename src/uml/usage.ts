import type { Node } from "@vscode/tree-sitter-wasm";
import type { ParsedFileDefinition } from "../goto-definition.ts";
import { firstAncestor, namedChildren } from "../lang/ast.ts";
import { highlightLanguageForPath } from "../lang/registry.ts";
import type { UmlRelationKind } from "../diagram-graph.ts";
import type { FileDefinitionKind } from "../types.ts";
import { canonicalScopeKey } from "./keys.ts";
import { collectRustReferences } from "./rust-usage.ts";
import type {
  DefinitionBindingSpace,
  DefinitionBindingTarget,
  DefinitionResolutionIndex,
  IndexedFileDefinition,
} from "./model.ts";

/** One resolved outgoing reference: `ownerKey` uses `targetKey`. Occurrences deduplicate. */
export type UmlReferenceEdge = {
  ownerKey: string;
  targetKey: string;
  kind: UmlRelationKind;
};

const NOMINAL_KINDS: Record<string, true> = {
  class: true,
  interface: true,
  trait: true,
  struct: true,
  union: true,
  enum: true,
  type: true,
};

export function isNominalKind(kind: FileDefinitionKind): boolean {
  return NOMINAL_KINDS[kind] === true;
}

const SCOPE_KINDS: Record<string, true> = { namespace: true, module: true };

/**
 * Reference attribution shared by both languages: which indexed declaration a syntax node sits in,
 * and which lexical scope chain its names resolve through.
 */
export class ReferenceContext {
  readonly path: string;
  readonly index: DefinitionResolutionIndex;
  readonly byKey = new Map<string, IndexedFileDefinition>();
  private readonly ownersByNode = new Map<number, string[]>();
  private readonly edges = new Map<string, UmlReferenceEdge>();

  constructor(path: string, index: DefinitionResolutionIndex, parsed: readonly ParsedFileDefinition[]) {
    this.path = path;
    this.index = index;
    for (const entry of parsed) {
      this.byKey.set(entry.definition.key, { ...entry.definition, hasBody: entry.hasBody });
      const existing = this.ownersByNode.get(entry.declaration.id);
      // Destructuring leaves share one declarator, and therefore one reference set.
      if (existing) existing.push(entry.definition.key);
      else this.ownersByNode.set(entry.declaration.id, [entry.definition.key]);
    }
  }

  ownersOf(node: Node): readonly string[] {
    let current: Node | undefined = node;
    while (current) {
      const owners = this.ownersByNode.get(current.id);
      if (owners) return owners;
      current = current.parent ?? undefined;
    }
    return [];
  }

  /** The nearest enclosing nominal declaration, for `this`/`Self` receivers. */
  enclosingNominal(node: Node): string | undefined {
    for (const owner of this.ownersOf(node)) {
      let key: string | undefined = owner;
      while (key !== undefined) {
        const definition = this.byKey.get(key);
        if (!definition) return undefined;
        if (isNominalKind(definition.kind)) return definition.key;
        key = definition.parentKey ?? undefined;
      }
    }
    return undefined;
  }

  /** Lexical namespace/module scopes enclosing `ownerKey`, innermost first, ending at file scope. */
  scopeChain(ownerKey: string | undefined): string[] {
    const chain: string[] = [];
    let key = ownerKey;
    while (key !== undefined) {
      const definition = this.byKey.get(key);
      if (!definition) break;
      if (SCOPE_KINDS[definition.kind] === true) chain.push(definition.key);
      key = definition.parentKey ?? undefined;
    }
    chain.push("");
    return chain;
  }

  resolveName(
    name: string,
    space: DefinitionBindingSpace,
    chain: readonly string[],
  ): DefinitionBindingTarget[] {
    for (const scope of chain) {
      const local = this.index.bindings(this.path, scope, name, space, false);
      if (local.length) return [...local];
      if (!scope) continue;
      const canonical = canonicalScopeKey(scope);
      const exported = this.index.bindings(this.path, canonical, name, space, true);
      if (exported.length) return [...exported];
    }
    return [];
  }

  /** Members a resolved receiver exposes under `name`, deduplicated by target key. */
  resolveMember(
    receiver: DefinitionBindingTarget,
    name: string,
    space: DefinitionBindingSpace,
  ): string[] {
    if (receiver.kind === "module") {
      return this.index.bindings(receiver.path, "", name, space, true)
        .flatMap((target) => (target.kind === "definition" ? [target.key] : []));
    }
    const definition = this.byKey.get(receiver.key) ?? this.index.definition(receiver.key);
    if (!definition) return [];
    if (SCOPE_KINDS[definition.kind] === true) {
      const scope = canonicalScopeKey(definition.key);
      const exported = this.index.bindings(definition.source.path, scope, name, space, true);
      if (exported.length) {
        return [...new Set(exported.flatMap((target) => (target.kind === "definition" ? [target.key] : [])))];
      }
      // An out-of-line body's `pub use` is a member of the box; it must resolve like one.
      const reexported = this.index.moduleExports(definition.key)
        .filter((entry) => entry.name === name)
        .map((entry) => entry.key);
      if (reexported.length) return [...new Set(reexported)];
    }
    // Also handles an out-of-line Rust module's body-file declarations.
    return this.index.members(definition.key)
      .filter((member) => member.name === name)
      .map((member) => member.key);
  }

  add(ownerKeys: readonly string[], targetKey: string, kind: UmlRelationKind): void {
    for (const ownerKey of ownerKeys) {
      const key = `${ownerKey}\u0000${targetKey}\u0000${kind}`;
      if (this.edges.has(key)) continue;
      this.edges.set(key, { ownerKey, targetKey, kind });
    }
  }

  addResolved(node: Node, targets: readonly DefinitionBindingTarget[], kind: UmlRelationKind): void {
    const owners = this.ownersOf(node);
    if (!owners.length) return;
    for (const target of targets) {
      if (target.kind !== "definition") continue;
      this.add(owners, target.key, kind);
    }
  }

  result(): UmlReferenceEdge[] {
    return [...this.edges.values()].sort((left, right) =>
      left.ownerKey.localeCompare(right.ownerKey)
      || left.targetKey.localeCompare(right.targetKey)
      || left.kind.localeCompare(right.kind)
    );
  }
}

// ---------------------------------------------------------------------------
// Script references
// ---------------------------------------------------------------------------

const SCRIPT_IMPORT_BINDING_PARENTS: Record<string, true> = {
  import_specifier: true,
  namespace_import: true,
  import_clause: true,
  import_alias: true,
  import_require_clause: true,
};

const SCRIPT_DECLARATION_NAME_PARENTS: Record<string, true> = {
  class_declaration: true,
  abstract_class_declaration: true,
  class: true,
  interface_declaration: true,
  enum_declaration: true,
  type_alias_declaration: true,
  function_declaration: true,
  generator_function_declaration: true,
  function_signature: true,
  variable_declarator: true,
  method_definition: true,
  method_signature: true,
  abstract_method_signature: true,
  public_field_definition: true,
  field_definition: true,
  property_signature: true,
  required_parameter: true,
  optional_parameter: true,
  enum_assignment: true,
  type_parameter: true,
  internal_module: true,
  module: true,
  labeled_statement: true,
};

/** Nodes whose whole subtree never contributes a reference. */
const SCRIPT_SKIPPED_SUBTREES: Record<string, true> = {
  import_statement: true,
  comment: true,
};

function scriptParameterNames(parameters: Node | null, out: Set<string>): void {
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    const pattern = parameter.childForFieldName("pattern") ?? parameter;
    collectPatternNames(pattern, out);
  }
}

function collectPatternNames(pattern: Node, out: Set<string>): void {
  switch (pattern.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.add(pattern.text);
      return;
    case "pair_pattern": {
      const value = pattern.childForFieldName("value");
      if (value) collectPatternNames(value, out);
      return;
    }
    case "assignment_pattern":
    case "object_assignment_pattern": {
      const left = pattern.childForFieldName("left");
      if (left) collectPatternNames(left, out);
      return;
    }
    case "rest_pattern":
    case "object_pattern":
    case "array_pattern":
      for (const child of namedChildren(pattern)) collectPatternNames(child, out);
      return;
  }
}

type ScopeFrame = { values: Set<string>; types: Set<string> };

function scriptScopeFrame(node: Node): ScopeFrame | undefined {
  const values = new Set<string>();
  const types = new Set<string>();
  const typeParameters = node.childForFieldName("type_parameters");
  for (const parameter of typeParameters ? namedChildren(typeParameters) : []) {
    const name = parameter.childForFieldName("name")?.text;
    if (name) types.add(name);
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_expression":
    case "generator_function":
    case "arrow_function":
    case "function_signature":
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature": {
      scriptParameterNames(node.childForFieldName("parameters"), values);
      const single = node.childForFieldName("parameter");
      if (single) collectPatternNames(single, values);
      break;
    }
    case "statement_block":
    case "class_body":
      for (const statement of namedChildren(node)) {
        if (
          statement.type === "lexical_declaration"
          || statement.type === "variable_declaration"
          || statement.type === "using_declaration"
        ) {
          for (const declarator of namedChildren(statement)) {
            const name = declarator.childForFieldName("name");
            if (name) collectPatternNames(name, values);
          }
        } else if (
          statement.type === "function_declaration"
          || statement.type === "generator_function_declaration"
        ) {
          const name = statement.childForFieldName("name")?.text;
          if (name) values.add(name);
        }
      }
      break;
    case "for_statement":
    case "for_in_statement": {
      const initializer = node.childForFieldName("initializer") ?? node.childForFieldName("left");
      if (initializer) {
        if (initializer.type === "identifier") values.add(initializer.text);
        else {
          for (const declarator of namedChildren(initializer)) {
            const name = declarator.childForFieldName("name") ?? declarator;
            collectPatternNames(name, values);
          }
        }
      }
      break;
    }
    case "catch_clause": {
      const parameter = node.childForFieldName("parameter");
      if (parameter) collectPatternNames(parameter, values);
      break;
    }
  }
  return values.size || types.size ? { values, types } : undefined;
}

function shadowed(frames: readonly ScopeFrame[], name: string, space: DefinitionBindingSpace): boolean {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (space === "value" ? frame.values.has(name) : frame.types.has(name)) return true;
  }
  return false;
}

function scriptIsUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (SCRIPT_IMPORT_BINDING_PARENTS[parent.type] === true) return false;
  if (parent.type === "export_specifier") return false;
  if (parent.type === "member_expression") return parent.childForFieldName("property")?.id !== node.id;
  if (parent.type === "nested_type_identifier") return parent.childForFieldName("name")?.id !== node.id;
  if (parent.type === "pair") return parent.childForFieldName("key")?.id !== node.id;
  if (SCRIPT_DECLARATION_NAME_PARENTS[parent.type] === true) {
    if (parent.childForFieldName("name")?.id === node.id) return false;
    if (parent.childForFieldName("pattern")?.id === node.id) return false;
  }
  return true;
}

function scriptHeritageKind(node: Node): UmlRelationKind {
  const clause = firstAncestor(node, (candidate) =>
    candidate.type === "extends_clause"
    || candidate.type === "implements_clause"
    || candidate.type === "extends_type_clause"
  );
  if (!clause) return "references";
  return clause.type === "extends_clause" ? "extends" : "implements";
}

/** A receiver expression's declared type or namespace, when it is statically knowable. */
function scriptReceiverTargets(
  context: ReferenceContext,
  node: Node,
  frames: readonly ScopeFrame[],
  chain: readonly string[],
): DefinitionBindingTarget[] {
  if (node.type === "this") {
    const nominal = context.enclosingNominal(node);
    return nominal ? [{ kind: "definition", key: nominal }] : [];
  }
  if (node.type === "identifier") {
    if (!shadowed(frames, node.text, "value")) {
      const resolved = context.resolveName(node.text, "value", chain);
      if (resolved.length) return resolved;
    }
    return scriptLocalReceiverType(context, node, chain);
  }
  if (node.type === "member_expression") {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (!object || !property) return [];
    const receivers = scriptReceiverTargets(context, object, frames, chain);
    const keys = receivers.flatMap((receiver) =>
      context.resolveMember(receiver, property.text, "value")
    );
    return [...new Set(keys)].map((key) => ({ kind: "definition", key } as const));
  }
  return [];
}

/** `const widget: Widget = …` / `const widget = new Widget()` name their receiver's type. */
function scriptLocalReceiverType(
  context: ReferenceContext,
  node: Node,
  chain: readonly string[],
): DefinitionBindingTarget[] {
  const scope = firstAncestor(node, (candidate) =>
    candidate.type === "statement_block" || candidate.type === "program"
  );
  const declarator = findLocalDeclarator(scope, node.text);
  if (!declarator) return [];
  const annotation = declarator.childForFieldName("type")?.namedChild(0);
  const typeName = annotation && annotation.type === "type_identifier" ? annotation.text : undefined;
  if (typeName !== undefined) return context.resolveName(typeName, "type", chain);
  const value = declarator.childForFieldName("value");
  if (value?.type !== "new_expression") return [];
  const constructed = value.childForFieldName("constructor");
  if (constructed?.type !== "identifier") return [];
  return context.resolveName(constructed.text, "type", chain);
}

function findLocalDeclarator(scope: Node | undefined, name: string): Node | undefined {
  if (!scope) return undefined;
  for (const statement of namedChildren(scope)) {
    if (
      statement.type !== "lexical_declaration"
      && statement.type !== "variable_declaration"
      && statement.type !== "using_declaration"
    ) continue;
    for (const declarator of namedChildren(statement)) {
      if (declarator.type !== "variable_declarator") continue;
      if (declarator.childForFieldName("name")?.text === name) return declarator;
    }
  }
  return undefined;
}

function visitScript(
  context: ReferenceContext,
  node: Node,
  frames: ScopeFrame[],
): void {
  if (SCRIPT_SKIPPED_SUBTREES[node.type] === true) return;
  const frame = scriptScopeFrame(node);
  if (frame) frames.push(frame);
  try {
    const owners = context.ownersOf(node);
    const chain = context.scopeChain(owners[0]);
    if (node.type === "nested_type_identifier") {
      const module = node.childForFieldName("module");
      const name = node.childForFieldName("name");
      if (module && name) {
        const receivers = scriptReceiverTargets(context, module, frames, chain);
        const keys = [
          ...new Set(receivers.flatMap((receiver) => context.resolveMember(receiver, name.text, "type"))),
        ];
        const kind = scriptHeritageKind(node);
        for (const key of keys) context.add(owners, key, kind);
      }
      return;
    }
    if (node.type === "member_expression") {
      const object = node.childForFieldName("object");
      const property = node.childForFieldName("property");
      if (object && property) {
        const receivers = scriptReceiverTargets(context, object, frames, chain);
        const keys = [
          ...new Set(receivers.flatMap((receiver) => context.resolveMember(receiver, property.text, "value"))),
        ];
        for (const key of keys) context.add(owners, key, "references");
        // Executable receiver subexpressions still carry their own references.
        if (object.type !== "identifier" && object.type !== "this" && object.type !== "member_expression") {
          visitScript(context, object, frames);
        }
      }
      return;
    }
    if (node.type === "type_identifier" || node.type === "identifier") {
      if (scriptIsUsage(node)) {
        const space: DefinitionBindingSpace = node.type === "type_identifier" ? "type" : "value";
        if (!shadowed(frames, node.text, space)) {
          context.addResolved(node, context.resolveName(node.text, space, chain), scriptHeritageKind(node));
        }
      }
      return;
    }
    for (const child of namedChildren(node)) visitScript(context, child, frames);
  } finally {
    if (frame) frames.pop();
  }
}

export function collectScriptReferences(
  context: ReferenceContext,
  root: Node,
): UmlReferenceEdge[] {
  visitScript(context, root, []);
  return context.result();
}

/** Every resolved outgoing reference one source file contributes, in deterministic order. */
export function collectFileReferences(
  path: string,
  root: Node,
  parsed: readonly ParsedFileDefinition[],
  index: DefinitionResolutionIndex,
): UmlReferenceEdge[] {
  const context = new ReferenceContext(path, index, parsed);
  return highlightLanguageForPath(path) === "rust"
    ? collectRustReferences(context, root)
    : collectScriptReferences(context, root);
}
