import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function createFixtureTracker(): {
  temporaryRoot(prefix: string): Promise<string>;
  writeFixtureFile(
    root: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void>;
  cleanup(): Promise<void>;
} {
  const roots: string[] = [];

  return {
    async temporaryRoot(prefix: string): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), prefix));
      roots.push(root);
      return root;
    },

    async writeFixtureFile(
      root: string,
      relativePath: string,
      content: string | Uint8Array,
    ): Promise<void> {
      const absolutePath = join(root, ...relativePath.split("/"));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    },

    async cleanup(): Promise<void> {
      await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    },
  };
}
