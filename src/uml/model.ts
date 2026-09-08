import type { Node } from "@vscode/tree-sitter-wasm";
import type { HeritageClause, UmlDependency, UmlDiagramGraph } from "../diagram-graph.ts";
import type { UmlExternalUser, UmlLocalUser } from "../types.ts";

export type SourceUnit = { path: string; root: Node };

/**
 * Canonical order: a member's modifiers are always emitted in this order, in every language.
 * `const`, `unsafe` and `mutable` are Rust-only; the rest are shared with TypeScript.
 */
export const UML_MODIFIERS = [
  "ambient",
  "public",
  "private",
  "protected",
  "abstract",
  "static",
  "readonly",
  "accessor",
  "async",
  "const",
  "override",
  "unsafe",
  "mutable",
] as const;

export type UmlModifier = (typeof UML_MODIFIERS)[number];

const UML_MODIFIER_ORDER: ReadonlyMap<string, number> = new Map(
  UML_MODIFIERS.map((modifier, index) => [modifier, index]),
);

/** Deduplicates `modifiers` and sorts them into `UML_MODIFIERS` order. */
export function orderUmlModifiers(modifiers: Iterable<UmlModifier>): UmlModifier[] {
  return [...new Set(modifiers)].sort(
    (left, right) => (UML_MODIFIER_ORDER.get(left) ?? 0) - (UML_MODIFIER_ORDER.get(right) ?? 0),
  );
}

export type PropertyDetails = {
  modifiers: UmlModifier[];
  name: string;
  type?: string;
  typeIds: string[];
  optional: boolean;
};

export type MethodDetails = {
  modifiers: UmlModifier[];
  name: string;
  returnType?: string;
  returnTypeIds?: string[];
};

/** The parse-time shapes are the persisted row shapes; one declaration serves both. */
export type { HeritageClause, UmlDependency };

/** A member annotation whose type references resolve once the whole project is parsed. */
type PendingMemberTypes = {
  kind: "member";
  file: string;
  annotation: Node;
  assign: (typeIds: string[]) => void;
};

/** A heritage base name whose target entity resolves once the whole project is parsed. */
type PendingHeritage = {
  kind: "heritage";
  file: string;
  base: Node;
  clause: HeritageClause;
};

export type PendingTypeReference = PendingMemberTypes | PendingHeritage;

type AssociationEnd = {
  typeId: string;
  name: string;
  multiplicity?: "0..*";
};

export type MemberAssociation = {
  a: AssociationEnd;
  b: AssociationEnd;
  associationType: 0;
  inherited: boolean;
};

export type UmlEntityModel = {
  name: string;
  id: string;
  properties: PropertyDetails[];
  methods: MethodDetails[];
  heritageClauses: HeritageClause[];
  items: string[];
};

export type FileDeclaration = {
  fileName: string;
  classes: UmlEntityModel[];
  interfaces: UmlEntityModel[];
  enums: UmlEntityModel[];
  types: UmlEntityModel[];
  heritageClauses: HeritageClause[][];
  memberAssociations?: MemberAssociation[];
};

export type UmlReference = {
  id: string;
  name: string;
};

export type ExternalUserNode = {
  navigation: UmlExternalUser;
  targets: UmlReference[];
};

export type LocalUserNode = {
  navigation: UmlLocalUser;
  ownerEntityId?: string;
  targets: UmlReference[];
};

type UmlCategory = {
  category: UmlDiagramGraph["categories"][number]["category"];
  test: boolean;
};

export type CategoryMap = Map<string, UmlCategory>;

/** Global UML detail switches; every flag on reproduces the maximal diagram. */
export type UmlVisibility = {
  attributes: boolean;
  methods: boolean;
  types: boolean;
  tests: boolean;
};

export const FULL_UML_VISIBILITY: UmlVisibility = {
  attributes: true,
  methods: true,
  types: true,
  tests: true,
};
