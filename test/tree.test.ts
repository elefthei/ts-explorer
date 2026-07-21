import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTree, readDirectoryEntries, readTree } from "../src/tree.ts";
import type { TreeNode } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads only immediate visible entries and classifies source paths case-sensitively", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-tree-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "src", "nested"), { recursive: true }),
    mkdir(join(root, "src", ".explore"), { recursive: true }),
    mkdir(join(root, "src", "node_modules"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "nested", "deep.ts"), "export {};\n"),
    writeFile(join(root, "src", ".explore", "cached.ts"), "export {};\n"),
    writeFile(join(root, "src", "node_modules", "dependency.js"), "export {};\n"),
    writeFile(join(root, "src", "01.ts"), "export {};\n"),
    writeFile(join(root, "src", "02.tsx"), "export {};\n"),
    writeFile(join(root, "src", "03.mts"), "export {};\n"),
    writeFile(join(root, "src", "04.cts"), "export {};\n"),
    writeFile(join(root, "src", "05.js"), "export {};\n"),
    writeFile(join(root, "src", "06.jsx"), "export {};\n"),
    writeFile(join(root, "src", "07.mjs"), "export {};\n"),
    writeFile(join(root, "src", "08.cjs"), "export {};\n"),
    writeFile(join(root, "src", "09.TS"), "export {};\n"),
    writeFile(join(root, "src", "10.JS"), "export {};\n"),
    writeFile(join(root, "src", "11.md"), "# Visible text\n"),
  ]);
  await symlink(join(root, "src", "nested"), join(root, "src", "linked"), "junction");

  const entries = await readDirectoryEntries(root, "./src//");

  expect(entries).toEqual([
    { name: "nested", path: "src/nested", kind: "directory" },
    { name: "01.ts", path: "src/01.ts", kind: "file", viewable: true },
    { name: "02.tsx", path: "src/02.tsx", kind: "file", viewable: true },
    { name: "03.mts", path: "src/03.mts", kind: "file", viewable: true },
    { name: "04.cts", path: "src/04.cts", kind: "file", viewable: true },
    { name: "05.js", path: "src/05.js", kind: "file", viewable: true },
    { name: "06.jsx", path: "src/06.jsx", kind: "file", viewable: true },
    { name: "07.mjs", path: "src/07.mjs", kind: "file", viewable: true },
    { name: "08.cjs", path: "src/08.cjs", kind: "file", viewable: true },
    { name: "09.TS", path: "src/09.TS", kind: "file", viewable: false },
    { name: "10.JS", path: "src/10.JS", kind: "file", viewable: false },
    { name: "11.md", path: "src/11.md", kind: "file", viewable: false },
  ]);
});

test("reconstructs and sorts a nested tree from unordered flat entries", () => {
  const entries: TreeNode[] = [
    { name: "zeta.js", path: "zeta.js", kind: "file", viewable: true },
    { name: "second.ts", path: "beta/second.ts", kind: "file", viewable: true },
    { name: "nested", path: "beta/nested", kind: "directory" },
    { name: "leaf.jsx", path: "beta/nested/leaf.jsx", kind: "file", viewable: true },
    { name: "beta", path: "beta", kind: "directory" },
    { name: "alpha", path: "alpha", kind: "directory" },
    { name: "first.md", path: "beta/first.md", kind: "file", viewable: false },
    { name: "alpha.txt", path: "alpha.txt", kind: "file", viewable: false },
  ];

  const tree = buildTree("C:/workspace/example", entries);

  expect(tree.children).toEqual([
    { name: "alpha", path: "alpha", kind: "directory", children: [] },
    {
      name: "beta",
      path: "beta",
      kind: "directory",
      children: [
        {
          name: "nested",
          path: "beta/nested",
          kind: "directory",
          children: [
            {
              name: "leaf.jsx",
              path: "beta/nested/leaf.jsx",
              kind: "file",
              viewable: true,
            },
          ],
        },
        { name: "first.md", path: "beta/first.md", kind: "file", viewable: false },
        { name: "second.ts", path: "beta/second.ts", kind: "file", viewable: true },
      ],
    },
    { name: "alpha.txt", path: "alpha.txt", kind: "file", viewable: false },
    { name: "zeta.js", path: "zeta.js", kind: "file", viewable: true },
  ]);
});

test("reads a complete nested tree with the directory-entry traversal rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-read-tree-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "src", "nested", "deeper"), { recursive: true }),
    mkdir(join(root, "src", "nested", "coverage"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "nested", "deeper", "leaf.ts"), "export {};\n"),
    writeFile(join(root, "src", "nested", "deeper", "notes.md"), "# Notes\n"),
    writeFile(join(root, "src", "nested", "deeper", "upper.TS"), "export {};\n"),
    writeFile(join(root, "src", "nested", "coverage", "hidden.ts"), "export {};\n"),
  ]);
  await symlink(
    join(root, "src", "nested", "deeper"),
    join(root, "src", "nested", "linked"),
    "junction",
  );

  const tree = await readTree(root);

  expect(tree.children).toEqual([
    {
      name: "src",
      path: "src",
      kind: "directory",
      children: [
        {
          name: "nested",
          path: "src/nested",
          kind: "directory",
          children: [
            {
              name: "deeper",
              path: "src/nested/deeper",
              kind: "directory",
              children: [
                {
                  name: "leaf.ts",
                  path: "src/nested/deeper/leaf.ts",
                  kind: "file",
                  viewable: true,
                },
                {
                  name: "notes.md",
                  path: "src/nested/deeper/notes.md",
                  kind: "file",
                  viewable: false,
                },
                {
                  name: "upper.TS",
                  path: "src/nested/deeper/upper.TS",
                  kind: "file",
                  viewable: false,
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});
