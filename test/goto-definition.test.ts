import { expect, test } from "bun:test";
import { parseDefinitionSpans, parseFileDefinitions } from "../src/goto-definition.ts";

function outlineRows(path: string, content: string) {
  return parseFileDefinitions(path, content).map((definition) =>
    `${definition.qualifiedName} ${definition.kind} ${definition.type ?? "—"} ${definition.source.line}:${definition.source.column}`
  );
}

/**
 * `qualifiedName | root|nested | owner`, resolving `parentKey` against the same file. The outline
 * key itself is an opaque identity, so ownership is asserted through the declaration it names.
 */
function ownershipRows(path: string, content: string) {
  const definitions = parseFileDefinitions(path, content);
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  return definitions.map((definition) => {
    const owner = definition.parentKey === null
      ? "—"
      : byKey.get(definition.parentKey)?.qualifiedName ?? "<unindexed>";
    return `${definition.qualifiedName} | ${definition.isTopLevel ? "root" : "nested"} | ${owner}`;
  });
}

function contractRows(path: string, content: string) {
  return parseDefinitionSpans(path, content).map((definition) => ({
    key: definition.key,
    kind: definition.kind,
    name: definition.name,
    qualifiedName: definition.qualifiedName,
    entityKind: definition.entityKind,
    renderedEntityName: definition.renderedEntityName,
    entityOccurrence: definition.entityOccurrence,
    memberName: definition.memberName,
    sourceMemberOccurrence: definition.sourceMemberOccurrence,
    line: definition.line,
    column: definition.column,
    token: content.slice(definition.from, definition.to),
  }));
}

/** One interface merged from two declarations, in compact and reformatted spellings. */
const MERGED_COMPACT = [
  "export interface Merged<T>{run():void}",
  "export interface Merged<T>{run(value:T):void;stop():void}",
  "",
].join("\n");
const MERGED_FORMATTED = [
  "export interface Merged<T> {",
  "  run(): void;",
  "}",
  "export interface Merged<T> {",
  "  run(value: T): void;",
  "  stop(): void;",
  "}",
  "",
].join("\n");

