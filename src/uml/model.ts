import type { UndirectedGraph } from "graphology";
import type { Node } from "ts-morph";
import type {
  GotoDefinition,
  UmlExternalUserKind,
  UmlLocalUser,
  UmlSourceLocation,
  UmlExternalUser,
} from "../types.ts";

export type UmlGraphNodeKind = "entity" | "boundary" | "local-user" | "external-user";

export type UmlGraphRelationKind =
  | "heritage"
  | "member-association"
  | "method-return"
  | "usage"
  | "local-user"
  | "external-user";

export type UmlGraphNodeAttributes = {
  kind: UmlGraphNodeKind;
  name: string;
  aliases?: string[];
  community?: number;
};

export type UmlGraphRelation = {
  kind: UmlGraphRelationKind;
  sourceId: string;
  targetId: string;
};

export type UmlGraphEdgeAttributes = {
  weight: number;
  relations: UmlGraphRelation[];
};

export type UmlGraph = UndirectedGraph<UmlGraphNodeAttributes, UmlGraphEdgeAttributes>;

export type UmlDiagramBundle = {
  dsl: string;
  dsls: string[];
  definitions: GotoDefinition[];
  externalUsers: UmlExternalUser[];
  localUsers: UmlLocalUser[];
  graph: UmlGraph;
};

export type UmlUsageEdge = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
};

export type MethodReturnDependency = UmlUsageEdge;

export type UmlEntityReference = {
  id: string;
  name: string;
};

export type ExternalUserTarget = {
  id: string;
  name: string;
};

export type ExternalUserNode = {
  navigation: UmlExternalUser;
  targets: ExternalUserTarget[];
};

export type LocalUserNode = {
  navigation: UmlLocalUser;
  targets: ExternalUserTarget[];
};

export type ReferenceOwner = {
  scopePath: string;
  signature: string;
  kind: UmlExternalUserKind;
  source: UmlSourceLocation;
  ownerEntityKey?: string;
};

export type ReferenceDeclaration = {
  declarationNode: Node;
  nameNode: Node;
  target: ExternalUserTarget;
};

export type UmlAnalysis = {
  methodReturnDependencies: MethodReturnDependency[];
  usageEdges: UmlUsageEdge[];
  definitions: GotoDefinition[];
  localUserNodes: LocalUserNode[];
  externalUserNodes: ExternalUserNode[];
};

export type UmlCategory = {
  category: string;
  test: boolean;
};

export type CategoryMap = Map<string, UmlCategory>;
