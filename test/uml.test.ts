import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUmlDiagram, buildUmlDiagrams } from "../src/uml.ts";

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

  const dsl = await buildUmlDiagram(root, "", []);
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
  expect(dsl).toMatch(/Box.*T|T.*Box/);
  expect(dsl).toContain("Base<|--Concrete");
  expect(dsl).toContain("Box~T~<|..Concrete");
  expect(dsl).toContain("classDef interface");
  expect(dsl).toContain("classDef abstract");
  expect(dsl).toContain("classDef concrete");
  expect(dsl).toContain("stroke:#ff5c5c");
  expect(dsl).toContain("stroke-dasharray: 6 4");
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

  const dsl = await buildUmlDiagram(root, "", []);

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

  const dsl = await buildUmlDiagram(root, "", []);
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
  expect(genericTypeLine).not.toContain("CapsResponse~");
  expect(genericTypeLine).not.toMatch(/[<>]/);
  expect(genericTypeLine).not.toMatch(/&(?:lt|gt);/);
});

test("reports exact source metadata for rendered UML declarations", async () => {
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

  expect(bundle.sources).toEqual([
    {
      name: "Status",
      path: "src/a-models.ts",
      line: 1,
      column: 13,
      methods: [],
    },
    {
      name: "Processor<T>",
      path: "src/a-models.ts",
      line: 5,
      column: 22,
      methods: [
        { name: "process", path: "src/a-models.ts", line: 6, column: 3 },
        { name: "process", path: "src/a-models.ts", line: 7, column: 3 },
        { name: "reset", path: "src/a-models.ts", line: 8, column: 3 },
      ],
    },
    {
      name: "Runner",
      path: "src/z-contracts.ts",
      line: 1,
      column: 18,
      methods: [
        { name: "execute", path: "src/z-contracts.ts", line: 2, column: 3 },
      ],
    },
    {
      name: "Hooks",
      path: "src/z-contracts.ts",
      line: 5,
      column: 13,
      methods: [
        { name: "before", path: "src/z-contracts.ts", line: 6, column: 3 },
      ],
    },
  ]);
  expect(bundle.sources.map(({ name }) => name)).not.toContain("hidden");
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
  expect(scoped.sources.map(({ name, path }) => ({ name, path }))).toEqual([
    { name: "Gadget", path: "src/lib/gadget.ts" },
    { name: "Widget", path: "src/lib/widget.ts" },
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
  expect(consumer.sources.map(({ name, path }) => ({ name, path }))).toEqual([
    { name: "Consumer", path: "src/app/consumer.ts" },
  ]);
  expect(consumer.dsl).toMatch(/^class Consumer\s*\{$/m);

  const rootBundle = await buildUmlDiagrams(root, "", []);
  expect(rootBundle.externalUsers).toEqual([]);
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
      label: "local: src/edges.ts: DataflowEdge",
      kind: "type",
      path: "src/edges.ts",
      line: 12,
      column: 13,
    },
    {
      nodeId: "local1",
      label: "local: src/edges.ts: DataflowEdge.ret()",
      kind: "method",
      path: "src/edges.ts",
      line: 15,
      column: 3,
    },
    {
      nodeId: "local2",
      label: "local: src/edges.ts: isRetEdge(DataflowEdge⟨N, T, ES⟩)",
      kind: "function",
      path: "src/edges.ts",
      line: 20,
      column: 14,
    },
    {
      nodeId: "local3",
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
      .filter((line) => / --> RetEdge~T~$/.test(line))
      .sort(),
  ).toEqual([
    "local0 --> RetEdge~T~",
    "local1 --> RetEdge~T~",
    "local2 --> RetEdge~T~",
    "local3 --> RetEdge~T~",
  ]);
  expect(
    bundle.dsl.split(/\r?\n/).filter((line) => / --> MsgEdge~N,ES~$/.test(line)),
  ).toEqual(["local0 --> MsgEdge~N,ES~"]);
  expect(
    bundle.sources
      .filter(({ name }) => name === "DeadEdge" || name === "RecursiveEdge")
      .map(({ name }) => name)
      .sort(),
  ).toEqual(["DeadEdge", "RecursiveEdge"]);
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

test("reuses one graph entity node for same-file merged interfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-merged-interface-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "merged.ts"),
    [
      "export interface Merged { first: string; }",
      "export interface Merged { second: number; }",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);
  const mergedNodes = bundle.graph.nodes().filter(
    (node) => bundle.graph.getNodeAttribute(node, "name") === "Merged",
  );

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
