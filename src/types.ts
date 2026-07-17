export type TreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children?: TreeNode[];
  editable?: boolean;
};

export type PackageInfo = {
  name: string;
  path: string;
  dependencies: string[];
};

export type ExplorerStatus = "ready" | "error";
export type DiagramKind = "packages" | "uml";

export type DiagramResponse = {
  kind: DiagramKind;
  scopePath: string;
  version: number;
  status: ExplorerStatus;
  dsl: string;
  error?: string;
};

export type FileResponse = {
  path: string;
  content: string;
  hash: string;
  editable: boolean;
};

export type WatchEventName = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export type WatchEvent = {
  type: "changed";
  version: number;
  paths: string[];
  events: WatchEventName[];
};

export type WatchMessage = WatchEvent | {
  type: "watch-error";
  version: number;
  error: string;
};

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
export type TsExtension = (typeof TS_EXTENSIONS)[number];

export function isTypeScriptPath(path: string): boolean {
  return TS_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isDeclarationPath(path: string): boolean {
  return /\.d\.(?:ts|tsx|mts|cts)$/.test(path);
}

export function isEditablePath(path: string): boolean {
  return isTypeScriptPath(path) && !isDeclarationPath(path);
}
