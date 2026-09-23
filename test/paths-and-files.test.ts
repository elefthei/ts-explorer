import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  normalizeRelativePath,
  type PathErrorCode,
  resolveCacheDbPath,
  resolveInside,
  resolveSourceDir,
} from "../src/paths.ts";
import { createFixtureTracker } from "./support/fixtures.ts";

const fixtures = createFixtureTracker();

afterEach(fixtures.cleanup);

function expectNormalizationError(input: string, code: PathErrorCode): void {
  try {
    normalizeRelativePath(input);
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
}

test("normalizes relative paths into stable POSIX cache keys", () => {
  const cases = [
    { input: "", expected: "" },
    { input: ".", expected: "" },
    { input: "./src//nested/./index.ts", expected: "src/nested/index.ts" },
    { input: String.raw`src\nested\index.ts`, expected: "src/nested/index.ts" },
  ];

  for (const { input, expected } of cases) {
    expect(normalizeRelativePath(input)).toBe(expected);
  }
});

test("rejects NUL, absolute, drive-qualified, and traversal paths", () => {
  const cases: Array<{ input: string; code: PathErrorCode }> = [
    { input: "src/\0index.ts", code: "BAD_REQUEST" },
    { input: "/etc/passwd", code: "FORBIDDEN" },
    { input: String.raw`C:\Windows\system.ini`, code: "FORBIDDEN" },
    { input: String.raw`\\server\share\secret.ts`, code: "FORBIDDEN" },
    { input: "src/../secret.ts", code: "FORBIDDEN" },
    { input: String.raw`..\secret.ts`, code: "FORBIDDEN" },
  ];

  for (const { input, code } of cases) {
    expectNormalizationError(input, code);
  }
});

test("resolves ordinary files but rejects traversal, absolute paths, and symlink escapes", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-paths-");
  const outside = await fixtures.temporaryRoot("ts-explorer-outside-");
  await mkdir(join(root, "src"));
  const file = join(root, "src", "ok.ts");
  await writeFile(file, "export const ok = 1;\n");
  await writeFile(join(outside, "secret.ts"), "secret");
  await symlink(outside, join(root, "escape"), "junction");
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(file);

  await expect(resolveInside(root, "../secret.ts", true)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(resolveInside(root, "/etc/passwd", true)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(resolveInside(root, "escape/secret.ts", true)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(resolveInside(canonicalRoot, "escape/secret.ts", true)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await resolveInside(root, "src/ok.ts", true)).toBe(canonicalFile);
  expect(await resolveInside(canonicalRoot, "src/ok.ts", true)).toBe(canonicalFile);
});

const windowsOnly = test.skipIf(process.platform !== "win32");

windowsOnly("canonicalizes every WSL spelling of one root to the same source root and cache", () => {
  const canonical = String.raw`\\wsl.localhost\archlinux\home\Alice\Project\src`;
  const spellings = [
    canonical,
    String.raw`\\wsl$\archlinux\home\Alice\Project\src`,
    "//wsl.localhost/archlinux/home/Alice/Project/src",
    String.raw`\\?\UNC\wsl.localhost\archlinux\home\Alice\Project\src`,
    String.raw`\\?\UNC\wsl$\archlinux\home\Alice\Project\src`,
  ];

  for (const spelling of spellings) {
    expect(resolveSourceDir(spelling)).toBe(canonical);
    expect(resolveCacheDbPath(spelling)).toBe(resolveCacheDbPath(canonical));
  }
  // The cache lives off the redirector because SQLite cannot lock files on it.
  expect(resolveCacheDbPath(canonical)).not.toStartWith("\\\\");
});

windowsOnly("keeps Linux path case significant so sibling roots never share a cache", () => {
  const upper = String.raw`\\wsl.localhost\archlinux\home\Alice\Project\src`;
  const lower = String.raw`\\wsl.localhost\archlinux\home\Alice\project\src`;

  expect(resolveSourceDir(lower)).toBe(lower);
  expect(resolveCacheDbPath(upper)).not.toBe(resolveCacheDbPath(lower));
});

windowsOnly("leaves non-WSL roots at their native resolution", () => {
  const unrelated = [
    String.raw`\\server\share\Project\src`,
    String.raw`\\wsl.localhost.example\share\Project\src`,
    String.raw`\\?\C:\Project\src`,
    String.raw`C:\Temp\Project`,
  ];

  for (const path of unrelated) {
    expect(resolveSourceDir(path)).toBe(resolve(path));
    expect(resolveCacheDbPath(path)).toBe(join(resolve(path), ".explore", "explore.db"));
  }
});
