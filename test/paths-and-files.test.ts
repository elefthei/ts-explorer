import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveInside } from "../src/paths.ts";
import { createExplorerStore } from "../src/store.ts";

test("rejects traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "ts-explorer-outside-"));
  await mkdir(join(root, "src"));
  const file = join(root, "src", "ok.ts");
  await writeFile(file, "export const ok = 1;\n");
  await writeFile(join(outside, "secret.ts"), "secret");
  await symlink(outside, join(root, "escape"));
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(file);

  await expect(resolveInside(root, "../secret.ts", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(resolveInside(root, "/etc/passwd", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(resolveInside(root, "escape/secret.ts", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(resolveInside(canonicalRoot, "escape/secret.ts", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await resolveInside(root, "src/ok.ts", true)).toBe(canonicalFile);
  expect(await resolveInside(canonicalRoot, "src/ok.ts", true)).toBe(canonicalFile);
});

test("formats without writing and saves only with a matching content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-files-"));
  await mkdir(join(root, "src"));
  const path = join(root, "src", "index.ts");
  await writeFile(path, "export const value=1\n");
  const store = createExplorerStore(root);
  const opened = await store.readFile("src/index.ts");
  const formatted = await store.formatFile("src/index.ts", "export const other=2\n");
  expect(formatted).toContain("export const other = 2;");
  expect(await readFile(path, "utf8")).toBe("export const value=1\n");
  await writeFile(path, "export const external = 3;\n");
  await expect(store.writeFile("src/index.ts", formatted, opened.hash)).rejects.toMatchObject({ code: "CONFLICT" });
  const current = await store.readFile("src/index.ts");
  const saved = await store.writeFile("src/index.ts", formatted, current.hash);
  expect(saved.content).toBe(formatted);
  await store.close();
});
