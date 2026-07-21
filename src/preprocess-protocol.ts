import type {
  DiagramKind,
  DiagramResponse,
  FileResponse,
  GotoDefinition,
  PackageInfo,
  SearchResponse,
  TreeNode,
} from "./types.ts";

export type PreprocessErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INTERNAL";

export type PreprocessCause = "startup" | "watch";


export type PreprocessScope = {
  path: string;
  kind: "package" | "directory" | "file";
};

export type SourceLocation = {
  line: number;
  column: number;
};

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
    type: "preprocess-scope";
    generationId: number;
    cause: PreprocessCause;
    scope: PreprocessScope;
    packages: PackageInfo[];
  }
  | { id: number; type: "read-tree"; generationId: number }
  | { id: number; type: "read-packages"; generationId: number }
  | {
    id: number;
    type: "read-diagram";
    generationId: number;
    kind: DiagramKind;
    scopePath: string;
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
  | { id: number; type: "search"; generationId: number; query: string }
  | { id: number; type: "promote-generation"; generationId: number }
  | {
    id: number;
    type: "discard-generation";
    generationId: number;
    mode: "delete" | "failed";
  }
  | { id: number; type: "shutdown" };

export type PreprocessResultMap = {
  init: { activeGenerationId: number | null };
  "begin-generation": { generationId: number };
  "discover-packages": { packages: PackageInfo[] };
  "preprocess-scope": { children: PreprocessScope[] };
  "read-tree": TreeNode;
  "read-packages": PackageInfo[];
  "read-diagram": Omit<DiagramResponse, "version">;
  "read-file": FileResponse;
  "read-definition": GotoDefinition | null;
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
  component: "uml" | "code";
  resource: string;
  generationId: number;
  cause: PreprocessCause;
};

const PREPROCESS_ERROR_CODES = new Set<PreprocessErrorCode>([
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "INTERNAL",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPreprocessProgressEvent(value: unknown): value is PreprocessProgressEvent {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    (value.event === "start" || value.event === "done") &&
    (value.component === "uml" || value.component === "code") &&
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
    PREPROCESS_ERROR_CODES.has(value.error.code as PreprocessErrorCode) &&
    typeof value.error.message === "string"
  );
}
