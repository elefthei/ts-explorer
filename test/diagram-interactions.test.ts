import { expect, test } from "bun:test";
import {
  adjacentTreeRowIndex,
  RequestSequence,
  DiagramClickSequence,
  type DiagramPointerTarget,
  fileNodeIdFromNodeId,
  formatUmlMethodReturnLabel,
  packageNodeIdFromNodeId,
  hasDiagramBody,
  hasPassedDragThreshold,
  matchesSearchQuery,
  panViewport,
  treeScrollTopForRow,
  zoomViewportAt,
} from "../src/web/diagram-interactions.ts";
import { STYLE_DEFS } from "../src/uml/mermaid.ts";

test("matchesSearchQuery honors the explicit case mode and rejects blank queries", () => {
  const cases = [
    {
      name: "exact-case substring in case-sensitive mode",
      candidate: "DataflowRuntime",
      query: "flowRun",
      caseInsensitive: false,
      expected: true,
    },
    {
      name: "exact-case substring in case-insensitive mode",
      candidate: "DataflowRuntime",
      query: "flowRun",
      caseInsensitive: true,
      expected: true,
    },
    {
      name: "mixed-case substring in case-sensitive mode",
      candidate: "DataflowRuntime",
      query: "flowrun",
      caseInsensitive: false,
      expected: false,
    },
    {
      name: "mixed-case substring in case-insensitive mode",
      candidate: "DataflowRuntime",
      query: "flowrun",
      caseInsensitive: true,
      expected: true,
    },
    {
      name: "empty query in case-sensitive mode",
      candidate: "DataflowRuntime",
      query: "",
      caseInsensitive: false,
      expected: false,
    },
    {
      name: "empty query in case-insensitive mode",
      candidate: "DataflowRuntime",
      query: "",
      caseInsensitive: true,
      expected: false,
    },
    {
      name: "whitespace-only query in case-sensitive mode",
      candidate: "DataflowRuntime",
      query: " \t\n ",
      caseInsensitive: false,
      expected: false,
    },
    {
      name: "whitespace-only query in case-insensitive mode",
      candidate: "DataflowRuntime",
      query: " \t\n ",
      caseInsensitive: true,
      expected: false,
    },
  ] as const;

  for (const { name, candidate, query, caseInsensitive, expected } of cases) {
    expect(matchesSearchQuery(candidate, query, caseInsensitive), name).toBe(expected);
  }
});

test("adjacentTreeRowIndex moves one row without wrapping and rejects invalid positions", () => {
  const cases = [
    { name: "forward from the middle", currentIndex: 2, direction: 1, rowCount: 5, expected: 3 },
    { name: "backward from the middle", currentIndex: 2, direction: -1, rowCount: 5, expected: 1 },
    { name: "forward at the last row", currentIndex: 4, direction: 1, rowCount: 5, expected: 4 },
    { name: "backward at the first row", currentIndex: 0, direction: -1, rowCount: 5, expected: 0 },
    { name: "index before the first row", currentIndex: -1, direction: 1, rowCount: 5, expected: -1 },
    { name: "index after the last row", currentIndex: 5, direction: -1, rowCount: 5, expected: -1 },
    { name: "empty row list", currentIndex: 0, direction: 1, rowCount: 0, expected: -1 },
  ] as const;

  for (const { name, currentIndex, direction, rowCount, expected } of cases) {
    expect(adjacentTreeRowIndex(currentIndex, direction, rowCount), name).toBe(expected);
  }
});

test("treeScrollTopForRow minimally reveals clipped rows and clamps to scroll bounds", () => {
  const cases = [
    {
      name: "fully visible row",
      currentScrollTop: 40,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 125,
      rowBottom: 150,
      expected: 40,
    },
    {
      name: "row aligned with both viewport edges",
      currentScrollTop: 40,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 100,
      rowBottom: 200,
      expected: 40,
    },
    {
      name: "row clipped above",
      currentScrollTop: 80,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 75,
      rowBottom: 125,
      expected: 55,
    },
    {
      name: "row clipped below",
      currentScrollTop: 80,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 175,
      rowBottom: 230,
      expected: 110,
    },
    {
      name: "upward adjustment reaches the zero bound",
      currentScrollTop: 15,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 70,
      rowBottom: 110,
      expected: 0,
    },
    {
      name: "downward adjustment reaches the maximum bound",
      currentScrollTop: 190,
      maxScrollTop: 200,
      viewportTop: 100,
      viewportBottom: 200,
      rowTop: 190,
      rowBottom: 225,
      expected: 200,
    },
  ];

  for (const { name, expected, ...dimensions } of cases) {
    expect(
      treeScrollTopForRow(
        dimensions.currentScrollTop,
        dimensions.maxScrollTop,
        dimensions.viewportTop,
        dimensions.viewportBottom,
        dimensions.rowTop,
        dimensions.rowBottom,
      ),
      name,
    ).toBe(expected);
  }
});

