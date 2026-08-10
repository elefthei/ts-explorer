import { expect, test } from "bun:test";
import { fuzzyMatch, rankFuzzy } from "../src/web/navigation.ts";

test("fuzzyMatch returns a zero score for an empty query", () => {
  expect(fuzzyMatch("src/uml/render.ts", "")).toEqual({ score: 0, positions: [] });
});

test("fuzzyMatch rejects candidates missing a query character", () => {
  expect(fuzzyMatch("abc", "z")).toBeUndefined();
  expect(fuzzyMatch("", "a")).toBeUndefined();
});

test("fuzzyMatch reports the matched positions in order", () => {
  const match = fuzzyMatch("src/uml/render.ts", "rndr");
  expect(match).toBeDefined();
  expect(match?.positions).toEqual([1, 10, 11, 13]);
});

test("fuzzyMatch prefers boundary-aligned candidates", () => {
  const target = fuzzyMatch("src/uml/render.ts", "rndr");
  const other = fuzzyMatch("src/preprocessor.ts", "rndr");
  expect(target).toBeDefined();
  expect(other === undefined || other.score < (target?.score ?? 0), "render outranks preprocessor")
    .toBe(true);
});

test("rankFuzzy drops non-matches, honors the limit and breaks ties by length", () => {
  const items = ["src/uml/render.ts", "src/uml/rd.ts", "src/cli.ts"] as const;
  const ranked = rankFuzzy(items, "rd", (item) => item, 2);
  expect(ranked.map((entry) => entry.item), "ranked items").toEqual([
    "src/uml/rd.ts",
    "src/uml/render.ts",
  ]);
});

test("rankFuzzy with an empty query matches everything up to the limit", () => {
  const items = ["bb", "a", "c"] as const;
  const ranked = rankFuzzy(items, "", (item) => item, 2);
  expect(ranked.map((entry) => entry.item), "ranked items").toEqual(["a", "c"]);
  expect(ranked.every((entry) => entry.match.score === 0), "empty query scores").toBe(true);
});
