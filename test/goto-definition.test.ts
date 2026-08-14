import { expect, test } from "bun:test";
import { parseDefinitionSpans } from "../src/goto-definition.ts";

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
  const compact = [
    "export interface Merged<T>{run():void}",
    "export interface Merged<T>{run(value:T):void;stop():void}",
    "",
  ].join("\n");
  const formatted = [
    "export interface Merged<T> {",
    "  run(): void;",
    "}",
    "export interface Merged<T> {",
    "  run(value: T): void;",
    "  stop(): void;",
    "}",
    "",
  ].join("\n");

  const compactDefinitions = parseDefinitionSpans("merged.ts", compact);
  const formattedDefinitions = parseDefinitionSpans("merged.ts", formatted);
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
