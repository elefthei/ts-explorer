import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSourceWatcher } from "../src/watcher.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("batches visible changes while suppressing cache changes under .explore", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-watch-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, ".explore"), { recursive: true }),
  ]);
  const firstFile = join(root, "src", "first.ts");
  const secondFile = join(root, "src", "second.js");
  const cacheFile = join(root, ".explore", "explore.db");
  await Promise.all([
    writeFile(firstFile, "export const first = 1;\n"),
    writeFile(secondFile, "export const second = 1;\n"),
    writeFile(cacheFile, "generation 1\n"),
  ]);

  let resolveBatch!: (batch: { paths: string[]; events: string[] }) => void;
  let rejectBatch!: (error: Error) => void;
  const batch = new Promise<{ paths: string[]; events: string[] }>((resolve, reject) => {
    resolveBatch = resolve;
    rejectBatch = reject;
  });
  const watcher = await startSourceWatcher(
    root,
    (paths, events) => resolveBatch({ paths, events }),
    rejectBatch,
  );

  try {
    await Promise.all([
      writeFile(firstFile, "export const first = 2;\n"),
      writeFile(secondFile, "export const second = 2;\n"),
      writeFile(cacheFile, "generation 2\n"),
    ]);

    const result = await batch;
    expect(result).toEqual({
      paths: ["src/first.ts", "src/second.js"],
      events: ["change", "change"],
    });
  } finally {
    await watcher.close();
  }
}, 5_000);

test("rejects when the watch root cannot be watched", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-watch-"));
  roots.push(root);
  // Root user ignores permission bits, so this case cannot be exercised there.
  if (process.getuid?.() === 0) return;
  await chmod(root, 0o000);

  try {
    await expect(
      startSourceWatcher(
        root,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow(/EACCES|permission denied/i);
  } finally {
    await chmod(root, 0o700);
  }
}, 5_000);
