const TRAVERSAL_IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  "build",
  "out",
  ".explore",
]);
const UML_IGNORED_SEGMENTS = new Set([".git", "node_modules", ".explore"]);

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

function hasIgnoredSegment(path: string, ignored: ReadonlySet<string>): boolean {
  return path.split(/[\\/]+/).some((segment) => ignored.has(segment));
}

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isTypeScriptPath(path: string): boolean {
  return TYPESCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isDeclarationPath(path: string): boolean {
  return /\.d\.(?:ts|tsx|mts|cts)$/.test(path);
}

export function isTraversalIgnoredPath(path: string): boolean {
  return hasIgnoredSegment(path, TRAVERSAL_IGNORED_SEGMENTS);
}

export function isUmlIgnoredPath(path: string): boolean {
  return hasIgnoredSegment(path, UML_IGNORED_SEGMENTS);
}

export type SourceDecodeFailure = "file is not valid UTF-8 text" | "file contains NUL bytes";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodeSourceBytes(
  bytes: Uint8Array,
): { text: string } | { failure: SourceDecodeFailure } {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { failure: "file is not valid UTF-8 text" };
  }
  return text.includes("\0") ? { failure: "file contains NUL bytes" } : { text };
}
