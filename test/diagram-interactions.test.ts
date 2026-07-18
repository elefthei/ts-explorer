import { expect, test } from "bun:test";
import {
  createRequestSequence,
  editorOffset,
  externalUserIdFromNodeId,
  formatUmlMethodReturnLabel,
  localUserIdFromNodeId,
  hasPassedDragThreshold,
  panViewport,
  resolveUmlSource,
  shouldStackDiagram,
  zoomViewportAt,
} from "../src/web/diagram-interactions.ts";
import type { UmlEntitySource, UmlSourceLocation } from "../src/types.ts";

function sourceLocation(location: UmlSourceLocation | undefined): UmlSourceLocation | undefined {
  return location && {
    path: location.path,
    line: location.line,
    column: location.column,
  };
}

test("shouldStackDiagram stacks UML diagrams but not package diagrams", () => {
  expect(shouldStackDiagram("uml")).toBe(true);
  expect(shouldStackDiagram("packages")).toBe(false);
});

test("createRequestSequence rejects tokens before any request is issued", () => {
  const sequence = createRequestSequence();
  const cases = [
    { name: "negative token", token: -1 },
    { name: "zero token", token: 0 },
    { name: "first positive token", token: 1 },
    { name: "future token", token: 42 },
  ];

  for (const { name, token } of cases) {
    expect(sequence.isCurrent(token), name).toBe(false);
  }
});

test("createRequestSequence transfers ownership to each monotonically issued token", () => {
  const sequence = createRequestSequence();

  const first = sequence.next();
  expect(first).toBe(1);
  expect(sequence.isCurrent(first)).toBe(true);

  const second = sequence.next();
  expect(second).toBe(2);
  expect(sequence.isCurrent(first)).toBe(false);
  expect(sequence.isCurrent(second)).toBe(true);

  const third = sequence.next();
  expect(third).toBe(3);
  expect(sequence.isCurrent(first)).toBe(false);
  expect(sequence.isCurrent(second)).toBe(false);
  expect(sequence.isCurrent(third)).toBe(true);
});

test("createRequestSequence instances issue tokens independently", () => {
  const firstSequence = createRequestSequence();
  const secondSequence = createRequestSequence();

  expect(firstSequence.next()).toBe(1);
  expect(firstSequence.next()).toBe(2);
  expect(secondSequence.next()).toBe(1);
  expect(firstSequence.isCurrent(2)).toBe(true);
  expect(secondSequence.isCurrent(1)).toBe(true);
});

test("externalUserIdFromNodeId resolves only installed Mermaid synthetic external-node IDs", () => {
  const cases = [
    { name: "standard installed ID", id: "classId-extern0-1", expected: "extern0" },
    {
      name: "prefixed installed ID with multi-digit node and render counters",
      id: "diagram-classId-extern27-314",
      expected: "extern27",
    },
    { name: "real class ID", id: "classId-Widget-1", expected: undefined },
    { name: "extern marker without node index", id: "classId-extern-1", expected: undefined },
    { name: "extern index with trailing text", id: "classId-extern12x-3", expected: undefined },
    { name: "synthetic ID without render counter", id: "classId-extern12", expected: undefined },
    { name: "raw external node name", id: "extern12", expected: undefined },
  ];

  for (const { name, id, expected } of cases) {
    expect(externalUserIdFromNodeId(id), name).toBe(expected);
  }
});

test("localUserIdFromNodeId resolves only installed Mermaid synthetic local-node IDs", () => {
  const cases = [
    { name: "standard installed ID", id: "classId-local0-1", expected: "local0" },
    { name: "prefixed installed ID", id: "diagram-classId-local3-42", expected: "local3" },
    {
      name: "multi-digit node and render counters",
      id: "classId-local27-314",
      expected: "local27",
    },
    { name: "real class ID", id: "classId-Widget-1", expected: undefined },
    { name: "external synthetic ID", id: "classId-extern0-1", expected: undefined },
    { name: "local marker without node index", id: "classId-local-1", expected: undefined },
    { name: "local index with trailing text", id: "classId-local12x-3", expected: undefined },
    { name: "synthetic ID without render counter", id: "classId-local12", expected: undefined },
    { name: "raw local node name", id: "local12", expected: undefined },
  ];

  for (const { name, id, expected } of cases) {
    expect(localUserIdFromNodeId(id), name).toBe(expected);
  }
});