test("parses every UML-addressable declaration with canonical names, keys, and source spans", () => {
  const source = [
    "export class Box<T, U> {",
    "  run(value: string): string;",
    "  run(value: number): number;",
    "  run(value: string | number) { return value; }",
    '  "quoted"(): void {}',
    "  7(): void {}",
    "}",
    "export interface Service<T> {",
    "  execute(): T;",
    "}",
    "export enum Status { Ready }",
    "export type Hooks<T> = {",
    "  before(): T;",
    '  "after"(): void;',
    "  9(): void;",
    "};",
    "export type Identifier = string;",
    "export type Callable = () => void;",
    "",
  ].join("\n");

  expect(contractRows("model.ts", source)).toEqual([
    {
      key: '["class","Box",0,null,null]',
      kind: "class",
      name: "Box",
      qualifiedName: "Box",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 1,
      column: 14,
      token: "Box",
    },
    {
      key: '["class","Box",0,"run",0]',
      kind: "method",
      name: "run",
      qualifiedName: "Box.run",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: "run",
      sourceMemberOccurrence: 0,
      line: 2,
      column: 3,
      token: "run",
    },
    {
      key: '["class","Box",0,"run",1]',
      kind: "method",
      name: "run",
      qualifiedName: "Box.run",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: "run",
      sourceMemberOccurrence: 1,
      line: 3,
      column: 3,
      token: "run",
    },
    {
      key: '["class","Box",0,"run",2]',
      kind: "method",
      name: "run",
      qualifiedName: "Box.run",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: "run",
      sourceMemberOccurrence: 2,
      line: 4,
      column: 3,
      token: "run",
    },
    {
      key: '["class","Box",0,"quoted",0]',
      kind: "method",
      name: "quoted",
      qualifiedName: "Box.quoted",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: "quoted",
      sourceMemberOccurrence: 0,
      line: 5,
      column: 3,
      token: '"quoted"',
    },
    {
      key: '["class","Box",0,"7",0]',
      kind: "method",
      name: "7",
      qualifiedName: "Box.7",
      entityKind: "class",
      renderedEntityName: "Box<T,U>",
      entityOccurrence: 0,
      memberName: "7",
      sourceMemberOccurrence: 0,
      line: 6,
      column: 3,
      token: "7",
    },
    {
      key: '["interface","Service",0,null,null]',
      kind: "interface",
      name: "Service",
      qualifiedName: "Service",
      entityKind: "interface",
      renderedEntityName: "Service<T>",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 8,
      column: 18,
      token: "Service",
    },
    {
      key: '["interface","Service",0,"execute",0]',
      kind: "method",
      name: "execute",
      qualifiedName: "Service.execute",
      entityKind: "interface",
      renderedEntityName: "Service<T>",
      entityOccurrence: 0,
      memberName: "execute",
      sourceMemberOccurrence: 0,
      line: 9,
      column: 3,
      token: "execute",
    },
    {
      key: '["enum","Status",0,null,null]',
      kind: "enum",
      name: "Status",
      qualifiedName: "Status",
      entityKind: "enum",
      renderedEntityName: "Status",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 11,
      column: 13,
      token: "Status",
    },
    {
      key: '["type","Hooks",0,null,null]',
      kind: "type",
      name: "Hooks",
      qualifiedName: "Hooks",
      entityKind: "type",
      renderedEntityName: "Hooks<T>",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 12,
      column: 13,
      token: "Hooks",
    },
    {
      key: '["type","Hooks",0,"before",0]',
      kind: "method",
      name: "before",
      qualifiedName: "Hooks.before",
      entityKind: "type",
      renderedEntityName: "Hooks<T>",
      entityOccurrence: 0,
      memberName: "before",
      sourceMemberOccurrence: 0,
      line: 13,
      column: 3,
      token: "before",
    },
    {
      key: '["type","Hooks",0,"after",0]',
      kind: "method",
      name: "after",
      qualifiedName: "Hooks.after",
      entityKind: "type",
      renderedEntityName: "Hooks<T>",
      entityOccurrence: 0,
      memberName: "after",
      sourceMemberOccurrence: 0,
      line: 14,
      column: 3,
      token: '"after"',
    },
    {
      key: '["type","Hooks",0,"9",0]',
      kind: "method",
      name: "9",
      qualifiedName: "Hooks.9",
      entityKind: "type",
      renderedEntityName: "Hooks<T>",
      entityOccurrence: 0,
      memberName: "9",
      sourceMemberOccurrence: 0,
      line: 15,
      column: 3,
      token: "9",
    },
    {
      key: '["type","Identifier",0,null,null]',
      kind: "type",
      name: "Identifier",
      qualifiedName: "Identifier",
      entityKind: "type",
      renderedEntityName: "Identifier",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 17,
      column: 13,
      token: "Identifier",
    },
    {
      key: '["type","Callable",0,null,null]',
      kind: "type",
      name: "Callable",
      qualifiedName: "Callable",
      entityKind: "type",
      renderedEntityName: "Callable",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 18,
      column: 13,
      token: "Callable",
    },
  ]);
});

test("keys distinguish declaration merges and overloads while remaining stable after formatting", () => {
  const compactDefinitions = parseDefinitionSpans("merged.ts", MERGED_COMPACT);
  const formattedDefinitions = parseDefinitionSpans("merged.ts", MERGED_FORMATTED);
  const expectedKeys = [
    '["interface","Merged",0,null,null]',
    '["interface","Merged",0,"run",0]',
    '["interface","Merged",1,null,null]',
    '["interface","Merged",1,"run",1]',
    '["interface","Merged",1,"stop",0]',
  ];

  expect(compactDefinitions.map(({ key }) => key)).toEqual(expectedKeys);
  expect(formattedDefinitions.map(({ key }) => key)).toEqual(expectedKeys);
  expect(formattedDefinitions.map(({ line, column }) => ({ line, column }))).toEqual([
    { line: 1, column: 18 },
    { line: 2, column: 3 },
    { line: 4, column: 18 },
    { line: 5, column: 3 },
    { line: 6, column: 3 },
  ]);
  const compactRun = compactDefinitions[3];
  const formattedRun = formattedDefinitions[3];
  if (!compactRun || !formattedRun) {
    throw new Error("expected merged interface run definitions");
  }
  expect(formattedRun.from).not.toBe(compactRun.from);
});

