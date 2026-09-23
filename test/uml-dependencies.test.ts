import { afterEach, expect, test } from "bun:test";
import { memberLabels, toUmlContract } from "./support/uml-contract.ts";
import { createUmlProjectTracker, readCompleteUml } from "./support/uml-project.ts";

const { openProject, cleanup } = createUmlProjectTracker();

afterEach(cleanup);

/** The fixture the rooted-navigation design is specified against. */
const ROOT_FILES = {
  "feature/root.ts": `import { B } from "./b";
export class Root { value: B; run(): B { return new B(); } }
export class Isolated {}
`,
  "feature/b.ts": `import { C } from "../shared/c";
export class B { value: C; }
`,
  "shared/c.ts": `import { B } from "../feature/b";
export class C { value: B; }
`,
  "consumer.ts": `import { Root } from "./feature/root";
export class Consumer { value: Root; }
`,
  "unrelated.ts": `export class Unrelated {}
`,
  "empty.ts": "",
};

test("a definition root closes over its outgoing references and keeps the cycle it reaches", async () => {
  const project = await openProject("ts-explorer-uml-root-", ROOT_FILES);
  const target = {
    kind: "definition",
    path: "feature/root.ts",
    definitionKey: project.key("feature/root.ts", "Root"),
  } as const;

  const contract = toUmlContract(readCompleteUml(project, target));

  expect(contract.status).toBe("ready");
  // Ordered by source position: b.ts, root.ts, c.ts. Consumer only points *at* Root, Isolated and
  // Unrelated are never reached, and Root's own members stay inside their class box.
  expect(contract.nodes).toEqual([
    "B@feature/b.ts",
    "Root@feature/root.ts",
    "C@shared/c.ts",
  ]);
  expect(contract.edges).toEqual([
    { kind: "references", source: "B@feature/b.ts", target: "C@shared/c.ts" },
    { kind: "references", source: "C@shared/c.ts", target: "B@feature/b.ts" },
    { kind: "references", source: "Root@feature/root.ts", target: "B@feature/b.ts" },
  ]);
  expect(contract.frames).toEqual([{
    root: "Root@feature/root.ts",
    nodeKeys: ["B@feature/b.ts", "C@shared/c.ts", "Root@feature/root.ts"],
  }]);
});

test("a file selection renders one frame per top-level definition", async () => {
  const project = await openProject("ts-explorer-uml-file-roots-", ROOT_FILES);

  const contract = toUmlContract(
    readCompleteUml(project, { kind: "file", path: "feature/root.ts" }),
  );

  expect(contract.frames).toEqual([
    {
      root: "Root@feature/root.ts",
      nodeKeys: ["B@feature/b.ts", "C@shared/c.ts", "Root@feature/root.ts"],
    },
    { root: "Isolated@feature/root.ts", nodeKeys: ["Isolated@feature/root.ts"] },
  ]);
  // The union of both closures, still excluding the file's importers.
  expect(contract.nodes).toEqual([
    "B@feature/b.ts",
    "Root@feature/root.ts",
    "Isolated@feature/root.ts",
    "C@shared/c.ts",
  ]);
});

test("an unreferenced definition is a one-node graph and an empty file has no frames", async () => {
  const project = await openProject("ts-explorer-uml-empty-", ROOT_FILES);

  const isolated = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "unrelated.ts",
    definitionKey: project.key("unrelated.ts", "Unrelated"),
  }));
  expect(isolated).toEqual({
    status: "ready",
    nodes: ["Unrelated@unrelated.ts"],
    edges: [],
    frames: [{ root: "Unrelated@unrelated.ts", nodeKeys: ["Unrelated@unrelated.ts"] }],
  });

  const empty = toUmlContract(readCompleteUml(project, { kind: "file", path: "empty.ts" }));
  expect(empty).toEqual({ status: "ready", nodes: [], edges: [], frames: [] });
});

