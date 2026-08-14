import type { Node } from "@vscode/tree-sitter-wasm";
import { children, namedChildren, renderedTypeName } from "../lang/ast.ts";
import { analysisLanguageForPath } from "../lang/registry.ts";
import { parseRustSource } from "../lang/rust.ts";
import {
  annotationType,
  declarationName,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  parseTypeScriptSource,
  topLevelDeclarations,
} from "../lang/typescript.ts";
import { createDeclarationBuilder, type DeclarationBuilder } from "./declaration.ts";
import { bareUmlName, posix, syntheticTypeId, umlFileKey } from "./keys.ts";
import {
  type FileDeclaration,
  type HeritageClause,
  type MethodDetails,
  orderUmlModifiers,
  type PendingTypeReference,
  type PropertyDetails,
  type SourceUnit,
  type UmlEntityModel,
  type UmlModifier,
  type UmlReference,
} from "./model.ts";
import type { SymbolTable } from "./resolve.ts";
import { parseRustFileDeclaration } from "./rust-parse.ts";

const ACCESSIBILITY_MODIFIERS: Record<string, UmlModifier> = {
  public: "public",
  private: "private",
  protected: "protected",
};

const TOKEN_MODIFIERS: Record<string, UmlModifier> = {
  readonly: "readonly",
  override: "override",
  abstract: "abstract",
  declare: "ambient",
  static: "static",
  accessor: "accessor",
  async: "async",
};

function memberModifiers(node: Node): UmlModifier[] {
  const collected: UmlModifier[] = [];
  if (node.type === "abstract_method_signature") collected.push("abstract");
  for (const child of children(node)) {
    const modifier = child.type === "accessibility_modifier"
      ? ACCESSIBILITY_MODIFIERS[child.text]
      : TOKEN_MODIFIERS[child.type];
    if (modifier) collected.push(modifier);
  }
  return orderUmlModifiers(collected);
}

function hasToken(node: Node, token: string): boolean {
  for (const child of children(node)) {
    if (child.type === token) return true;
  }
  return false;
}

const OPTIONAL_UNDEFINED_SUFFIX = " | undefined";

export type ParsedUmlProject = {
  declarations: FileDeclaration[];
  units: SourceUnit[];
  entities: Map<string, UmlReference>;
  pending: PendingTypeReference[];
  dispose(): void;
};

export type ParsedSourceUnits = {
  units: SourceUnit[];
  byKey: Map<string, SourceUnit>;
  dispose(): void;
};

