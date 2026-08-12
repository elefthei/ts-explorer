import { afterEach, expect, test } from "bun:test";
import { ExplorerStore, InputError } from "../src/store.ts";
import type { GotoDefinition } from "../src/types.ts";
import { createFixtureTracker } from "./support/fixtures.ts";

const fixtures = createFixtureTracker();

const WORKSPACE: Record<string, string> = {
  "package.json": `{
  "name": "root",
  "private": true,
  "workspaces": ["packages/*"]
}
`,
  "packages/a/package.json": `{
  "name": "a"
}
`,
  "packages/b/package.json": `{
  "name": "b"
}
`,
  "packages/a/src/index.ts": `export class Shared {
  run(): void {}
}
`,
  "packages/b/src/index.ts": `export class Shared {
  run(): void {}
}
`,
  "packages/a/src/dup.ts": `export class Twin {}
export class Twin {}
`,
  "packages/a/src/types.d.ts": `export declare class Ambient {}
`,
  "packages/a/src/odd.ts": `export class Odd {
  "a%b"(): void {}
  "cd"(): void {}
}
`,
  "packages/a/src/notes.txt": `plain text
`,
  "node_modules/pkg/index.ts": `export class Vendored {}
`,
};

const SHARED_A_DEFINITION: GotoDefinition = {
  key: '["class","Shared",0,null,null]',
  kind: "class",
  name: "Shared",
  qualifiedName: "Shared",
  source: { path: "packages/a/src/index.ts", line: 1, column: 14 },
  uml: { scopePath: "packages/a/src/index.ts", entityName: "Shared" },
};

const ODD_DEFINITIONS: GotoDefinition[] = [
  {
    key: '["class","Odd",0,null,null]',
    kind: "class",
    name: "Odd",
    qualifiedName: "Odd",
    source: { path: "packages/a/src/odd.ts", line: 1, column: 14 },
    uml: { scopePath: "packages/a/src/odd.ts", entityName: "Odd" },
  },
  {
    key: '["class","Odd",0,"a%b",0]',
    kind: "method",
    name: "a%b",
    qualifiedName: "Odd.a%b",
    source: { path: "packages/a/src/odd.ts", line: 2, column: 3 },
    uml: {
      scopePath: "packages/a/src/odd.ts",
      entityName: "Odd",
      memberName: "a%b",
      memberOccurrence: 0,
    },
  },
  {
    key: '["class","Odd",0,"cd",0]',
    kind: "method",
    name: "cd",
    qualifiedName: "Odd.cd",
    source: { path: "packages/a/src/odd.ts", line: 3, column: 3 },
    uml: {
      scopePath: "packages/a/src/odd.ts",
      entityName: "Odd",
      memberName: "cd",
      memberOccurrence: 0,
    },
  },
];

afterEach(async () => {
  await fixtures.cleanup();
});

async function withWorkspaceStore(
  prefix: string,
  run: (store: ExplorerStore) => Promise<void>,
): Promise<void> {
  const root = await fixtures.temporaryRoot(prefix);
  for (const [path, source] of Object.entries(WORKSPACE)) {
    await fixtures.writeFixtureFile(root, path, source);
  }
  let resolvePromotion!: () => void;
  const promoted = new Promise<void>((resolve) => {
    resolvePromotion = resolve;
  });
  const store = new ExplorerStore(root, () => undefined, resolvePromotion);
  try {
    await store.ready();
    await promoted;
    await run(store);
  } finally {
    await store.close();
  }
}

test("duplicate definitions resolve to the earliest line then column", async () => {
  await withWorkspaceStore("ts-explorer-lookup-duplicates-", async (store) => {
    // characterizes: ORDER BY source_line, source_column LIMIT 1 (src/cache.ts:3025-3034)
    expect(await store.lookupDefinition("packages/a/src/dup.ts", "Twin", "Twin")).toEqual({
      version: 0,
      definition: { path: "packages/a/src/dup.ts", line: 1, column: 14 },
    });
  });
}, 60_000);

test("definition lookup is path-exact across packages", async () => {
  await withWorkspaceStore("ts-explorer-lookup-packages-", async (store) => {
    expect(await store.lookupDefinition("packages/a/src/index.ts", "Shared", "Shared")).toEqual({
      version: 0,
      definition: { path: "packages/a/src/index.ts", line: 1, column: 14 },
    });
    expect(await store.lookupDefinition("packages/b/src/index.ts", "Shared", "Shared")).toEqual({
      version: 0,
      definition: { path: "packages/b/src/index.ts", line: 1, column: 14 },
    });
    // characterizes: a path that does not declare the name resolves to null, never to a sibling
    expect(await store.lookupDefinition("packages/a/src/dup.ts", "Shared", "Shared")).toEqual({
      version: 0,
      definition: null,
    });
  });
}, 60_000);