test("a method root carries only its own references, not a sibling method's", async () => {
  const project = await openProject("ts-explorer-uml-method-root-", {
    "pair.ts": `import { Helper } from "./helper";
import { Other } from "./other";
export class Pair {
  first(): Helper { return new Helper(); }
  second(): Other { return new Other(); }
}
`,
    "helper.ts": "export class Helper {}\n",
    "other.ts": "export class Other {}\n",
  });

  const first = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "pair.ts",
    definitionKey: project.key("pair.ts", "Pair.first"),
  }));
  expect(first.nodes).toEqual(["Helper@helper.ts", "Pair.first@pair.ts"]);
  expect(first.edges).toEqual([
    { kind: "references", source: "Pair.first@pair.ts", target: "Helper@helper.ts" },
  ]);

  // The declaring class aggregates both methods' dependencies instead.
  const pair = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "pair.ts",
    definitionKey: project.key("pair.ts", "Pair"),
  }));
  expect(pair.nodes).toEqual(["Helper@helper.ts", "Other@other.ts", "Pair@pair.ts"]);
  expect(pair.edges).toEqual([
    { kind: "references", source: "Pair@pair.ts", target: "Helper@helper.ts" },
    { kind: "references", source: "Pair@pair.ts", target: "Other@other.ts" },
  ]);
});

test("a class root absorbs its own members while each member stays a selectable root", async () => {
  const project = await openProject("ts-explorer-uml-self-members-", {
    "machine.ts": `export class Machine {
  private state: number = 0;
  start(): void { this.step(); }
  step(): void { this.state += 1; }
}
`,
  });

  const machine = readCompleteUml(project, {
    kind: "definition",
    path: "machine.ts",
    definitionKey: project.key("machine.ts", "Machine"),
  });
  const classRoot = toUmlContract(machine);
  // `start -> step -> state` is internal to the box: one node, no arrows, no extra member boxes.
  expect(classRoot.nodes).toEqual(["Machine@machine.ts"]);
  expect(classRoot.edges).toEqual([]);
  // The compartments still address the real member definitions.
  expect(memberLabels(machine, "Machine@machine.ts")).toEqual([
    "Machine.state@machine.ts",
    "Machine.start@machine.ts",
    "Machine.step@machine.ts",
  ]);

  const method = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "machine.ts",
    definitionKey: project.key("machine.ts", "Machine.start"),
  }));
  expect(method.frames).toEqual([{
    root: "Machine.start@machine.ts",
    nodeKeys: [
      "Machine.start@machine.ts",
      "Machine.state@machine.ts",
      "Machine.step@machine.ts",
    ],
  }]);
  expect(method.edges).toEqual([
    { kind: "references", source: "Machine.start@machine.ts", target: "Machine.step@machine.ts" },
    { kind: "references", source: "Machine.step@machine.ts", target: "Machine.state@machine.ts" },
  ]);

  const property = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "machine.ts",
    definitionKey: project.key("machine.ts", "Machine.state"),
  }));
  expect(property.nodes).toEqual(["Machine.state@machine.ts"]);
  expect(property.edges).toEqual([]);
});

test("an alias stays an intermediate node in the chain it forwards", async () => {
  const project = await openProject("ts-explorer-uml-alias-chain-", {
    "alias.ts": `import { Target } from "./target";
export type Alias = Target;
export class AliasRoot { value: Alias; }
`,
    "target.ts": "export class Target {}\n",
  });

  const contract = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "alias.ts",
    definitionKey: project.key("alias.ts", "AliasRoot"),
  }));

  expect(contract.nodes).toEqual([
    "Alias@alias.ts",
    "AliasRoot@alias.ts",
    "Target@target.ts",
  ]);
  expect(contract.edges).toEqual([
    { kind: "references", source: "Alias@alias.ts", target: "Target@target.ts" },
    { kind: "references", source: "AliasRoot@alias.ts", target: "Alias@alias.ts" },
  ]);
});
