import { sep } from "node:path";

export function posix(path: string): string {
  return path.split(sep).join("/");
}

export function isTestPath(path: string): boolean {
  return /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[tj]sx?$|(^|[\\/])tests\.rs$/
    .test(path);
}

/** Repeated same-file namespace blocks share the occurrence-0 key as their export scope. */
export function canonicalScopeKey(scopeKey: string): string {
  try {
    const parts = JSON.parse(scopeKey) as unknown;
    if (!Array.isArray(parts) || parts.length !== 4) return scopeKey;
    return JSON.stringify([parts[0], parts[1], parts[2], 0]);
  } catch {
    return scopeKey;
  }
}
