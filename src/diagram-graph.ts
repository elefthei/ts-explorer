import type {
  FileDefinitionKind,
  PackageDiagramNode,
  PackageDiagramPayload,
} from "./types.ts";
import type { UmlModifier } from "./uml/model.ts";

export const DIAGRAM_GRAPH_FORMAT_VERSION = 2 as const;

type DiagramRenderMode = "normal" | "bare";

export type DiagramNodeKind =
  | "package"
  | "placeholder"
  | "entity"
  | "definition"
  | "boundary";

export type DiagramEdgeKind = "package-dependency" | "uml-relation";

export type DiagramRelationKind =
  | "package-dependency"
  | "extends"
  | "implements"
  | "references";

export type UmlRelationKind = Exclude<DiagramRelationKind, "package-dependency">;

export type UmlCategoryKind = "interface" | "type" | "enum" | "abstract" | "concrete";

/** Persisted per-file completion marker; the display model lives in normalized tables. */
export type UmlFileOutcome =
  | { status: "ready" }
  | { status: "error"; error: string };

type DiagramGraphBase = {
  scopePath: string;
  formatVersion: typeof DIAGRAM_GRAPH_FORMAT_VERSION;
  renderMode: DiagramRenderMode;
  nodes: {
    nodeId: string;
    nodeOrdinal: number;
    nodeKind: DiagramNodeKind;
    name: string;
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

type UmlEntityOccurrence = { entityOrdinal: number };

/**
 * One source file's direct UML facts. Every `node_id` is a canonical definition key, so graphs of
 * different files compose by identity without any name matching.
 */
export type UmlDiagramGraph = DiagramGraphBase & {
  kind: "uml";
  entities: (UmlEntityOccurrence & {
    definitionKey: string;
    entityKind: FileDefinitionKind;
    name: string;
  })[];
  properties: (UmlEntityOccurrence & {
    propertyOrdinal: number;
    definitionKey: string;
    name: string;
    type: string | null;
    optional: boolean;
  })[];
  methods: (UmlEntityOccurrence & {
    methodOrdinal: number;
    definitionKey: string;
    name: string;
    returnType: string | null;
  })[];
  memberModifiers: (UmlEntityOccurrence & {
    memberKind: "property" | "method";
    memberOrdinal: number;
    modifierOrdinal: number;
    modifier: UmlModifier;
  })[];
  enumItems: (UmlEntityOccurrence & {
    itemOrdinal: number;
    definitionKey: string;
    value: string;
  })[];
  categories: {
    categoryOrdinal: number;
    definitionKey: string;
    category: UmlCategoryKind;
    isTest: boolean;
  }[];
};

export type DiagramGraph = PackageDiagramGraph | UmlDiagramGraph;

export type RenderedPackageDiagram = {
  kind: "packages";
  dsl: string;
  dsls: string[];
  packageNodes: PackageDiagramNode[];
  definitions: never[];
  externalUsers: never[];
  localUsers: never[];
};

export type { PackageDiagramPayload };