test("RequestSequence rejects tokens before any request is issued", () => {
  const sequence = new RequestSequence();
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

test("RequestSequence transfers ownership to each monotonically issued token", () => {
  const sequence = new RequestSequence();

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

test("RequestSequence instances issue tokens independently", () => {
  const firstSequence = new RequestSequence();
  const secondSequence = new RequestSequence();

  expect(firstSequence.next()).toBe(1);
  expect(firstSequence.next()).toBe(2);
  expect(secondSequence.next()).toBe(1);
  expect(firstSequence.isCurrent(2)).toBe(true);
  expect(secondSequence.isCurrent(1)).toBe(true);
});

test("fileNodeIdFromNodeId resolves only Mermaid flowchart file-node IDs", () => {
  const cases = [
    { name: "unprefixed first file", id: "flowchart-f0-0", expected: "f0" },
    {
      name: "render-prefixed multi-digit file and counter",
      id: "diagram-1-flowchart-f12-7",
      expected: "f12",
    },
    { name: "package node", id: "flowchart-p0-0", expected: undefined },
    { name: "UML class ID", id: "classId-f0-0", expected: undefined },
    { name: "missing file index", id: "flowchart-f-0", expected: undefined },
    { name: "file index with trailing text", id: "flowchart-f12x-7", expected: undefined },
    { name: "missing Mermaid counter", id: "flowchart-f12", expected: undefined },
    { name: "non-numeric Mermaid counter", id: "flowchart-f12-last", expected: undefined },
    { name: "suffix after Mermaid counter", id: "flowchart-f12-7-extra", expected: undefined },
    { name: "render prefix that does not end in a separator", id: "xflowchart-f0-0", expected: undefined },
    { name: "raw response-local node ID", id: "f12", expected: undefined },
  ];

  for (const { name, id, expected } of cases) {
    expect(fileNodeIdFromNodeId(id), name).toBe(expected);
  }
});

test("packageNodeIdFromNodeId resolves only Mermaid flowchart package-node IDs", () => {
  const cases = [
    { name: "unprefixed first package", id: "flowchart-p0-0", expected: "p0" },
    {
      name: "render-prefixed multi-digit package and counter",
      id: "diagram-1-flowchart-p12-7",
      expected: "p12",
    },
    {
      name: "arbitrary Mermaid render prefix",
      id: "diagram-314-flowchart-p27-42",
      expected: "p27",
    },
    { name: "UML class ID", id: "classId-p0-0", expected: undefined },
    { name: "missing package index", id: "flowchart-p-0", expected: undefined },
    { name: "negative package index", id: "flowchart-p-1-0", expected: undefined },
    { name: "package index with trailing text", id: "flowchart-p12x-7", expected: undefined },
    { name: "missing Mermaid counter", id: "flowchart-p12", expected: undefined },
    { name: "non-numeric Mermaid counter", id: "flowchart-p12-last", expected: undefined },
    { name: "suffix after Mermaid counter", id: "flowchart-p12-7-extra", expected: undefined },
    { name: "raw logical package ID", id: "p12", expected: undefined },
  ];

  for (const { name, id, expected } of cases) {
    expect(packageNodeIdFromNodeId(id), name).toBe(expected);
  }
});

function definitionTarget(name: string): DiagramPointerTarget {
  return {
    kind: "definition",
    definition: {
      key: name,
      parentKey: null,
      isTopLevel: true,
      name,
      qualifiedName: name,
      kind: "class",
      type: name,
      source: { path: "model.ts", line: 1, column: 14 },
    },
  };
}

const ROOT = definitionTarget("Root");
const OTHER = definitionTarget("Other");
const FILE: DiagramPointerTarget = { kind: "file", path: "feature/root.ts" };

test("DiagramClickSequence selects one tap and opens the pressed target on the second", () => {
  const sequence = new DiagramClickSequence();

  expect(sequence.record(ROOT, 1, 1_000, 40, 60)).toEqual({ action: "select", target: ROOT });
  // The repaint that the first tap triggered replaced the pressed SVG node, so the second press
  // lands on nothing; it must still open what the user pressed.
  expect(sequence.record(undefined, 1, 1_120, 40, 60)).toEqual({ action: "open", target: ROOT });
  // The snapshot is consumed, so a third press starts over.
  expect(sequence.record(undefined, 1, 1_140, 40, 60)).toBe(undefined);
});

test("DiagramClickSequence opens the first target even when the second press hits another node", () => {
  const sequence = new DiagramClickSequence();

  expect(sequence.record(ROOT, 7, 0, 10, 10)).toEqual({ action: "select", target: ROOT });
  expect(sequence.record(OTHER, 7, 200, 12, 8)).toEqual({ action: "open", target: ROOT });

  expect(sequence.record(FILE, 7, 400, 10, 10)).toEqual({ action: "select", target: FILE });
  expect(sequence.record(ROOT, 7, 500, 10, 10)).toEqual({ action: "open", target: FILE });
});

test("DiagramClickSequence consumes a second tap only within 500 ms and 5 px of the first", () => {
  const cases = [
    { name: "same instant and position", timeStamp: 1_000, x: 40, y: 60, opens: true },
    { name: "exactly at the interval bound", timeStamp: 1_500, x: 40, y: 60, opens: true },
    { name: "one millisecond past the interval", timeStamp: 1_501, x: 40, y: 60, opens: false },
    { name: "exactly at the radius bound on x", timeStamp: 1_100, x: 45, y: 60, opens: true },
    { name: "exactly at the radius bound on y", timeStamp: 1_100, x: 40, y: 55, opens: true },
    { name: "one pixel past the radius on x", timeStamp: 1_100, x: 46, y: 60, opens: false },
    { name: "one pixel past the radius on y", timeStamp: 1_100, x: 40, y: 66, opens: false },
  ] as const;

  for (const { name, timeStamp, x, y, opens } of cases) {
    const sequence = new DiagramClickSequence();
    sequence.record(ROOT, 3, 1_000, 40, 60);
    expect(sequence.record(OTHER, 3, timeStamp, x, y), name).toEqual(
      opens ? { action: "open", target: ROOT } : { action: "select", target: OTHER },
    );
  }
});

test("DiagramClickSequence keeps a rejected second tap as the new first tap", () => {
  const sequence = new DiagramClickSequence();

  sequence.record(ROOT, 3, 1_000, 40, 60);
  expect(sequence.record(OTHER, 3, 3_000, 40, 60)).toEqual({ action: "select", target: OTHER });
  // The slow tap replaced the snapshot, so the next quick tap opens `Other`, never `Root`.
  expect(sequence.record(undefined, 3, 3_100, 40, 60)).toEqual({ action: "open", target: OTHER });
});

test("DiagramClickSequence never lets a second pointer consume another pointer's tap", () => {
  const sequence = new DiagramClickSequence();

  sequence.record(ROOT, 1, 1_000, 40, 60);
  expect(sequence.record(OTHER, 2, 1_010, 40, 60)).toEqual({ action: "select", target: OTHER });
  // Pointer 1's snapshot is gone, so its own follow-up press cannot open anything either.
  expect(sequence.record(undefined, 1, 1_020, 40, 60)).toBe(undefined);
});

test("DiagramClickSequence discards its snapshot on clear and on a targetless tap", () => {
  const cleared = new DiagramClickSequence();
  cleared.record(ROOT, 1, 1_000, 40, 60);
  cleared.clear();
  expect(cleared.record(OTHER, 1, 1_050, 40, 60)).toEqual({ action: "select", target: OTHER });

  const abandoned = new DiagramClickSequence();
  abandoned.record(ROOT, 1, 1_000, 40, 60);
  // A press on empty canvas by another pointer matches nothing and leaves no snapshot behind.
  expect(abandoned.record(undefined, 2, 1_050, 300, 300)).toBe(undefined);
  expect(abandoned.record(undefined, 2, 1_060, 300, 300)).toBe(undefined);
  expect(abandoned.record(undefined, 1, 1_060, 40, 60)).toBe(undefined);
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

test("hasDiagramBody rejects DSLs that carry no renderable statements", () => {
  const emptyUml = `classDiagram\n${STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n")}\n`;
  const cases = [
    { name: "bare UML render mode", dsl: "classDiagram\n  direction LR", expected: false },
    { name: "UML scope with no entities", dsl: emptyUml, expected: false },
    { name: "header with nothing after it", dsl: "classDiagram", expected: false },
    { name: "bare package render mode", dsl: "flowchart LR", expected: false },
    {
      name: "package diagram with no packages",
      dsl: "flowchart LR\n  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb",
      expected: false,
    },
    { name: "empty string", dsl: "", expected: false },
    { name: "leading blank line before the header", dsl: "\nclassDiagram\n\nclass Foo", expected: true },
    { name: "class diagram with one labeled entity", dsl: 'classDiagram\nclass Foo["Foo"]\nclassDef local fill:#000', expected: true },
    { name: "flowchart with one node", dsl: 'flowchart LR\n  p0["share"]\n  classDef package fill:#000\n  class p0 package', expected: true },
  ] as const;
  for (const { name, dsl, expected } of cases) {
    expect(hasDiagramBody(dsl), name).toBe(expected);
  }
});
