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

const SCOPE_ENTITY_KINDS: Record<string, true> = { module: true, namespace: true };

const CALLABLE_MEMBER_KINDS: Record<string, true> = {
  function: true,
  method: true,
  // `constructor` names `Object.prototype.constructor`, so its literal type needs pinning.
  constructor: true as const,
  getter: true,
  setter: true,
};

/** A nominal member's declared `type` is just its own name, so only these rows show one. */
const SCOPE_MEMBER_TYPED_KINDS: Record<string, true> = {
  constant: true,
  variable: true,
  property: true,
  type: true,
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

type ScopeMemberRows = { properties: PropertyDetails[]; methods: MethodDetails[] };

/**
 * A module or namespace lists what it holds: its declarations split into a callable and a
 * non-callable compartment, followed by the names it re-exports. A declared name wins over a
 * re-exported one, and a re-export carries no declaration node, so it renders untyped.
 */
function scopeMemberRows(
  declared: readonly ParsedFileDefinition[],
  reexported: readonly { name: string; key: string }[],
  index: DefinitionResolutionIndex,
  rust: boolean,
): ScopeMemberRows {
  const properties: PropertyDetails[] = [];
  const methods: MethodDetails[] = [];
  const seen = new Set<string>();
  for (const member of declared) {
    const { kind, name } = member.definition;
    seen.add(name);
    if (CALLABLE_MEMBER_KINDS[kind] === true) {
      methods.push(methodDetails(member, rust));
      continue;
    }
    const row = propertyDetails(member, rust);
    if (SCOPE_MEMBER_TYPED_KINDS[kind] !== true) delete row.type;
    properties.push(row);
  }
  for (const entry of reexported) {
    if (seen.has(entry.name)) continue;
    const indexed = index.definition(entry.key);
    if (!indexed) continue;
    seen.add(entry.name);
    if (CALLABLE_MEMBER_KINDS[indexed.kind] === true) {
      methods.push({ definitionKey: entry.key, modifiers: ["public"], name: entry.name });
      continue;
    }
    properties.push({
      definitionKey: entry.key,
      modifiers: ["public"],
      name: entry.name,
      optional: false,
    });
  }
  return { properties, methods };
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

  // A module or namespace is not a nominal owner — it never absorbs its members' references — but
  // its box still lists them. A memberless scope stays a plain box with no compartment.
  for (const entry of parsed) {
    const { kind, key, name } = entry.definition;
    if (SCOPE_ENTITY_KINDS[kind] !== true) continue;
    const { properties, methods } = scopeMemberRows(
      membersByParent.get(key) ?? [],
      // A TypeScript namespace's exports are already members; only Rust `pub use` adds rows.
      rust ? index.moduleExports(key) : [],
      index,
      rust,
    );
    if (!properties.length && !methods.length) continue;
    entities.push({ id: key, name, kind, properties, methods, items: [] });
  }
  if (rust) {
    // An out-of-line `mod x;` body contributes its top level to the box `x` was declared in.
    for (const ownerKey of index.moduleOwners(path)) {
      const indexed = index.definition(ownerKey);
      if (!indexed) continue;
      const { properties, methods } = scopeMemberRows(
        parsed.filter((entry) => entry.definition.isTopLevel),
        index.moduleExports(ownerKey),
        index,
        rust,
      );
      if (!properties.length && !methods.length) continue;
      entities.push({
        id: ownerKey,
        name: indexed.name,
        kind: indexed.kind,
        properties,
        methods,
        items: [],
      });
    }
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
