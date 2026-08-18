import { afterEach, expect, test } from "bun:test";
import { createFixtureTracker } from "./support/fixtures.ts";
import { extractContract, extractNormalizedGraph } from "./support/uml-contract.ts";

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});

test("extracts every entity kind with its members", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-kinds-", {
    "src/model.ts": `export class Widget {
  label = "widget";
  size?: number;
  render(): string {
    return this.label;
  }
}
export interface Shape {
  area: number;
  scale(factor: number): void;
}
export enum Mode {
  Idle,
  Busy,
}
export type Options = { retries: number; onDone(): void };
export type Id = string;
export type Fn = (a: number) => void;
export class Box<T> {
  value!: T;
  read(): T {
    return this.value;
  }
}
export interface Container<T> {
  items: T[];
}
`,
  });

  const { contract } = await extractContract(root);

  expect(contract).toEqual({
    entities: [
      {
        file: "src/model.ts",
        kind: "class",
        name: "Widget",
        properties: [
          { name: "label", type: null, optional: false, modifiers: [] },
          { name: "size", type: "number", optional: true, modifiers: [] },
        ],
        // characterizes: rendered return types carry the "\n§() " method-return marker
        methods: [{ name: "render", type: "\n§() string", modifiers: [] }],
        enumItems: [],
        heritage: [],
      },
      {
        file: "src/model.ts",
        kind: "class",
        name: "Box<T>",
        properties: [{ name: "value", type: "T", optional: false, modifiers: [] }],
        methods: [{ name: "read", type: "\n§() T", modifiers: [] }],
        enumItems: [],
        heritage: [],
      },
      {
        file: "src/model.ts",
        kind: "interface",
        name: "Shape",
        properties: [{ name: "area", type: "number", optional: false, modifiers: [] }],
        methods: [{ name: "scale", type: "\n§() void", modifiers: [] }],
        enumItems: [],
        heritage: [],
      },
      {
        file: "src/model.ts",
        kind: "interface",
        name: "Container<T>",
        properties: [{ name: "items", type: "T[]", optional: false, modifiers: [] }],
        methods: [],
        enumItems: [],
        heritage: [],
      },
      {
        file: "src/model.ts",
        kind: "enum",
        name: "Mode",
        properties: [],
        methods: [],
        enumItems: ["Idle", "Busy"],
        heritage: [],
      },
      {
        // characterizes: an object type alias contributes properties and methods like an interface
        file: "src/model.ts",
        kind: "type",
        name: "Options",
        properties: [{ name: "retries", type: "number", optional: false, modifiers: [] }],
        methods: [{ name: "onDone", type: "\n§() void", modifiers: [] }],
        enumItems: [],
        heritage: [],
      },
      {
        // characterizes: scalar and callable aliases contribute an entity with no members
        file: "src/model.ts",
        kind: "type",
        name: "Id",
        properties: [],
        methods: [],
        enumItems: [],
        heritage: [],
      },
      {
        file: "src/model.ts",
        kind: "type",
        name: "Fn",
        properties: [],
        methods: [],
        enumItems: [],
        heritage: [],
      },
    ],
    // characterizes: categories are ordered interface, type, enum, class - not declaration order
    categories: [
      { entityName: "Shape", category: "interface", isTest: false },
      { entityName: "Container<T>", category: "interface", isTest: false },
      { entityName: "Options", category: "type", isTest: false },
      { entityName: "Id", category: "type", isTest: false },
      { entityName: "Fn", category: "type", isTest: false },
      { entityName: "Mode", category: "enum", isTest: false },
      { entityName: "Widget", category: "concrete", isTest: false },
      { entityName: "Box<T>", category: "concrete", isTest: false },
    ],
    associations: [],
    methodReturns: [],
    usage: [],
    localUsers: [],
    externalUsers: [],
    definitions: [
      {
        definitionOrdinal: 0,
        definitionKey: '["class","Widget",0,null,null]',
        definitionKind: "class",
        name: "Widget",
        qualifiedName: "Widget",
        sourcePath: "src/model.ts",
        sourceLine: 1,
        sourceColumn: 14,
        umlScopePath: "src/model.ts",
        umlEntityName: "Widget",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 1,
        definitionKey: '["class","Widget",0,"render",0]',
        definitionKind: "method",
        name: "render",
        qualifiedName: "Widget.render",
        sourcePath: "src/model.ts",
        sourceLine: 4,
        sourceColumn: 3,
        umlScopePath: "src/model.ts",
        umlEntityName: "Widget",
        umlMemberName: "render",
        umlMemberOccurrence: 0,
      },
      {
        definitionOrdinal: 2,
        definitionKey: '["interface","Shape",0,null,null]',
        definitionKind: "interface",
        name: "Shape",
        qualifiedName: "Shape",
        sourcePath: "src/model.ts",
        sourceLine: 8,
        sourceColumn: 18,
        umlScopePath: "src/model.ts",
        umlEntityName: "Shape",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 3,
        definitionKey: '["interface","Shape",0,"scale",0]',
        definitionKind: "method",
        name: "scale",
        qualifiedName: "Shape.scale",
        sourcePath: "src/model.ts",
        sourceLine: 10,
        sourceColumn: 3,
        umlScopePath: "src/model.ts",
        umlEntityName: "Shape",
        umlMemberName: "scale",
        umlMemberOccurrence: 0,
      },
      {
        definitionOrdinal: 4,
        definitionKey: '["enum","Mode",0,null,null]',
        definitionKind: "enum",
        name: "Mode",
        qualifiedName: "Mode",
        sourcePath: "src/model.ts",
        sourceLine: 12,
        sourceColumn: 13,
        umlScopePath: "src/model.ts",
        umlEntityName: "Mode",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 5,
        definitionKey: '["type","Options",0,null,null]',
        definitionKind: "type",
        name: "Options",
        qualifiedName: "Options",
        sourcePath: "src/model.ts",
        sourceLine: 16,
        sourceColumn: 13,
        umlScopePath: "src/model.ts",
        umlEntityName: "Options",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 6,
        definitionKey: '["type","Options",0,"onDone",0]',
        definitionKind: "method",
        name: "onDone",
        qualifiedName: "Options.onDone",
        sourcePath: "src/model.ts",
        sourceLine: 16,
        sourceColumn: 42,
        umlScopePath: "src/model.ts",
        umlEntityName: "Options",
        umlMemberName: "onDone",
        umlMemberOccurrence: 0,
      },
      {
        definitionOrdinal: 7,
        definitionKey: '["type","Id",0,null,null]',
        definitionKind: "type",
        name: "Id",
        qualifiedName: "Id",
        sourcePath: "src/model.ts",
        sourceLine: 17,
        sourceColumn: 13,
        umlScopePath: "src/model.ts",
        umlEntityName: "Id",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 8,
        definitionKey: '["type","Fn",0,null,null]',
        definitionKind: "type",
        name: "Fn",
        qualifiedName: "Fn",
        sourcePath: "src/model.ts",
        sourceLine: 18,
        sourceColumn: 13,
        umlScopePath: "src/model.ts",
        umlEntityName: "Fn",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        // characterizes: definition names stay bare while the UML entity name keeps its parameters
        definitionOrdinal: 9,
        definitionKey: '["class","Box",0,null,null]',
        definitionKind: "class",
        name: "Box",
        qualifiedName: "Box",
        sourcePath: "src/model.ts",
        sourceLine: 19,
        sourceColumn: 14,
        umlScopePath: "src/model.ts",
        umlEntityName: "Box<T>",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
      {
        definitionOrdinal: 10,
        definitionKey: '["class","Box",0,"read",0]',
        definitionKind: "method",
        name: "read",
        qualifiedName: "Box.read",
        sourcePath: "src/model.ts",
        sourceLine: 21,
        sourceColumn: 3,
        umlScopePath: "src/model.ts",
        umlEntityName: "Box<T>",
        umlMemberName: "read",
        umlMemberOccurrence: 0,
      },
      {
        definitionOrdinal: 11,
        definitionKey: '["interface","Container",0,null,null]',
        definitionKind: "interface",
        name: "Container",
        qualifiedName: "Container",
        sourcePath: "src/model.ts",
        sourceLine: 25,
        sourceColumn: 18,
        umlScopePath: "src/model.ts",
        umlEntityName: "Container<T>",
        umlMemberName: null,
        umlMemberOccurrence: null,
      },
    ],
    // characterizes: unconnected entities each land in their own community
    nodes: [
      { name: "Widget", kind: "entity", community: 0 },
      { name: "Box<T>", kind: "entity", community: 1 },
      { name: "Shape", kind: "entity", community: 2 },
      { name: "Container<T>", kind: "entity", community: 3 },
      { name: "Mode", kind: "entity", community: 4 },
      { name: "Options", kind: "entity", community: 5 },
      { name: "Id", kind: "entity", community: 6 },
      { name: "Fn", kind: "entity", community: 7 },
    ],
    edges: [],
    relations: [],
  });
}, 30_000);

