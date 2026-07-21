import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackages, buildPackageDiagram } from "../src/packages.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("discovers workspace packages and only workspace dependency edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-packages-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await mkdir(join(root, "packages", "a"), { recursive: true });
  await mkdir(join(root, "packages", "b"), { recursive: true });
  await writeFile(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "a", dependencies: { b: "*", external: "*" } }));
  await writeFile(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b", devDependencies: {} }));

  const expected = [
    { name: "a", path: "packages/a", dependencies: ["b"] },
    { name: "b", path: "packages/b", dependencies: [] },
  ];
  const packages = await discoverPackages(root);
  const canonicalPackages = await discoverPackages(await realpath(root));
  expect(packages).toEqual(expected);
  expect(canonicalPackages).toEqual(expected);
  expect(buildPackageDiagram(packages)).toEqual({
    dsl: [
      "flowchart LR",
      '  p0["a"]',
      '  p1["b"]',
      "  p0 --> p1",
      "  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
      "  class p0 package",
      "  class p1 package",
    ].join("\n"),
    packageNodes: [
      { nodeId: "p0", name: "a", path: "packages/a" },
      { nodeId: "p1", name: "b", path: "packages/b" },
    ],
  });
});

test("omits malformed child manifests without crashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-packages-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await mkdir(join(root, "packages", "broken"), { recursive: true });
  await writeFile(join(root, "packages", "broken", "package.json"), "{");
  const packages = await discoverPackages(root);
  expect(packages).toEqual([]);
  expect(buildPackageDiagram(packages)).toEqual({
    dsl: [
      "flowchart LR",
      '  source["No workspace packages"]',
      "  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
    ].join("\n"),
    packageNodes: [],
  });
});
