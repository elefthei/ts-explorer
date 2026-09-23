import type { Node } from "@vscode/tree-sitter-wasm";
import { children, namedChildren, renderedTypeName } from "./lang/ast.ts";
import { parseSourceForLanguage } from "./lang/parse.ts";
import { analysisLanguageForPath, highlightLanguageForPath } from "./lang/registry.ts";
import {
  RUST_ENTITY_KIND_BY_NODE,
  rustBodyMethods,
  rustImplTargetName,
  rustTopLevelItems,
} from "./lang/rust.ts";
import {
  annotationType,
  ENTITY_KIND_BY_NODE,
  forEachBindingName,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  topLevelDeclarations,
} from "./lang/typescript.ts";
import { isDeclarationPath } from "./source.ts";
import type { FileDefinition, FileDefinitionKind, GotoDefinitionKind } from "./types.ts";

export type ParsedEntityKind = Exclude<GotoDefinitionKind, "method">;

export type ParsedDefinitionSpan = {
  key: string;
  kind: GotoDefinitionKind;
  name: string;
  qualifiedName: string;
  entityKind: ParsedEntityKind;
  entityName: string;
  renderedEntityName: string;
  entityOccurrence: number;
  memberName?: string;
  sourceMemberOccurrence?: number;
  line: number;
  column: number;
  from: number;
  to: number;
};

function entityMethodNodes(declaration: Node, kind: ParsedEntityKind): Node[] {
  const body = declaration.childForFieldName("body");
  const methods: Node[] = [];
  if (kind === "class") {
    if (body?.type !== "class_body") return methods;
    for (const member of namedChildren(body)) {
      if (!METHOD_NODE_TYPES.has(member.type) || isAccessor(member)) continue;
      methods.push(member);
    }
    return methods;
  }
  if (kind === "interface") {
    if (body?.type !== "interface_body") return methods;
    for (const member of namedChildren(body)) {
      if (member.type === "method_signature") methods.push(member);
    }
    return methods;
  }
  if (kind === "type") {
    const value = declaration.childForFieldName("value");
    if (value?.type !== "object_type") return methods;
    for (const member of namedChildren(value)) {
      if (member.type === "method_signature") methods.push(member);
    }
  }
  return methods;
}

/** One declared entity and the members the definition index addresses under it, in source order. */
type DefinitionEntity = {
  kind: ParsedEntityKind;
  nameNode: Node;
  renderedName: string;
  members: { name: string; node: Node }[];
};

/**
 * Language-neutral span builder. `key` is the persisted `DefinitionIndex.key` and is asserted
 * verbatim by the definition-lookup suites, so its shape must not move.
 */
function definitionSpans(entities: readonly DefinitionEntity[]): ParsedDefinitionSpan[] {
  const entityOccurrences = new Map<string, number>();
  const memberOccurrences = new Map<string, number>();
  const spans: ParsedDefinitionSpan[] = [];
  for (const entity of entities) {
    const { kind, nameNode, renderedName } = entity;
    const name = nameNode.text;
    const entityCounterKey = `${kind}\0${name}`;
    const entityOccurrence = entityOccurrences.get(entityCounterKey) ?? 0;
    entityOccurrences.set(entityCounterKey, entityOccurrence + 1);
    spans.push({
      key: JSON.stringify([kind, name, entityOccurrence, null, null]),
      kind,
      name,
      qualifiedName: name,
      entityKind: kind,
      entityName: name,
      renderedEntityName: renderedName,
      entityOccurrence,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      from: nameNode.startIndex,
      to: nameNode.endIndex,
    });
    for (const member of entity.members) {
      const memberCounterKey = `${kind}\0${name}\0${member.name}`;
      const sourceMemberOccurrence = memberOccurrences.get(memberCounterKey) ?? 0;
      memberOccurrences.set(memberCounterKey, sourceMemberOccurrence + 1);
      spans.push({
        key: JSON.stringify([kind, name, entityOccurrence, member.name, sourceMemberOccurrence]),
        kind: "method",
        name: member.name,
        qualifiedName: `${name}.${member.name}`,
        entityKind: kind,
        entityName: name,
        renderedEntityName: renderedName,
        entityOccurrence,
        memberName: member.name,
        sourceMemberOccurrence,
        line: member.node.startPosition.row + 1,
        column: member.node.startPosition.column + 1,
        from: member.node.startIndex,
        to: member.node.endIndex,
      });
    }
  }
  return spans;
}