test("records decoded modifiers for every member form", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-modifiers-", {
    "src/members.ts": `export abstract class Members {
  public plain = 1;
  private secret = 2;
  protected shared = 3;
  static counter = 4;
  readonly frozen = 5;
  static readonly both = 6;
  optional?: string;
  definite!: string;
  accessor tracked = 7;
  declare ambient: number;
  #hard = 8;
  arrow = (value: number): number => value;
  abstract run(): void;
  async load(): Promise<void> {}
  protected static make(): Members | undefined { return undefined; }
  get value(): number { return 1; }
  set value(next: number) {}
  constructor(public injected: string, private hidden: number) { super(); }
}
export interface Signatures {
  (call: string): void;
  new (construct: string): Signatures;
  [index: number]: string;
  readonly ro: string;
  method?(): void;
}
`,
  });

  const { contract } = await extractContract(root);

  expect(contract.entities).toEqual([
    {
      file: "src/members.ts",
      kind: "class",
      name: "Members",
      properties: [
        { name: "plain", type: null, optional: false, modifiers: ["public"] },
        { name: "secret", type: null, optional: false, modifiers: ["private"] },
        { name: "shared", type: null, optional: false, modifiers: ["protected"] },
        { name: "counter", type: null, optional: false, modifiers: ["static"] },
        // characterizes: an unannotated member carries no type - nothing is inferred
        { name: "frozen", type: null, optional: false, modifiers: ["readonly"] },
        { name: "both", type: null, optional: false, modifiers: ["static", "readonly"] },
        // characterizes: `?` sets optional and strips the trailing "| undefined"
        { name: "optional", type: "string", optional: true, modifiers: [] },
        { name: "definite", type: "string", optional: false, modifiers: [] },
        { name: "tracked", type: null, optional: false, modifiers: ["accessor"] },
        { name: "ambient", type: "number", optional: false, modifiers: ["ambient"] },
        // characterizes: `#private` fields are kept, name included
        { name: "#hard", type: null, optional: false, modifiers: [] },
        // characterizes: an arrow-function field stays a property, never a method, and its
        // unannotated declaration leaves the property untyped
        { name: "arrow", type: null, optional: false, modifiers: [] },
        // characterizes: constructor parameter properties are appended after the class fields
        { name: "injected", type: "string", optional: false, modifiers: ["public"] },
        { name: "hidden", type: "number", optional: false, modifiers: ["private"] },
      ],
      // characterizes: get/set accessors and the constructor contribute no method rows
      methods: [
        { name: "run", type: "\n§() void", modifiers: ["abstract"] },
        { name: "load", type: "\n§() Promise⟨void⟩", modifiers: ["async"] },
        // characterizes: an explicit `| undefined` return annotation is preserved verbatim
        { name: "make", type: "\n§() Members | undefined", modifiers: ["protected", "static"] },
      ],
      enumItems: [],
      heritage: [],
    },
    {
      // characterizes: call, construct and index signatures contribute nothing
      file: "src/members.ts",
      kind: "interface",
      name: "Signatures",
      properties: [{ name: "ro", type: "string", optional: false, modifiers: ["readonly"] }],
      // characterizes: an optional method keeps no optional marker of its own
      methods: [{ name: "method", type: "\n§() void", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
  ]);
}, 30_000);

test("merged declarations and overloads share one entity", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-merged-", {
    "src/merged.ts": `export interface Merged {
  first(): void;
}
export interface Merged {
  second(): void;
}
export class Merged2 {
  run(): void {}
}
export namespace Merged2 {
  export const flag = 1;
}
export class Overloads {
  run(value: string): string;
  run(value: number): number;
  run(value: string | number): string | number {
    return value;
  }
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: each merged block is its own entity row, all sharing one graph node
  expect(contract.entities).toEqual([
    {
      file: "src/merged.ts",
      kind: "class",
      name: "Merged2",
      properties: [],
      methods: [{ name: "run", type: "\n§() void", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
    {
      // characterizes: overloads collapse into the implementation signature only
      file: "src/merged.ts",
      kind: "class",
      name: "Overloads",
      properties: [],
      methods: [{ name: "run", type: "\n§() string | number", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
    {
      file: "src/merged.ts",
      kind: "interface",
      name: "Merged",
      properties: [],
      methods: [{ name: "first", type: "\n§() void", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
    {
      file: "src/merged.ts",
      kind: "interface",
      name: "Merged",
      properties: [],
      methods: [{ name: "second", type: "\n§() void", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
  ]);
  expect(contract.nodes).toEqual([
    { name: "Merged2", kind: "entity", community: 0 },
    { name: "Overloads", kind: "entity", community: 1 },
    { name: "Merged", kind: "entity", community: 2 },
  ]);
  expect(contract.definitions).toEqual([
    {
      definitionOrdinal: 0,
      definitionKey: '["interface","Merged",0,null,null]',
      definitionKind: "interface",
      name: "Merged",
      qualifiedName: "Merged",
      sourcePath: "src/merged.ts",
      sourceLine: 1,
      sourceColumn: 18,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 1,
      definitionKey: '["interface","Merged",0,"first",0]',
      definitionKind: "method",
      name: "first",
      qualifiedName: "Merged.first",
      sourcePath: "src/merged.ts",
      sourceLine: 2,
      sourceColumn: 3,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged",
      umlMemberName: "first",
      umlMemberOccurrence: 0,
    },
    {
      definitionOrdinal: 2,
      definitionKey: '["interface","Merged",1,null,null]',
      definitionKind: "interface",
      name: "Merged",
      qualifiedName: "Merged",
      sourcePath: "src/merged.ts",
      sourceLine: 4,
      sourceColumn: 18,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 3,
      definitionKey: '["interface","Merged",1,"second",0]',
      definitionKind: "method",
      name: "second",
      qualifiedName: "Merged.second",
      sourcePath: "src/merged.ts",
      sourceLine: 5,
      sourceColumn: 3,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged",
      umlMemberName: "second",
      umlMemberOccurrence: 0,
    },
    {
      definitionOrdinal: 4,
      definitionKey: '["class","Merged2",0,null,null]',
      definitionKind: "class",
      name: "Merged2",
      qualifiedName: "Merged2",
      sourcePath: "src/merged.ts",
      sourceLine: 7,
      sourceColumn: 14,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged2",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 5,
      definitionKey: '["class","Merged2",0,"run",0]',
      definitionKind: "method",
      name: "run",
      qualifiedName: "Merged2.run",
      sourcePath: "src/merged.ts",
      sourceLine: 8,
      sourceColumn: 3,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Merged2",
      umlMemberName: "run",
      umlMemberOccurrence: 0,
    },
    {
      definitionOrdinal: 6,
      definitionKey: '["class","Overloads",0,null,null]',
      definitionKind: "class",
      name: "Overloads",
      qualifiedName: "Overloads",
      sourcePath: "src/merged.ts",
      sourceLine: 13,
      sourceColumn: 14,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Overloads",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      // characterizes: only the first overload span is recorded, at the first signature
      definitionOrdinal: 7,
      definitionKey: '["class","Overloads",0,"run",0]',
      definitionKind: "method",
      name: "run",
      qualifiedName: "Overloads.run",
      sourcePath: "src/merged.ts",
      sourceLine: 14,
      sourceColumn: 3,
      umlScopePath: "src/merged.ts",
      umlEntityName: "Overloads",
      umlMemberName: "run",
      umlMemberOccurrence: 0,
    },
  ]);
}, 30_000);

test("export form does not change entity extraction, and duplicate names stay distinct", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-exports-", {
    "src/a.ts": `export class Dup {}
class Hidden {}
export default class Named {}
`,
    "src/anon.ts": `export default class {}
`,
    "src/b.ts": `export * from "./a.ts";
export class Dup {}
export { Dup as Aliased };
`,
  });

  const graph = await extractNormalizedGraph(root);

  // characterizes: non-exported and default-exported classes are extracted like exported ones
  expect(graph.entities.map((entity) => entity.nodeId)).toEqual([
    '"<root>/src/a".Dup',
    '"<root>/src/a".Hidden',
    '"<root>/src/a".Named',
    // characterizes: an anonymous default export becomes the entity named "default"
    '"<root>/src/anon".default',
    '"<root>/src/b".Dup',
  ]);
  // characterizes: same-named classes in different files stay separate nodes;
  // `export { Dup as Aliased }` adds an export local-user node instead of an entity
  expect(graph.nodes.map((node) => node.name).sort()).toEqual([
    "Dup",
    "Dup",
    "Hidden",
    "Named",
    "default",
    "export: src/b.ts: Aliased",
  ]);
  // characterizes: the anonymous default export produces no definition row
  expect(graph.definitions).toEqual([
    {
      definitionOrdinal: 0,
      definitionKey: '["class","Dup",0,null,null]',
      definitionKind: "class",
      name: "Dup",
      qualifiedName: "Dup",
      sourcePath: "src/a.ts",
      sourceLine: 1,
      sourceColumn: 14,
      umlScopePath: "src/a.ts",
      umlEntityName: "Dup",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 1,
      definitionKey: '["class","Hidden",0,null,null]',
      definitionKind: "class",
      name: "Hidden",
      qualifiedName: "Hidden",
      sourcePath: "src/a.ts",
      sourceLine: 2,
      sourceColumn: 7,
      umlScopePath: "src/a.ts",
      umlEntityName: "Hidden",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 2,
      definitionKey: '["class","Named",0,null,null]',
      definitionKind: "class",
      name: "Named",
      qualifiedName: "Named",
      sourcePath: "src/a.ts",
      sourceLine: 3,
      sourceColumn: 22,
      umlScopePath: "src/a.ts",
      umlEntityName: "Named",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
    {
      definitionOrdinal: 3,
      definitionKey: '["class","Dup",0,null,null]',
      definitionKind: "class",
      name: "Dup",
      qualifiedName: "Dup",
      sourcePath: "src/b.ts",
      sourceLine: 2,
      sourceColumn: 14,
      umlScopePath: "src/b.ts",
      umlEntityName: "Dup",
      umlMemberName: null,
      umlMemberOccurrence: null,
    },
  ]);
}, 30_000);

test("heritage records extends and implements, and unresolved bases become boundary nodes", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-heritage-", {
    "src/vendor.d.ts": `export declare class Missing {}
`,
    "src/model.ts": `import { Missing } from "./vendor";
export class Base {}
export interface First {}
export interface Second {}
export class Box<T> {
  value!: T;
}
export class Sub extends Base {}
export class Impl implements First, Second {}
export interface Wide extends First, Second {}
export class Narrow extends Box<string> {}
export class Foreign extends Missing {}
`,
  });

  const { contract } = await extractContract(root);

  expect(
    contract.entities.map(({ name, heritage }) => ({ name, heritage })),
  ).toEqual([
    { name: "Base", heritage: [] },
    { name: "Box<T>", heritage: [] },
    { name: "Sub", heritage: [{ kind: "extends", clause: "Base", className: "Sub" }] },
    {
      name: "Impl",
      heritage: [
        { kind: "implements", clause: "First", className: "Impl" },
        { kind: "implements", clause: "Second", className: "Impl" },
      ],
    },
    {
      // characterizes: a generic base is recorded by its declared name, not the instantiation
      name: "Narrow",
      heritage: [{ kind: "extends", clause: "Box<T>", className: "Narrow" }],
    },
    { name: "Foreign", heritage: [{ kind: "extends", clause: "Missing", className: "Foreign" }] },
    { name: "First", heritage: [] },
    { name: "Second", heritage: [] },
    {
      // characterizes: `interface extends` is recorded as an implements clause
      name: "Wide",
      heritage: [
        { kind: "implements", clause: "First", className: "Wide" },
        { kind: "implements", clause: "Second", className: "Wide" },
      ],
    },
  ]);
  // characterizes: `Missing` lives only in the excluded .d.ts, so it surfaces as a boundary node
  expect(contract.nodes.map(({ name, kind }) => ({ name, kind }))).toEqual([
    { name: "Base", kind: "entity" },
    { name: "Box<T>", kind: "entity" },
    { name: "Sub", kind: "entity" },
    { name: "Impl", kind: "entity" },
    { name: "Narrow", kind: "entity" },
    { name: "Foreign", kind: "entity" },
    { name: "First", kind: "entity" },
    { name: "Second", kind: "entity" },
    { name: "Wide", kind: "entity" },
    { name: "Missing", kind: "boundary" },
  ]);
}, 30_000);

test("member associations link entities through property types", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-associations-", {
    "src/model.ts": `export class Other {}
export type Handle = { id: string };
export class Owner {
  other!: Other;
  many!: Other[];
  maybe?: Other;
  self!: Owner;
  handle!: Handle;
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: one association per property, arrays carry 0..*, self-references are removed
  expect(contract.associations).toEqual([
    { a: "Owner", aMultiplicity: null, b: "Other", bMultiplicity: null, inherited: false },
    { a: "Owner", aMultiplicity: null, b: "Other", bMultiplicity: "0..*", inherited: false },
    { a: "Owner", aMultiplicity: null, b: "Other", bMultiplicity: null, inherited: false },
    { a: "Owner", aMultiplicity: null, b: "Handle", bMultiplicity: null, inherited: false },
  ]);
  // characterizes: duplicate associations aggregate onto one edge that also carries a usage relation
  expect(contract.relations).toEqual([
    { kind: "member-association", source: "Owner", target: "Other" },
    { kind: "member-association", source: "Owner", target: "Other" },
    { kind: "member-association", source: "Owner", target: "Other" },
    { kind: "usage", source: "Owner", target: "Other" },
    { kind: "member-association", source: "Owner", target: "Handle" },
    { kind: "usage", source: "Owner", target: "Handle" },
  ]);
  expect(contract.edges).toEqual([
    { a: "Other", b: "Owner", weight: 4 },
    { a: "Handle", b: "Owner", weight: 2 },
  ]);
}, 30_000);

test("enum items keep their rendered values", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-enums-", {
    "src/enums.ts": `export enum Numbers {
  First,
  Second = 5,
}
export enum Strings {
  Ready = "ready",
}
export enum Computed {
  Shifted = 1 << 2,
}
export const enum Constant {
  Only,
}
declare enum Ambient {
  Value,
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: enum items record member names only - initializers never reach the model
  expect(contract.entities).toEqual([
    {
      file: "src/enums.ts",
      kind: "enum",
      name: "Numbers",
      properties: [],
      methods: [],
      enumItems: ["First", "Second"],
      heritage: [],
    },
    {
      file: "src/enums.ts",
      kind: "enum",
      name: "Strings",
      properties: [],
      methods: [],
      enumItems: ["Ready"],
      heritage: [],
    },
    {
      file: "src/enums.ts",
      kind: "enum",
      name: "Computed",
      properties: [],
      methods: [],
      enumItems: ["Shifted"],
      heritage: [],
    },
    {
      file: "src/enums.ts",
      kind: "enum",
      name: "Constant",
      properties: [],
      methods: [],
      enumItems: ["Only"],
      heritage: [],
    },
    {
      // characterizes: `declare enum` inside a .ts file is extracted like a plain enum
      file: "src/enums.ts",
      kind: "enum",
      name: "Ambient",
      properties: [],
      methods: [],
      enumItems: ["Value"],
      heritage: [],
    },
  ]);
}, 30_000);

test("file forms decide what is extracted", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-files-", {
    "a.ts": `export class InTs {}
`,
    "b.tsx": `export class InTsx {
  render() {
    return <div className="tsx" />;
  }
}
`,
    "c.mts": `export class InMts {}
`,
    "d.cts": `export class InCts {}
`,
    "e.d.ts": `export declare class InDts {}
`,
    "node_modules/pkg/f.ts": `export class InNodeModules {}
`,
    ".explore/g.ts": `export class InExplore {}
`,
    "dist/h.ts": `export class InDist {}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: .ts/.tsx/.mts/.cts are extracted; .d.ts, node_modules and .explore are not.
  // `dist` is ignored for traversal but not for UML extraction (src/source.ts:11).
  expect(contract.entities.map(({ file, name }) => ({ file, name }))).toEqual([
    { file: "a.ts", name: "InTs" },
    { file: "b.tsx", name: "InTsx" },
    { file: "c.mts", name: "InMts" },
    { file: "d.cts", name: "InCts" },
    { file: "dist/h.ts", name: "InDist" },
  ]);
}, 30_000);

