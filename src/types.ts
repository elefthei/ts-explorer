export type TreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children?: TreeNode[];
  viewable?: boolean;
};

export type PackageInfo = {
  name: string;
  path: string;
  dependencies: string[];
};

export type PackageDiagramNode = {
  nodeId: string;
  name: string;
  path: string;
};

type ExplorerStatus = "ready" | "error";
export type DiagramKind = "packages" | "uml";

export type PreprocessPriorityStatus = "queued" | "processing" | "done";

export type PreprocessPriorityResponse = {
  status: PreprocessPriorityStatus;
  resource: string;
  requestId: number;
};

export type PreprocessControlRequest =
  | { action: "prioritize"; resource: string }
  | { action: "poll"; requestId: number };

export type UmlSourceLocation = {
  path: string;
  line: number;
  column: number;
};

export type GotoDefinitionKind =
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "method";

export type GotoDefinition = {
  key: string;
  kind: GotoDefinitionKind;
  name: string;
  qualifiedName: string;
  source: UmlSourceLocation;
  uml: {
    scopePath: string;
    entityName: string;
    memberName?: string;
    memberOccurrence?: number;
  };
};

export type EditorGotoDefinition = GotoDefinition & {
  displayFrom: number;
  displayTo: number;
};

export type GotoDefinitionLookupResponse = {
  version: number;
  definition: GotoDefinition | null;
};


export type UmlExternalUserKind =
  | "method"
  | "constructor"
  | "property"
  | "class"
  | "function"
  | "variable"
  | "type"
  | "export";

export const UML_METHOD_RETURN_MARKER = "§";

export type UmlExternalUser = {
  nodeId: string;
  label: string;
  scopePath: string;
  kind: UmlExternalUserKind;
};

export type UmlLocalUser = UmlSourceLocation & {
  nodeId: string;
  label: string;
  kind: UmlExternalUserKind;
};

export type SearchResponse = {
  version: number;
  query: string;
  files: string[];
  definitions: GotoDefinition[];
  directories: string[];
  renderDirs: string[];
};

export type DiagramResponse = {
  kind: DiagramKind;
  scopePath: string;
  version: number;
  status: ExplorerStatus;
  dsl: string;
  dsls: string[];
  packageNodes: PackageDiagramNode[];
  definitions: GotoDefinition[];
  externalUsers: UmlExternalUser[];
  localUsers: UmlLocalUser[];
  error?: string;
};

export type FileResponse = {
  path: string;
  content: string;
  definitions: EditorGotoDefinition[];
  cursorOffset?: number;
};

export type WatchEventName = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

type WatchEvent = {
  type: "changed";
  version: number;
  paths: string[];
  events: WatchEventName[];
};

export type WatchMessage =
  | WatchEvent
  | {
    type: "watch-error";
    version: number;
    error: string;
  }
  | {
    type: "cache-ready";
    version: number;
  };