function typescriptDefinitionEntities(root: Node): DefinitionEntity[] {
  const entities: DefinitionEntity[] = [];
  for (const declaration of topLevelDeclarations(root)) {
    const kind = ENTITY_KIND_BY_NODE[declaration.type];
    if (!kind) continue;
    const nameNode = declaration.childForFieldName("name");
    if (!nameNode) continue;
    const members: DefinitionEntity["members"] = [];
    for (const method of entityMethodNodes(declaration, kind)) {
      const member = memberName(method);
      // The definition index addresses members by source name; `#private` members are unaddressable.
      if (!member || member.node.type === "private_property_identifier") continue;
      if (member.name === "constructor") continue;
      members.push(member);
    }
    entities.push({
      kind,
      nameNode,
      renderedName: renderedTypeName(nameNode.text, declaration),
      members,
    });
  }
  return entities;
}

/** Same-file `impl` blocks keyed by the bare name of the type they apply to, in source order. */
function rustImplBlocks(items: readonly Node[]): Map<string, Node[]> {
  const blocks = new Map<string, Node[]>();
  for (const item of items) {
    if (item.type !== "impl_item") continue;
    const name = rustImplTargetName(item);
    if (name === undefined) continue;
    const existing = blocks.get(name);
    if (existing) existing.push(item);
    else blocks.set(name, [item]);
  }
  return blocks;
}

/** Methods a Rust entity contributes: trait requirements, or every same-file `impl` block's. */
function rustEntityMethodNodes(
  declaration: Node,
  implBlocks: ReadonlyMap<string, Node[]>,
  bareName: string,
): Node[] {
  if (declaration.type === "trait_item") {
    return rustBodyMethods(declaration.childForFieldName("body"));
  }
  const methods: Node[] = [];
  if (declaration.type === "type_item") return methods;
  for (const block of implBlocks.get(bareName) ?? []) {
    methods.push(...rustBodyMethods(block.childForFieldName("body")));
  }
  return methods;
}

function rustDefinitionEntities(root: Node): DefinitionEntity[] {
  const items = rustTopLevelItems(root);
  const implBlocks = rustImplBlocks(items);
  const entities: DefinitionEntity[] = [];
  for (const declaration of items) {
    const kind = RUST_ENTITY_KIND_BY_NODE[declaration.type];
    if (!kind) continue;
    const nameNode = declaration.childForFieldName("name");
    if (!nameNode) continue;
    const members: DefinitionEntity["members"] = [];
    for (const method of rustEntityMethodNodes(declaration, implBlocks, nameNode.text)) {
      const memberNode = method.childForFieldName("name");
      if (!memberNode) continue;
      members.push({ name: memberNode.text, node: memberNode });
    }
    entities.push({
      kind,
      nameNode,
      renderedName: renderedTypeName(nameNode.text, declaration),
      members,
    });
  }
  return entities;
}

export function parseDefinitionSpans(path: string, content: string): ParsedDefinitionSpan[] {
  if (isDeclarationPath(path)) return [];
  const language = analysisLanguageForPath(path);
  if (language === undefined) return [];
  const parsed = parseSourceForLanguage(language, path, content);
  if (!parsed) return [];
  try {
    return definitionSpans(
      language === "rust"
        ? rustDefinitionEntities(parsed.root)
        : typescriptDefinitionEntities(parsed.root),
    );
  } finally {
    parsed.dispose();
  }
}

