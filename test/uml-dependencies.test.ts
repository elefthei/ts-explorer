import { afterEach, expect, test } from "bun:test";
import { extractUmlDiagramGraph } from "../src/uml.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { extractContract, normalizeRoot } from "./support/uml-contract.ts";

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});

async function fixtureRoot(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await fixtures.temporaryRoot(prefix);
  for (const [path, source] of Object.entries(files)) {
    await fixtures.writeFixtureFile(root, path, source);
  }
  return root;
}

test("reference syntaxes that produce usage edges", async () => {
  const root = await fixtureRoot("ts-explorer-usage-syntax-", {
    "src/targets.ts": `export class ArgTarget {}
export class NewTarget {}
export class ParamTarget {}
export class ReturnTarget {}
export class PropTarget {}
export class GenericTarget {}
export class AssertTarget {}
export class TypeofTarget {}
export class ConstraintTarget {}
export class SatisfiesTarget {}
export class IndexedTarget {
  field!: string;
}
export class JsdocTarget {}
export class TypeOnlyTarget {}
export class Consumer {
  prop!: PropTarget;
  take(value: ParamTarget): ReturnTarget {
    return new ReturnTarget();
  }
  build(): void {
    accept(new ArgTarget());
    const made = new NewTarget();
    const box: Array<GenericTarget> = [];
    const cast = made as unknown as AssertTarget;
    const shape: typeof TypeofTarget = TypeofTarget;
    const idx: IndexedTarget["field"] = "";
    const sat = {} satisfies Partial<SatisfiesTarget>;
  }
  limit<T extends ConstraintTarget>(value: T): T {
    return value;
  }
  /** @param value {JsdocTarget} */
  documented(value: unknown): void {}
}
function accept(value: ArgTarget): void {}
`,
    "src/type-only.ts": `import type { TypeOnlyTarget } from "./targets.ts";
export class TypeOnlyUser {
  value!: TypeOnlyTarget;
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: every reference position except JSDoc yields one usage edge per pair, sorted by
  // source name then target name. `ReturnTarget` is absent because a method return type is carried
  // by methodReturnDependencies instead. A type-only import still counts as a use.
  expect(contract.usage).toEqual([
    { source: "Consumer", target: "ArgTarget" },
    { source: "Consumer", target: "AssertTarget" },
    { source: "Consumer", target: "ConstraintTarget" },
    { source: "Consumer", target: "GenericTarget" },
    { source: "Consumer", target: "IndexedTarget" },
    { source: "Consumer", target: "NewTarget" },
    { source: "Consumer", target: "ParamTarget" },
    { source: "Consumer", target: "PropTarget" },
    { source: "Consumer", target: "SatisfiesTarget" },
    { source: "Consumer", target: "TypeofTarget" },
    { source: "TypeOnlyUser", target: "TypeOnlyTarget" },
  ]);
  // characterizes: a scope-local free function is a local user, never a usage edge
  expect(contract.localUsers).toEqual([
    {
      label: "local: src/targets.ts: accept(ArgTarget)",
      path: "src/targets.ts",
      line: 36,
      column: 10,
      kind: "function",
      owner: null,
      targets: ["ArgTarget"],
    },
  ]);
  expect(contract.externalUsers).toEqual([]);
}, 30_000);

test("method return types are traversed through aliases, unions, intersections, arrays, generics and cycles", async () => {
  const root = await fixtureRoot("ts-explorer-usage-returns-", {
    "src/returns.ts": `export class Direct {}
export class Wrapped {}
export class UnionA {}
export class UnionB {}
export class InterA {}
export class InterB {}
export class Elem {}
export class KeyType {}
export class ValueType {}
export class AliasTarget {}
export type AliasOne = AliasTarget;
export type AliasTwo = AliasOne;
export class Cycle1 {
  next(): Cycle2 {
    return new Cycle2();
  }
}
export class Cycle2 {
  prev(): Cycle1 {
    return new Cycle1();
  }
}
export class Returns {
  direct(): Direct {
    return new Direct();
  }
  promised(): Promise<Wrapped> {
    return Promise.resolve(new Wrapped());
  }
  either(): UnionA | UnionB {
    return new UnionA();
  }
  both(): InterA & InterB {
    return new InterA() as InterA & InterB;
  }
  list(): Elem[] {
    return [];
  }
  mapped(): Map<KeyType, ValueType> {
    return new Map();
  }
  aliased(): AliasTwo {
    return new AliasTarget();
  }
  self(): this {
    return this;
  }
}
export type LiteralHost = {
  produce(): Direct;
};
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: rows keep declaration order (they are never sorted); traversal descends through
  // type arguments, unions, intersections and array elements, resolves an alias chain to the
  // declaring class, drops `this`, and tolerates mutual recursion.
  expect(contract.methodReturns).toEqual([
    { source: "Cycle1", target: "Cycle2" },
    { source: "Cycle2", target: "Cycle1" },
    { source: "Returns", target: "Direct" },
    { source: "Returns", target: "Wrapped" },
    { source: "Returns", target: "UnionA" },
    { source: "Returns", target: "UnionB" },
    { source: "Returns", target: "InterA" },
    { source: "Returns", target: "InterB" },
    { source: "Returns", target: "Elem" },
    { source: "Returns", target: "KeyType" },
    { source: "Returns", target: "ValueType" },
    { source: "Returns", target: "AliasTarget" },
    // characterizes: a type-literal alias that uses another entity is turned into a local-user node
    // and its entity is deleted, so its own return dependency keeps a dangling source id
    { source: '<unmapped:"<root>/src/returns".LiteralHost>', target: "Direct" },
  ]);
  expect(contract.entities.map((entity) => entity.name)).toEqual([
    "Direct",
    "Wrapped",
    "UnionA",
    "UnionB",
    "InterA",
    "InterB",
    "Elem",
    "KeyType",
    "ValueType",
    "AliasTarget",
    "Cycle1",
    "Cycle2",
    "Returns",
  ]);
  // characterizes: the deleted alias entities resurface as local users owned by dangling ids
  expect(contract.localUsers).toEqual([
    {
      label: "local: src/returns.ts: AliasOne",
      path: "src/returns.ts",
      line: 11,
      column: 13,
      kind: "type",
      owner: '<unmapped:"<root>/src/returns".AliasOne>',
      targets: ["AliasTarget"],
    },
    {
      label: "local: src/returns.ts: AliasTwo",
      path: "src/returns.ts",
      line: 12,
      column: 13,
      kind: "type",
      owner: '<unmapped:"<root>/src/returns".AliasTwo>',
      targets: ['<unmapped:"<root>/src/returns".AliasOne>'],
    },
    {
      label: "local: src/returns.ts: LiteralHost.produce()",
      path: "src/returns.ts",
      line: 50,
      column: 3,
      kind: "method",
      owner: '<unmapped:"<root>/src/returns".LiteralHost>',
      targets: ["Direct"],
    },
  ]);
}, 30_000);

test("only methods create return dependencies", async () => {
  const root = await fixtureRoot("ts-explorer-usage-non-methods-", {
    "src/model.ts": `export class Target {}
export class Holder {
  factory: () => Target = () => new Target();
  take(value: Target): void {}
  constructor() {}
}
export function make(): Target {
  return new Target();
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: a callable property, a free function and a constructor contribute nothing here
  expect(contract.methodReturns).toEqual([]);
  // characterizes: the method parameter and the property initializer still make Holder a user
  expect(contract.usage).toEqual([{ source: "Holder", target: "Target" }]);
  expect(contract.localUsers).toEqual([
    {
      label: "local: src/model.ts: make()",
      path: "src/model.ts",
      line: 7,
      column: 17,
      kind: "function",
      owner: null,
      targets: ["Target"],
    },
  ]);
}, 30_000);

test("unresolved usage endpoints are dropped while heritage keeps a boundary node", async () => {
  const root = await fixtureRoot("ts-explorer-usage-boundary-", {
    "src/vendor.d.ts": `export declare class Missing {}
export declare class Absent {}
`,
    "src/model.ts": `import { Absent, Missing } from "./vendor";
export class Consumer extends Missing {
  use(): void {
    new Absent();
  }
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: the asymmetry between resolveEndpoint (src/uml/graph.ts:74-92), which invents a
  // boundary node for an unknown heritage endpoint, and the usage collector, which never registers
  // a reference declaration for an entity that lives outside the extracted scope.
  expect(contract.nodes).toEqual([
    { name: "Consumer", kind: "entity", community: 0 },
    { name: "Missing", kind: "boundary", community: 0 },
  ]);
  expect(contract.usage).toEqual([]);
  expect(contract.localUsers).toEqual([]);
  expect(contract.relations).toEqual([
    { kind: "heritage", source: "Consumer", target: "Missing" },
  ]);
  expect(contract.edges).toEqual([{ a: "Consumer", b: "Missing", weight: 1 }]);
}, 30_000);

test("local and external users are grouped by owner signature", async () => {
  const root = await fixtureRoot("ts-explorer-usage-users-", {
    "src/inner/model.ts": `export class Widget {}
`,
    "src/inner/users.ts": `import { Widget } from "./model.ts";
export function freeFunction(value: Widget): void {}
export const arrow = (value: Widget) => value;
export const holder = {
  handle: (value: Widget) => value,
};
export type Alias = Widget;
export { Widget };
`,
    "src/outer/sibling.ts": `import { Widget } from "../inner/model.ts";
export function outsider(value: Widget): void {}
`,
  });

  const { contract } = await extractContract(root, "src/inner");

  // characterizes: local users sort by scope path, signature then kind; a top-level arrow const and
  // an object-literal callable both render as callables, a type alias renders bare, and an export
  // specifier switches the label prefix from `local:` to `export:`.
  expect(contract.localUsers).toEqual([
    {
      label: "local: src/inner/users.ts: Alias",
      path: "src/inner/users.ts",
      line: 7,
      column: 13,
      kind: "type",
      owner: '<unmapped:"<root>/src/inner/users".Alias>',
      targets: ["Widget"],
    },
    {
      label: "local: src/inner/users.ts: arrow(Widget)",
      path: "src/inner/users.ts",
      line: 3,
      column: 14,
      kind: "function",
      owner: null,
      targets: ["Widget"],
    },
    {
      label: "local: src/inner/users.ts: freeFunction(Widget)",
      path: "src/inner/users.ts",
      line: 2,
      column: 17,
      kind: "function",
      owner: null,
      targets: ["Widget"],
    },
    {
      label: "local: src/inner/users.ts: holder.handle(Widget)",
      path: "src/inner/users.ts",
      line: 5,
      column: 3,
      kind: "method",
      owner: null,
      targets: ["Widget"],
    },
    {
      label: "export: src/inner/users.ts: Widget",
      path: "src/inner/users.ts",
      line: 8,
      column: 10,
      kind: "export",
      owner: null,
      targets: ["Widget"],
    },
  ]);
  // characterizes: an out-of-scope sibling becomes one external user keyed by its file scope path
  expect(contract.externalUsers).toEqual([
    {
      label: "extern: src/outer/sibling.ts: outsider(Widget)",
      scopePath: "src/outer/sibling.ts",
      kind: "function",
      targets: ["Widget"],
    },
  ]);
}, 30_000);

test("same-name references resolve to the declaring entity", async () => {
  const root = await fixtureRoot("ts-explorer-usage-shadowing-", {
    "src/first.ts": `export class Same {}
export namespace Space {
  export class Nested {}
}
`,
    "src/second.ts": `export class Same {}
`,
    "src/user.ts": `import { Same, Space } from "./first.ts";
export class Consumer {
  hold!: Same;
  shadow(): void {
    const Same = 1;
    void Same;
  }
  nested(): void {
    const value = new Space.Nested();
    void value;
  }
}
`,
  });

  const graph = await normalizeRoot(root, await extractUmlDiagramGraph(root, "", []));

  // characterizes: the reference resolves through the symbol, so the shadowing local `Same` adds
  // nothing and the edge lands on src/first.ts rather than the same-named class in src/second.ts
  expect(graph.usageEdges).toEqual([
    {
      dependencyOrdinal: 0,
      sourceId: '"<root>/src/user".Consumer',
      sourceName: "Consumer",
      targetId: '"<root>/src/first".Same',
      targetName: "Same",
    },
  ]);
  // characterizes: a namespace-nested class is not an entity, so `Space.Nested` has no node at all
  expect(graph.nodes.map((node) => `${node.nodeKind}:${node.nodeId}`)).toEqual([
    'entity:"<root>/src/first".Same',
    'entity:"<root>/src/second".Same',
    'entity:"<root>/src/user".Consumer',
  ]);
}, 30_000);
