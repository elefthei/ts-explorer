import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTree } from "../src/tree.ts";

test("builds sorted tree and marks supported TypeScript files editable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-tree-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "src", "a.tsx"), "export {};");
  await writeFile(join(root, "src", "b.d.ts"), "declare const b: string;");
  await writeFile(join(root, "node_modules", "ignored.ts"), "export {};");
  const tree = await readTree(root);
  expect(tree.children?.map((child) => child.name)).toEqual(["src", "README.md"]);
  expect(tree.children?.[0].children).toEqual([
    { name: "a.tsx", path: "src/a.tsx", kind: "file", editable: true },
    { name: "b.d.ts", path: "src/b.d.ts", kind: "file", editable: false },
  ]);
});
