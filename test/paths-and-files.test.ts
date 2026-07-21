import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeRelativePath,
  type PathErrorCode,
  resolveInside,
} from "../src/paths.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "ts-explorer-outside-"));
  roots.push(root, outside);
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
