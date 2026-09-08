import { existsSync } from "node:fs";
import { highlightLanguageForPath } from "./lang/registry.ts";

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

function hasIgnoredSegment(path: string, ignored: ReadonlySet<string>): boolean {
  return path.split(/[\\/]+/).some((segment) => ignored.has(segment));
}

// A directory named `target` is Cargo's build output only when a `Cargo.toml` sits beside it;
// `src/target` in a TypeScript project is an ordinary source directory and must stay visible.
const cargoTargetDirectories = new Map<string, boolean>();

export function isCargoTargetPath(absolutePath: string): boolean {
  const segments = absolutePath.split(/[\\/]+/);
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    if (segments[index] !== "target") continue;
    const directory = segments.slice(0, index).join("/");
    let cached = cargoTargetDirectories.get(directory);
    if (cached === undefined) {
      cached = existsSync(`${directory}/Cargo.toml`);
      cargoTargetDirectories.set(directory, cached);
    }
    if (cached) return true;
  }
  return false;
}

export function isSourcePath(path: string): boolean {
  return highlightLanguageForPath(path) !== undefined;
}

/** Only these files are handed to Prettier; Rust is served exactly as written. */
export function isPrettierFormattablePath(path: string): boolean {
  const id = highlightLanguageForPath(path);
  return id !== undefined && id !== "rust";
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

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodeSourceBytes(
  bytes: Uint8Array,
): { text: string } | { failure: "file is not valid UTF-8 text" | "file contains NUL bytes" } {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { failure: "file is not valid UTF-8 text" };
  }
  return text.includes("\0") ? { failure: "file contains NUL bytes" } : { text };
}
