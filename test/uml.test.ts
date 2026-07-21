import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUmlDiagrams } from "../src/uml.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("renders generic and semantic UML styles including tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src", "model.ts"), `
    export interface Box<T> { value: T; }
    export abstract class Base { abstract run(): void; }
    export class Concrete extends Base implements Box<string> {
      value = "ok";
      run(): void {}
    }
    export interface Output { value: string; }
    export class ResultService {
      result!: { ok: true; output: Output } | { ok: false; rejection: Error };
      execute(): Promise<
        { ok: true; output: Output } |
        { ok: false; rejection: Error }
      > {
        throw new Error("not implemented");
      }
    }
  `);
  await writeFile(join(root, "tests", "example.test.ts"), `export class ExampleTest {}`);

  const dsl = (await buildUmlDiagrams(root, "", [])).dsl;
  const lines = dsl.split(/\r?\n/);
  const resultIndex = lines.findIndex((line) => line.includes("result:"));
  const executeIndex = lines.findIndex((line) => line.includes("execute()"));
  if (resultIndex === -1) {
    throw new Error("Expected generated UML to include the result property");
  }
  if (executeIndex === -1) {
    throw new Error("Expected generated UML to include the execute method");
  }

  const resultLine = lines[resultIndex].trim();
  const executeLine = lines[executeIndex].trim();
  const executeReturnRow =
    "§() Promise⟨｛ ok: true; output: Output; ｝ | ｛ ok: false; rejection: Error; ｝⟩";
  expect(resultLine).toContain(
    "result: ｛ ok: true; output: Output; ｝ | ｛ ok: false; rejection: Error; ｝",
  );
  expect(resultLine).not.toContain("§()");
  expect(executeLine).toBe("+execute()");
  expect(lines[executeIndex + 1]?.trim()).toBe(executeReturnRow);
  expect(lines.filter((line) => line.trim() === executeReturnRow)).toHaveLength(1);
  expect(dsl).toContain("ResultService");
  expect(dsl).not.toMatch(/\|\s*\{/);
  expect(dsl).toContain('cssClass "Output" interface');
  expect(dsl).toContain('cssClass "Base" abstract');
  expect(dsl).toContain('cssClass "ResultService" concrete');
  expect(dsl).toContain("classDiagram");
  expect(dsl).toContain('class Box["Box⟨T⟩"]');
  expect(dsl).toContain("Base<|--Concrete");
  expect(dsl).toContain("Box<|..Concrete");
  expect(dsl).toContain("classDef interface");
  expect(dsl).toContain("classDef abstract");
  expect(dsl).toContain("classDef concrete");
  expect(dsl).toContain("stroke:#ff5c5c");
  expect(dsl).toContain("stroke-dasharray: 6 4");
});

test("keeps generic labels Unicode while Mermaid identifiers remain parser-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-generic-identifiers-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "model.ts"),
    `export interface SessionStorage<TMetadata> {
  metadata: TMetadata;
}
export class DurableSessionStorage implements SessionStorage<string> {
  metadata = "";
}
export class JuncoAgent<TSkill, TTool, Ctx> {
  skill!: TSkill;
  tool!: TTool;
  context!: Ctx;
}
`,
  );

  const dsl = (await buildUmlDiagrams(root, "", [])).dsl;
  const lines = dsl.split(/\r?\n/);

  expect(dsl).toContain('class SessionStorage["SessionStorage⟨TMetadata⟩"]');
  expect(dsl).toContain('class JuncoAgent["JuncoAgent⟨TSkill,TTool,Ctx⟩"]');
  expect(dsl).toContain("SessionStorage<|..DurableSessionStorage");
  for (const line of lines.filter(
    (line) => /^class\s+/.test(line) || /(?:--|<\|\.\.|\.\.>)/.test(line),
  )) {
    expect(line.replace(/\["[^"]*"\]/g, "")).not.toMatch(/[⟨⟩]/);
  }
  expect(dsl).not.toContain("~");
});

test("renders const-only scopes without the tsuml2 no-entity sentinel", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-const-only-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.dsl.startsWith("classDiagram")).toBe(true);
  expect(bundle.dsl).not.toContain("[Could not process any class / interface / enum / type]");
  expect(bundle.dsls).toEqual([bundle.dsl]);
});

test("renders directed method-return edges for project-local types", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-returns-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "machines.ts"),
    `
      export class AbstractStateMachine {}
      export class AsyncStateMachine {}
      export class OptionalStateMachine {}
    `,
  );
  await writeFile(
    join(root, "src", "runtime.ts"),
    `
      import {
        AbstractStateMachine,
        AsyncStateMachine,
        OptionalStateMachine,
      } from "./machines";

      export class DataflowRuntime {
        getMachine(): AbstractStateMachine {
          throw new Error("not implemented");
        }

        getMachineAgain(): AbstractStateMachine {
          throw new Error("not implemented");
        }

        getAsyncMachine(): Promise<AsyncStateMachine> {
          throw new Error("not implemented");
        }

        getOptionalMachine(): OptionalStateMachine | undefined {
          throw new Error("not implemented");
        }

        getSelf(): DataflowRuntime {
          return this;
        }

        getDate(): Date {
          return new Date(0);
        }
      }
    `,
  );

  const dsl = (await buildUmlDiagrams(root, "", [])).dsl;

  expect(
    [...dsl.matchAll(/^[ \t]*DataflowRuntime[ \t]*-->[ \t]*AbstractStateMachine[ \t]*\r?$/gm)],
  ).toHaveLength(1);
  expect(
    [...dsl.matchAll(/^[ \t]*DataflowRuntime[ \t]*-->[ \t]*AsyncStateMachine[ \t]*\r?$/gm)],
  ).toHaveLength(1);
  expect(
    [...dsl.matchAll(/^[ \t]*DataflowRuntime[ \t]*-->[ \t]*OptionalStateMachine[ \t]*\r?$/gm)],
  ).toHaveLength(1);
  expect(dsl).not.toMatch(
    /^[ \t]*DataflowRuntime[ \t]*-->[ \t]*DataflowRuntime[ \t]*\r?$/gm,
  );
  expect(dsl).not.toMatch(/^[ \t]*DataflowRuntime[ \t]*-->[ \t]*Date[ \t]*\r?$/gm);
});

test("encodes nested generic member return types without Mermaid tildes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-nested-generics-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "model.ts"), `
    export interface GitCell { value: string; }
    export interface CapsResponse<C, T> { context: C; value: T; }
    export class Checker<C> {
      check(): CapsResponse<C, Readonly<Record<string, Readonly<Record<string, GitCell>>>>> {
        throw new Error("not implemented");
      }
    }
  `);
  await writeFile(join(root, "src", "sentinel.ts"), "export class Sentinel {}\n");

  const dsl = (await buildUmlDiagrams(root, "", [])).dsl;
  const lines = dsl.split(/\r?\n/);
  const checkIndex = lines.findIndex((line) => line.includes("check()"));
  if (checkIndex === -1) {
    throw new Error("Expected generated UML to include the generic check method");
  }

  const checkLine = lines[checkIndex].trim();
  const genericTypeLine = lines[checkIndex + 1]?.trim();
  expect(checkLine).toBe("+check()");
  expect(genericTypeLine).toBe(
    "§() CapsResponse⟨C, Readonly⟨Record⟨string, Readonly⟨Record⟨string, GitCell⟩⟩⟩⟩⟩",
  );
  expect(dsl).not.toContain("~");
  expect(genericTypeLine).not.toMatch(/[<>]/);
  expect(genericTypeLine).not.toMatch(/&(?:lt|gt);/);
});

test("removes import qualifiers from nested generic property and method labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-import-types-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "types.ts"),
    [
      "export interface Skill { name: string; }",
      "export interface AgentTool<TSchema, TContext> {",
      "  schema: TSchema;",
      "  context: TContext;",
      "}",
      "export interface DurableContext { durable: true; }",
      "export declare function definitions<TSchema>(): Map<Skill, AgentTool<TSchema, any>>;",
      "export declare function current<TSchema>(): {",
      "  tool: AgentTool<TSchema, any>;",
      "  context: DurableContext;",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "runtime.ts"),
    [
      'import { current, definitions } from "./types";',
      "export class Runtime<TSchema> {",
      "  readonly registry = definitions<TSchema>();",
      "  resolve() { return current<TSchema>(); }",
      "}",
      "",
    ].join("\n"),
  );

  const dsl = (await buildUmlDiagrams(root, "", [])).dsl;
  const lines = dsl.split(/\r?\n/).map((line) => line.trim());
  const registryLine = lines.find((line) => line.includes("registry:"));
  const resolveIndex = lines.findIndex((line) => line.includes("resolve()"));

  expect(registryLine).toBe("+registry: Map⟨Skill, AgentTool⟨TSchema, any⟩⟩");
  expect(lines[resolveIndex]).toBe("+resolve()");
  expect(lines[resolveIndex + 1]).toBe(
    "§() ｛ tool: AgentTool⟨TSchema, any⟩; context: DurableContext; ｝",
  );
});

test("reports canonical definition metadata with deterministic duplicate-name ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-sources-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "z-contracts.ts"),
    [
      "export interface Runner {",
      "  execute(): void;",
      "}",
      "",
      "export type Hooks = {",
      "  before(): boolean;",
      "};",
      "",
      "export enum Status { Other }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "a-models.ts"),
    [
      "export enum Status {",
      "  Ready,",
      "}",
      "",
      "export declare class Processor<T> {",
      "  process(value: string): string;",
      "  process(value: number): number;",
      "  reset(): void;",
      "}",
      "",
      "export function hidden(): void {}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.definitions).toEqual([
    {
      key: '["enum","Status",0,null,null]',
      kind: "enum",
      name: "Status",
      qualifiedName: "Status",
      source: { path: "src/a-models.ts", line: 1, column: 13 },
      uml: { scopePath: "src/a-models.ts", entityName: "Status" },
    },
    {
      key: '["class","Processor",0,null,null]',
      kind: "class",
      name: "Processor",
      qualifiedName: "Processor",
      source: { path: "src/a-models.ts", line: 5, column: 22 },
      uml: { scopePath: "src/a-models.ts", entityName: "Processor<T>" },
    },
    {
      key: '["class","Processor",0,"process",0]',
      kind: "method",
      name: "process",
      qualifiedName: "Processor.process",
      source: { path: "src/a-models.ts", line: 6, column: 3 },
      uml: {
        scopePath: "src/a-models.ts",
        entityName: "Processor<T>",
        memberName: "process",
        memberOccurrence: 0,
      },
    },
    {
      key: '["class","Processor",0,"process",1]',
      kind: "method",
      name: "process",
      qualifiedName: "Processor.process",
      source: { path: "src/a-models.ts", line: 7, column: 3 },
      uml: {
        scopePath: "src/a-models.ts",
        entityName: "Processor<T>",
        memberName: "process",
        memberOccurrence: 1,
      },
    },
    {
      key: '["class","Processor",0,"reset",0]',
      kind: "method",
      name: "reset",
      qualifiedName: "Processor.reset",
      source: { path: "src/a-models.ts", line: 8, column: 3 },
      uml: {
        scopePath: "src/a-models.ts",
        entityName: "Processor<T>",
        memberName: "reset",
        memberOccurrence: 0,
      },
    },
    {
      key: '["interface","Runner",0,null,null]',
      kind: "interface",
      name: "Runner",
      qualifiedName: "Runner",
      source: { path: "src/z-contracts.ts", line: 1, column: 18 },
      uml: { scopePath: "src/z-contracts.ts", entityName: "Runner" },
    },
    {
      key: '["interface","Runner",0,"execute",0]',
      kind: "method",
      name: "execute",
      qualifiedName: "Runner.execute",
      source: { path: "src/z-contracts.ts", line: 2, column: 3 },
      uml: {
        scopePath: "src/z-contracts.ts",
        entityName: "Runner",
        memberName: "execute",
        memberOccurrence: 0,
      },
    },
    {
      key: '["type","Hooks",0,null,null]',
      kind: "type",
      name: "Hooks",
      qualifiedName: "Hooks",
      source: { path: "src/z-contracts.ts", line: 5, column: 13 },
      uml: { scopePath: "src/z-contracts.ts", entityName: "Hooks" },
    },
    {
      key: '["type","Hooks",0,"before",0]',
      kind: "method",
      name: "before",
      qualifiedName: "Hooks.before",
      source: { path: "src/z-contracts.ts", line: 6, column: 3 },
      uml: {
        scopePath: "src/z-contracts.ts",
        entityName: "Hooks",
        memberName: "before",
        memberOccurrence: 0,
      },
    },
    {
      key: '["enum","Status",0,null,null]',
      kind: "enum",
      name: "Status",
      qualifiedName: "Status",
      source: { path: "src/z-contracts.ts", line: 9, column: 13 },
      uml: { scopePath: "src/z-contracts.ts", entityName: "Status" },
    },
  ]);
  expect(bundle.definitions.map(({ name }) => name)).not.toContain("hidden");
});

test("groups cross-scope method references into one fan-out external user", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-external-fanout-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(
    join(root, "src", "lib", "gadget.ts"),
    [
      "export class Gadget {",
      "  constructor(readonly source: unknown) {}",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "lib", "widget.ts"),
    [
      "export class Widget {",
      "  readonly value = 1;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "consumer.ts"),
    [
      'import { Gadget } from "../lib/gadget";',
      'import { Widget } from "../lib/widget";',
      "",
      "export class Consumer {",
      "  build(input: Widget): Gadget {",
      "    const first: Widget = input;",
      "    const second = first as Widget;",
      "    return new Gadget(second);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "import-only.ts"),
    [
      'import type { Gadget } from "../lib/gadget";',
      'import type { Widget } from "../lib/widget";',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "re-export-only.ts"),
    [
      'export type { Gadget } from "../lib/gadget";',
      'export { Widget } from "../lib/widget";',
      "",
    ].join("\n"),
  );

  const scoped = await buildUmlDiagrams(root, "src/lib", []);

  expect(scoped.externalUsers).toEqual([
    {
      nodeId: "extern0",
      label: "extern: src/app/consumer.ts: Consumer.build(Widget)",
      scopePath: "src/app/consumer.ts",
      kind: "method",
    },
    {
      nodeId: "extern1",
      label: "extern: src/app/re-export-only.ts: Gadget",
      scopePath: "src/app/re-export-only.ts",
      kind: "export",
    },
    {
      nodeId: "extern2",
      label: "extern: src/app/re-export-only.ts: Widget",
      scopePath: "src/app/re-export-only.ts",
      kind: "export",
    },
  ]);
  expect(scoped.definitions).toEqual([
    {
      key: '["class","Gadget",0,null,null]',
      kind: "class",
      name: "Gadget",
      qualifiedName: "Gadget",
      source: { path: "src/lib/gadget.ts", line: 1, column: 14 },
      uml: { scopePath: "src/lib/gadget.ts", entityName: "Gadget" },
    },
    {
      key: '["class","Widget",0,null,null]',
      kind: "class",
      name: "Widget",
      qualifiedName: "Widget",
      source: { path: "src/lib/widget.ts", line: 1, column: 14 },
      uml: { scopePath: "src/lib/widget.ts", entityName: "Widget" },
    },
  ]);
  expect(
    scoped.dsl.match(
      /^class extern0\["extern: src\/app\/consumer\.ts<br\/>Consumer\.build\(Widget\)"\]$/gm,
    ) ?? [],
  ).toHaveLength(1);
  expect(scoped.dsl.match(/^extern0 --> (?:Gadget|Widget)$/gm)?.sort()).toEqual([
    "extern0 --> Gadget",
    "extern0 --> Widget",
  ]);
  expect(scoped.dsl).not.toContain("extern3");

  const consumer = await buildUmlDiagrams(root, "src/app/consumer.ts", []);
  expect(consumer.definitions).toEqual([
    {
      key: '["class","Consumer",0,null,null]',
      kind: "class",
      name: "Consumer",
      qualifiedName: "Consumer",
      source: { path: "src/app/consumer.ts", line: 4, column: 14 },
      uml: { scopePath: "src/app/consumer.ts", entityName: "Consumer" },
    },
    {
      key: '["class","Consumer",0,"build",0]',
      kind: "method",
      name: "build",
      qualifiedName: "Consumer.build",
      source: { path: "src/app/consumer.ts", line: 5, column: 3 },
      uml: {
        scopePath: "src/app/consumer.ts",
        entityName: "Consumer",
        memberName: "build",
        memberOccurrence: 0,
      },
    },
  ]);
  expect(consumer.dsl).toMatch(/^class Consumer\s*\{$/m);

  const rootBundle = await buildUmlDiagrams(root, "", []);
  expect(rootBundle.externalUsers).toEqual([]);
}, 15_000);

test("filters same-package test external users and renders retained extern nodes purple", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-same-package-tests-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "packages", "demo", "src", "target"), { recursive: true }),
    mkdir(join(root, "packages", "demo", "z-child", "test"), { recursive: true }),
    mkdir(join(root, "packages", "demo", "test"), { recursive: true }),
    mkdir(join(root, "packages", "demo", "tests"), { recursive: true }),
    mkdir(join(root, "packages", "demo", "__tests__"), { recursive: true }),
    mkdir(join(root, "packages", "other", "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "packages", "demo", "src", "target", "widget.ts"),
      "export class Widget {}\n",
    ),
    writeFile(
      join(root, "packages", "demo", "src", "consumer.ts"),
      [
        'import { Widget } from "./target/widget";',
        "export class SourceConsumer {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "z-child", "test", "consumer.test.ts"),
      [
        'import { Widget } from "../../src/target/widget";',
        "export class ChildPackageTest {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "other", "test", "consumer.test.ts"),
      [
        'import { Widget } from "../../demo/src/target/widget";',
        "export class OtherPackageTest {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "test", "test-user.ts"),
      [
        'import { Widget } from "../src/target/widget";',
        "export class TestDirectoryUser {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "tests", "tests-user.ts"),
      [
        'import { Widget } from "../src/target/widget";',
        "export class TestsDirectoryUser {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "__tests__", "dunder-user.ts"),
      [
        'import { Widget } from "../src/target/widget";',
        "export class DunderTestUser {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "src", "co-located.test.ts"),
      [
        'import { Widget } from "./target/widget";',
        "export class CoLocatedTestUser {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "demo", "src", "co-located.spec.ts"),
      [
        'import { Widget } from "./target/widget";',
        "export class CoLocatedSpecUser {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
  ]);

  const bundle = await buildUmlDiagrams(root, "packages/demo/src/target", [
    { name: "demo", path: "packages/demo", dependencies: [] },
    { name: "demo-child", path: "packages/demo/z-child", dependencies: ["demo"] },
    { name: "other", path: "packages/other", dependencies: ["demo"] },
  ]);

  expect(bundle.externalUsers).toEqual([
    {
      nodeId: "extern0",
      label: "extern: packages/demo/src/consumer.ts: SourceConsumer.build()",
      scopePath: "packages/demo/src/consumer.ts",
      kind: "method",
    },
    {
      nodeId: "extern1",
      label:
        "extern: packages/demo/z-child/test/consumer.test.ts: ChildPackageTest.build()",
      scopePath: "packages/demo/z-child/test/consumer.test.ts",
      kind: "method",
    },
    {
      nodeId: "extern2",
      label: "extern: packages/other/test/consumer.test.ts: OtherPackageTest.build()",
      scopePath: "packages/other/test/consumer.test.ts",
      kind: "method",
    },
  ]);
  expect(bundle.definitions).toEqual([
    {
      key: '["class","Widget",0,null,null]',
      kind: "class",
      name: "Widget",
      qualifiedName: "Widget",
      source: { path: "packages/demo/src/target/widget.ts", line: 1, column: 14 },
      uml: {
        scopePath: "packages/demo/src/target/widget.ts",
        entityName: "Widget",
      },
    },
  ]);

  expect(bundle.dsl).toContain(
    'class extern0["extern: packages/demo/src/consumer.ts<br/>SourceConsumer.build()"]',
  );
  expect(bundle.dsl).toContain(
    'class extern1["extern: packages/demo/z-child/test/consumer.test.ts<br/>ChildPackageTest.build()"]',
  );
  expect(bundle.dsl).toContain(
    'class extern2["extern: packages/other/test/consumer.test.ts<br/>OtherPackageTest.build()"]',
  );
  const dslLines = bundle.dsl.split(/\r?\n/).map((line) => line.trim());
  for (const nodeId of ["extern0", "extern1", "extern2"]) {
    expect(dslLines.filter((line) => line === `${nodeId} --> Widget`)).toHaveLength(1);
    expect(bundle.dsl).toContain(`cssClass "${nodeId}" external`);
  }

  const filteredPaths = [
    "packages/demo/test/test-user.ts",
    "packages/demo/tests/tests-user.ts",
    "packages/demo/__tests__/dunder-user.ts",
    "packages/demo/src/co-located.test.ts",
    "packages/demo/src/co-located.spec.ts",
  ];
  const externalMetadata = JSON.stringify(bundle.externalUsers);
  for (const filteredPath of filteredPaths) {
    expect(externalMetadata).not.toContain(filteredPath);
    expect(bundle.dsl).not.toContain(filteredPath);
    for (const communityDsl of bundle.dsls) {
      expect(communityDsl).not.toContain(filteredPath);
    }
  }
  expect(externalMetadata).not.toContain("extern3");
  expect(bundle.dsl).not.toContain("extern3");
  for (const communityDsl of bundle.dsls) {
    expect(communityDsl).not.toContain("extern3");
  }

  const externalGraphNodeIds = bundle.graph
    .nodes()
    .filter((node) => bundle.graph.getNodeAttribute(node, "kind") === "external-user")
    .sort();
  expect(externalGraphNodeIds).toEqual([
    "external-user:extern0",
    "external-user:extern1",
    "external-user:extern2",
  ]);
  const widgetEntityIds = bundle.graph.nodes().filter((node) => {
    const attributes = bundle.graph.getNodeAttributes(node);
    return attributes.kind === "entity" && attributes.name === "Widget";
  });
  expect(widgetEntityIds).toHaveLength(1);
  const widgetEntityId = widgetEntityIds[0];
  if (widgetEntityId === undefined) {
    throw new Error("Expected the Widget entity graph node");
  }
  const graphRelations = bundle.graph.edges().flatMap((edge) =>
    bundle.graph.getEdgeAttribute(edge, "relations")
  );
  const externalRelations = graphRelations
    .filter(({ kind }) => kind === "external-user")
    .map(({ sourceId, targetId }) => ({ sourceId, targetId }))
    .sort(({ sourceId: left }, { sourceId: right }) => left.localeCompare(right));
  expect(externalRelations).toEqual([
    { sourceId: "external-user:extern0", targetId: widgetEntityId },
    { sourceId: "external-user:extern1", targetId: widgetEntityId },
    { sourceId: "external-user:extern2", targetId: widgetEntityId },
  ]);
  const graphNodeNames = bundle.graph
    .nodes()
    .map((node) => bundle.graph.getNodeAttribute(node, "name"));
  const relationNodeNames = graphRelations.flatMap(({ sourceId, targetId }) => [
    bundle.graph.getNodeAttribute(sourceId, "name"),
    bundle.graph.getNodeAttribute(targetId, "name"),
  ]);
  for (const filteredPath of filteredPaths) {
    expect(graphNodeNames.some((name) => name.includes(filteredPath))).toBe(false);
    expect(relationNodeNames.some((name) => name.includes(filteredPath))).toBe(false);
  }

  expect(bundle.dsl).toContain(
    "classDef external fill:#3a2b52,stroke:#b58bff,color:#f4f7fb,stroke-dasharray: 4 3",
  );
});

test("keeps nested-package tests external for a root source package", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-root-package-tests-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "src", "target"), { recursive: true }),
    mkdir(join(root, "test"), { recursive: true }),
    mkdir(join(root, "packages", "nested", "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "target", "widget.ts"), "export class Widget {}\n"),
    writeFile(
      join(root, "test", "root-user.ts"),
      [
        'import { Widget } from "../src/target/widget";',
        "export class RootTest {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "packages", "nested", "test", "consumer.test.ts"),
      [
        'import { Widget } from "../../../src/target/widget";',
        "export class NestedPackageTest {",
        "  build(): Widget { return new Widget(); }",
        "}",
        "",
      ].join("\n"),
    ),
  ]);

  const bundle = await buildUmlDiagrams(root, "src/target", [
    { name: "root", path: "", dependencies: [] },
    { name: "nested", path: "packages/nested", dependencies: ["root"] },
  ]);

  expect(bundle.externalUsers).toEqual([
    {
      nodeId: "extern0",
      label:
        "extern: packages/nested/test/consumer.test.ts: NestedPackageTest.build()",
      scopePath: "packages/nested/test/consumer.test.ts",
      kind: "method",
    },
  ]);
  const rootTestPath = "test/root-user.ts";
  expect(JSON.stringify(bundle.externalUsers)).not.toContain(rootTestPath);
  expect(bundle.dsl).not.toContain(rootTestPath);
  for (const communityDsl of bundle.dsls) {
    expect(communityDsl).not.toContain(rootTestPath);
  }
  expect(bundle.dsl.split(/\r?\n/).filter((line) => line.trim() === "extern0 --> Widget")).toHaveLength(1);
  expect(bundle.dsl).not.toContain("extern1");
});

test("keeps external users for targets already connected inside the selected scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-external-connected-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "lib", "base.ts"), "export class Base {}\n");
  await writeFile(
    join(root, "src", "lib", "connected.ts"),
    [
      'import { Base } from "./base";',
      "",
      "export class Connected extends Base {}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "connected-user.ts"),
    [
      'import { Connected } from "../lib/connected";',
      "",
      "export class ConnectedUser {",
      "  read(input: Connected): Connected {",
      "    return input;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "connected-import.ts"),
    'import type { Connected } from "../lib/connected";\n',
  );

  const scoped = await buildUmlDiagrams(root, "src/lib", []);

  expect(scoped.externalUsers).toEqual([
    {
      nodeId: "extern0",
      label: "extern: src/app/connected-user.ts: ConnectedUser.read(Connected)",
      scopePath: "src/app/connected-user.ts",
      kind: "method",
    },
  ]);
  expect(scoped.dsl).toContain("Base<|--Connected");
  expect(scoped.dsl.match(/^extern0 --> Connected$/gm) ?? []).toHaveLength(1);
});

test("classifies and stably orders every supported external user owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-external-kinds-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "lib", "widget.ts"), "export class Widget {}\n");
  await writeFile(join(root, "src", "lib", "auxiliary.ts"), "export class Auxiliary {}\n");
  await writeFile(
    join(root, "src", "app", "a-owners.ts"),
    [
      'import { Widget } from "../lib/widget";',
      "",
      "export class AlphaHeritage extends Widget {}",
      "",
      "export class BetaConstructor {",
      "  constructor(input: Set<{ item: Widget }>) {",
      "    void input;",
      "  }",
      "}",
      "",
      "export class DeltaProperty {",
      "  value: Map<string, { item: Widget }>;",
      "}",
      "",
      "export class GammaMethod {",
      "  build(input: Promise<Array<{ item: Widget }>>): Widget {",
      "    void input;",
      "    return {} as Widget;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "z-top-level.ts"),
    [
      'import { Widget } from "../lib/widget";',
      "",
      "export function EpsilonFunction(",
      "  input: ReadonlyArray<{ value: Widget }>,",
      "): Widget {",
      "  return input[0]!.value;",
      "}",
      "",
      "export const ThetaVariable: (input: Widget) => Widget = (input) => input;",
      "",
      "export type ZetaAlias = Widget;",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "imports-only.ts"),
    [
      'import type { Widget } from "../lib/widget";',
      'export { Widget as ReExportedWidget } from "../lib/widget";',
      "",
    ].join("\n"),
  );

  const scoped = await buildUmlDiagrams(root, "src/lib", []);

  expect(scoped.externalUsers).toEqual([
    {
      nodeId: "extern0",
      label: "extern: src/app/a-owners.ts: AlphaHeritage",
      scopePath: "src/app/a-owners.ts",
      kind: "class",
    },
    {
      nodeId: "extern1",
      label: "extern: src/app/a-owners.ts: BetaConstructor.constructor(Set⟨｛ item: Widget ｝⟩)",
      scopePath: "src/app/a-owners.ts",
      kind: "constructor",
    },
    {
      nodeId: "extern2",
      label: "extern: src/app/a-owners.ts: DeltaProperty.item: Widget",
      scopePath: "src/app/a-owners.ts",
      kind: "property",
    },
    {
      nodeId: "extern3",
      label:
        "extern: src/app/a-owners.ts: GammaMethod.build(Promise⟨Array⟨｛ item: Widget ｝⟩⟩)",
      scopePath: "src/app/a-owners.ts",
      kind: "method",
    },
    {
      nodeId: "extern4",
      label: "extern: src/app/imports-only.ts: ReExportedWidget",
      scopePath: "src/app/imports-only.ts",
      kind: "export",
    },
    {
      nodeId: "extern5",
      label:
        "extern: src/app/z-top-level.ts: EpsilonFunction(ReadonlyArray⟨｛ value: Widget ｝⟩)",
      scopePath: "src/app/z-top-level.ts",
      kind: "function",
    },
    {
      nodeId: "extern6",
      label: "extern: src/app/z-top-level.ts: ThetaVariable(Widget)",
      scopePath: "src/app/z-top-level.ts",
      kind: "function",
    },
    {
      nodeId: "extern7",
      label: "extern: src/app/z-top-level.ts: ZetaAlias",
      scopePath: "src/app/z-top-level.ts",
      kind: "type",
    },
  ]);
});

test("renders every local and re-exported user of a RetEdge-shaped type", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-local-users-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "edges.ts"),
    [
      "export type MsgEdge<N, ES> = {",
      '  kind: "msg";',
      "  message: N;",
      "  effect: ES;",
      "};",
      "",
      "export type RetEdge<T> = {",
      '  kind: "ret";',
      "  value: T;",
      "};",
      "",
      "export type DataflowEdge<N, T, ES> = MsgEdge<N, ES> | RetEdge<T>;",
      "",
      "export const DataflowEdge = {",
      "  ret: <T>(): RetEdge<T> => {",
      '    throw new Error("not implemented");',
      "  },",
      "};",
      "",
      "export const isRetEdge = <N, T, ES>(",
      "  edge: DataflowEdge<N, T, ES>,",
      '): edge is RetEdge<T> => edge.kind === "ret";',
      "",
      "export type DeadEdge = {",
      '  kind: "dead";',
      "};",
      "",
      "export type RecursiveEdge = {",
      "  next?: RecursiveEdge;",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "index.ts"),
    'export type { RetEdge } from "./edges";\n',
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.externalUsers).toEqual([]);
  expect(bundle.localUsers).toEqual([
    {
      nodeId: "local0",
      label: "local: src/edges.ts: DataflowEdge.ret()",
      kind: "method",
      path: "src/edges.ts",
      line: 15,
      column: 3,
    },
    {
      nodeId: "local1",
      label: "local: src/edges.ts: isRetEdge(DataflowEdge⟨N, T, ES⟩)",
      kind: "function",
      path: "src/edges.ts",
      line: 20,
      column: 14,
    },
    {
      nodeId: "local2",
      label: "export: src/index.ts: RetEdge",
      kind: "export",
      path: "src/index.ts",
      line: 1,
      column: 15,
    },
  ]);
  expect(
    bundle.dsl
      .split(/\r?\n/)
      .filter((line) => / --> RetEdge$/.test(line))
      .sort(),
  ).toEqual([
    "DataflowEdge --> RetEdge",
    "local0 --> RetEdge",
    "local1 --> RetEdge",
    "local2 --> RetEdge",
  ]);
  expect(
    bundle.dsl.split(/\r?\n/).filter((line) => / --> MsgEdge$/.test(line)),
  ).toEqual(["DataflowEdge --> MsgEdge"]);
  expect(bundle.definitions).toEqual([
    {
      key: '["type","MsgEdge",0,null,null]',
      kind: "type",
      name: "MsgEdge",
      qualifiedName: "MsgEdge",
      source: { path: "src/edges.ts", line: 1, column: 13 },
      uml: { scopePath: "src/edges.ts", entityName: "MsgEdge<N,ES>" },
    },
    {
      key: '["type","RetEdge",0,null,null]',
      kind: "type",
      name: "RetEdge",
      qualifiedName: "RetEdge",
      source: { path: "src/edges.ts", line: 7, column: 13 },
      uml: { scopePath: "src/edges.ts", entityName: "RetEdge<T>" },
    },
    {
      key: '["type","DataflowEdge",0,null,null]',
      kind: "type",
      name: "DataflowEdge",
      qualifiedName: "DataflowEdge",
      source: { path: "src/edges.ts", line: 12, column: 13 },
      uml: { scopePath: "src/edges.ts", entityName: "DataflowEdge<N,T,ES>" },
    },
    {
      key: '["type","DeadEdge",0,null,null]',
      kind: "type",
      name: "DeadEdge",
      qualifiedName: "DeadEdge",
      source: { path: "src/edges.ts", line: 24, column: 13 },
      uml: { scopePath: "src/edges.ts", entityName: "DeadEdge" },
    },
    {
      key: '["type","RecursiveEdge",0,null,null]',
      kind: "type",
      name: "RecursiveEdge",
      qualifiedName: "RecursiveEdge",
      source: { path: "src/edges.ts", line: 28, column: 13 },
      uml: { scopePath: "src/edges.ts", entityName: "RecursiveEdge" },
    },
  ]);
  expect(bundle.dsl).toMatch(/^class DataflowEdge\s*\{$/m);
  expect(bundle.dsl).toContain('class MsgEdge["MsgEdge⟨N,ES⟩"]');
  expect(bundle.dsl).toContain('class RetEdge["RetEdge⟨T⟩"]');
  expect(bundle.dsl).toContain('class DataflowEdge["DataflowEdge⟨N,T,ES⟩"]');
  expect(bundle.dsl).not.toContain("~");
  const dataflowNode = bundle.graph.nodes().find(
    (node) => bundle.graph.getNodeAttribute(node, "name") === "DataflowEdge<N,T,ES>",
  );
  expect(dataflowNode).toBeDefined();
  expect(bundle.graph.getNodeAttribute(dataflowNode!, "kind")).toBe("entity");
  expect(
    bundle.dsl
      .split(/\r?\n/)
      .filter((line) => /(?:-->|--)\s+(?:DeadEdge|RecursiveEdge)$/.test(line)),
  ).toEqual([]);
  expect(bundle.dsl).not.toMatch(
    /^[ \t]*RecursiveEdge[ \t]*-->[ \t]*RecursiveEdge[ \t]*\r?$/m,
  );
});

test("deduplicates rendered method parameter and body uses into one direct arrow", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-rendered-method-user-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "model.ts"),
    [
      "export interface Target {",
      "  value: string;",
      "}",
      "",
      "export class User {",
      "  consume(target: Target): void {",
      "    const copy = target as Target;",
      "    void copy;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.localUsers).toEqual([]);
  expect(bundle.externalUsers).toEqual([]);
  expect(
    bundle.dsl.match(/^[ \t]*User[ \t]*-->[ \t]*Target[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(1);
});

test("keeps a member association alongside its directed rendered-user arrow", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-property-user-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "model.ts"),
    [
      "export interface Target {",
      "  value: string;",
      "}",
      "",
      "export class User {",
      "  target!: Target;",
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.localUsers).toEqual([]);
  expect(
    bundle.dsl.match(/^[ \t]*User[ \t]*--[ \t]*Target[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(1);
  expect(
    bundle.dsl.match(/^[ \t]*User[ \t]*-->[ \t]*Target[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(1);
});

test("does not duplicate same-direction method-return or inheritance relationships", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-directed-dedup-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "model.ts"),
    [
      "export class Parent {}",
      "",
      "export class Child extends Parent {}",
      "",
      "export class Product {}",
      "",
      "export class Factory {",
      "  make(): Product {",
      "    return new Product();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.localUsers).toEqual([]);
  expect(bundle.dsl.match(/^[ \t]*Parent<\|--Child[ \t]*\r?$/gm) ?? []).toHaveLength(1);
  expect(
    bundle.dsl.match(/^[ \t]*Child[ \t]*-->[ \t]*Parent[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(0);
  expect(
    bundle.dsl.match(/^[ \t]*Factory[ \t]*-->[ \t]*Product[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(1);
});

test("retains a rendered usage arrow opposite an existing inheritance direction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-reverse-direction-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "model.ts"),
    [
      "export class Parent {",
      "  accept(child: Child): void {",
      "    void child;",
      "  }",
      "}",
      "",
      "export class Child extends Parent {}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.localUsers).toEqual([]);
  expect(bundle.dsl.match(/^[ \t]*Parent<\|--Child[ \t]*\r?$/gm) ?? []).toHaveLength(1);
  expect(
    bundle.dsl.match(/^[ \t]*Parent[ \t]*-->[ \t]*Child[ \t]*\r?$/gm) ?? [],
  ).toHaveLength(1);
});

test("exposes every UML relation through an assigned undirected simple graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-graph-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(
    join(root, "src", "lib", "model.ts"),
    [
      "export class Base {}",
      "export interface Associated { value: string; }",
      "export interface Used { token: string; }",
      "export class Child extends Base {",
      "  associated!: Associated;",
      '  create(): Associated { return { value: "created" }; }',
      "  consume(input: Used): void { void input; }",
      "}",
      "export function acceptAssociated(value: Associated): void { void value; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "app", "consumer.ts"),
    [
      'import type { Associated } from "../lib/model";',
      "export class Consumer {",
      '  create(): Associated { return { value: "external" }; }',
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "src/lib", []);
  const { graph } = bundle;
  const entityId = (name: string): string => {
    const id = graph.nodes().find((node) => {
      const attributes = graph.getNodeAttributes(node);
      return attributes.kind === "entity" && attributes.name === name;
    });
    if (id === undefined) throw new Error(`Expected entity graph node ${name}`);
    return id;
  };
  const relationNames = graph.edges().flatMap((edge) =>
    graph.getEdgeAttribute(edge, "relations").map((relation) => ({
      kind: relation.kind,
      source: graph.getNodeAttribute(relation.sourceId, "name"),
      target: graph.getNodeAttribute(relation.targetId, "name"),
    }))
  );

  expect(graph.type).toBe("undirected");
  expect(graph.multi).toBe(false);
  for (const name of ["Base", "Associated", "Used", "Child"]) {
    expect(graph.getNodeAttributes(entityId(name))).toMatchObject({ kind: "entity", name });
  }
  expect(bundle.localUsers).toHaveLength(1);
  expect(bundle.externalUsers).toHaveLength(1);
  const local = bundle.localUsers[0]!;
  const external = bundle.externalUsers[0]!;
  expect(graph.getNodeAttributes(`local-user:${local.nodeId}`)).toMatchObject({
    kind: "local-user",
    name: local.label,
  });
  expect(graph.getNodeAttributes(`external-user:${external.nodeId}`)).toMatchObject({
    kind: "external-user",
    name: external.label,
  });
  graph.forEachNode((_node, attributes) => {
    expect(Number.isInteger(attributes.community)).toBe(true);
  });
  graph.forEachEdge((_edge, attributes, source, target) => {
    expect(attributes.weight).toBe(attributes.relations.length);
    expect(attributes.weight).toBeGreaterThan(0);
    for (const relation of attributes.relations) {
      expect(graph.hasNode(relation.sourceId)).toBe(true);
      expect(graph.hasNode(relation.targetId)).toBe(true);
      expect(new Set([relation.sourceId, relation.targetId])).toEqual(new Set([source, target]));
    }
  });

  expect([...new Set(relationNames.map(({ kind }) => kind))].sort()).toEqual([
    "external-user",
    "heritage",
    "local-user",
    "member-association",
    "method-return",
    "usage",
  ]);
  expect(relationNames).toContainEqual({ kind: "heritage", source: "Child", target: "Base" });
  expect(relationNames).toContainEqual({
    kind: "member-association",
    source: "Child",
    target: "Associated",
  });
  expect(relationNames).toContainEqual({
    kind: "method-return",
    source: "Child",
    target: "Associated",
  });
  expect(relationNames).toContainEqual({ kind: "usage", source: "Child", target: "Used" });
  expect(relationNames).toContainEqual({
    kind: "local-user",
    source: local.label,
    target: "Associated",
  });
  expect(relationNames).toContainEqual({
    kind: "external-user",
    source: external.label,
    target: "Associated",
  });

  const repeatedPair = graph.getEdgeAttributes(entityId("Child"), entityId("Associated"));
  expect(repeatedPair.weight).toBe(repeatedPair.relations.length);
  expect(repeatedPair.weight).toBeGreaterThan(1);
  expect(repeatedPair.relations.map(({ kind }) => kind)).toEqual([
    "member-association",
    "method-return",
  ]);
});

test("preserves merged definition occurrences while reusing one graph entity node", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-merged-interface-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "merged.ts"),
    [
      "export interface Merged { run(value: string): string; }",
      "export interface Merged { run(value: number): number; stop(): void; }",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);
  const mergedNodes = bundle.graph.nodes().filter(
    (node) => bundle.graph.getNodeAttribute(node, "name") === "Merged",
  );

  expect(bundle.definitions).toEqual([
    {
      key: '["interface","Merged",0,null,null]',
      kind: "interface",
      name: "Merged",
      qualifiedName: "Merged",
      source: { path: "src/merged.ts", line: 1, column: 18 },
      uml: { scopePath: "src/merged.ts", entityName: "Merged" },
    },
    {
      key: '["interface","Merged",0,"run",0]',
      kind: "method",
      name: "run",
      qualifiedName: "Merged.run",
      source: { path: "src/merged.ts", line: 1, column: 27 },
      uml: {
        scopePath: "src/merged.ts",
        entityName: "Merged",
        memberName: "run",
        memberOccurrence: 0,
      },
    },
    {
      key: '["interface","Merged",1,null,null]',
      kind: "interface",
      name: "Merged",
      qualifiedName: "Merged",
      source: { path: "src/merged.ts", line: 2, column: 18 },
      uml: { scopePath: "src/merged.ts", entityName: "Merged" },
    },
    {
      key: '["interface","Merged",1,"run",1]',
      kind: "method",
      name: "run",
      qualifiedName: "Merged.run",
      source: { path: "src/merged.ts", line: 2, column: 27 },
      uml: {
        scopePath: "src/merged.ts",
        entityName: "Merged",
        memberName: "run",
        memberOccurrence: 1,
      },
    },
    {
      key: '["interface","Merged",1,"stop",0]',
      kind: "method",
      name: "stop",
      qualifiedName: "Merged.stop",
      source: { path: "src/merged.ts", line: 2, column: 55 },
      uml: {
        scopePath: "src/merged.ts",
        entityName: "Merged",
        memberName: "stop",
        memberOccurrence: 0,
      },
    },
  ]);
  expect(mergedNodes).toHaveLength(1);
  expect(bundle.graph.getNodeAttribute(mergedNodes[0]!, "kind")).toBe("entity");
  expect(Number.isInteger(bundle.graph.getNodeAttribute(mergedNodes[0]!, "community"))).toBe(true);
});

test("keeps undeclared heritage boundary nodes and edges renderable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-boundary-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "shared"), { recursive: true });
  await writeFile(
    join(root, "src", "lib", "error.ts"),
    [
      'import { Error } from "../shared/error";',
      "export class CustomError extends Error {}",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "src", "shared", "error.ts"), "export class Error {}\n");

  const bundle = await buildUmlDiagrams(root, "src/lib", []);
  const errorId = bundle.graph.nodes().find(
    (node) => bundle.graph.getNodeAttribute(node, "name") === "Error",
  );
  const customErrorId = bundle.graph.nodes().find(
    (node) => bundle.graph.getNodeAttribute(node, "name") === "CustomError",
  );
  if (errorId === undefined || customErrorId === undefined) {
    throw new Error("Expected Error and CustomError graph nodes");
  }

  expect(bundle.graph.getNodeAttributes(errorId)).toMatchObject({
    kind: "boundary",
    name: "Error",
  });
  expect(bundle.graph.getEdgeAttribute(customErrorId, errorId, "relations")).toContainEqual({
    kind: "heritage",
    sourceId: customErrorId,
    targetId: errorId,
  });
  expect(bundle.dsl).toContain("Error<|--CustomError");
  const customErrorFrames = bundle.dsls.filter((dsl) => /\bclass CustomError\s*\{/.test(dsl));
  expect(customErrorFrames).toHaveLength(1);
  expect(customErrorFrames[0]).toContain("Error<|--CustomError");
});
