import { afterEach, expect, test } from "bun:test";
import type { UmlDiagramPayload } from "../src/types.ts";
import { toFileContract, toUmlContract, umlLabel } from "./support/uml-contract.ts";
import { createUmlProjectTracker, readCompleteUml } from "./support/uml-project.ts";

const { openProject, cleanup } = createUmlProjectTracker();

afterEach(cleanup);

/** `label -> test` for every node of a definition selection. */
function nodeTestFlags(diagram: UmlDiagramPayload): [string, boolean][] {
  if (diagram.view.kind !== "definitions") throw new Error("expected a definitions view");
  return diagram.view.nodes.map((node) => [umlLabel(node.definition), node.test]);
}

const DIRECTORY_FILES = {
  "area/isolated.ts": "export class Alone {}\n",
  "area/notes.md": "not a source file\n",
  "area/unused.ts": `import { Unused } from "../outside/unused-target";
export const nothing = 1;
`,
  "area/typeonly.ts": `import type { Shape } from "../outside/shape";
export type Alias = Shape;
`,
  "area/reexport.ts": `export { Shape } from "../outside/shape";
`,
  "area/side-effect.ts": `import "../outside/effect";
export const flag = true;
`,
  "outside/unused-target.ts": "export class Unused {}\n",
  "outside/shape.ts": "export interface Shape { size: number; }\n",
  "outside/effect.ts": "export const effect = 1;\n",
  "outside/back.ts": `import { Alone } from "../area/isolated";
export class Back { value: Alone; }
`,
};

test("a directory selection graphs its subtree plus the project files it imports", async () => {
  const project = await openProject("ts-explorer-uml-directory-", DIRECTORY_FILES);

  const contract = toFileContract(readCompleteUml(project, { kind: "directory", path: "area" }));

  expect(contract.status).toBe("ready");
  // Every visible regular file in the subtree — including the isolated one and the Markdown file —
  // plus the three outside targets as boundary leaves. `outside/back.ts` only imports *into* the
  // subtree, so it is absent.
  expect(contract.nodes).toEqual([
    { path: "area/isolated.ts", boundary: false, test: false },
    { path: "area/notes.md", boundary: false, test: false },
    { path: "area/reexport.ts", boundary: false, test: false },
    { path: "area/side-effect.ts", boundary: false, test: false },
    { path: "area/typeonly.ts", boundary: false, test: false },
    { path: "area/unused.ts", boundary: false, test: false },
    { path: "outside/effect.ts", boundary: true, test: false },
    { path: "outside/shape.ts", boundary: true, test: false },
    { path: "outside/unused-target.ts", boundary: true, test: false },
  ]);
  // Unused, type-only, re-exported and side-effect-only imports all count; a boundary leaf never
  // contributes its own imports.
  expect(contract.edges).toEqual([
    { source: "area/reexport.ts", target: "outside/shape.ts" },
    { source: "area/side-effect.ts", target: "outside/effect.ts" },
    { source: "area/typeonly.ts", target: "outside/shape.ts" },
    { source: "area/unused.ts", target: "outside/unused-target.ts" },
  ]);
});

test("the root directory contains every visible file and its imports point both ways", async () => {
  const project = await openProject("ts-explorer-uml-root-directory-", DIRECTORY_FILES);

  const contract = toFileContract(readCompleteUml(project, { kind: "directory", path: "" }));

  expect(contract.nodes.map((node) => node.path)).toEqual([
    "area/isolated.ts",
    "area/notes.md",
    "area/reexport.ts",
    "area/side-effect.ts",
    "area/typeonly.ts",
    "area/unused.ts",
    "outside/back.ts",
    "outside/effect.ts",
    "outside/shape.ts",
    "outside/unused-target.ts",
  ]);
  expect(contract.nodes.every((node) => !node.boundary)).toBe(true);
  // The importer excluded from the `area` view is an ordinary node here, with its edge.
  expect(contract.edges).toContainEqual({
    source: "outside/back.ts",
    target: "area/isolated.ts",
  });
  expect(contract.edges).toHaveLength(5);
});

test("local bindings shadow project declarations instead of creating edges", async () => {
  const project = await openProject("ts-explorer-uml-shadowing-", {
    "shadow.ts": `import { Helper } from "./helper";
export class Shadowed {
  run(): void {
    const Other = 1;
    void Other;
  }
  generic<Helper>(value: Helper): void { void value; }
}
export function shadows(Helper: string): string { return Helper; }
`,
    "helper.ts": "export class Helper {}\n",
    "other.ts": "export class Other {}\n",
  });

  const contract = toUmlContract(readCompleteUml(project, { kind: "file", path: "shadow.ts" }));

  // A local constant, a generic parameter and a parameter each shadow an equally named project
  // declaration, so neither Helper nor Other is reachable.
  expect(contract.nodes).toEqual(["Shadowed@shadow.ts", "shadows@shadow.ts"]);
  expect(contract.edges).toEqual([]);
});

