import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { posix } from "node:path";
import { simpleGit } from "simple-git";
import type { PackageInfo, SearchResponse, TreeNode } from "./types.ts";

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function collectFilePaths(node: TreeNode, paths: Set<string>): void {
  if (node.kind === "file") {
    paths.add(node.path);
    return;
  }
  for (const child of node.children ?? []) collectFilePaths(child, paths);
}

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

export async function searchRepository(
  sourceDir: string,
  query: string,
  packages: readonly PackageInfo[],
  tree: TreeNode,
): Promise<Omit<SearchResponse, "version">> {
  const realSourceDir = await realpath(sourceDir);
  const git = simpleGit({
    baseDir: realSourceDir,
    maxConcurrentProcesses: 1,
    timeout: { block: 30_000 },
  });
  const repositoryRoot = await realpath((await git.revparse(["--show-toplevel"])).trim());
  const sourcePrefix = toPosix(relative(repositoryRoot, realSourceDir));
  if (sourcePrefix === ".." || sourcePrefix.startsWith("../")) {
    throw new Error("source directory is outside the Git working tree");
  }

  const visibleFiles = new Set<string>();
  collectFilePaths(tree, visibleFiles);
  const grep = await git.grep(query, ["-i", "-F", "-I"]);
  const files = new Set<string>();
  for (const rawPath of grep.paths) {
    const repositoryPath = rawPath.replaceAll("\\", "/");
    let sourcePath: string;
    if (!sourcePrefix) sourcePath = repositoryPath;
    else {
      const prefix = `${sourcePrefix}/`;
      if (!repositoryPath.startsWith(prefix)) continue;
      sourcePath = repositoryPath.slice(prefix.length);
    }
    if (visibleFiles.has(sourcePath)) files.add(sourcePath);
  }

  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  return {
    query,
    files: sortedFiles,
    definitions: [],
    ...buildSearchScopes(sortedFiles, packages),
  };
}
