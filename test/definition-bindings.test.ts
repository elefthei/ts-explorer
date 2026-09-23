import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";
import type {
  DefinitionBinding,
  DefinitionBindingTarget,
  DefinitionIndexSnapshot,
} from "../src/uml/model.ts";

const firstKey = JSON.stringify(["a.ts", "class", "First", 0]);
const secondKey = JSON.stringify(["a.ts", "class", "Second", 0]);
const first: DefinitionBindingTarget = { kind: "definition", key: firstKey };
const second: DefinitionBindingTarget = { kind: "definition", key: secondKey };
const moduleTarget: DefinitionBindingTarget = { kind: "module", path: "module.ts" };

const binding = (
  name: string,
  bindingKind: DefinitionBinding["bindingKind"],
  target: DefinitionBindingTarget,
  ordinal = 0,
  space: DefinitionBinding["space"] = "type",
  scopeKey = "",
): DefinitionBinding => ({
  sourcePath: "a.ts",
  scopeKey,
  name,
  space,
  bindingKind,
  ordinal,
  target,
});

const snapshot: DefinitionIndexSnapshot = {
  entries: [{ name: "a.ts", path: "a.ts", kind: "file" }],
  definitions: [
    { key: firstKey, name: "First" },
    { key: secondKey, name: "Second" },
  ].map(({ key, name }, index) => ({
    key,
    name,
    qualifiedName: name,
    kind: "class",
    parentKey: null,
    isTopLevel: true,
    hasBody: true,
    type: null,
    source: { path: "a.ts", line: index + 1, column: 1 },
  })),
  bindings: [
    binding("Both", "local", first),
    binding("Both", "import", second),
    binding("Both", "export", second),
    binding("Imported", "import", moduleTarget),
    binding("LocalOnly", "local", first),
    binding("Ordered", "export", second, 1),
    binding("Ordered", "export", first, 0),
    binding("Both", "local", second, 0, "value"),
    binding("Both", "local", second, 0, "type", "inner"),
  ],
  contributors: [],
  imports: [],
};

const cases: {
  label: string;
  name: string;
  exported: boolean;
  space: DefinitionBinding["space"];
  scope: string;
  expected: DefinitionBindingTarget[];
}[] = [
  { label: "locals shadow imports", name: "Both", exported: false, space: "type", scope: "", expected: [first] },
  { label: "imports are the local fallback", name: "Imported", exported: false, space: "type", scope: "", expected: [moduleTarget] },
  { label: "exports are isolated", name: "Both", exported: true, space: "type", scope: "", expected: [second] },
  { label: "exports never fall back to locals", name: "LocalOnly", exported: true, space: "type", scope: "", expected: [] },
  { label: "exports never fall back to imports", name: "Imported", exported: true, space: "type", scope: "", expected: [] },
  { label: "targets retain ordinal order", name: "Ordered", exported: true, space: "type", scope: "", expected: [first, second] },
  { label: "value space is separate", name: "Both", exported: false, space: "value", scope: "", expected: [second] },
  { label: "lexical scope is separate", name: "Both", exported: false, space: "type", scope: "inner", expected: [second] },
];

for (const entry of cases) {
  test(`definition bindings: ${entry.label}`, () => {
    const root = mkdtempSync(join(tmpdir(), "bindings-"));
    const cache = new Cache(join(root, "cache.sqlite"));
    try {
      const generationId = cache.beginGeneration("startup", "bindings-test");
      cache.writeDefinitionIndex(generationId, snapshot);
      const index = cache.createDefinitionResolutionIndex(generationId);
      const result = index.bindings("a.ts", entry.scope, entry.name, entry.space, entry.exported);
      expect(result).toEqual(entry.expected);
    } finally {
      cache.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("bindings are scoped to their file and generation", () => {
  const root = mkdtempSync(join(tmpdir(), "bindings-"));
  const cache = new Cache(join(root, "cache.sqlite"));
  try {
    const generationId = cache.beginGeneration("startup", "bindings-test");
    cache.writeDefinitionIndex(generationId, snapshot);
    expect(
      cache.createDefinitionResolutionIndex(generationId)
        .bindings("other.ts", "", "Both", "type", false),
    ).toEqual([]);
    const otherGeneration = cache.beginGeneration("watch", "other-generation");
    expect(
      cache.createDefinitionResolutionIndex(otherGeneration)
        .bindings("a.ts", "", "Both", "type", false),
    ).toEqual([]);
  } finally {
    cache.close();
    rmSync(root, { recursive: true, force: true });
  }
});
