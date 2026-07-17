import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

export type PathErrorCode = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND";

export class PathError extends Error {
  constructor(public readonly code: PathErrorCode, message: string) {
    super(message);
    this.name = "PathError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function validateRelativePath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new PathError("BAD_REQUEST", "path must be a valid string");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new PathError("FORBIDDEN", "path must be relative to the source root");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new PathError("FORBIDDEN", "path escapes the source root");
  }
  return parts.join("/");
}

export async function resolveInside(root: string, relativePath: string, mustExist: boolean): Promise<string> {
  const safePath = validateRelativePath(relativePath);
  const realRoot = await realpath(root).catch(() => {
    throw new PathError("NOT_FOUND", "source root does not exist");
  });
  const candidate = resolve(realRoot, ...safePath.split("/").filter(Boolean));
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    if (mustExist) throw new PathError("NOT_FOUND", `path not found: ${safePath}`);
    const parent = await realpath(dirname(candidate)).catch(() => {
      throw new PathError("NOT_FOUND", `parent path not found: ${safePath}`);
    });
    resolved = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  }
  if (!isWithin(realRoot, resolved)) {
    throw new PathError("FORBIDDEN", "path escapes the source root");
  }
  if (mustExist) {
    const info = await lstat(resolved).catch(() => null);
    if (!info) throw new PathError("NOT_FOUND", `path not found: ${safePath}`);
    if (info.isSymbolicLink()) throw new PathError("FORBIDDEN", "symbolic links are not allowed");
  }
  return resolved;
}

export async function ensureRegularFile(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new PathError("NOT_FOUND", "file not found");
  if (!info.isFile()) throw new PathError("BAD_REQUEST", "path is not a regular file");
}
