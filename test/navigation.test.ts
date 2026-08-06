import { expect, test } from "bun:test";
import {
  DEFAULT_EXPLORER_LOCATION,
  explorerLocationsEqual,
  fuzzyMatch,
  parseExplorerLocation,
  rankFuzzy,
  serializeExplorerLocation,
  type ExplorerLocation,
} from "../src/web/navigation.ts";

test("explorer locations round-trip through their serialized form", () => {
  const cases = [
    { name: "default location", location: DEFAULT_EXPLORER_LOCATION },
    {
      name: "UML scope",
      location: {
        ...DEFAULT_EXPLORER_LOCATION,
        view: "uml",
        scope: "src/web",
      },
    },
    {
      name: "editor file with source position",
      location: {
        ...DEFAULT_EXPLORER_LOCATION,
        view: "editor",
        file: "src/web/main.ts",
        line: 42,
        column: 7,
      },
    },
    {
      name: "case-insensitive regular expression search",
      location: {
        ...DEFAULT_EXPLORER_LOCATION,
        query: "class\\s+Explorer",
        mode: "regex",
        caseInsensitive: true,
      },
    },
  ] as const satisfies readonly { name: string; location: ExplorerLocation }[];

  for (const { name, location } of cases) {
    expect(parseExplorerLocation(serializeExplorerLocation(location)), name).toEqual(location);
  }
});

test("serializeExplorerLocation emits only meaningful values in fixed key order", () => {
  const emptyValues: ExplorerLocation = {
    ...DEFAULT_EXPLORER_LOCATION,
    view: "editor",
    line: 4,
    column: 2,
  };
  expect(serializeExplorerLocation(emptyValues)).toBe("?view=editor");

  const complete: ExplorerLocation = {
    view: "editor",
    scope: "src",
    file: "src/main.ts",
    line: 4,
    column: 2,
    query: "main",
    mode: "path",
    caseInsensitive: true,
  };
  expect(serializeExplorerLocation(complete)).toBe(
    "?view=editor&scope=src&file=src%2Fmain.ts&line=4&col=2&q=main&m=path&ci=1",
  );
});

test("parseExplorerLocation normalizes safe paths and rejects unsafe paths", () => {
  const normalized = parseExplorerLocation(
    "?view=uml&scope=%20%2Fsrc%2Fweb%2F%20&file=.%2Fsrc%2Fmain.ts%2F",
  );
  expect(normalized).toEqual({
    ...DEFAULT_EXPLORER_LOCATION,
    view: "uml",
    scope: "src/web",
    file: "src/main.ts",
  });

  const cases = [
    { name: "parent traversal", search: "?file=../etc/passwd" },
    { name: "Windows separator", search: String.raw`?file=C:\x` },
    { name: "nested parent traversal", search: "?file=src/../secret.ts" },
  ] as const;

  for (const { name, search } of cases) {
    expect(parseExplorerLocation(search), name).toEqual(DEFAULT_EXPLORER_LOCATION);
  }
});

test("parseExplorerLocation defaults unknown values and requires a complete valid source position", () => {
  expect(parseExplorerLocation("")).toEqual(DEFAULT_EXPLORER_LOCATION);
  expect(parseExplorerLocation("?view=bogus&m=bogus&ci=true")).toEqual(
    DEFAULT_EXPLORER_LOCATION,
  );

  const cases = [
    { name: "zero line", position: "line=0&col=2" },
    { name: "non-numeric line", position: "line=abc&col=2" },
    { name: "missing column", position: "line=2" },
    { name: "missing line", position: "col=2" },
  ] as const;

  for (const { name, position } of cases) {
    expect(parseExplorerLocation(`?view=editor&file=src/main.ts&${position}`), name).toEqual({
      ...DEFAULT_EXPLORER_LOCATION,
      view: "editor",
      file: "src/main.ts",
    });
  }
});

test("explorerLocationsEqual compares every location field", () => {
  const location: ExplorerLocation = {
    ...DEFAULT_EXPLORER_LOCATION,
    view: "editor",
    file: "src/main.ts",
    line: 3,
    column: 5,
  };
  expect(explorerLocationsEqual(location, { ...location })).toBe(true);

  const cases = [
    { name: "view", change: { view: "uml" } },
    { name: "scope", change: { scope: "src" } },
    { name: "file", change: { file: "src/other.ts" } },
    { name: "line", change: { line: 4 } },
    { name: "column", change: { column: 6 } },
    { name: "query", change: { query: "main" } },
    { name: "mode", change: { mode: "path" } },
    { name: "case mode", change: { caseInsensitive: true } },
  ] as const satisfies readonly {
    name: string;
    change: Partial<ExplorerLocation>;
  }[];

  for (const { name, change } of cases) {
    expect(explorerLocationsEqual(location, { ...location, ...change }), name).toBe(false);
  }
});

test("fuzzyMatch performs deterministic greedy subsequence matching", () => {
  const renderMatch = fuzzyMatch("src/uml/render.ts", "rndr");
  const preprocessorMatch = fuzzyMatch("src/preprocessor.ts", "rndr");
  expect(renderMatch).toBeDefined();
  expect(renderMatch?.positions).toEqual([1, 10, 11, 13]);
  expect(
    preprocessorMatch === undefined
      || (renderMatch !== undefined && renderMatch.score > preprocessorMatch.score),
  ).toBe(true);
  expect(fuzzyMatch("abc", "z")).toBeUndefined();
  expect(fuzzyMatch("", "a")).toBeUndefined();
  expect(fuzzyMatch("abc", "")).toEqual({ score: 0, positions: [] });
});

test("rankFuzzy drops non-matches and applies limit and documented tie-breaks", () => {
  const ranked = rankFuzzy(["beta", "z", "aa", "a", "no match"], "", (item) => item, 3);
  expect(ranked.map(({ item }) => item)).toEqual(["a", "z", "aa"]);
  expect(ranked.every(({ match }) => match.score === 0)).toBe(true);

  expect(rankFuzzy(["alpha", "beta"], "z", (item) => item, 5)).toEqual([]);
  expect(rankFuzzy(["alpha"], "", (item) => item, 0)).toEqual([]);
});