// ---------------------------------------------------------------------------
// File outline
//
// `parseDefinitionSpans` above is deliberately UML-only: it addresses the entities a diagram can
// render and maps raw spans to formatted editor spans. The collectors below answer a different
// question — every named declaration a reader of the file would expect in an outline, each with
// an unambiguous identity the UML pane can root a dependency graph on.
// ---------------------------------------------------------------------------

/** One outline row together with the syntax nodes dependency attribution needs. */
export type ParsedFileDefinition = {
  definition: FileDefinition;
  /** The declaration node that owns this name; references inside it belong to this definition. */
  declaration: Node;
  nameNode: Node;
  hasBody: boolean;
  /**
   * Bare name of the type a Rust `impl` block applies to. Ownership is resolved once the project
   * declaration catalogue exists, because the type may be declared in another file.
   */
  implOwnerName?: string;
};

type OutlineScope = {
  prefix: string;
  parentKey: string | null;
  topLevel: boolean;
  implOwnerName?: string;
};

type OutlineCollector = {
  readonly path: string;
  readonly nodes: ParsedFileDefinition[];
  readonly occurrences: Map<string, number>;
};

const FILE_SCOPE: OutlineScope = { prefix: "", parentKey: null, topLevel: true };

function qualify(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

/** The scope a declaration's own members live in: never a root, always owned by that declaration. */
function childScope(entry: ParsedFileDefinition): OutlineScope {
  return {
    prefix: entry.definition.qualifiedName,
    parentKey: entry.definition.key,
    topLevel: false,
  };
}

function hasDeclarationBody(node: Node): boolean {
  return node.childForFieldName("body") !== null;
}

/** Records one outline row. Nameless declarations are not addressable. */
function emitDefinition(
  out: OutlineCollector,
  scope: OutlineScope,
  nameNode: Node,
  declaration: Node,
  name: string,
  kind: FileDefinitionKind,
  type: string | null,
  hasBody: boolean,
): ParsedFileDefinition | undefined {
  if (!name) return undefined;
  const qualifiedName = qualify(scope.prefix, name);
  const counter = `${kind}\u0000${qualifiedName}`;
  const occurrence = out.occurrences.get(counter) ?? 0;
  out.occurrences.set(counter, occurrence + 1);
  const entry: ParsedFileDefinition = {
    definition: {
      key: JSON.stringify([out.path, kind, qualifiedName, occurrence]),
      parentKey: scope.parentKey,
      isTopLevel: scope.topLevel,
      name,
      qualifiedName,
      kind,
      type,
      source: {
        path: out.path,
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column + 1,
      },
    },
    declaration,
    nameNode,
    hasBody,
    ...(scope.implOwnerName === undefined ? {} : { implOwnerName: scope.implOwnerName }),
  };
  out.nodes.push(entry);
  return entry;
}

/** Raw `<...>` text, preserving bounds, Rust lifetimes and const generics; `""` when absent. */
function typeParametersText(node: Node): string {
  return node.childForFieldName("type_parameters")?.text ?? "";
}

/** A nominal declaration's own name as written, e.g. `Box<T extends Base>`. */
function nominalTypeText(name: string, declaration: Node): string {
  return `${name}${typeParametersText(declaration)}`;
}

/**
 * `<T>(a: A): R`. The declared return field is copied verbatim rather than unwrapped, so a type
 * predicate (`: x is string`) survives; a missing annotation is simply omitted.
 */
function scriptCallableType(node: Node): string | null {
  const parameters = node.childForFieldName("parameters")
    ?? node.childForFieldName("parameter");
  if (!parameters) return null;
  const rendered = parameters.type === "formal_parameters"
    ? parameters.text
    : `(${parameters.text})`;
  return `${typeParametersText(node)}${rendered}${node.childForFieldName("return_type")?.text ?? ""}`;
}

function scriptAnnotation(node: Node): string | null {
  return annotationType(node, "type")?.text ?? null;
}

const SCRIPT_DEFAULT_EXPORT_KINDS: Record<string, FileDefinitionKind> = {
  class: "class",
  function_expression: "function",
  generator_function: "function",
  arrow_function: "function",
};

/** Declared member name, falling back to the literal computed-name text UML intentionally drops. */
function outlineMemberName(member: Node): { name: string; node: Node } | undefined {
  const named = memberName(member);
  if (named) return named.name ? named : undefined;
  const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
  return nameNode?.type === "computed_property_name"
    ? { name: nameNode.text, node: nameNode }
    : undefined;
}

/** `get`/`set` win over everything; only a plain class-body `constructor` is a constructor. */
function scriptMethodKind(member: Node, name: string): FileDefinitionKind {
  const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
  for (const token of children(member)) {
    if (nameNode && token.startIndex >= nameNode.startIndex) break;
    if (token.type === "get") return "getter";
    if (token.type === "set") return "setter";
  }
  if (
    name !== "constructor"
    || member.type !== "method_definition"
    || member.parent?.type !== "class_body"
    || children(member).some((token) => token.type === "static")
  ) return "method";
  return "constructor";
}

/**
 * Constructor parameters carrying an accessibility modifier or `readonly` declare class fields, so
 * they are emitted in the class scope rather than under the constructor.
 */
function collectConstructorProperties(member: Node, owner: OutlineScope, out: OutlineCollector): void {
  const parameters = member.childForFieldName("parameters");
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    const declaresField = children(parameter).some((token) =>
      token.type === "accessibility_modifier" || token.type === "readonly"
    );
    if (!declaresField) continue;
    const nameNode = parameter.childForFieldName("pattern") ?? parameter.childForFieldName("name");
    if (!nameNode) continue;
    if (nameNode.type !== "identifier" && nameNode.type !== "private_property_identifier") continue;
    emitDefinition(
      out,
      owner,
      nameNode,
      parameter,
      nameNode.text,
      "property",
      scriptAnnotation(parameter),
      false,
    );
  }
}

