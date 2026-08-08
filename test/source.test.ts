import { expect, test } from "bun:test";
import {
  isDeclarationPath,
  isSourcePath,
  isTraversalIgnoredPath,
  isTypeScriptPath,
  isUmlIgnoredPath,
} from "../src/source.ts";

test("isSourcePath accepts all supported source extensions", () => {
  for (const path of [
    "a.ts",
    "a.tsx",
    "a.mts",
    "a.cts",
    "a.js",
    "a.jsx",
    "a.mjs",
    "a.cjs",
  ]) {
    expect(isSourcePath(path)).toBe(true);
  }
});

test("isSourcePath rejects non-source extensions", () => {
  for (const path of ["a.json", "a.md", "a.css", "a.txt", "a"]) {
    expect(isSourcePath(path)).toBe(false);
  }
});

test("isTypeScriptPath accepts only TypeScript extensions", () => {
  for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts"]) {
    expect(isTypeScriptPath(path)).toBe(true);
  }
  for (const path of ["a.js", "a.jsx", "a.mjs", "a.cjs", "a.json"]) {
    expect(isTypeScriptPath(path)).toBe(false);
  }
});

test("isDeclarationPath matches .d.ts family suffixes only", () => {
  for (const path of ["a.d.ts", "a.d.tsx", "a.d.mts", "a.d.cts", "src/b.d.ts"]) {
    expect(isDeclarationPath(path)).toBe(true);
  }
  for (const path of ["a.ts", "a.d.js", "ad.ts", "a.d.tsx.bak"]) {
    expect(isDeclarationPath(path)).toBe(false);
  }
});

test("isTraversalIgnoredPath flags paths containing ignored directory segments", () => {
  for (const path of [
    "node_modules/foo/index.ts",
    ".git/HEAD",
    "dist/main.js",
    "coverage/lcov.info",
    ".cache/data",
    "build/out.js",
    "out/main.js",
    ".explore/explore.db",
    "src/node_modules/leaf.ts",
  ]) {
    expect(isTraversalIgnoredPath(path)).toBe(true);
  }
});

test("isTraversalIgnoredPath allows ordinary source paths", () => {
  for (const path of ["src/main.ts", "test/foo.test.ts", "README.md"]) {
    expect(isTraversalIgnoredPath(path)).toBe(false);
  }
});

test("isTraversalIgnoredPath handles backslash path separators", () => {
  expect(isTraversalIgnoredPath("node_modules\\foo\\index.ts")).toBe(true);
  expect(isTraversalIgnoredPath("src\\main.ts")).toBe(false);
});

test("isUmlIgnoredPath only flags the smaller UML-ignored set", () => {
  for (const path of [".git/HEAD", "node_modules/foo/index.ts", ".explore/explore.db"]) {
    expect(isUmlIgnoredPath(path)).toBe(true);
  }
  // dist/coverage/build/out are traversal-ignored but not UML-ignored
  for (const path of ["dist/main.js", "coverage/lcov.info", "build/out.js", "out/main.js"]) {
    expect(isUmlIgnoredPath(path)).toBe(false);
  }
});
