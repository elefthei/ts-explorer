import { afterEach, expect, test } from "bun:test";
import { UML_METHOD_RETURN_MARKER } from "../src/types.ts";
import { extractUmlDiagramGraph } from "../src/uml.ts";
import { FULL_UML_VISIBILITY, type UmlVisibility } from "../src/uml/model.ts";
import { renderUmlView } from "../src/uml/view.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { materializeUmlGraph } from "./support/normalized-graph.ts";

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});

const FIXTURE_FILES = {
  "src/model.ts": `export interface Output { code: number; }
export class ResultService {
  private cache?: Output;
  execute(value: string): Output { return { code: value.length }; }
}
`,
  "test/model.test.ts": `import { ResultService } from "../src/model.ts";
export class TestHarness {}
export function runs(): void { new ResultService().execute("x"); }
`,
};

test("global visibility toggles filter the maximal UML model at emission time", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-uml-visibility-", FIXTURE_FILES);
  const materialized = await materializeUmlGraph(
    root,
    await extractUmlDiagramGraph(root, "", []),
  );
  const { cached, record } = materialized;
  const { view } = cached;
  const dslFor = (overrides: Partial<UmlVisibility>): string =>
    renderUmlView(view, { ...FULL_UML_VISIBILITY, ...overrides }).dsl;

  const full = dslFor({});
  expect(full).toContain("cache");
  expect(full).toContain("execute()");
  expect(full).toContain(": Output");
  expect(full).toContain("class local0[");
  expect(full).toContain("TestHarness");

  const withoutAttributes = dslFor({ attributes: false });
  expect(withoutAttributes).not.toContain("cache");
  expect(withoutAttributes).toContain("execute()");
  expect(withoutAttributes).toContain("class local0[");

  const withoutMethods = dslFor({ methods: false });
  expect(withoutMethods).not.toContain("execute()");
  expect(withoutMethods).toContain("cache");

  const withoutTypes = dslFor({ types: false });
  expect(withoutTypes).toContain("cache");
  expect(withoutTypes).toContain("execute()");
  expect(withoutTypes).not.toContain(": Output");
  expect(withoutTypes).not.toContain(UML_METHOD_RETURN_MARKER);

  const withoutTests = dslFor({ tests: false });
  expect(withoutTests).not.toContain("local0");
  expect(withoutTests).not.toContain("TestHarness");
  expect(withoutTests).toContain("ResultService");
  expect(withoutTests).toContain("Output");

  const namesOnly = dslFor({ attributes: false, methods: false, types: false, tests: false });
  expect(namesOnly).toContain("ResultService");
  expect(namesOnly).toContain("Output");
  expect(namesOnly).toContain("classDef concrete");
  expect(namesOnly).toContain('cssClass "ResultService" concrete');
  expect(namesOnly).toContain('cssClass "Output" interface');

  const fullFrames = renderUmlView(view, FULL_UML_VISIBILITY).dsls;
  expect(fullFrames.length).toBeGreaterThan(0);
  for (const frame of fullFrames) expect(frame).toContain("classDiagram");
  for (const frame of renderUmlView(view, { ...FULL_UML_VISIBILITY, tests: false }).dsls) {
    expect(frame).not.toContain("TestHarness");
  }

  // SQLite keeps the maximal model: rendering a reduced view never rewrites what was persisted.
  expect(record.properties.filter((property) => property.name === "cache")).toEqual([
    expect.objectContaining({ name: "cache", type: "Output", optional: true }),
  ]);
  expect(record.methods.filter((method) => method.name === "execute")).toEqual([
    expect.objectContaining({
      name: "execute",
      returnType: `\n${UML_METHOD_RETURN_MARKER}() Output`,
    }),
  ]);
  expect(record.localUsers.map((user) => user.path)).toEqual(["test/model.test.ts"]);
  expect(
    view.declarations.flatMap((declaration) =>
      declaration.classes.flatMap((entity) => entity.properties)
    ),
  ).toContainEqual(expect.objectContaining({ name: "cache", type: "Output" }));
});