function collectScriptMembers(body: Node, owner: OutlineScope, out: OutlineCollector): void {
  for (const member of namedChildren(body)) {
    switch (member.type) {
      case "public_field_definition":
      case "field_definition":
      case "property_signature": {
        const named = outlineMemberName(member);
        if (named) {
          emitDefinition(
            out,
            owner,
            named.node,
            member,
            named.name,
            "property",
            scriptAnnotation(member),
            false,
          );
        }
        break;
      }
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature": {
        const named = outlineMemberName(member);
        if (!named) break;
        const kind = scriptMethodKind(member, named.name);
        emitDefinition(
          out,
          owner,
          named.node,
          member,
          named.name,
          kind,
          scriptCallableType(member),
          hasDeclarationBody(member),
        );
        if (kind === "constructor") collectConstructorProperties(member, owner, out);
        break;
      }
    }
  }
}

/**
 * Binding leaves only: object keys, array holes and default expressions never declare a name, and
 * an aggregate annotation is not the type of any individual binding.
 */
function collectBindingPattern(
  pattern: Node,
  declaration: Node,
  scope: OutlineScope,
  kind: FileDefinitionKind,
  out: OutlineCollector,
): void {
  forEachBindingName(pattern, (nameNode) => {
    emitDefinition(out, scope, nameNode, declaration, nameNode.text, kind, null, false);
  });
}

