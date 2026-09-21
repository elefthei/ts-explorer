import { sep } from "node:path";

export function posix(path: string): string {
  return path.split(sep).join("/");
}

export function isTestPath(path: string): boolean {
  return /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[tj]sx?$|(^|[\\/])tests\.rs$/
    .test(path);
}
