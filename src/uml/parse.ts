import type { Node } from "@vscode/tree-sitter-wasm";
import type { ParsedFileDefinition } from "../goto-definition.ts";
import { children, renderedTypeName } from "../lang/ast.ts";
import { highlightLanguageForPath } from "../lang/registry.ts";
import { annotationType } from "../lang/typescript.ts";
import type { UmlCategoryKind } from "../diagram-graph.ts";
import type { FileDefinitionKind } from "../types.ts";
import { isTestPath } from "./keys.ts";
import type {
  DefinitionResolutionIndex,
  MethodDetails,
  PropertyDetails,
  UmlEntityModel,
  UmlModifier,
} from "./model.ts";
import { orderUmlModifiers } from "./model.ts";
import { rustMemberModifiers, rustMemberReturnType } from "./rust-parse.ts";
import { isNominalKind } from "./usage.ts";

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

const OPTIONAL_UNDEFINED_SUFFIX = " | undefined";

const PROPERTY_MEMBER_KINDS: Record<string, true> = {
  property: true,
  constant: true,
  variable: true,
};

function scriptMemberModifiers(node: Node): UmlModifier[] {
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

export type NominalCategory = {
  definitionKey: string;
  category: UmlCategoryKind;
  isTest: boolean;
};

export type NominalModel = {
  /** Boxes this file declares, plus fragments for types it only implements members of. */
  entities: UmlEntityModel[];
  categories: NominalCategory[];
};

function categoryOf(kind: FileDefinitionKind, declaration: Node): UmlCategoryKind {
  if (kind === "interface" || kind === "trait") return "interface";
  if (kind === "enum") return "enum";
  if (kind === "type") return "type";
  return declaration.type === "abstract_class_declaration" ? "abstract" : "concrete";
}

function propertyDetails(
  entry: ParsedFileDefinition,
  rust: boolean,
): PropertyDetails {
  const node = entry.declaration;
  const optional = !rust && children(node).some((child) => child.type === "?");
  let type = entry.definition.type ?? undefined;
  if (optional && type?.endsWith(OPTIONAL_UNDEFINED_SUFFIX)) {
    type = type.slice(0, type.length - OPTIONAL_UNDEFINED_SUFFIX.length);
  }
  return {
    definitionKey: entry.definition.key,
    modifiers: rust ? rustMemberModifiers(node) : scriptMemberModifiers(node),
    name: entry.definition.name,
    ...(type === undefined ? {} : { type }),
    optional,
  };
}

function methodDetails(entry: ParsedFileDefinition, rust: boolean): MethodDetails {
  const node = entry.declaration;
  const returnType = rust
    ? rustMemberReturnType(node)
    : annotationType(node, "return_type")?.text;
  return {
    definitionKey: entry.definition.key,
    modifiers: rust ? rustMemberModifiers(node) : scriptMemberModifiers(node),
    name: entry.definition.name,
    ...(returnType === undefined ? {} : { returnType }),
  };
}

/**
 * Overload signatures collapse into the implementation that follows them; when a name has no
 * implementation every declared signature is kept, each carrying its own definition key.
 */
function collapseOverloads(entries: readonly ParsedFileDefinition[]): ParsedFileDefinition[] {
  const implemented = new Set(
    entries.filter((entry) => entry.hasBody).map((entry) => entry.definition.name),
  );
  return entries.filter((entry) => entry.hasBody || !implemented.has(entry.definition.name));
}

/**
 * The nominal boxes one source file contributes. Cross-file Rust implementations produce a
 * fragment keyed by the implemented type's canonical definition key; the declaring file supplies
 * the header and category when fragments are merged for a view.
 */
export function buildNominalModel(
  path: string,
  parsed: readonly ParsedFileDefinition[],
  index: DefinitionResolutionIndex,
): NominalModel {
  const rust = highlightLanguageForPath(path) === "rust";
  const byKey = new Map(parsed.map((entry) => [entry.definition.key, entry] as const));
  const membersByParent = new Map<string, ParsedFileDefinition[]>();
  for (const entry of parsed) {
    const parentKey = entry.definition.parentKey;
    if (parentKey === null) continue;
    const existing = membersByParent.get(parentKey);
    if (existing) existing.push(entry);
    else membersByParent.set(parentKey, [entry]);
  }

  const entities: UmlEntityModel[] = [];
  const categories: NominalCategory[] = [];
  const isTest = isTestPath(path);
  const ownerKeys = new Set<string>();

  for (const entry of parsed) {
    const { kind, key } = entry.definition;
    if (!isNominalKind(kind)) continue;
    // A plain alias has no compartment; it renders as its declared right-hand side instead.
    if (kind === "type" && !membersByParent.has(key)) continue;
    ownerKeys.add(key);
    categories.push({
      definitionKey: key,
      category: categoryOf(kind, entry.declaration),
      isTest,
    });
  }
  for (const [parentKey] of membersByParent) {
    if (byKey.has(parentKey)) continue;
    const parent = index.definition(parentKey);
    if (parent && isNominalKind(parent.kind)) ownerKeys.add(parentKey);
  }

  for (const ownerKey of ownerKeys) {
    const owner = byKey.get(ownerKey);
    const indexed = owner?.definition ?? index.definition(ownerKey);
    if (!indexed) continue;
    const members = membersByParent.get(ownerKey) ?? [];
    const properties = members
      .filter((member) => PROPERTY_MEMBER_KINDS[member.definition.kind] === true)
      .map((member) => propertyDetails(member, rust));
    const methods = collapseOverloads(members.filter((member) => member.definition.kind === "method"))
      .map((member) => methodDetails(member, rust));
    const items = members
      .filter((member) => member.definition.kind === "enum-member")
      .map((member) => ({ definitionKey: member.definition.key, value: member.definition.name }));
    entities.push({
      id: ownerKey,
      name: owner ? renderedTypeName(indexed.name, owner.declaration) : indexed.name,
      kind: indexed.kind,
      properties,
      methods,
      items,
    });
  }
  entities.sort((left, right) => left.id.localeCompare(right.id));
  categories.sort((left, right) => left.definitionKey.localeCompare(right.definitionKey));
  return { entities, categories };
}