/** `namespace A.B` declares `A` and `A.B`, each at its own token; returns the innermost scope. */
function collectModuleName(
  nameNode: Node,
  declaration: Node,
  scope: OutlineScope,
  kind: FileDefinitionKind,
  out: OutlineCollector,
): OutlineScope | undefined {
  if (nameNode.type === "nested_identifier") {
    const object = nameNode.childForFieldName("object");
    const property = nameNode.childForFieldName("property");
    if (!object || !property) return undefined;
    const parent = collectModuleName(object, declaration, scope, kind, out);
    if (parent === undefined) return undefined;
    const entry = emitDefinition(out, parent, property, declaration, property.text, kind, null, true);
    return entry ? childScope(entry) : undefined;
  }
  const name = nameNode.type === "string"
    ? namedChildren(nameNode).find((child) => child.type === "string_fragment")?.text ?? ""
    : nameNode.text;
  const entry = emitDefinition(
    out,
    scope,
    nameNode,
    declaration,
    name,
    kind,
    null,
    hasDeclarationBody(declaration),
  );
  return entry ? childScope(entry) : undefined;
}

function collectScriptDeclaration(node: Node, scope: OutlineScope, out: OutlineCollector): void {
  switch (node.type) {
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const name = nameNode.text;
      const kind = node.type === "interface_declaration" ? "interface" : "class";
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        name,
        kind,
        nominalTypeText(name, node),
        hasDeclarationBody(node),
      );
      if (!entry) return;
      const body = node.childForFieldName("body");
      if (body) collectScriptMembers(body, childScope(entry), out);
      return;
    }
    case "type_alias_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const value = node.childForFieldName("value");
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        nameNode.text,
        "type",
        value?.text ?? null,
        false,
      );
      if (!entry) return;
      if (value?.type === "object_type") collectScriptMembers(value, childScope(entry), out);
      return;
    }
    case "enum_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const name = nameNode.text;
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        name,
        "enum",
        nominalTypeText(name, node),
        hasDeclarationBody(node),
      );
      if (!entry) return;
      const owner = childScope(entry);
      const body = node.childForFieldName("body");
      for (const member of body ? namedChildren(body) : []) {
        // A member is either `Name = value` or the bare name token itself; discriminants are ignored.
        const named = member.type === "enum_assignment"
          ? outlineMemberName(member)
          : member.type === "property_identifier"
            ? { name: member.text, node: member }
            : undefined;
        if (named) {
          emitDefinition(out, owner, named.node, member, named.name, "enum-member", name, false);
        }
      }
      return;
    }
    case "internal_module":
    case "module": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const kind = node.type === "internal_module" ? "namespace" : "module";
      const owner = collectModuleName(nameNode, node, scope, kind, out);
      if (owner === undefined) return;
      const body = node.childForFieldName("body");
      if (body) visitScriptScope(body, owner, out);
      return;
    }
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      emitDefinition(
        out,
        scope,
        nameNode,
        node,
        nameNode.text,
        "function",
        scriptCallableType(node),
        hasDeclarationBody(node),
      );
      return;
    }
    case "lexical_declaration":
    case "variable_declaration":
    case "using_declaration": {
      const kind: FileDefinitionKind =
        node.type === "lexical_declaration" && node.childForFieldName("kind")?.text === "const"
          ? "constant"
          : "variable";
      for (const declarator of namedChildren(node)) {
        if (declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.childForFieldName("name");
        if (!nameNode) continue;
        if (nameNode.type === "identifier") {
          emitDefinition(
            out,
            scope,
            nameNode,
            declarator,
            nameNode.text,
            kind,
            scriptAnnotation(declarator),
            false,
          );
          continue;
        }
        collectBindingPattern(nameNode, declarator, scope, kind, out);
      }
      return;
    }
  }
}

/** `export default class {}` binds the module name `default` at the `default` keyword itself. */
function collectDefaultExport(statement: Node, scope: OutlineScope, out: OutlineCollector): void {
  const value = statement.childForFieldName("value");
  if (!value) return;
  const kind = SCRIPT_DEFAULT_EXPORT_KINDS[value.type];
  if (!kind) return;
  const keyword = children(statement).find((token) => token.type === "default");
  if (!keyword) return;
  const type = kind === "class"
    ? nominalTypeText("default", value)
    : scriptCallableType(value);
  const entry = emitDefinition(out, scope, keyword, value, "default", kind, type, true);
  if (!entry) return;
  const body = kind === "class" ? value.childForFieldName("body") : undefined;
  if (body) collectScriptMembers(body, childScope(entry), out);
}

