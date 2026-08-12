import type { Node } from "@vscode/tree-sitter-wasm";
import {
  annotationType,
  children,
  declarationName,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  namedChildren,
  parseTypeScriptSource,
  renderedTypeName,
  topLevelDeclarations,
} from "../lang/typescript.ts";
import { bareUmlName, posix, syntheticTypeId, umlEntityKey, umlFileKey } from "./keys.ts";
import {
  type FileDeclaration,
  type HeritageClause,
  type MethodDetails,
  type PropertyDetails,
  type SourceUnit,
  UML_MODIFIER_ABSTRACT,
  UML_MODIFIER_ACCESSOR,
  UML_MODIFIER_AMBIENT,
  UML_MODIFIER_ASYNC,
  UML_MODIFIER_OVERRIDE,
  UML_MODIFIER_PRIVATE,
  UML_MODIFIER_PROTECTED,
  UML_MODIFIER_PUBLIC,
  UML_MODIFIER_READONLY,
  UML_MODIFIER_STATIC,
  type UmlEntityModel,
  type UmlReference,
} from "./model.ts";
import type { SymbolTable } from "./resolve.ts";

const ACCESSIBILITY_FLAGS: Record<string, number> = {
  public: UML_MODIFIER_PUBLIC,
  private: UML_MODIFIER_PRIVATE,
  protected: UML_MODIFIER_PROTECTED,
};

const TOKEN_FLAGS: Record<string, number> = {
  readonly: UML_MODIFIER_READONLY,
  override: UML_MODIFIER_OVERRIDE,
  abstract: UML_MODIFIER_ABSTRACT,
  declare: UML_MODIFIER_AMBIENT,
  static: UML_MODIFIER_STATIC,
  accessor: UML_MODIFIER_ACCESSOR,
  async: UML_MODIFIER_ASYNC,
};

function memberModifierFlags(node: Node): number {
  let flags = node.type === "abstract_method_signature" ? UML_MODIFIER_ABSTRACT : 0;
  for (const child of children(node)) {
    if (child.type === "accessibility_modifier") flags |= ACCESSIBILITY_FLAGS[child.text] ?? 0;
    else flags |= TOKEN_FLAGS[child.type] ?? 0;
  }
  return flags;
}

function hasToken(node: Node, token: string): boolean {
  for (const child of children(node)) {
    if (child.type === token) return true;
  }
  return false;
}

const OPTIONAL_UNDEFINED_SUFFIX = " | undefined";

type PendingMemberTypes = {
  kind: "member";
  file: string;
  annotation: Node;
  assign: (typeIds: string[]) => void;
};

type PendingHeritage = {
  kind: "heritage";
  file: string;
  base: Node;
  clause: HeritageClause;
};

type PendingTypeReference = PendingMemberTypes | PendingHeritage;

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

/** Parses every TypeScript file in `files` that has content; non-TS paths are skipped. */
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
      const parsed = parseTypeScriptSource(file, source);
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

function parseProperty(node: Node, name: string, pending: PendingTypeReference[], file: string): PropertyDetails {
  const annotation = annotationType(node, "type");
  const optional = hasToken(node, "?");
  let type = annotation?.text;
  if (optional && type?.endsWith(OPTIONAL_UNDEFINED_SUFFIX)) {
    type = type.slice(0, type.length - OPTIONAL_UNDEFINED_SUFFIX.length);
  }
  const details: PropertyDetails = {
    modifierFlags: memberModifierFlags(node),
    name,
    ...(type === undefined ? {} : { type }),
    typeIds: [],
    optional,
  };
  if (annotation) {
    pending.push({
      kind: "member",
      file,
      annotation,
      assign: (typeIds) => {
        details.typeIds = typeIds;
      },
    });
  }
  return details;
}

function parseMethod(node: Node, name: string, pending: PendingTypeReference[], file: string): MethodDetails {
  const annotation = annotationType(node, "return_type");
  const details: MethodDetails = {
    modifierFlags: memberModifierFlags(node),
    name,
    ...(annotation === undefined ? {} : { returnType: annotation.text, returnTypeIds: [] }),
  };
  if (annotation) {
    pending.push({
      kind: "member",
      file,
      annotation,
      assign: (typeIds) => {
        details.returnTypeIds = typeIds;
      },
    });
  }
  return details;
}