test("formatUmlMethodReturnLabel formats only synthetic return rows with two-NBSP indentation", () => {
  const cases = [
    {
      name: "Mermaid-normalized marker row",
      text: "§() : Promise⟨string⟩",
      expected: "\u00a0\u00a0Promise⟨string⟩",
    },
    {
      name: "raw DSL marker row",
      text: "§() Promise⟨string⟩",
      expected: "\u00a0\u00a0Promise⟨string⟩",
    },
    {
      name: "empty marker row",
      text: "§()",
      expected: undefined,
    },
    {
      name: "ordinary method row",
      text: "+execute() : Promise⟨string⟩",
      expected: undefined,
    },
    {
      name: "return type containing colons",
      text: "§() : Result⟨｛ ok: true; reason: string ｝⟩",
      expected: "\u00a0\u00a0Result⟨｛ ok: true; reason: string ｝⟩",
    },
  ];

  for (const { name, text, expected } of cases) {
    expect(formatUmlMethodReturnLabel(text), name).toBe(expected);
  }
});

test("hasPassedDragThreshold distinguishes click jitter from drag movement", () => {
  const cases = [
    { name: "zero movement", dx: 0, dy: 0, threshold: undefined, expected: false },
    { name: "diagonal jitter below the default threshold", dx: 3, dy: 3, threshold: undefined, expected: false },
    { name: "exact default threshold", dx: 3, dy: 4, threshold: undefined, expected: true },
    { name: "exact default threshold in the negative direction", dx: -3, dy: -4, threshold: undefined, expected: true },
    { name: "below a configured threshold", dx: 3, dy: 4, threshold: 6, expected: false },
    { name: "above a configured threshold", dx: 6, dy: 8, threshold: 9, expected: true },
  ];

  for (const { name, dx, dy, threshold, expected } of cases) {
    expect(hasPassedDragThreshold(0, 0, dx, dy, threshold), name).toBe(expected);
  }
});

test("panViewport accumulates signed movement deltas", () => {
  const viewport = { scale: 1, x: 10, y: -4 };

  panViewport(viewport, 3, -2);
  panViewport(viewport, -8, 7);

  expect(viewport).toEqual({ scale: 1, x: 5, y: 1 });
});

test("zoomViewportAt applies multiplicative zoom-in and zoom-out factors around the supplied origin", () => {
  const viewport = { scale: 1, x: 8, y: -6 };

  zoomViewportAt(viewport, 1.5, 0, 0);
  expect(viewport).toEqual({ scale: 1.5, x: 12, y: -9 });

  zoomViewportAt(viewport, 0.5, 0, 0);
  expect(viewport).toEqual({ scale: 0.75, x: 6, y: -4.5 });
});

test("zoomViewportAt scales above and below the former bounds", () => {
  const upper = { scale: 1, x: 10, y: -5 };
  zoomViewportAt(upper, 8, 40, 25);
  expect(upper).toEqual({ scale: 8, x: -200, y: -215 });

  const lower = { scale: 1, x: 10, y: -5 };
  zoomViewportAt(lower, 0.125, 40, 25);
  expect(lower).toEqual({ scale: 0.125, x: 36.25, y: 21.25 });
});

test("zoomViewportAt leaves the viewport unchanged for invalid factors", () => {
  const initial = { scale: 2, x: 10, y: -20 };
  const cases = [
    { name: "zero", factor: 0 },
    { name: "negative", factor: -0.5 },
    { name: "Infinity", factor: Infinity },
    { name: "NaN", factor: NaN },
  ] as const;

  for (const { name, factor } of cases) {
    const viewport = { ...initial };
    zoomViewportAt(viewport, factor, 110, 80);
    expect(viewport, name).toEqual(initial);
  }
});