function visitScriptStatement(statement: Node, scope: OutlineScope, out: OutlineCollector): void {
  switch (statement.type) {
    case "export_statement": {
      const declaration = statement.childForFieldName("declaration");
      if (declaration) visitScriptStatement(declaration, scope, out);
      else collectDefaultExport(statement, scope, out);
      return;
    }
    case "ambient_declaration":
      // `declare global { … }` carries an unnamed statement block that adds no scope of its own.
      for (const child of namedChildren(statement)) {
        if (child.type === "statement_block") visitScriptScope(child, scope, out);
        else visitScriptStatement(child, scope, out);
      }
      return;
    case "expression_statement": {
      const inner = statement.namedChild(0);
      if (inner && (inner.type === "internal_module" || inner.type === "module")) {
        visitScriptStatement(inner, scope, out);
      }
      return;
    }
    default:
      collectScriptDeclaration(statement, scope, out);
  }
}

function visitScriptScope(scope: Node, outlineScope: OutlineScope, out: OutlineCollector): void {
  for (const statement of namedChildren(scope)) visitScriptStatement(statement, outlineScope, out);
}

/** `(a: A) -> R`; Rust's `return_type` field holds the bare type, so the arrow is re-added. */
function rustCallableType(node: Node): string | null {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return null;
  const returnType = node.childForFieldName("return_type");
  const rendered = returnType ? ` -> ${returnType.text}` : "";
  return `${typeParametersText(node)}${parameters.text}${rendered}`;
}

/** Named struct/union/variant fields, plus tuple fields addressed by their ordinal. */
function collectRustFields(body: Node, owner: OutlineScope, out: OutlineCollector): void {
  if (body.type === "field_declaration_list") {
    for (const field of namedChildren(body)) {
      if (field.type !== "field_declaration") continue;
      const nameNode = field.childForFieldName("name");
      if (!nameNode) continue;
      const type = field.childForFieldName("type")?.text ?? null;
      emitDefinition(out, owner, nameNode, field, nameNode.text, "property", type, false);
    }
    return;
  }
  if (body.type !== "ordered_field_declaration_list") return;
  // Tuple fields have no name token, so the ordinal names the row and the type node locates it.
  let ordinal = 0;
  for (const field of namedChildren(body)) {
    if (field.type === "attribute_item" || field.type === "visibility_modifier") continue;
    emitDefinition(out, owner, field, field, String(ordinal), "property", field.text, false);
    ordinal += 1;
  }
}