test("excludes declarations that have no canonical UML definition target", () => {
  const source = [
    "const computed = Symbol();",
    "export default class {",
    "  hidden(): void {}",
    "}",
    "export class Visible {",
    "  constructor() {}",
    "  property = 1;",
    "  get current() { return this.property; }",
    "  set current(value: number) { this.property = value; }",
    "  [computed](): void {}",
    "  method(): void { class NestedInMethod {} }",
    "}",
    "namespace Scope {",
    "  export class NestedClass {}",
    "  export interface NestedInterface {}",
    "}",
    "export function freeFunction(): void {}",
    "export const Anonymous = class NamedExpression {};",
    "",
  ].join("\n");

  expect(
    parseDefinitionSpans("visible.ts", source).map(({ key, kind, name }) => ({ key, kind, name })),
  ).toEqual([
    { key: '["class","Visible",0,null,null]', kind: "class", name: "Visible" },
    { key: '["class","Visible",0,"method",0]', kind: "method", name: "method" },
  ]);

  for (const path of ["visible.d.ts", "visible.d.mts", "visible.d.cts", "visible.js"]) {
    expect(parseDefinitionSpans(path, source), path).toEqual([]);
  }
});

test("accepts every supported source extension", () => {
  for (const path of ["component.ts", "component.tsx", "component.mts", "component.cts"]) {
    expect(
      parseDefinitionSpans(path, "export class Component {}\n").map(({ key }) => key),
      path,
    ).toEqual(['["class","Component",0,null,null]']);
  }
  expect(
    parseDefinitionSpans("component.rs", "pub struct Component;\n").map(({ key }) => key),
  ).toEqual(['["class","Component",0,null,null]']);
});

test("CRLF sources keep one-based line and column", () => {
  const lines = [
    "export class Box {",
    "  run(): void {}",
    "}",
    "export interface Service {",
    "  execute(): void;",
    "}",
    "",
  ];
  const lf = lines.join("\n");
  const crlf = lines.join("\r\n");

  expect(contractRows("model.ts", crlf)).toEqual(contractRows("model.ts", lf));
  expect(parseDefinitionSpans("model.ts", lf).map(({ from, to }) => [from, to])).toEqual([
    [13, 16],
    [21, 24],
    [55, 62],
    [67, 74],
  ]);
  // characterizes: only the raw offsets absorb the extra carriage returns
  expect(parseDefinitionSpans("model.ts", crlf).map(({ from, to }) => [from, to])).toEqual([
    [13, 16],
    [22, 25],
    [58, 65],
    [71, 78],
  ]);
});

test("Unicode and astral identifiers report UTF-16 columns", () => {
  const source = [
    "export class Ünïcode {",
    "  ströme(): void {}",
    "}",
    "",
  ].join("\n");

  expect(contractRows("model.ts", source)).toEqual([
    {
      key: '["class","Ünïcode",0,null,null]',
      kind: "class",
      name: "Ünïcode",
      qualifiedName: "Ünïcode",
      entityKind: "class",
      renderedEntityName: "Ünïcode",
      entityOccurrence: 0,
      memberName: undefined,
      sourceMemberOccurrence: undefined,
      line: 1,
      column: 14,
      token: "Ünïcode",
    },
    {
      key: '["class","Ünïcode",0,"ströme",0]',
      kind: "method",
      name: "ströme",
      qualifiedName: "Ünïcode.ströme",
      entityKind: "class",
      renderedEntityName: "Ünïcode",
      entityOccurrence: 0,
      memberName: "ströme",
      sourceMemberOccurrence: 0,
      line: 2,
      column: 3,
      token: "ströme",
    },
  ]);

  // characterizes: columns count UTF-16 code units, so the astral name shifts `run` by two
  const astral = "export class A\u{1D465}B { run(): void {} }\n";
  expect(contractRows("model.ts", astral).map(({ name, line, column }) => ({
    name,
    line,
    column,
  }))).toEqual([
    { name: "A\u{1D465}B", line: 1, column: 14 },
    { name: "run", line: 1, column: 21 },
  ]);

  // characterizes: a leading BOM is counted as a column on the first line
  const bom = "\uFEFFexport class Bommed {\n  run(): void {}\n}\n";
  expect(contractRows("model.ts", bom).map(({ name, line, column }) => ({
    name,
    line,
    column,
  }))).toEqual([
    { name: "Bommed", line: 1, column: 15 },
    { name: "run", line: 2, column: 3 },
  ]);
});

