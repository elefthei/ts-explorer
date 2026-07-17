import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUmlDiagram } from "../src/uml.ts";

test("renders generic and semantic UML styles including tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src", "model.ts"), `
    export interface Box<T> { value: T; }
    export abstract class Base { abstract run(): void; }
    export class Concrete extends Base implements Box<string> {
      value = "ok";
      run(): void {}
    }
  `);
  await writeFile(join(root, "tests", "example.test.ts"), `export class ExampleTest {}`);

  const dsl = await buildUmlDiagram(root, "", []);
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
