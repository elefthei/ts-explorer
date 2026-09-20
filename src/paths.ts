import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathErrorCode = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND";

export class PathError extends Error {
  constructor(public readonly code: PathErrorCode, message: string) {
    super(message);
    this.name = "PathError";
  }
}

// Windows reaches a WSL distribution through a network redirector. `wsl$` and `wsl.localhost` are
// interchangeable authorities for the same tree, and `\\?\UNC\` is the namespaced spelling of both.
export const WSL_UNC_ROOT = /^\\\\(?:\?\\UNC\\)?(?:wsl\.localhost|wsl\$)\\/i;

// Windows can spell one WSL root four ways (`wsl$`/`wsl.localhost`, plain or namespaced). Canonicalize
// the source root itself so I/O, watching and cache identity all agree. Linux path components stay
// case-sensitive: `Project` and `project` are different roots.
export function resolveSourceDir(sourceDir: string): string {
  const root = resolve(sourceDir);
  return process.platform === "win32" ? root.replace(WSL_UNC_ROOT, "\\\\wsl.localhost\\") : root;
}

// SQLite cannot acquire a file lock over the WSL redirector: every statement, including `SELECT 1`,
// fails with SQLITE_BUSY ("database is locked"). The cache therefore lives on local disk for those
// roots, in a directory keyed by the canonical root so distinct projects never share one database.
export function resolveCacheDbPath(sourceDir: string): string {
  const root = resolveSourceDir(sourceDir);
  if (process.platform !== "win32" || !WSL_UNC_ROOT.test(root)) {
    return join(root, ".explore", "explore.db");
  }
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const label = basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 32) || "root";
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "ts-explorer", `${label}-${digest}`, "explore.db");
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function normalizeRelativePath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new PathError("BAD_REQUEST", "path must be a valid string");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new PathError("FORBIDDEN", "path must be relative to the source root");
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new PathError("FORBIDDEN", "path escapes the source root");
  }
  return parts.join("/");
}

export async function resolveInside(root: string, relativePath: string, mustExist: boolean): Promise<string> {
  const safePath = normalizeRelativePath(relativePath);
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