test("tabs, missing trailing newline and blank leading lines", () => {
  const tabbed = "export class Tabbed {\n\trun(): void {}\n}\n";
  const unterminated = "export class NoNewline {\n  run(): void {}\n}";
  const leadingBlanks = "\n\nexport class Late {\n  run(): void {}\n}\n";

  // characterizes: a tab is one column, exactly like any other single code unit
  expect(contractRows("model.ts", tabbed).map(({ name, line, column }) => ({
    name,
    line,
    column,
  }))).toEqual([
    { name: "Tabbed", line: 1, column: 14 },
    { name: "run", line: 2, column: 2 },
  ]);
  expect(contractRows("model.ts", unterminated).map(({ name, line, column }) => ({
    name,
    line,
    column,
  }))).toEqual([
    { name: "NoNewline", line: 1, column: 14 },
    { name: "run", line: 2, column: 3 },
  ]);
  expect(contractRows("model.ts", leadingBlanks).map(({ name, line, column }) => ({
    name,
    line,
    column,
  }))).toEqual([
    { name: "Late", line: 3, column: 14 },
    { name: "run", line: 4, column: 3 },
  ]);
});

test("decorators and leading modifiers do not move the name span", () => {
  const source = [
    "declare const dec: ClassDecorator;",
    "@dec export abstract class Decorated {",
    "  abstract run(): void;",
    "}",
    "export default abstract class Named {",
    "  run(): void {}",
    "}",
    "declare class Ambient {",
    "  run(): void;",
    "}",
    "",
  ].join("\n");

  // characterizes: the span always lands on the name token, whatever precedes it on the line
  expect(contractRows("model.ts", source).map(({ key, line, column, token }) => ({
    key,
    line,
    column,
    token,
  }))).toEqual([
    { key: '["class","Decorated",0,null,null]', line: 2, column: 28, token: "Decorated" },
    { key: '["class","Decorated",0,"run",0]', line: 3, column: 12, token: "run" },
    { key: '["class","Named",0,null,null]', line: 5, column: 31, token: "Named" },
    { key: '["class","Named",0,"run",0]', line: 6, column: 3, token: "run" },
    { key: '["class","Ambient",0,null,null]', line: 8, column: 15, token: "Ambient" },
    { key: '["class","Ambient",0,"run",0]', line: 9, column: 3, token: "run" },
  ]);
});

test("namespace-nested and ambient-module declarations stay excluded", () => {
  const source = [
    "namespace N {",
    "  export class Inner {}",
    "  export interface Shape {}",
    "}",
    'declare module "m" {',
    "  export class Ambient {}",
    "  export interface Contract {}",
    "}",
    "",
  ].join("\n");

  expect(contractRows("model.ts", source)).toEqual([]);
});

test("TSX generic arrow syntax parses as TSX", () => {
  const withTrailingComma = "const f = <T,>(v: T) => v;\nexport class Component {\n  run(): void {}\n}\n";
  const withoutTrailingComma = "const f = <T>(v: T) => v;\nexport class Component {\n  run(): void {}\n}\n";

  expect(contractRows("component.tsx", withTrailingComma).map(({ key, line, column }) => ({
    key,
    line,
    column,
  }))).toEqual([
    { key: '["class","Component",0,null,null]', line: 2, column: 14 },
    { key: '["class","Component",0,"run",0]', line: 3, column: 3 },
  ]);
  // characterizes: tree-sitter-tsx accepts the ambiguous generic arrow instead of reading `<T>`
  // as the start of a JSX element, so the declarations after it stay navigable in both parsers
  expect(contractRows("component.tsx", withoutTrailingComma).map(({ key, line, column }) => ({
    key,
    line,
    column,
  }))).toEqual([
    { key: '["class","Component",0,null,null]', line: 2, column: 14 },
    { key: '["class","Component",0,"run",0]', line: 3, column: 3 },
  ]);
  expect(contractRows("component.ts", withoutTrailingComma).map(({ key }) => key)).toEqual([
    '["class","Component",0,null,null]',
    '["class","Component",0,"run",0]',
  ]);
});

test("outlines unreferenced constants and free functions that UML never addresses", () => {
  const source = [
    "const UNUSED_LIMIT: number = 3;",
    "let mutable = 1;",
    "function unreferenced(value: string): number { const local = value.length; return local; }",
    "",
  ].join("\n");
  // These declare no UML entity at all, so `parseDefinitionSpans` is empty by design.
  expect(parseDefinitionSpans("free.ts", source)).toEqual([]);
  expect(outlineRows("free.ts", source)).toEqual([
    "UNUSED_LIMIT constant number 1:7",
    "mutable variable — 2:5",
    "unreferenced function (value: string): number 3:10",
  ]);
});

