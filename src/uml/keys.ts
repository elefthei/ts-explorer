import { relative, sep } from "node:path";

export function posix(path: string): string {
  return path.split(sep).join("/");
}

export function umlEntityKey(fileName: string, name: string): string {
  const path = posix(fileName);
  return `${process.platform === "win32" ? path.toLowerCase() : path}\0${name}`;
}

export function bareUmlName(name: string): string {
  const genericStart = name.indexOf("<");
  return genericStart === -1 ? name : name.slice(0, genericStart);
}

export function umlFileKey(fileName: string): string {
  const path = posix(fileName);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function scopeRelativePath(sourceDir: string, path: string): string {
  return posix(relative(sourceDir, path));
}