function collectRustItem(
  node: Node,
  scope: OutlineScope,
  memberScope: boolean,
  out: OutlineCollector,
): void {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "";
  switch (node.type) {
    case "struct_item":
    case "union_item": {
      if (!nameNode) return;
      const kind = node.type === "struct_item" ? "struct" : "union";
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        name,
        kind,
        nominalTypeText(name, node),
        hasDeclarationBody(node),
      );
      if (!entry) return;
      const body = node.childForFieldName("body");
      if (body) collectRustFields(body, childScope(entry), out);
      return;
    }
    case "trait_item": {
      if (!nameNode) return;
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        name,
        "trait",
        nominalTypeText(name, node),
        hasDeclarationBody(node),
      );
      if (!entry) return;
      const body = node.childForFieldName("body");
      if (body) visitRustItems(body, childScope(entry), true, out);
      return;
    }
    case "enum_item": {
      if (!nameNode) return;
      const entry = emitDefinition(
        out,
        scope,
        nameNode,
        node,
        name,
        "enum",
        nominalTypeText(name, node),
        hasDeclarationBody(node),
      );
      if (!entry) return;
      const owner = childScope(entry);
      const body = node.childForFieldName("body");
      for (const variant of body ? namedChildren(body) : []) {
        if (variant.type !== "enum_variant") continue;
        const variantName = variant.childForFieldName("name");
        if (!variantName) continue;
        const variantEntry = emitDefinition(
          out,
          owner,
          variantName,
          variant,
          variantName.text,
          "enum-member",
          name,
          false,
        );
        if (!variantEntry) continue;
        const variantBody = variant.childForFieldName("body");
        if (variantBody) collectRustFields(variantBody, childScope(variantEntry), out);
      }
      return;
    }
    case "type_item":
    case "associated_type":
      if (nameNode) {
        emitDefinition(
          out,
          scope,
          nameNode,
          node,
          name,
          "type",
          node.childForFieldName("type")?.text ?? null,
          false,
        );
      }
      return;
    case "mod_item": {
      if (!nameNode) return;
      const body = node.childForFieldName("body");
      const entry = emitDefinition(out, scope, nameNode, node, name, "module", null, body !== null);
      if (!entry) return;
      // An out-of-line `mod child;` has no body here; its file is indexed on its own.
      if (body) visitRustItems(body, childScope(entry), false, out);
      return;
    }
    case "macro_definition":
      if (nameNode) emitDefinition(out, scope, nameNode, node, name, "macro", null, true);
      return;
    case "function_item":
    case "function_signature_item":
      if (nameNode) {
        emitDefinition(
          out,
          scope,
          nameNode,
          node,
          name,
          memberScope ? "method" : "function",
          rustCallableType(node),
          hasDeclarationBody(node),
        );
      }
      return;
    case "const_item":
    case "static_item":
      if (nameNode && name !== "_") {
        const kind = node.type === "const_item" ? "constant" : "variable";
        emitDefinition(
          out,
          scope,
          nameNode,
          node,
          name,
          kind,
          node.childForFieldName("type")?.text ?? null,
          false,
        );
      }
      return;
    case "impl_item": {
      // Members are qualified by the implemented type, whether or not it is declared in this file.
      // Their owner key is resolved by the project catalogue, so it stays null here.
      const target = rustImplTargetName(node);
      if (target === undefined) return;
      const body = node.childForFieldName("body");
      if (!body) return;
      visitRustItems(
        body,
        {
          prefix: qualify(scope.prefix, target),
          parentKey: null,
          topLevel: false,
          implOwnerName: target,
        },
        true,
        out,
      );
      return;
    }
    case "foreign_mod_item": {
      // An `extern` block introduces no namespace of its own.
      const body = node.childForFieldName("body");
      if (body) visitRustItems(body, scope, memberScope, out);
      return;
    }
  }
}

function visitRustItems(
  node: Node,
  scope: OutlineScope,
  memberScope: boolean,
  out: OutlineCollector,
): void {
  for (const item of namedChildren(node)) collectRustItem(item, scope, memberScope, out);
}

/**
 * Every named declaration `path` contributes to the Files outline, in source order, with the
 * declaration nodes dependency extraction attributes references to. The caller owns `root`'s tree
 * and must dispose it; this collector never does.
 */
export function collectFileDefinitionNodes(path: string, root: Node): ParsedFileDefinition[] {
  const language = highlightLanguageForPath(path);
  if (language === undefined) return [];
  const out: OutlineCollector = { path, nodes: [], occurrences: new Map() };
  if (language === "rust") visitRustItems(root, FILE_SCOPE, false, out);
  else visitScriptScope(root, FILE_SCOPE, out);
  return out.nodes;
}

/** Parser-owning wrapper over {@link collectFileDefinitionNodes}. */
export function parseFileDefinitions(path: string, content: string): FileDefinition[] {
  const language = highlightLanguageForPath(path);
  if (language === undefined) return [];
  const parsed = parseSourceForLanguage(language, path, content);
  if (!parsed) return [];
  try {
    return collectFileDefinitionNodes(path, parsed.root).map((entry) => entry.definition);
  } finally {
    parsed.dispose();
  }
}
