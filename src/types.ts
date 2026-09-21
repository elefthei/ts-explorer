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

/**
 * Every declaration kind the file outline can surface. These are outline records for the Files
 * explorer, deliberately wider than `GotoDefinitionKind`, which addresses UML entities only.
 */
export const FILE_DEFINITION_KINDS = [
  "class",
  "interface",
  "trait",
  "struct",
  "union",
  "enum",
  "type",
  "namespace",
  "module",
  "function",
  "constant",
  "variable",
  "property",
  "method",
  "constructor",
  "getter",
  "setter",
  "enum-member",
  "macro",
] as const;

export type FileDefinitionKind = (typeof FILE_DEFINITION_KINDS)[number];

export type FileDefinition = {
  /**
   * `JSON.stringify([path, kind, qualifiedName, occurrence])`. Stable across formatting and
   * line moves, and distinct for overloads and merged declarations.
   */
  key: string;
  /** Declaring namespace/module/type/member, or `null` for a file-scope declaration. */
  parentKey: string | null;
  /** A root the UML pane can select on its own; derived from AST scope, never from dots. */
  isTopLevel: boolean;
  name: string;
  qualifiedName: string;
  kind: FileDefinitionKind;
  /** Declared source annotation or callable signature; never a compiler-inferred type. */
  type: string | null;
  source: UmlSourceLocation;
};

export type FileDefinitionsResponse = {
  version: number;
  definitions: FileDefinition[];
};

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

export const UML_METHOD_RETURN_MARKER = "§";

export type SearchResponse = {
  version: number;
  query: string;
  caseInsensitive: boolean;
  files: string[];
  definitions: GotoDefinition[];
  directories: string[];
  renderDirs: string[];
};

/** What the explorer selection addresses; a definition target carries its outline key. */
export type UmlTarget =
  | { kind: "definition"; path: string; definitionKey: string }
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string };

export type DiagramRequest =
  | { kind: "packages"; scopePath: "" }
  | { kind: "uml"; target: UmlTarget };

/** The manifest dependency graph; its JSON shape is unchanged by the rooted UML redesign. */
export type PackageDiagramPayload = {
  kind: "packages";
  scopePath: string;
  status: "ready" | "error";
  dsl: string;
  dsls: string[];
  packageNodes: PackageDiagramNode[];
  /** Package diagrams never carry UML navigation rows; the fields stay for wire stability. */
  definitions: never[];
  externalUsers: never[];
  localUsers: never[];
  error?: string;
};

export type UmlDiagramPayload = {
  kind: "uml";
  /** Always `target.path`; kept so existing clients can key a response by scope. */
  scopePath: string;
  target: UmlTarget;
  status: "ready" | "error";
  view: UmlViewModel;
  error?: string;
};

export type DiagramPayload = PackageDiagramPayload | UmlDiagramPayload;

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
