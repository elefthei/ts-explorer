import { expect, test } from "bun:test";
import {
  adjacentTreeRowIndex,
  RequestSequence,
  externalUserIdFromNodeId,
  formatUmlMethodReturnLabel,
  localUserIdFromNodeId,
  packageNodeIdFromNodeId,
  hasPassedDragThreshold,
  matchesSearchQuery,
  panViewport,
  shouldStackDiagram,
  treeScrollTopForRow,
  zoomViewportAt,
} from "../src/web/diagram-interactions.ts";

test("shouldStackDiagram stacks UML diagrams but not package diagrams", () => {
  expect(shouldStackDiagram("uml")).toBe(true);
  expect(shouldStackDiagram("packages")).toBe(false);
});

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