test("outlines destructured binding names rather than initializers or object keys", () => {
  const source = [
    "const { alpha, beta: renamed = 1, ...rest } = source;",
    "const [first, , third] = list;",
    "const { outer: { inner } } = nested;",
    "",
  ].join("\n");
  expect(outlineRows("bindings.ts", source)).toEqual([
    "alpha constant — 1:9",
    "renamed constant — 1:22",
    "rest constant — 1:38",
    "first constant — 2:8",
    "third constant — 2:17",
    "inner constant — 3:18",
  ]);
});

test("outlines namespace and ambient module members but never function locals or parameters", () => {
  const source = [
    "export namespace Outer.Inner {",
    "  export const FLAG: boolean = true;",
    "  export function run(step: number): void { const local = step; }",
    "}",
    'declare module "ext" { export function fromModule(): void; }',
    "declare global { interface Injected { field: string } }",
    "",
  ].join("\n");
  expect(outlineRows("namespaces.ts", source)).toEqual([
    "Outer namespace — 1:18",
    "Outer.Inner namespace — 1:24",
    "Outer.Inner.FLAG constant boolean 2:16",
    "Outer.Inner.run function (step: number): void 3:19",
    "ext module — 5:16",
    "ext.fromModule function (): void 5:40",
    "Injected interface Injected 6:28",
    "Injected.field property string 6:39",
  ]);
});

test("outlines every overload and same-name member at its own source position", () => {
  const source = [
    "export function pick(value: string): string;",
    "export function pick(value: number): number;",
    "export function pick(value: unknown): unknown { return value; }",
    "export class Pair {",
    "  get value(): number { return 1; }",
    "  set value(next: number) {}",
    "}",
    "",
  ].join("\n");
  expect(outlineRows("overloads.ts", source)).toEqual([
    "pick function (value: string): string 1:17",
    "pick function (value: number): number 2:17",
    "pick function (value: unknown): unknown 3:17",
    "Pair class Pair 4:14",
    "Pair.value getter (): number 5:7",
    "Pair.value setter (next: number) 6:7",
  ]);
  // Every overload signature is separately selectable and separately rooted, in source order.
  expect(ownershipRows("overloads.ts", source)).toEqual([
    "pick | root | —",
    "pick | root | —",
    "pick | root | —",
    "Pair | root | —",
    "Pair.value | nested | Pair",
    "Pair.value | nested | Pair",
  ]);
  const keys = parseFileDefinitions("overloads.ts", source).map(({ key }) => key);
  expect(new Set(keys).size, "every declaration is addressable on its own").toBe(keys.length);
});

test("outlines JavaScript declarations the UML analysis deliberately ignores", () => {
  const source = "export const enabled = true; export function ping() { const local = 1; return local; }\n";
  expect(parseDefinitionSpans("script.js", source)).toEqual([]);
  expect(outlineRows("script.js", source)).toEqual([
    "enabled constant — 1:14",
    "ping function () 1:46",
  ]);
});

test("AST scope, not dotted names, decides which outline rows are roots", () => {
  const source = [
    "export declare function wrapped(): void;",
    "declare const ambient: number;",
    "declare global {",
    "  interface Injected { field: string }",
    "}",
    "const { alpha, beta: renamed } = source;",
    "const [first] = list;",
    "export class Holder { value = 1; }",
    "export namespace Scope {",
    "  export class Nested {}",
    "}",
    "",
  ].join("\n");

  // `export`, `declare` and `declare global` add no scope, so what they wrap stays a root; a
  // container's own members never are, whatever their names look like.
  expect(ownershipRows("roots.ts", source)).toEqual([
    "wrapped | root | —",
    "ambient | root | —",
    "Injected | root | —",
    "Injected.field | nested | Injected",
    "alpha | root | —",
    "renamed | root | —",
    "first | root | —",
    "Holder | root | —",
    "Holder.value | nested | Holder",
    "Scope | root | —",
    "Scope.Nested | nested | Scope",
  ]);
});