test("search returns definitions from every package in path order", async () => {
  await withWorkspaceStore("ts-explorer-lookup-search-", async (store) => {
    const response = await store.search("Shared", false);

    expect(response.files).toEqual([
      "packages/a/src/index.ts",
      "packages/b/src/index.ts",
    ]);
    // characterizes: definitions sort by path, line, column then definition key
    expect(response.definitions).toEqual([
      SHARED_A_DEFINITION,
      {
        key: '["class","Shared",0,"run",0]',
        kind: "method",
        name: "run",
        qualifiedName: "Shared.run",
        source: { path: "packages/a/src/index.ts", line: 2, column: 3 },
        uml: {
          scopePath: "packages/a/src/index.ts",
          entityName: "Shared",
          memberName: "run",
          memberOccurrence: 0,
        },
      },
      {
        key: '["class","Shared",0,null,null]',
        kind: "class",
        name: "Shared",
        qualifiedName: "Shared",
        source: { path: "packages/b/src/index.ts", line: 1, column: 14 },
        uml: { scopePath: "packages/b/src/index.ts", entityName: "Shared" },
      },
      {
        key: '["class","Shared",0,"run",0]',
        kind: "method",
        name: "run",
        qualifiedName: "Shared.run",
        source: { path: "packages/b/src/index.ts", line: 2, column: 3 },
        uml: {
          scopePath: "packages/b/src/index.ts",
          entityName: "Shared",
          memberName: "run",
          memberOccurrence: 0,
        },
      },
    ]);
  });
}, 60_000);

test("unknown, non-source and out-of-range requests", async () => {
  await withWorkspaceStore("ts-explorer-lookup-edges-", async (store) => {
    // characterizes: an unindexed path is a miss, not an error
    expect(await store.getDefinition("packages/a/src/missing.ts", { line: 1, column: 1 })).toEqual({
      version: 0,
      definition: null,
    });
    // characterizes: getDefinition returns the stored definition without display offsets;
    // only readFile attaches displayFrom/displayTo to the definitions it returns
    expect(await store.getDefinition("packages/a/src/index.ts", { line: 1, column: 14 })).toEqual({
      version: 0,
      definition: SHARED_A_DEFINITION,
    });

    const nonSource = await store.readFile("packages/a/src/notes.txt").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(nonSource).toBeInstanceOf(InputError);
    expect((nonSource as InputError).message).toBe(
      "only TypeScript and JavaScript source files can be viewed",
    );

    const content = "export class Shared {\n  run(): void {}\n}\n";
    expect((await store.readFile("packages/a/src/index.ts")).content).toBe(content);
    // characterizes: a line past EOF clamps to the end of the file (offset 41 == content.length)
    expect((await store.readFile("packages/a/src/index.ts", { line: 999, column: 1 })).cursorOffset)
      .toBe(41);
    // characterizes: a column past EOL clamps to the last column of that line, before the newline
    expect((await store.readFile("packages/a/src/index.ts", { line: 2, column: 999 })).cursorOffset)
      .toBe(38);
    expect((await store.readFile("packages/a/src/index.ts", { line: 2, column: 3 })).cursorOffset)
      .toBe(24);
  });
}, 60_000);

test("declaration files and node_modules contribute no definitions", async () => {
  await withWorkspaceStore("ts-explorer-lookup-excluded-", async (store) => {
    const ambient = await store.search("Ambient", false);
    // characterizes: a .d.ts is still searchable as text but never yields a definition
    expect(ambient.files).toEqual(["packages/a/src/types.d.ts"]);
    expect(ambient.definitions).toEqual([]);

    const vendored = await store.search("Vendored", false);
    expect(vendored.files).toEqual([]);
    expect(vendored.definitions).toEqual([]);

    expect(await store.getDefinition("packages/a/src/types.d.ts", { line: 1, column: 22 })).toEqual({
      version: 0,
      definition: null,
    });
    expect(await store.getDefinition("node_modules/pkg/index.ts", { line: 1, column: 14 })).toEqual({
      version: 0,
      definition: null,
    });
  });
}, 60_000);

test("literal wildcard and short-query search", async () => {
  await withWorkspaceStore("ts-explorer-lookup-wildcard-", async (store) => {
    const wildcard = await store.search("a%b", false);
    // characterizes: `%` disables the indexed LIKE lookup, and the JS post-filter matches literally
    expect(wildcard.files).toEqual(["packages/a/src/odd.ts"]);
    expect(wildcard.definitions).toEqual([ODD_DEFINITIONS[1]]);

    const scanned = await store.search("Od", false);
    const indexed = await store.search("Odd", false);
    // characterizes: the <3 code point scan path and the trigram path agree
    expect(scanned.definitions).toEqual(ODD_DEFINITIONS);
    expect(indexed.definitions).toEqual(ODD_DEFINITIONS);
    expect(scanned.files).toEqual(["packages/a/src/odd.ts"]);
    expect(indexed.files).toEqual(["packages/a/src/odd.ts"]);
  });
}, 60_000);
