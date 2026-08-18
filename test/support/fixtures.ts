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
  fixtureRoot(prefix: string, files: Record<string, string | Uint8Array>): Promise<string>;
  cleanup(): Promise<void>;
} {
  const roots: string[] = [];

  const temporaryRoot = async (prefix: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };

  const writeFixtureFile = async (
    root: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    const absolutePath = join(root, ...relativePath.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  };

  return {
    temporaryRoot,
    writeFixtureFile,

    /** A temporary root pre-populated with `files`, keyed by root-relative POSIX path. */
    async fixtureRoot(
      prefix: string,
      files: Record<string, string | Uint8Array>,
    ): Promise<string> {
      const root = await temporaryRoot(prefix);
      for (const [path, content] of Object.entries(files)) {
        await writeFixtureFile(root, path, content);
      }
      return root;
    },

    async cleanup(): Promise<void> {
      await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    },
  };
}