test("a dotted namespace and a quoted ambient module own their members", () => {
  const source = [
    "export namespace Outer.Inner {",
    "  export const FLAG = true;",
    "}",
    'declare module "lib.core" {',
    "  export function fromModule(): void;",
    "}",
    "",
  ].join("\n");

  // `lib.core` is a file-scope declaration whose name happens to contain a dot: it is a root,
  // while `Outer.Inner` — a dotted name that really is nested — is not.
  expect(ownershipRows("modules.ts", source)).toEqual([
    "Outer | root | —",
    "Outer.Inner | nested | Outer",
    "Outer.Inner.FLAG | nested | Outer.Inner",
    "lib.core | root | —",
    "lib.core.fromModule | nested | lib.core",
  ]);
  expect(outlineRows("modules.ts", source)).toEqual([
    "Outer namespace — 1:18",
    "Outer.Inner namespace — 1:24",
    "Outer.Inner.FLAG constant — 2:16",
    "lib.core module — 4:16",
    "lib.core.fromModule function (): void 5:19",
  ]);
});

test("constructor parameter properties belong to the class, not the constructor", () => {
  const source = [
    "export class Account {",
    "  constructor(public readonly id: string, private label: string, plain: number) {}",
    "}",
    "",
  ].join("\n");

  // A plain parameter declares nothing; the two field-declaring parameters are class members.
  expect(ownershipRows("account.ts", source)).toEqual([
    "Account | root | —",
    "Account.constructor | nested | Account",
    "Account.id | nested | Account",
    "Account.label | nested | Account",
  ]);
  expect(outlineRows("account.ts", source)).toEqual([
    "Account class Account 1:14",
    "Account.constructor constructor (public readonly id: string, private label: string, plain: number) 2:3",
    "Account.id property string 2:31",
    "Account.label property string 2:51",
  ]);
});

test("outline keys identify one declaration per file and survive reformatting", () => {
  const compactKeys = parseFileDefinitions("merged.ts", MERGED_COMPACT).map(({ key }) => key);
  const formattedKeys = parseFileDefinitions("merged.ts", MERGED_FORMATTED).map(({ key }) => key);
  expect(compactKeys).toEqual(formattedKeys);
  expect(new Set(compactKeys).size).toBe(compactKeys.length);
  // A line-only edit keeps every root selectable, so a selection survives editing above it.
  expect(parseFileDefinitions("merged.ts", `\n\n${MERGED_FORMATTED}`).map(({ key }) => key))
    .toEqual(formattedKeys);
  // Each merged block owns its own members rather than the first block's.
  expect(ownershipRows("merged.ts", MERGED_FORMATTED)).toEqual([
    "Merged | root | —",
    "Merged.run | nested | Merged",
    "Merged | root | —",
    "Merged.run | nested | Merged",
    "Merged.stop | nested | Merged",
  ]);
  const [firstBlock, firstRun, secondBlock, secondRun] = parseFileDefinitions(
    "merged.ts",
    MERGED_FORMATTED,
  );
  expect(firstRun?.parentKey).toBe(firstBlock?.key ?? "");
  expect(secondRun?.parentKey).toBe(secondBlock?.key ?? "");

  // The same declaration text in another file is a different identity.
  const here = parseFileDefinitions("same.ts", "export class Shared {}\n");
  const there = parseFileDefinitions("nested/same.ts", "export class Shared {}\n");
  expect(there[0]?.qualifiedName).toBe(here[0]?.qualifiedName ?? "");
  expect(there[0]?.key).not.toBe(here[0]?.key ?? "");
});

test("Rust impl members are never file roots and extern blocks add no scope", () => {
  const source = [
    "pub struct Root;",
    "impl Root { pub fn make(&self) -> u32 { 1 } }",
    'extern "C" { pub fn external(value: u32) -> u32; }',
    "pub mod inline { pub const FLAG: bool = true; }",
    "pub trait Contract { fn run(&self); }",
    "",
  ].join("\n");

  // `Root.make` is owned by the type it implements, which may live in another file, so the
  // project catalogue resolves its owner; the parser only refuses to make it a file root.
  expect(ownershipRows("lib.rs", source)).toEqual([
    "Root | root | —",
    "Root.make | nested | —",
    "external | root | —",
    "inline | root | —",
    "inline.FLAG | nested | inline",
    "Contract | root | —",
    "Contract.run | nested | Contract",
  ]);
});
