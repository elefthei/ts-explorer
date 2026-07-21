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
  expect(formattedDefinitions[3]!.from).not.toBe(compactDefinitions[3]!.from);
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

test("accepts every supported TypeScript source extension", () => {
  for (const path of ["component.ts", "component.tsx", "component.mts", "component.cts"]) {
    expect(
      parseDefinitionSpans(path, "export class Component {}\n").map(({ key }) => key),
      path,
    ).toEqual(['["class","Component",0,null,null]']);
  }
});
