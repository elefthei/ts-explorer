import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSourceDir } from "../src/paths.ts";
import { startSourceWatcher } from "../src/watcher.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("batches visible changes while suppressing cache changes under .explore", async () => {
  // Fixture I/O uses the canonical root because Bun's writes fail on namespaced UNC spellings, while
  // the watcher receives TEMP/TMP exactly as configured to prove the application canonicalizes it.
  const root = await mkdtemp(join(resolveSourceDir(tmpdir()), "ts-explorer-watch-"));
  roots.push(root);
  const watchedArgument = join(tmpdir(), basename(root));
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

  const expectedPaths = ["src/first.ts", "src/second.js"];
  const batches: { paths: string[]; events: string[] }[] = [];
  const observed = new Map<string, string>();
  const errors: Error[] = [];
  const completion = Promise.withResolvers<void>();
  // Chokidar restarts write stabilization per path, so the two edits may arrive in separate batches.
  const watcher = await startSourceWatcher(
    watchedArgument,
    (paths, events) => {
      batches.push({ paths: [...paths], events: [...events] });
      for (const [index, path] of paths.entries()) observed.set(path, events[index] as string);
      if (expectedPaths.every((path) => observed.has(path))) completion.resolve();
    },
    (error) => {
      errors.push(error);
      completion.reject(error);
    },
  );
  // Real filesystem delivery has no deterministic clock to advance; this integration deadline fails
  // the gate below the test timeout so the watcher still closes before fixture removal.
  const watchdog = setTimeout(
    () => completion.reject(new Error(`watch batches incomplete: ${JSON.stringify(batches)}`)),
    30_000,
  );

  try {
    await Promise.all([
      writeFile(firstFile, "export const first = 2;\n"),
      writeFile(secondFile, "export const second = 2;\n"),
      writeFile(cacheFile, "generation 2\n"),
    ]);

    await completion.promise;
    for (const { paths, events } of batches) {
      expect(events).toHaveLength(paths.length);
      expect(paths).toEqual([...new Set(paths)].sort((left, right) => left.localeCompare(right)));
    }
    expect(Object.fromEntries([...observed].sort(([left], [right]) => left.localeCompare(right))))
      .toEqual({ "src/first.ts": "change", "src/second.js": "change" });
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(watchdog);
    await watcher.close();
  }
}, 60_000);