test("member references resolve to the intended member and unknown receivers resolve to nothing", async () => {
  const project = await openProject("ts-explorer-uml-members-", {
    "statics.ts": `export class Holder {
  static make(): void {}
  run(): void { this.helper(); }
  helper(): void {}
}
export function callsStatic(): void { Holder.make(); }
export function unknownReceiver(value: { make(): void }): void { value.make(); }
`,
  });

  const staticCall = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "statics.ts",
    definitionKey: project.key("statics.ts", "callsStatic"),
  }));
  expect(staticCall.edges).toEqual([
    {
      kind: "references",
      source: "callsStatic@statics.ts",
      target: "Holder.make@statics.ts",
    },
  ]);

  const thisCall = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "statics.ts",
    definitionKey: project.key("statics.ts", "Holder.run"),
  }));
  expect(thisCall.edges).toEqual([
    {
      kind: "references",
      source: "Holder.run@statics.ts",
      target: "Holder.helper@statics.ts",
    },
  ]);

  // An anonymous structural receiver has no project declaration; nothing is invented for it.
  const unknown = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "statics.ts",
    definitionKey: project.key("statics.ts", "unknownReceiver"),
  }));
  expect(unknown.nodes).toEqual(["unknownReceiver@statics.ts"]);
  expect(unknown.edges).toEqual([]);
});

test("a qualified namespace member resolves to one target, not to its namespace", async () => {
  const project = await openProject("ts-explorer-uml-namespace-", {
    "ns.ts": `export namespace Space {
  export class Inner {}
  export class Sibling {}
}
export class NsUser { value: Space.Inner; }
`,
  });

  const contract = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "ns.ts",
    definitionKey: project.key("ns.ts", "NsUser"),
  }));

  // `Space.Inner` is one edge to the member; the qualifier adds neither a namespace node nor the
  // namespace's other members.
  expect(contract.nodes).toEqual(["Space.Inner@ns.ts", "NsUser@ns.ts"]);
  expect(contract.edges).toEqual([
    { kind: "references", source: "NsUser@ns.ts", target: "Space.Inner@ns.ts" },
  ]);
});

test("merged namespace blocks share exported members but not private ones", async () => {
  const project = await openProject("ts-explorer-uml-merged-namespace-", {
    "blocks.ts": `export namespace Merged {
  export class Shared {}
  class Hidden {}
}
export namespace Merged {
  export class UsesShared { value: Shared; }
  export class UsesHidden { value: Hidden; }
}
`,
  });

  const usesShared = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "blocks.ts",
    definitionKey: project.key("blocks.ts", "Merged.UsesShared"),
  }));
  expect(usesShared.edges).toEqual([
    {
      kind: "references",
      source: "Merged.UsesShared@blocks.ts",
      target: "Merged.Shared@blocks.ts",
    },
  ]);

  // `Hidden` is private to the first block, so the second block cannot see it.
  const usesHidden = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "blocks.ts",
    definitionKey: project.key("blocks.ts", "Merged.UsesHidden"),
  }));
  expect(usesHidden.nodes).toEqual(["Merged.UsesHidden@blocks.ts"]);
  expect(usesHidden.edges).toEqual([]);
});

test("JavaScript and declaration files produce real edges", async () => {
  const project = await openProject("ts-explorer-uml-js-dts-", {
    "lib.js": `import { helperFn } from "./helper-impl.js";
export function caller() { return helperFn(); }
`,
    "helper-impl.js": "export function helperFn() { return 1; }\n",
    "types.d.ts": `import type { Payload } from "./payload";
export interface Wrapper { payload: Payload; }
`,
    "payload.d.ts": "export interface Payload { code: number; }\n",
  });

  const js = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "lib.js",
    definitionKey: project.key("lib.js", "caller"),
  }));
  expect(js.edges).toEqual([
    { kind: "references", source: "caller@lib.js", target: "helperFn@helper-impl.js" },
  ]);

  const declarations = toUmlContract(readCompleteUml(project, {
    kind: "definition",
    path: "types.d.ts",
    definitionKey: project.key("types.d.ts", "Wrapper"),
  }));
  expect(declarations.edges).toEqual([
    { kind: "references", source: "Wrapper@types.d.ts", target: "Payload@payload.d.ts" },
  ]);
});

test("definitions and files from test paths are marked as tests", async () => {
  const project = await openProject("ts-explorer-uml-test-paths-", {
    "src/model.ts": "export class Model {}\n",
    "test/harness.test.ts": `import { Model } from "../src/model";
export class Harness { value: Model; }
`,
  });

  const definitions = readCompleteUml(project, {
    kind: "definition",
    path: "test/harness.test.ts",
    definitionKey: project.key("test/harness.test.ts", "Harness"),
  });
  expect(nodeTestFlags(definitions)).toEqual([
    ["Model@src/model.ts", false],
    ["Harness@test/harness.test.ts", true],
  ]);

  const files = toFileContract(readCompleteUml(project, { kind: "directory", path: "" }));
  expect(files.nodes).toEqual([
    { path: "src/model.ts", boundary: false, test: false },
    { path: "test/harness.test.ts", boundary: false, test: true },
  ]);
});
