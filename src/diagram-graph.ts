import type {
  GotoDefinition,
  GotoDefinitionKind,
  PackageDiagramNode,
  UmlExternalUser,
  UmlExternalUserKind,
  UmlLocalUser,
} from "./types.ts";

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

type UmlEntityKind = "class" | "interface" | "enum" | "type";
type UmlCategoryKind = "interface" | "type" | "enum" | "abstract" | "concrete";
type UmlUserKind = UmlExternalUserKind;
type UmlSettingLineKind = "nomnoml" | "mermaid";
type UmlHeritageClauseType = 0 | 1;
type UmlAssociationType = 0;

type UmlEntityOccurrence = {
  declarationOrdinal: number;
  entityKind: UmlEntityKind;
  entityOrdinal: number;
};

type UmlHeritageFields = {
  clause: string;
  clauseTypeId: string;
  className: string;
  classTypeId: string;
  clauseType: UmlHeritageClauseType;
};

type UmlDependencyFields = {
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
  settings: {
    glob: string;
    tsconfig: string | null;
    outFile: string;
    propertyTypes: boolean;
    modifiers: boolean;
    typeLinks: boolean;
    outDsl: string;
    outMermaidDsl: string;
    memberAssociations: boolean;
    exportedTypesOnly: boolean;
  } | null;
  settingLines: {
    settingKind: UmlSettingLineKind;
    lineOrdinal: number;
    value: string;
  }[];
  declarations: {
    declarationOrdinal: number;
    fileName: string;
    memberAssociationsPresent: boolean;
  }[];
  entities: (UmlEntityOccurrence & {
    nodeId: string;
  })[];
  properties: (UmlEntityOccurrence & {
    propertyOrdinal: number;
    modifierFlags: number;
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
    modifierFlags: number;
    name: string;
    returnType: string | null;
    returnTypeIdsPresent: boolean;
  })[];
  methodReturnTypeIds: (UmlEntityOccurrence & {
    methodOrdinal: number;
    typeIdOrdinal: number;
    typeId: string;
  })[];
  enumItems: (UmlEntityOccurrence & {
    itemOrdinal: number;
    value: string;
  })[];
  entityHeritageClauses: (UmlEntityOccurrence & UmlHeritageFields & {
    clauseOrdinal: number;
  })[];
  declarationHeritageGroups: (UmlEntityOccurrence & {
    groupOrdinal: number;
  })[];
  declarationHeritageClauses: (UmlHeritageFields & {
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
    associationType: UmlAssociationType;
    inherited: boolean;
  }[];
  categories: {
    categoryOrdinal: number;
    entityName: string;
    category: UmlCategoryKind;
    isTest: boolean;
  }[];
  methodReturnDependencies: (UmlDependencyFields & {
    dependencyOrdinal: number;
  })[];
  usageEdges: (UmlDependencyFields & {
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
    userKind: UmlUserKind;
    ownerEntityId: string | null;
  }[];
  externalUsers: {
    userOrdinal: number;
    nodeId: string;
    navigationNodeId: string;
    label: string;
    scopePath: string;
    userKind: UmlUserKind;
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

export type RenderedDiagram = {
  dsl: string;
  dsls: string[];
  packageNodes: PackageDiagramNode[];
  definitions: GotoDefinition[];
  externalUsers: UmlExternalUser[];
  localUsers: UmlLocalUser[];
};
