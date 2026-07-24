import { afterEach, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Cache } from "../src/cache.ts";
import {
  discoverPackages,
  extractPackageDiagramGraph,
} from "../src/packages.ts";
import type { PackageInfo } from "../src/types.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { renderDiagramGraph } from "./support/normalized-graph.ts";

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});

async function materializePackageDiagram(
  packages: readonly PackageInfo[],
  renderMode: "normal" | "bare" = "normal",
) {
  const cacheRoot = await fixtures.temporaryRoot("ts-explorer-package-cache-");
  let cache: Cache | undefined;
  try {
    cache = new Cache(join(cacheRoot, "cache.sqlite"));
    const generationId = cache.beginGeneration("startup");
    const extracted = extractPackageDiagramGraph(packages, renderMode);
    const outcome = renderMode === "bare"
      ? { status: "error" as const, error: "package discovery failed" }
      : { status: "ready" as const };
    const cached = cache.writeDiscovery(
      generationId,
      packages,
      { graph: extracted, outcome },
      renderDiagramGraph,
    );
    const reloaded = cache.readDiagramGraph(generationId, "packages", "");
    if (reloaded?.kind !== "packages") {
      throw new Error("materialized package diagram graph was not found");
    }
    return {
      extracted,
      reloaded,
      rendered: renderDiagramGraph(reloaded),
      cached,
    };
  } finally {
    cache?.close();
  }
}

test("discovers workspace packages and only workspace dependency edges", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-packages-");
  await fixtures.writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  await fixtures.writeFixtureFile(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "a", dependencies: { b: "*", external: "*" } }),
  );
  await fixtures.writeFixtureFile(
    root,
    "packages/b/package.json",
    JSON.stringify({ name: "b", devDependencies: {} }),
  );

  const expected = [
    { name: "a", path: "packages/a", dependencies: ["b"] },
    { name: "b", path: "packages/b", dependencies: [] },
  ];
  const packages = await discoverPackages(root);
  const canonicalPackages = await discoverPackages(await realpath(root));
  expect(packages).toEqual(expected);
  expect(canonicalPackages).toEqual(expected);

  const { extracted, reloaded, rendered, cached } = await materializePackageDiagram(packages);
  expect(reloaded).toEqual(extracted);
  expect(reloaded.nodes).toEqual([
    {
      nodeId: "p0",
      nodeOrdinal: 0,
      nodeKind: "package",
      name: "a",
      community: null,
    },
    {
      nodeId: "p1",
      nodeOrdinal: 1,
      nodeKind: "package",
      name: "b",
      community: null,
    },
  ]);
  expect(reloaded.packageNodes).toEqual([
    { nodeId: "p0", packagePath: "packages/a" },
    { nodeId: "p1", packagePath: "packages/b" },
  ]);
  expect(reloaded.edges).toEqual([
    {
      edgeOrdinal: 0,
      sourceNodeId: "p0",
      targetNodeId: "p1",
      edgeKind: "package-dependency",
      directed: true,
      weight: 1,
    },
  ]);
  expect(reloaded.relations).toEqual([
    {
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "package-dependency",
      sourceNodeId: "p0",
      targetNodeId: "p1",
    },
  ]);

  const expectedDsl = [
    "flowchart LR",
    '  p0["a"]',
    '  p1["b"]',
    "  p0 --> p1",
    "  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
    "  class p0 package",
    "  class p1 package",
  ].join("\n");
  expect({
    dsl: rendered.dsl,
    packageNodes: rendered.packageNodes,
  }).toEqual({
    dsl: expectedDsl,
    packageNodes: [
      { nodeId: "p0", name: "a", path: "packages/a" },
      { nodeId: "p1", name: "b", path: "packages/b" },
    ],
  });
  expect(rendered).toEqual(renderDiagramGraph(extracted));
  expect(cached).toEqual({
    kind: "packages",
    scopePath: "",
    status: "ready",
    ...rendered,
  });
});

test("omits malformed child manifests without crashing", async () => {
  const root = await fixtures.temporaryRoot("ts-explorer-packages-");
  await fixtures.writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  await fixtures.writeFixtureFile(root, "packages/broken/package.json", "{");
  const packages = await discoverPackages(root);
  expect(packages).toEqual([]);

  const { extracted, reloaded, rendered } = await materializePackageDiagram(packages);
  expect(reloaded).toEqual(extracted);
  expect(reloaded.nodes).toEqual([
    {
      nodeId: "source",
      nodeOrdinal: 0,
      nodeKind: "placeholder",
      name: "No workspace packages",
      community: null,
    },
  ]);
  expect(reloaded.packageNodes).toEqual([{ nodeId: "source", packagePath: null }]);
  expect(reloaded.edges).toEqual([]);
  expect(reloaded.relations).toEqual([]);
  expect({
    dsl: rendered.dsl,
    packageNodes: rendered.packageNodes,
  }).toEqual({
    dsl: [
      "flowchart LR",
      '  source["No workspace packages"]',
      "  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
    ].join("\n"),
    packageNodes: [],
  });
  expect(rendered).toEqual(renderDiagramGraph(extracted));
});
 
test("materializes a bare package error graph without topology rows", async () => {
  const { extracted, reloaded, rendered, cached } = await materializePackageDiagram([], "bare");

  expect(reloaded).toEqual(extracted);
  expect(reloaded.renderMode).toBe("bare");
  expect(reloaded.nodes).toEqual([]);
  expect(reloaded.aliases).toEqual([]);
  expect(reloaded.edges).toEqual([]);
  expect(reloaded.relations).toEqual([]);
  expect(reloaded.packageNodes).toEqual([]);
  expect(rendered).toEqual({
    dsl: "flowchart LR",
    dsls: ["flowchart LR"],
    packageNodes: [],
    definitions: [],
    externalUsers: [],
    localUsers: [],
  });
  expect(cached).toEqual({
    kind: "packages",
    scopePath: "",
    status: "error",
    error: "package discovery failed",
    ...rendered,
  });
});

test("preserves ordered directed dependencies including package self-edges", async () => {
  const packages: PackageInfo[] = [
    {
      name: "a",
      path: "packages/a",
      dependencies: ["a", "b"],
    },
    {
      name: "b",
      path: "packages/b",
      dependencies: [],
    },
  ];
  const { extracted, reloaded, rendered } = await materializePackageDiagram(packages);

  expect(reloaded).toEqual(extracted);
  expect(reloaded.edges).toEqual([
    {
      edgeOrdinal: 0,
      sourceNodeId: "p0",
      targetNodeId: "p0",
      edgeKind: "package-dependency",
      directed: true,
      weight: 1,
    },
    {
      edgeOrdinal: 1,
      sourceNodeId: "p0",
      targetNodeId: "p1",
      edgeKind: "package-dependency",
      directed: true,
      weight: 1,
    },
  ]);
  expect(reloaded.relations).toEqual([
    {
      edgeOrdinal: 0,
      relationOrdinal: 0,
      relationKind: "package-dependency",
      sourceNodeId: "p0",
      targetNodeId: "p0",
    },
    {
      edgeOrdinal: 1,
      relationOrdinal: 0,
      relationKind: "package-dependency",
      sourceNodeId: "p0",
      targetNodeId: "p1",
    },
  ]);
  expect(rendered.dsl).toBe([
    "flowchart LR",
    '  p0["a"]',
    '  p1["b"]',
    "  p0 --> p0",
    "  p0 --> p1",
    "  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
    "  class p0 package",
    "  class p1 package",
  ].join("\n"));
  expect(rendered).toEqual(renderDiagramGraph(extracted));
});
