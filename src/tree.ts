import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isEditablePath } from "./types.ts";
import type { TreeNode } from "./types.ts";

const IGNORED = new Set([".git", "node_modules", "dist", "coverage", ".cache", "build", "out"]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export async function readTree(sourceDir: string): Promise<TreeNode> {
  async function readDirectory(directory: string): Promise<TreeNode[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nodes: Array<TreeNode | null> = await Promise.all(entries
      .filter((entry) => !IGNORED.has(entry.name) && !entry.isSymbolicLink())
      .map(async (entry): Promise<TreeNode | null> => {
        const absolute = join(directory, entry.name);
        const path = toPosix(relative(sourceDir, absolute));
        if (entry.isDirectory()) {
          return { name: entry.name, path, kind: "directory", children: await readDirectory(absolute) };
        }
        if (!entry.isFile()) return null;
        return { name: entry.name, path, kind: "file", editable: isEditablePath(path) };
      }));
    return nodes.filter((node): node is TreeNode => node !== null).sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }
  return { name: sourceDir.split(sep).at(-1) || sourceDir, path: "", kind: "directory", children: await readDirectory(sourceDir) };
}
