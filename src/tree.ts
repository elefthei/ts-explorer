import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { normalizeRelativePath, resolveInside } from "./paths.ts";
import { isSourcePath, isTraversalIgnoredPath } from "./source.ts";
import type { TreeNode } from "./types.ts";

function compareTreeNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export async function readDirectoryEntries(
  sourceDir: string,
  scopePath: string,
): Promise<TreeNode[]> {
  const normalizedScopePath = normalizeRelativePath(scopePath);
  const directory = await resolveInside(sourceDir, normalizedScopePath, true);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry): TreeNode | undefined => {
      const path = normalizeRelativePath(
        normalizedScopePath ? `${normalizedScopePath}/${entry.name}` : entry.name,
      );
      if (isTraversalIgnoredPath(path)) return undefined;
      if (entry.isDirectory()) return { name: entry.name, path, kind: "directory" };
      if (!entry.isFile()) return undefined;
      return { name: entry.name, path, kind: "file", viewable: isSourcePath(path) };
    })
    .filter((entry): entry is TreeNode => entry !== undefined)
    .sort(compareTreeNodes);
}

async function collectTreeEntries(
  sourceDir: string,
  scopePath: string,
): Promise<TreeNode[]> {
  const entries = await readDirectoryEntries(sourceDir, scopePath);
  const descendants = await Promise.all(
    entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => collectTreeEntries(sourceDir, entry.path)),
  );
  return entries.concat(...descendants);
}

export async function readTree(sourceDir: string): Promise<TreeNode> {
  return buildTree(sourceDir, await collectTreeEntries(sourceDir, ""));
}

export function buildTree(sourceDir: string, entries: readonly TreeNode[]): TreeNode {
  const root: TreeNode = {
    name: basename(resolve(sourceDir)) || sourceDir,
    path: "",
    kind: "directory",
    children: [],
  };
  const nodes = new Map<string, TreeNode>([["", root]]);

  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path);
    if (!path) continue;
    nodes.set(path, entry.kind === "directory"
      ? { name: entry.name, path, kind: "directory", children: [] }
      : { name: entry.name, path, kind: "file", viewable: entry.viewable === true });
  }

  for (const [path, node] of nodes) {
    if (!path) continue;
    const separator = path.lastIndexOf("/");
    const parentPath = separator === -1 ? "" : path.slice(0, separator);
    const parent = nodes.get(parentPath);
    if (parent?.kind === "directory") parent.children?.push(node);
  }

  for (const node of nodes.values()) {
    if (node.kind === "directory") node.children?.sort(compareTreeNodes);
  }
  return root;
}
