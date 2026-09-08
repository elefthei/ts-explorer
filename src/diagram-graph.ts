import type { LanguageId } from "./lang/registry.ts";
import type {
  GotoDefinition,
  GotoDefinitionKind,
  PackageDiagramNode,
  UmlExternalUser,
  UmlExternalUserKind,
  UmlLocalUser,
} from "./types.ts";
import type { UmlModifier } from "./uml/model.ts";
import type { UmlViewModel } from "./uml/view.ts";

export const DIAGRAM_GRAPH_FORMAT_VERSION = 1 as const;

type DiagramRenderMode = "normal" | "bare";

type DiagramNodeKind =
  | "package"
  | "placeholder"
  | "entity"
  | "boundary"
  | "local-user"
  | "external-user";

type DiagramEdgeKind = "package-dependency" | "uml-relation";

type DiagramRelationKind =
  | "package-dependency"
  | "heritage"
  | "member-association"
  | "method-return"
  | "usage"
  | "local-user"
  | "external-user";

export type UmlEntityKind = "class" | "interface" | "enum" | "type";
export type UmlCategoryKind = "interface" | "type" | "enum" | "abstract" | "concrete";

type UmlEntityOccurrence = {
  declarationOrdinal: number;
  entityKind: UmlEntityKind;
  entityOrdinal: number;
};

/** The persisted heritage row; `src/uml/model.ts` re-exports it as the parse-time shape. */
export type HeritageClause = {
  clause: string;
  clauseTypeId: string;
  className: string;
  classTypeId: string;
  relation: "extends" | "implements";
};

/** The persisted dependency row; `src/uml/model.ts` re-exports it as the parse-time shape. */
export type UmlDependency = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
};

type UmlUserTarget = {
  userOrdinal: number;
  targetOrdinal: number;
  targetId: string;
  targetName: string;
};

type DiagramGraphBase = {
  scopePath: string;
  formatVersion: typeof DIAGRAM_GRAPH_FORMAT_VERSION;
  renderMode: DiagramRenderMode;
  nodes: {
    nodeId: string;
    nodeOrdinal: number;
    nodeKind: DiagramNodeKind;
    name: string;
    community: number | null;
  }[];
  aliases: {
    nodeId: string;
    aliasOrdinal: number;
    alias: string;
  }[];
  edges: {
    edgeOrdinal: number;
    sourceNodeId: string;
    targetNodeId: string;
    edgeKind: DiagramEdgeKind;
    directed: boolean;
    weight: number;
  }[];
  relations: {
    edgeOrdinal: number;
    relationOrdinal: number;
    relationKind: DiagramRelationKind;
    sourceNodeId: string;
    targetNodeId: string;
  }[];
};

export type PackageDiagramGraph = DiagramGraphBase & {
  kind: "packages";
  packageNodes: {
    nodeId: string;
    packagePath: string | null;
  }[];
};

export type UmlDiagramGraph = DiagramGraphBase & {
  kind: "uml";
  declarations: {
    declarationOrdinal: number;
    fileName: string;
    language: LanguageId;
    memberAssociationsPresent: boolean;
  }[];
  entities: (UmlEntityOccurrence & {
    nodeId: string;
  })[];
  properties: (UmlEntityOccurrence & {
    propertyOrdinal: number;
    name: string;
    type: string | null;
    optional: boolean;
  })[];
  propertyTypeIds: (UmlEntityOccurrence & {
    propertyOrdinal: number;
    typeIdOrdinal: number;
    typeId: string;
  })[];
  methods: (UmlEntityOccurrence & {
    methodOrdinal: number;
    name: string;
    returnType: string | null;
    returnTypeIdsPresent: boolean;
  })[];
  methodReturnTypeIds: (UmlEntityOccurrence & {
    methodOrdinal: number;
    typeIdOrdinal: number;
    typeId: string;
  })[];
  memberModifiers: (UmlEntityOccurrence & {
    memberKind: "property" | "method";
    memberOrdinal: number;
    modifierOrdinal: number;
    modifier: UmlModifier;
  })[];
  enumItems: (UmlEntityOccurrence & {
    itemOrdinal: number;
    value: string;
  })[];
  entityHeritageClauses: (UmlEntityOccurrence & HeritageClause & {
    clauseOrdinal: number;
  })[];
  declarationHeritageGroups: (UmlEntityOccurrence & {
    groupOrdinal: number;
  })[];
  declarationHeritageClauses: (HeritageClause & {
    declarationOrdinal: number;
    groupOrdinal: number;
    clauseOrdinal: number;
  })[];
  memberAssociations: {
    declarationOrdinal: number;
    associationOrdinal: number;
    aTypeId: string;
    aName: string;
    aMultiplicity: "0..*" | null;
    bTypeId: string;
    bName: string;
    bMultiplicity: "0..*" | null;
    associationType: 0;
    inherited: boolean;
  }[];
  categories: {
    categoryOrdinal: number;
    entityName: string;
    category: UmlCategoryKind;
    isTest: boolean;
  }[];
  methodReturnDependencies: (UmlDependency & {
    dependencyOrdinal: number;
  })[];
  usageEdges: (UmlDependency & {
    dependencyOrdinal: number;
  })[];
  localUsers: {
    userOrdinal: number;
    nodeId: string;
    navigationNodeId: string;
    label: string;
    path: string;
    line: number;
    column: number;
    userKind: UmlExternalUserKind;
    ownerEntityId: string | null;
  }[];
  externalUsers: {
    userOrdinal: number;
    nodeId: string;
    navigationNodeId: string;
    label: string;
    scopePath: string;
    userKind: UmlExternalUserKind;
  }[];
  localUserTargets: UmlUserTarget[];
  externalUserTargets: UmlUserTarget[];
  definitions: {
    definitionOrdinal: number;
    definitionKey: string;
    definitionKind: GotoDefinitionKind;
    name: string;
    qualifiedName: string;
    sourcePath: string;
    sourceLine: number;
    sourceColumn: number;
    umlScopePath: string;
    umlEntityName: string;
    umlMemberName: string | null;
    umlMemberOccurrence: number | null;
  }[];
};

export type DiagramGraph = PackageDiagramGraph | UmlDiagramGraph;

type RenderedDiagramBase = {
  packageNodes: PackageDiagramNode[];
  definitions: GotoDefinition[];
  externalUsers: UmlExternalUser[];
  localUsers: UmlLocalUser[];
};

export type RenderedPackageDiagram = RenderedDiagramBase & {
  kind: "packages";
  dsl: string;
  dsls: string[];
};

export type RenderedUmlDiagram = RenderedDiagramBase & {
  kind: "uml";
  view: UmlViewModel;
};

export type RenderedDiagram = RenderedPackageDiagram | RenderedUmlDiagram;