/** Parses every analysable source file in `files` that has content; other paths are skipped. */
export function parseSourceUnits(
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
): ParsedSourceUnits {
  const units: SourceUnit[] = [];
  const byKey = new Map<string, SourceUnit>();
  const disposers: (() => void)[] = [];
  const dispose = (): void => {
    for (const release of disposers.splice(0)) release();
    units.length = 0;
    byKey.clear();
  };
  try {
    for (const file of files) {
      const source = contents.get(umlFileKey(file));
      if (source === undefined) continue;
      const parsed = analysisLanguageForPath(file) === "rust"
        ? parseRustSource(source)
        : parseTypeScriptSource(file, source);
      if (!parsed) continue;
      disposers.push(parsed.dispose);
      const unit: SourceUnit = { path: posix(file), root: parsed.root };
      units.push(unit);
      byKey.set(umlFileKey(file), unit);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { units, byKey, dispose };
}

function parseProperty(node: Node, name: string, builder: DeclarationBuilder): PropertyDetails {
  const annotation = annotationType(node, "type");
  const optional = hasToken(node, "?");
  let type = annotation?.text;
  if (optional && type?.endsWith(OPTIONAL_UNDEFINED_SUFFIX)) {
    type = type.slice(0, type.length - OPTIONAL_UNDEFINED_SUFFIX.length);
  }
  const details: PropertyDetails = {
    modifiers: memberModifiers(node),
    name,
    ...(type === undefined ? {} : { type }),
    typeIds: [],
    optional,
  };
  if (annotation) {
    builder.memberTypes(annotation, (typeIds) => {
      details.typeIds = typeIds;
    });
  }
  return details;
}

function parseMethod(node: Node, name: string, builder: DeclarationBuilder): MethodDetails {
  const annotation = annotationType(node, "return_type");
  const details: MethodDetails = {
    modifiers: memberModifiers(node),
    name,
    ...(annotation === undefined ? {} : { returnType: annotation.text, returnTypeIds: [] }),
  };
  if (annotation) {
    builder.memberTypes(annotation, (typeIds) => {
      details.returnTypeIds = typeIds;
    });
  }
  return details;
}

function classMembers(
  body: Node,
  builder: DeclarationBuilder,
): { properties: PropertyDetails[]; methods: MethodDetails[] } {
  const properties: PropertyDetails[] = [];
  const candidates: { node: Node; name: string }[] = [];
  let constructorNode: Node | undefined;
  for (const member of namedChildren(body)) {
    if (member.type === "public_field_definition") {
      const name = memberName(member)?.name;
      if (name !== undefined) properties.push(parseProperty(member, name, builder));
      continue;
    }
    if (!METHOD_NODE_TYPES.has(member.type) || isAccessor(member)) continue;
    const name = memberName(member)?.name;
    if (name === undefined) continue;
    if (name === "constructor") {
      constructorNode ??= member;
      continue;
    }
    candidates.push({ node: member, name });
  }
  // Overload signatures collapse into the implementation that follows them.
  const implemented = new Set(
    candidates.filter(({ node }) => node.type === "method_definition").map(({ name }) => name),
  );
  const methods = candidates
    .filter(({ node, name }) => node.type === "method_definition" || !implemented.has(name))
    .map(({ node, name }) => parseMethod(node, name, builder));

  if (constructorNode) {
    const parameters = constructorNode.childForFieldName("parameters");
    for (const parameter of parameters ? namedChildren(parameters) : []) {
      if (parameter.type !== "required_parameter" && parameter.type !== "optional_parameter") continue;
      if (!children(parameter).some((child) => child.type === "accessibility_modifier")) continue;
      const name = parameter.childForFieldName("pattern")?.text;
      if (name === undefined) continue;
      properties.push(parseProperty(parameter, name, builder));
    }
  }
  return { properties, methods };
}

function signatureMembers(
  body: Node,
  builder: DeclarationBuilder,
): { properties: PropertyDetails[]; methods: MethodDetails[] } {
  const properties: PropertyDetails[] = [];
  const methods: MethodDetails[] = [];
  for (const member of namedChildren(body)) {
    const name = memberName(member)?.name;
    if (name === undefined) continue;
    if (member.type === "property_signature") properties.push(parseProperty(member, name, builder));
    else if (member.type === "method_signature") methods.push(parseMethod(member, name, builder));
  }
  return { properties, methods };
}

function heritageBaseName(node: Node): Node {
  return node.type === "generic_type" ? node.childForFieldName("name") ?? node : node;
}

function collectHeritage(declaration: Node, entity: UmlEntityModel, builder: DeclarationBuilder): void {
  const push = (base: Node, relation: HeritageClause["relation"]): void => {
    builder.heritage(entity, heritageBaseName(base), relation);
  };
  if (declaration.type === "interface_declaration") {
    for (const child of namedChildren(declaration)) {
      if (child.type !== "extends_type_clause") continue;
      for (const base of namedChildren(child)) push(base, "implements");
    }
    return;
  }
  for (const child of namedChildren(declaration)) {
    if (child.type !== "class_heritage") continue;
    for (const group of namedChildren(child)) {
      if (group.type === "extends_clause") {
        const value = group.childForFieldName("value");
        if (value) push(value, "extends");
      } else if (group.type === "implements_clause") {
        for (const base of namedChildren(group)) push(base, "implements");
      }
    }
  }
}

function parseFileDeclaration(
  unit: SourceUnit,
  entities: Map<string, UmlReference>,
  pending: PendingTypeReference[],
): FileDeclaration {
  if (analysisLanguageForPath(unit.path) === "rust") {
    return parseRustFileDeclaration(unit, entities, pending);
  }
  const builder = createDeclarationBuilder(unit.path, entities, pending);
  for (const node of topLevelDeclarations(unit.root)) {
    const isClass = node.type === "class_declaration"
      || node.type === "abstract_class_declaration"
      || node.type === "class";
    const bare = declarationName(node) ?? (node.type === "class" ? "default" : undefined);
    if (bare === undefined) continue;
    const name = renderedTypeName(bare, node);

    if (isClass) {
      const entity = builder.entity(name, "classes");
      const body = node.childForFieldName("body");
      if (body?.type === "class_body") {
        const members = classMembers(body, builder);
        entity.properties = members.properties;
        entity.methods = members.methods;
      }
      collectHeritage(node, entity, builder);
    } else if (node.type === "interface_declaration") {
      const entity = builder.entity(name, "interfaces");
      const body = node.childForFieldName("body");
      if (body?.type === "interface_body") {
        const members = signatureMembers(body, builder);
        entity.properties = members.properties;
        entity.methods = members.methods;
      }
      collectHeritage(node, entity, builder);
    } else if (node.type === "enum_declaration") {
      const entity = builder.entity(name, "enums");
      const body = node.childForFieldName("body");
      for (const item of body ? namedChildren(body) : []) {
        if (item.type === "enum_assignment") {
          const itemName = item.childForFieldName("name")?.text;
          if (itemName !== undefined) entity.items.push(itemName);
        } else if (item.type === "property_identifier") {
          entity.items.push(item.text);
        }
      }
    } else if (node.type === "type_alias_declaration") {
      // Only an object-shaped alias is an entity, and the guard must precede registration.
      const value = node.childForFieldName("value");
      if (value?.type !== "object_type") continue;
      const entity = builder.entity(name, "types");
      const members = signatureMembers(value, builder);
      entity.properties = members.properties;
      entity.methods = members.methods;
    }
  }
  return builder.finish();
}

export function parseUmlProject(
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
): ParsedUmlProject {
  const parsed = parseSourceUnits(files, contents);
  const declarations: FileDeclaration[] = [];
  const entities = new Map<string, UmlReference>();
  const pending: PendingTypeReference[] = [];
  try {
    for (const unit of parsed.units) {
      declarations.push(parseFileDeclaration(unit, entities, pending));
    }
  } catch (error) {
    parsed.dispose();
    throw error;
  }
  return { declarations, units: parsed.units, entities, pending, dispose: parsed.dispose };
}

/**
 * Cross-references carry the *bare* entity id (`"<file>".Name`), matching the symbol identity a
 * type checker would report. `src/uml/graph.ts` registers that id as an alias of the rendered
 * entity node, so a generic target still resolves to a single node.
 */
function crossReferenceId(target: UmlReference): string {
  const bare = bareUmlName(target.name);
  if (bare === target.name || !target.id.endsWith(target.name)) return target.id;
  return target.id.slice(0, target.id.length - target.name.length) + bare;
}

export function resolveUmlTypeReferences(project: ParsedUmlProject, symbols: SymbolTable): void {
  for (const entry of project.pending) {
    if (entry.kind === "member") {
      const seen = new Set<string>();
      const typeIds: string[] = [];
      for (const reference of symbols.resolveTypeReferences(entry.file, entry.annotation)) {
        const id = crossReferenceId(reference);
        if (seen.has(id)) continue;
        seen.add(id);
        typeIds.push(id);
      }
      entry.assign(typeIds);
      continue;
    }
    const written = entry.base.text;
    const target = symbols.resolve(entry.file, written);
    if (target) {
      entry.clause.clause = target.name;
      entry.clause.clauseTypeId = crossReferenceId(target);
      continue;
    }
    // An unresolved base still needs a stable id: `src/uml/graph.ts` turns it into a boundary node,
    // and an empty id would both collide across bases and fail row validation.
    const bare = bareUmlName(written);
    entry.clause.clause = bare;
    entry.clause.clauseTypeId = syntheticTypeId(entry.file, bare);
  }
  project.pending.length = 0;
}
