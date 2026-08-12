import type { Node } from "@vscode/tree-sitter-wasm";
import type { UmlDiagramGraph } from "../diagram-graph.ts";
import type { UmlExternalUser, UmlLocalUser } from "../types.ts";

export type SourceUnit = { path: string; root: Node };

// Numeric values MUST equal ts.ModifierFlags: test/support/uml-contract.ts decodes modifierFlags
// with the TypeScript enum and reports `unknown:<residual>` for any bit it does not recognise.
export const UML_MODIFIER_PUBLIC = 1;
export const UML_MODIFIER_PRIVATE = 2;
export const UML_MODIFIER_PROTECTED = 4;
export const UML_MODIFIER_READONLY = 8;
export const UML_MODIFIER_OVERRIDE = 16;
export const UML_MODIFIER_ABSTRACT = 64;
export const UML_MODIFIER_AMBIENT = 128;
export const UML_MODIFIER_STATIC = 256;
export const UML_MODIFIER_ACCESSOR = 512;
export const UML_MODIFIER_ASYNC = 1024;

export type PropertyDetails = {
  modifierFlags: number;
  name: string;
  type?: string;
  typeIds: string[];
  optional: boolean;
};

export type MethodDetails = {
  modifierFlags: number;
  name: string;
  returnType?: string;
  returnTypeIds?: string[];
};

export type HeritageClause = {
  clause: string;
  clauseTypeId: string;
  className: string;
  classTypeId: string;
  type: 0 | 1;
};

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

export type UmlDependency = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
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
