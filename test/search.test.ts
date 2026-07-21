import { expect, test } from "bun:test";
import { buildSearchScopes } from "../src/search.ts";
import type { PackageInfo } from "../src/types.ts";

const rootPackage: PackageInfo = { name: "root", path: "", dependencies: [] };

const cases: Array<{
  name: string;
  files: string[];
  packages: PackageInfo[];
  expected: {
    directories: string[];
    renderDirs: string[];
  };
}> = [
  {
    name: "root package includes the source root and collapses all render scopes under it",
    files: ["src/z.ts", "root.ts", "src/deep/a.ts"],
    packages: [rootPackage],
    expected: {
      directories: ["", "src", "src/deep"],
      renderDirs: [""],
    },
  },
  {
    name: "longest nested workspace wins only on a segment boundary",
    files: ["packages/app/modules/feature/src/a.ts"],
    packages: [
      { name: "app", path: "packages/app", dependencies: [] },
      { name: "deceptive-prefix", path: "packages/app/modules/feat", dependencies: [] },
      { name: "feature", path: "packages/app/modules/feature", dependencies: [] },
    ],
    expected: {
      directories: ["packages/app/modules/feature", "packages/app/modules/feature/src"],
      renderDirs: ["packages/app/modules/feature/src"],
    },
  },
  {
    name: "file outside every package falls back to a complete root chain",
    files: ["vendor/lib/tool.ts"],
    packages: [{ name: "app", path: "packages/app", dependencies: [] }],
    expected: {
      directories: ["", "vendor", "vendor/lib"],
      renderDirs: ["vendor/lib"],
    },
  },
  {
    name: "file directly in a package root renders and highlights that package root",
    files: ["packages/widget/index.ts"],
    packages: [{ name: "widget", path: "packages/widget", dependencies: [] }],
    expected: {
      directories: ["packages/widget"],
      renderDirs: ["packages/widget"],
    },
  },
  {
    name: "duplicates are removed, outputs are sorted, and ancestor parents minimally cover descendants",
    files: [
      "packages/demo/test/c.ts",
      "packages/demo/src/deep/b.ts",
      "packages/demo/src/a.ts",
      "packages/demo/src/deep/b.ts",
    ],
    packages: [{ name: "demo", path: "packages/demo", dependencies: [] }],
    expected: {
      directories: [
        "packages/demo",
        "packages/demo/src",
        "packages/demo/src/deep",
        "packages/demo/test",
      ],
      renderDirs: ["packages/demo/src", "packages/demo/test"],
    },
  },
];

test("buildSearchScopes derives package-capped highlight chains and minimal render covers", () => {
  for (const { name, files, packages, expected } of cases) {
    expect(buildSearchScopes(files, packages), name).toEqual(expected);
  }
});