test("zoomViewportAt preserves the world point under a nonzero pointer origin", () => {
  const viewport = { scale: 2, x: 10, y: -20 };
  const origin = { x: 110, y: 80 };
  const worldBefore = {
    x: (origin.x - viewport.x) / viewport.scale,
    y: (origin.y - viewport.y) / viewport.scale,
  };

  zoomViewportAt(viewport, 1.25, origin.x, origin.y);

  expect(viewport).toEqual({ scale: 2.5, x: -15, y: -45 });
  expect((origin.x - viewport.x) / viewport.scale).toBe(worldBefore.x);
  expect((origin.y - viewport.y) / viewport.scale).toBe(worldBefore.y);
});

test("resolveUmlSource chooses the earliest duplicate bare or generic entity independent of input order", () => {
  const earliest: UmlEntitySource = {
    name: "Widget<T>",
    path: "a/widget.ts",
    line: 4,
    column: 7,
    methods: [],
  };
  const laterInFile: UmlEntitySource = {
    name: "Widget",
    path: "a/widget.ts",
    line: 18,
    column: 2,
    methods: [],
  };
  const laterPath: UmlEntitySource = {
    name: "Widget<U>",
    path: "z/widget.ts",
    line: 1,
    column: 1,
    methods: [],
  };
  const expected = { path: "a/widget.ts", line: 4, column: 7 };

  expect(sourceLocation(resolveUmlSource([laterPath, laterInFile, earliest], "Widget"))).toEqual(
    expected,
  );
  expect(sourceLocation(resolveUmlSource([earliest, laterInFile, laterPath], "Widget"))).toEqual(
    expected,
  );
});

test("resolveUmlSource selects the requested same-name method occurrence", () => {
  const sources: UmlEntitySource[] = [{
    name: "Service<T>",
    path: "src/service.ts",
    line: 3,
    column: 14,
    methods: [
      { name: "run", path: "src/service.ts", line: 6, column: 3 },
      { name: "stop", path: "src/service.ts", line: 9, column: 3 },
      { name: "run", path: "src/service.ts", line: 12, column: 3 },
      { name: "run", path: "src/service.ts", line: 16, column: 3 },
    ],
  }];

  expect(sourceLocation(resolveUmlSource(sources, "Service", "run", 0))).toEqual({
    path: "src/service.ts",
    line: 6,
    column: 3,
  });
  expect(sourceLocation(resolveUmlSource(sources, "Service", "run", 1))).toEqual({
    path: "src/service.ts",
    line: 12,
    column: 3,
  });
  expect(sourceLocation(resolveUmlSource(sources, "Service", "run", 2))).toEqual({
    path: "src/service.ts",
    line: 16,
    column: 3,
  });
});

test("resolveUmlSource returns undefined for absent entities, methods, and occurrences", () => {
  const sources: UmlEntitySource[] = [{
    name: "Service",
    path: "src/service.ts",
    line: 3,
    column: 14,
    methods: [{ name: "run", path: "src/service.ts", line: 6, column: 3 }],
  }];

  expect(resolveUmlSource(sources, "Missing")).toBeUndefined();
  expect(resolveUmlSource(sources, "extern0")).toBeUndefined();
  expect(resolveUmlSource(sources, "local0")).toBeUndefined();
  expect(resolveUmlSource(sources, "Service", "missing")).toBeUndefined();
  expect(resolveUmlSource(sources, "Service", "run", 1)).toBeUndefined();
});

test("editorOffset clamps invalid, low, and high lines and columns", () => {
  const documentLines = [
    { from: 0, to: 3 },
    { from: 4, to: 8 },
    { from: 9, to: 10 },
  ];
  const doc = {
    lines: documentLines.length,
    line(number: number) {
      const line = documentLines[number - 1];
      if (!line) throw new RangeError(`Invalid line ${number}`);
      return line;
    },
  };
  const cases = [
    { name: "invalid line", line: Number.NaN, column: 2, expected: 1 },
    { name: "line below one", line: -3, column: 2, expected: 1 },
    { name: "line past the document", line: 99, column: 2, expected: 10 },
    { name: "invalid column", line: 2, column: Number.NaN, expected: 4 },
    { name: "column below one", line: 2, column: -3, expected: 4 },
    { name: "middle position", line: 2, column: 3, expected: 6 },
    { name: "column past line end", line: 2, column: 99, expected: 8 },
  ];

  for (const { name, line, column, expected } of cases) {
    const location = { path: "src/example.ts", line, column };
    expect(editorOffset(doc, location), name).toBe(expected);
  }
});
