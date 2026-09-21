import type {
  DiagramPayload,
  DiagramRequest,
  FileDefinition,
  FileResponse,
  GotoDefinition,
  PackageInfo,
  SearchResponse,
  TreeNode,
  UmlSourceLocation,
} from "./types.ts";

const PREPROCESS_ERROR_CODES = {
  BAD_REQUEST: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  INVALID_INPUT: true,
  SCHEMA_RETRY: true,
  INTERNAL: true,
} as const;

export type PreprocessErrorCode = keyof typeof PREPROCESS_ERROR_CODES;

export type PreprocessCause = "startup" | "watch";

export type PreprocessScope = {
  path: string;
  kind: "package" | "directory" | "file";
};

export type SourceLocation = {
  line: number;
  column: number;
};

/**
 * A SQL-only diagram read. `pending` names the file graphs the parent must schedule before the
 * selection can be published; the worker never enqueues work itself.
 */
export type DiagramReadResult =
  | { state: "complete"; diagram: DiagramPayload }
  | { state: "pending"; files: string[] };

export type PreprocessRequest =
  | {
    id: number;
    type: "init";
    sourceDir: string;
    dbPath: string;
    recover: boolean;
  }
  | { id: number; type: "begin-generation"; cause: PreprocessCause }
  | { id: number; type: "discover-packages"; generationId: number }
  | {
    id: number;
    type: "index-definitions";
    generationId: number;
    cause: PreprocessCause;
  }
  | {
    id: number;
    type: "preprocess-scope";
    generationId: number;
    cause: PreprocessCause;
    scope: PreprocessScope;
  }
  | { id: number; type: "read-tree"; generationId: number }
  | { id: number; type: "read-packages"; generationId: number }
  | {
    id: number;
    type: "read-diagram";
    generationId: number;
    request: DiagramRequest;
  }
  | {
    id: number;
    type: "read-file";
    generationId: number;
    path: string;
    location?: SourceLocation;
  }
  | {
    id: number;
    type: "read-definition";
    generationId: number;
    path: string;
    line: number;
    column: number;
  }
  | {
    id: number;
    type: "read-file-definitions";
    generationId: number;
    path: string;
  }
  | {
    id: number;
    type: "lookup-definition";
    path: string;
    name: string;
    qualifiedName: string;
  }
  | {
    id: number;
    type: "search";
    generationId: number;
    query: string;
    caseInsensitive: boolean;
  }
  | { id: number; type: "promote-generation"; generationId: number }
  | {
    id: number;
    type: "discard-generation";
    generationId: number;
    mode: "delete" | "failed";
  }
  | { id: number; type: "shutdown" };

export type PreprocessResultMap = {
  init: { activeGenerationId: number | null; hasFailedDiagrams: boolean };
  "begin-generation": { generationId: number };
  "discover-packages": { packages: PackageInfo[] };
  "index-definitions": { definitionCount: number };
  "preprocess-scope": { children: PreprocessScope[] };
  "read-tree": TreeNode;
  "read-packages": PackageInfo[];
  "read-diagram": DiagramReadResult;
  "read-file": FileResponse;
  "read-definition": GotoDefinition | null;
  "read-file-definitions": FileDefinition[];
  "lookup-definition": UmlSourceLocation | null;
  search: Omit<SearchResponse, "version">;
  "promote-generation": null;
  "discard-generation": null;
  shutdown: null;
};

export type PreprocessSuccess<
  Type extends PreprocessRequest["type"] = PreprocessRequest["type"],
> = {
  [Key in Type]: {
    id: number;
    ok: true;
    value: PreprocessResultMap[Key];
  };
}[Type];

export type PreprocessFailure = {
  id: number;
  ok: false;
  error: {
    code: PreprocessErrorCode;
    message: string;
  };
};

export type PreprocessResponse = PreprocessSuccess | PreprocessFailure;

export type PreprocessProgressEvent = {
  event: "start" | "done";
  component: "uml" | "code" | "definitions";
  resource: string;
  generationId: number;
  cause: PreprocessCause;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPreprocessProgressEvent(value: unknown): value is PreprocessProgressEvent {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    (value.event === "start" || value.event === "done") &&
    (value.component === "uml" || value.component === "code" ||
      value.component === "definitions") &&
    typeof value.resource === "string" &&
    typeof value.generationId === "number" &&
    Number.isSafeInteger(value.generationId) &&
    value.generationId > 0 &&
    (value.cause === "startup" || value.cause === "watch")
  );
}

export function isPreprocessResponse(value: unknown): value is PreprocessResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) return Object.hasOwn(value, "value");
  if (!isRecord(value.error)) return false;
  return (
    typeof value.error.code === "string" &&
    Object.hasOwn(PREPROCESS_ERROR_CODES, value.error.code) &&
    typeof value.error.message === "string"
  );
}