test("entity ids embed the declaring file path", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-ids-", {
    "src/model.ts": `export class Widget {}
export class Box<T> {
  value!: T;
}
`,
    "src/nested/deep.ts": `export interface Deep {
  id: string;
}
`,
  });

  const graph = await extractNormalizedGraph(root);

  // The only test that pins raw tsuml2 ids. Two consumers depend on this exact shape:
  // the generic alias derivation at src/uml/graph.ts:66-71 slices the rendered name off the id,
  // and umlEntityKey at src/uml/keys.ts:11-14 rebuilds the same `<file>\0<name>` pairing.
  expect(graph.entities.map((entity) => entity.nodeId)).toEqual([
    '"<root>/src/model".Widget',
    '"<root>/src/model".Box<T>',
    '"<root>/src/nested/deep".Deep',
  ]);
  // characterizes: the `Box` alias is only materialized when an endpoint references it
  expect(graph.aliases).toEqual([]);
}, 30_000);

test("a malformed source file does not lose the rest of the scope", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-contract-malformed-", {
    "src/broken.ts": `export class Broken {
  run(): void {}
`,
    "src/valid.ts": `export class Valid {
  ok(): boolean {
    return true;
  }
}
`,
  });

  const { contract } = await extractContract(root);

  // characterizes: the recovered parse of a file with an unclosed class still contributes its
  // entity and members, and the valid file is unaffected.
  expect(contract.entities).toEqual([
    {
      file: "src/broken.ts",
      kind: "class",
      name: "Broken",
      properties: [],
      methods: [{ name: "run", type: "\n§() void", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
    {
      file: "src/valid.ts",
      kind: "class",
      name: "Valid",
      properties: [],
      methods: [{ name: "ok", type: "\n§() boolean", modifiers: [] }],
      enumItems: [],
      heritage: [],
    },
  ]);
  expect(contract.definitions.map(({ definitionKey, sourcePath }) => ({
    definitionKey,
    sourcePath,
  }))).toEqual([
    { definitionKey: '["class","Broken",0,null,null]', sourcePath: "src/broken.ts" },
    { definitionKey: '["class","Broken",0,"run",0]', sourcePath: "src/broken.ts" },
    { definitionKey: '["class","Valid",0,null,null]', sourcePath: "src/valid.ts" },
    { definitionKey: '["class","Valid",0,"ok",0]', sourcePath: "src/valid.ts" },
  ]);
}, 30_000);