function classMembers(
  body: Node,
  pending: PendingTypeReference[],
  file: string,
): { properties: PropertyDetails[]; methods: MethodDetails[] } {
  const properties: PropertyDetails[] = [];
  const candidates: { node: Node; name: string }[] = [];
  let constructorNode: Node | undefined;
  for (const member of namedChildren(body)) {
    if (member.type === "public_field_definition") {
      const name = memberName(member)?.name;
      if (name !== undefined) properties.push(parseProperty(member, name, pending, file));
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
    .map(({ node, name }) => parseMethod(node, name, pending, file));

  if (constructorNode) {
    const parameters = constructorNode.childForFieldName("parameters");
    for (const parameter of parameters ? namedChildren(parameters) : []) {
      if (parameter.type !== "required_parameter" && parameter.type !== "optional_parameter") continue;
      if (!children(parameter).some((child) => child.type === "accessibility_modifier")) continue;
      const name = parameter.childForFieldName("pattern")?.text;
      if (name === undefined) continue;
      properties.push(parseProperty(parameter, name, pending, file));
    }
  }
  return { properties, methods };
}

function signatureMembers(
  body: Node,
  pending: PendingTypeReference[],
  file: string,
): { properties: PropertyDetails[]; methods: MethodDetails[] } {
  const properties: PropertyDetails[] = [];
  const methods: MethodDetails[] = [];
  for (const member of namedChildren(body)) {
    const name = memberName(member)?.name;
    if (name === undefined) continue;
    if (member.type === "property_signature") properties.push(parseProperty(member, name, pending, file));
    else if (member.type === "method_signature") methods.push(parseMethod(member, name, pending, file));
  }
  return { properties, methods };
}

function heritageBaseName(node: Node): Node {
  return node.type === "generic_type" ? node.childForFieldName("name") ?? node : node;
}

function collectHeritage(
  declaration: Node,
  entity: UmlEntityModel,
  pending: PendingTypeReference[],
  file: string,
): void {
  const push = (base: Node, type: 0 | 1): void => {
    const clause: HeritageClause = {
      clause: "",
      clauseTypeId: "",
      className: entity.name,
      classTypeId: entity.id,
      type,
    };
    entity.heritageClauses.push(clause);
    pending.push({ kind: "heritage", file, base: heritageBaseName(base), clause });
  };
  if (declaration.type === "interface_declaration") {
    for (const child of namedChildren(declaration)) {
      if (child.type !== "extends_type_clause") continue;
      for (const base of namedChildren(child)) push(base, 1);
    }
    return;
  }
  for (const child of namedChildren(declaration)) {
    if (child.type !== "class_heritage") continue;
    for (const group of namedChildren(child)) {
      if (group.type === "extends_clause") {
        const value = group.childForFieldName("value");
        if (value) push(value, 0);
      } else if (group.type === "implements_clause") {
        for (const base of namedChildren(group)) push(base, 1);
      }
    }
  }
}

function emptyEntity(name: string, id: string): UmlEntityModel {
  return { name, id, properties: [], methods: [], heritageClauses: [], items: [] };
}

function parseFileDeclaration(
  unit: SourceUnit,
  entities: Map<string, UmlReference>,
  pending: PendingTypeReference[],
): FileDeclaration {
  const fileName = unit.path;
  const declaration: FileDeclaration = {
    fileName,
    classes: [],
    interfaces: [],
    enums: [],
    types: [],
    heritageClauses: [],
  };
  for (const node of topLevelDeclarations(unit.root)) {
    const isClass = node.type === "class_declaration"
      || node.type === "abstract_class_declaration"
      || node.type === "class";
    const bare = declarationName(node) ?? (node.type === "class" ? "default" : undefined);
    if (bare === undefined) continue;
    const name = renderedTypeName(bare, node);
    const id = syntheticTypeId(fileName, name);
    const entity = emptyEntity(name, id);

    if (isClass) {
      const body = node.childForFieldName("body");
      if (body?.type === "class_body") {
        const members = classMembers(body, pending, fileName);
        entity.properties = members.properties;
        entity.methods = members.methods;
      }
      collectHeritage(node, entity, pending, fileName);
      declaration.classes.push(entity);
    } else if (node.type === "interface_declaration") {
      const body = node.childForFieldName("body");
      if (body?.type === "interface_body") {
        const members = signatureMembers(body, pending, fileName);
        entity.properties = members.properties;
        entity.methods = members.methods;
      }
      collectHeritage(node, entity, pending, fileName);
      declaration.interfaces.push(entity);
    } else if (node.type === "enum_declaration") {
      const body = node.childForFieldName("body");
      for (const item of body ? namedChildren(body) : []) {
        if (item.type === "enum_assignment") {
          const itemName = item.childForFieldName("name")?.text;
          if (itemName !== undefined) entity.items.push(itemName);
        } else if (item.type === "property_identifier") {
          entity.items.push(item.text);
        }
      }
      declaration.enums.push(entity);
    } else if (node.type === "type_alias_declaration") {
      const value = node.childForFieldName("value");
      if (value?.type !== "object_type") continue;
      const members = signatureMembers(value, pending, fileName);
      entity.properties = members.properties;
      entity.methods = members.methods;
      declaration.types.push(entity);
    } else {
      continue;
    }
    entities.set(umlEntityKey(fileName, bareUmlName(name)), { id: entity.id, name: entity.name });
  }
  for (const entity of [...declaration.classes, ...declaration.interfaces]) {
    if (entity.heritageClauses.length) declaration.heritageClauses.push(entity.heritageClauses);
  }
  return declaration;
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
