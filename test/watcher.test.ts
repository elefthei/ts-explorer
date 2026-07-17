import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSourceWatcher } from "../src/watcher.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

test("batches external TypeScript changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-watch-"));
  await mkdir(join(root, "src"));
  const file = join(root, "src", "index.ts");
  await writeFile(file, "export const value = 1;\n");
  const batch = new Promise<{ paths: string[]; events: string[] }>((resolve) => {
    void startSourceWatcher(root, (paths, events) => resolve({ paths, events }), (error) => { throw error; }).then((watcher) => closers.push(watcher.close));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(file, "export const value = 2;\n");
  const result = await Promise.race([batch, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watch timeout")), 3000))]);
  expect(result.paths).toEqual(["src/index.ts"]);
  expect(result.events).toContain("change");
});
