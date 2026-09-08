import type { UmlViewModel } from "./uml/view.ts";

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

export const HIGHLIGHT_TOKENS = [
  "keyword",
  "comment",
  "string",
  "string2",
  "number",
  "bool",
  "atom",
  "propertyName",
  "labelName",
  "typeName",
  "className",
  "variableName",
  "variableName2",
  "definition",
  "operator",
  "punctuation",
  "invalid",
] as const;

export type HighlightToken = (typeof HIGHLIGHT_TOKENS)[number];

export type HighlightSpan = {
  from: number;
  to: number;
  token: HighlightToken;
};

export type GotoDefinitionLookupResponse = {
  version: number;
  definition: GotoDefinition | null;
};

export type DefinitionLookupResponse = {
  version: number;
  definition: UmlSourceLocation | null;
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
  caseInsensitive: boolean;
  files: string[];
  definitions: GotoDefinition[];
  directories: string[];
  renderDirs: string[];
};

type DiagramResponseBase = {
  scopePath: string;
  status: "ready" | "error";
  packageNodes: PackageDiagramNode[];
  definitions: GotoDefinition[];
  externalUsers: UmlExternalUser[];
  localUsers: UmlLocalUser[];
  error?: string;
};

export type DiagramPayload =
  | (DiagramResponseBase & { kind: "packages"; dsl: string; dsls: string[] })
  | (DiagramResponseBase & { kind: "uml"; view: UmlViewModel });

export type DiagramResponse = DiagramPayload & { version: number };

export type FileResponse = {
  path: string;
  content: string;
  definitions: EditorGotoDefinition[];
  highlights: HighlightSpan[];
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

