import { posix } from "node:path";
import type { PackageInfo, SearchResponse } from "./types.ts";

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function containsPath(parent: string, child: string): boolean {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

export function buildSearchScopes(
  files: readonly string[],
  packages: readonly PackageInfo[],
): Pick<SearchResponse, "directories" | "renderDirs"> {
  const directories = new Set<string>();
  const immediateParents = new Set<string>();
  const packagesBySpecificity = [...packages].sort((left, right) =>
    pathDepth(right.path) - pathDepth(left.path) || left.path.localeCompare(right.path)
  );

  for (const file of new Set(files)) {
    const immediateParent = posix.dirname(file) === "." ? "" : posix.dirname(file);
    immediateParents.add(immediateParent);
    const packagePath = packagesBySpecificity.find((pkg) => containsPath(pkg.path, file))?.path ?? "";
    let current = immediateParent;
    while (true) {
      directories.add(current);
      if (current === packagePath || current === "") break;
      const parent = posix.dirname(current);
      current = parent === "." ? "" : parent;
    }
  }

  const renderDirs: string[] = [];
  const orderedParents = [...immediateParents].sort((left, right) =>
    pathDepth(left) - pathDepth(right) || left.localeCompare(right)
  );
  for (const directory of orderedParents) {
    if (!renderDirs.some((parent) => containsPath(parent, directory))) renderDirs.push(directory);
  }

  return {
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
    renderDirs: renderDirs.sort((left, right) => left.localeCompare(right)),
  };
}

