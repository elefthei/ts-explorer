import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.ts";
import type { UmlEntitySource, UmlExternalUser, UmlLocalUser } from "../src/types.ts";

test("serves tree, packages, diagrams, files, format, and save routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-server-"));
  await mkdir(join(root, "packages", "demo", "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await writeFile(join(root, "packages", "demo", "package.json"), JSON.stringify({ name: "demo" }));
  const file = join(root, "packages", "demo", "src", "index.ts");
  await writeFile(file, "export const value=1\n");
  await writeFile(
    join(root, "packages", "demo", "src", "machine.ts"),
    "export class AbstractStateMachine {}\n",
  );
  await writeFile(
    join(root, "packages", "demo", "src", "runtime.ts"),
    'import { AbstractStateMachine } from "./machine";\nexport class DataflowRuntime { getMachine(): AbstractStateMachine { return new AbstractStateMachine(); } }\n',
  );
  const server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const pageResponse = await fetch(`${base}/`);
    expect(pageResponse.ok).toBe(true);
    const html = await pageResponse.text();
    const navigation = html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i)?.[0] ?? "";
    expect(navigation).toMatch(
      /\bid\s*=\s*["']packages-mode["'][\s\S]*\bid\s*=\s*["']uml-mode["'][\s\S]*\bid\s*=\s*["']editor-mode["']/i,
    );
    expect(html).toMatch(/<section\b[^>]*\bid\s*=\s*["']graph-panel["'][^>]*>/i);
    expect(html).toMatch(/<section\b[^>]*\bid\s*=\s*["']editor-panel["'][^>]*>/i);
    expect(html).not.toMatch(/<aside\b[^>]*\bid\s*=\s*["']editor-panel["'][^>]*>/i);
    const diagramStageOpening =
      /<div\b(?=[^>]*\sid\s*=\s*["']diagram-stage["'])[^>]*>/i.exec(html);
    expect(diagramStageOpening).not.toBeNull();
    const diagramStageStart = diagramStageOpening?.index ?? -1;
    const divTags = /<\/?div\b[^>]*>/gi;
    divTags.lastIndex = diagramStageStart + (diagramStageOpening?.[0].length ?? 0);
    let diagramStageEnd = -1;
    let divDepth = 1;
    while (divDepth > 0) {
      const tag = divTags.exec(html);
      if (!tag) break;
      divDepth += /^<\//.test(tag[0]) ? -1 : 1;
      if (divDepth === 0) diagramStageEnd = divTags.lastIndex;
    }
    expect(diagramStageEnd).toBeGreaterThan(diagramStageStart);
    const diagramStage = html.slice(diagramStageStart, diagramStageEnd);
    const loadingElements = [
      ...html.matchAll(
        /<div\b(?=[^>]*\sid\s*=\s*["']diagram-loading["'])[^>]*>([\s\S]*?)<\/div>/gi,
      ),
    ];
    expect(loadingElements).toHaveLength(1);
    const loadingElement = loadingElements[0]?.[0] ?? "";
    const loadingOpeningTag = loadingElement.match(/^<div\b[^>]*>/i)?.[0] ?? "";
    expect(diagramStage).toContain(loadingElement);
    expect(loadingOpeningTag).toMatch(/\srole\s*=\s*["']status["']/i);
    expect(loadingOpeningTag).toMatch(/\saria-live\s*=\s*["']polite["']/i);
    expect(loadingOpeningTag).toMatch(/\saria-atomic\s*=\s*["']true["']/i);
    expect(loadingOpeningTag).toMatch(/\shidden(?:\s|>)/i);
    expect(loadingElements[0]?.[1]).toBe("Loading...");
    const styleResponse = await fetch(`${base}/style.css`);
    expect(styleResponse.ok).toBe(true);
    const stylesheet = await styleResponse.text();
    expect(stylesheet).toMatch(
      /(?:^|})\s*\.svg-holder\.stacked\s*\{\s*display:flex;\s*flex-direction:column;/,
    );
    expect(stylesheet).not.toMatch(/body\.portrait|@media\s*\([^)]*orientation\s*:\s*portrait/i);
    const mainResponse = await fetch(`${base}/main.js`);
    expect(mainResponse.ok).toBe(true);
    const mainScript = await mainResponse.text();
    expect(mainScript).toMatch(
      /shouldStackDiagram\w*\s*\(\s*state\w*\.mode\s*\)/,
    );
    expect(mainScript).not.toMatch(
      /matchMedia\s*\(\s*["'`]\s*\(\s*orientation\s*:\s*portrait\s*\)\s*["'`]\s*\)|orientation\s*:\s*portrait/i,
    );
    const tree = await (await fetch(`${base}/api/tree`)).json() as { root: { children?: Array<{ name: string }> } };
    expect(tree.root.children?.map((child) => child.name)).toContain("packages");
    const packages = await (await fetch(`${base}/api/packages`)).json() as { packages: Array<{ name: string }> };
    expect(packages.packages.map((pkg) => pkg.name)).toEqual(["demo"]);
    const diagram = await (await fetch(`${base}/api/diagram?kind=packages&path=`)).json() as {
      dsl: string;
      dsls: string[];
      sources: UmlEntitySource[];
      externalUsers: UmlExternalUser[];
      localUsers: UmlLocalUser[];
    };
    expect(diagram.dsl).toContain("flowchart LR");
    expect(diagram.dsls).toEqual([diagram.dsl]);
    expect(diagram.sources).toEqual([]);
    expect(diagram.externalUsers).toEqual([]);
    expect(diagram.localUsers).toEqual([]);
    expect(Object.hasOwn(diagram, "graph")).toBe(false);
    const uml = await (await fetch(`${base}/api/diagram?kind=uml&path=packages/demo`)).json() as {
      dsl: string;
      dsls: string[];
      sources: UmlEntitySource[];
      externalUsers: UmlExternalUser[];
      localUsers: UmlLocalUser[];
    };
    expect(uml.dsl).toContain("classDiagram");
    expect(uml.dsls.length).toBeGreaterThan(0);
    expect(uml.dsls.every((dsl) => dsl.includes("classDiagram"))).toBe(true);
    expect(Object.hasOwn(uml, "graph")).toBe(false);
    expect(uml.sources).toEqual([
      {
        path: "packages/demo/src/machine.ts",
        line: 1,
        column: 14,
        name: "AbstractStateMachine",
        methods: [],
      },
      {
        path: "packages/demo/src/runtime.ts",
        line: 2,
        column: 14,
        name: "DataflowRuntime",
        methods: [
          {
            path: "packages/demo/src/runtime.ts",
            line: 2,
            column: 32,
            name: "getMachine",
          },
        ],
      },
    ]);
    expect(uml.externalUsers).toEqual([]);
    expect(uml.localUsers).toEqual([]);
    expect(uml.dsl).toMatch(
      /^[ \t]*DataflowRuntime[ \t]*-->[ \t]*AbstractStateMachine[ \t]*\r?$/m,
    );
    const methodReturnDsls = uml.dsls.filter((dsl) =>
      /^[ \t]*DataflowRuntime[ \t]*-->[ \t]*AbstractStateMachine[ \t]*\r?$/m.test(dsl),
    );
    expect(methodReturnDsls).toHaveLength(1);
    const methodReturnDsl = methodReturnDsls[0];
    expect(methodReturnDsl).toMatch(/^[ \t]*class[ \t]+DataflowRuntime[ \t]*\{/m);
    expect(methodReturnDsl).toMatch(/^[ \t]*class[ \t]+AbstractStateMachine[ \t]*\{/m);
    await mkdir(join(root, "packages", "demo", "src", "target"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "src", "target", "widget.ts"),
      "export class Widget {}\n",
    );
    await writeFile(
      join(root, "packages", "demo", "src", "target", "local-user.ts"),
      'import { Widget } from "./widget";\nexport function acceptWidget(widget: Widget): void { void widget; }\n',
    );
    await writeFile(
      join(root, "packages", "demo", "src", "consumer.ts"),
      'import { Widget } from "./target/widget";\nexport class Consumer { build(): Widget { return new Widget(); } }\n',
    );
    const scopedPath = "packages/demo/src/target";
    const scopedUml = await (
      await fetch(`${base}/api/diagram?kind=uml&path=${encodeURIComponent(scopedPath)}`)
    ).json() as {
      dsl: string;
      dsls: string[];
      sources: UmlEntitySource[];
      externalUsers: UmlExternalUser[];
      localUsers: UmlLocalUser[];
    };
    expect(scopedUml.localUsers).toEqual([
      {
        nodeId: "local0",
        label: "local: packages/demo/src/target/local-user.ts: acceptWidget(Widget)",
        kind: "function",
        path: "packages/demo/src/target/local-user.ts",
        line: 2,
        column: 17,
      },
    ]);
    expect(scopedUml.externalUsers).toEqual([
      {
        nodeId: "extern0",
        label: "extern: packages/demo/src/consumer.ts: Consumer.build()",
        scopePath: "packages/demo/src/consumer.ts",
        kind: "method",
      },
    ]);
    const localDeclaration =
      'class local0["local: packages/demo/src/target/local-user.ts<br/>acceptWidget(Widget)"]';
    const localEdge = /^[ \t]*local0[ \t]*-->[ \t]*Widget[ \t]*\r?$/m;
    expect(scopedUml.dsl).toContain(localDeclaration);
    expect(scopedUml.dsl).toMatch(localEdge);
    const externalDeclaration =
      'class extern0["extern: packages/demo/src/consumer.ts<br/>Consumer.build()"]';
    const externalEdge = /^[ \t]*extern0[ \t]*-->[ \t]*Widget[ \t]*\r?$/m;
    expect(scopedUml.dsl).toContain(externalDeclaration);
    expect(scopedUml.dsl).toMatch(externalEdge);
    const externalStackedDsls = scopedUml.dsls.filter(
      (dsl) => dsl.includes(externalDeclaration) && externalEdge.test(dsl),
    );
    expect(externalStackedDsls).toHaveLength(1);
    expect(scopedUml.dsls).toHaveLength(1);
    const localStackedDsls = scopedUml.dsls.filter(
      (dsl) => dsl.includes(localDeclaration) && localEdge.test(dsl),
    );
    expect(localStackedDsls).toHaveLength(1);
    expect(externalStackedDsls[0]).toMatch(/^[ \t]*class[ \t]+Widget[ \t]*\{/m);
    const cachedScopedUml = await (
      await fetch(`${base}/api/diagram?kind=uml&path=${encodeURIComponent(scopedPath)}`)
    ).json() as typeof scopedUml;
    expect(cachedScopedUml.externalUsers).toEqual(scopedUml.externalUsers);
    expect(cachedScopedUml.localUsers).toEqual(scopedUml.localUsers);
    expect(cachedScopedUml.dsl).toBe(scopedUml.dsl);
    expect(cachedScopedUml.dsls).toEqual(scopedUml.dsls);
    const missingScope = await (
      await fetch(`${base}/api/diagram?kind=uml&path=packages/demo/src/missing`)
    ).json() as {
      status: string;
      dsl: string;
      dsls: string[];
      sources: UmlEntitySource[];
      externalUsers: UmlExternalUser[];
      localUsers: UmlLocalUser[];
    };
    expect(missingScope.status).toBe("error");
    expect(missingScope.dsl).toBe("classDiagram");
    expect(missingScope.dsls).toEqual(["classDiagram"]);
    expect(missingScope.sources).toEqual([]);
    expect(missingScope.externalUsers).toEqual([]);
    expect(missingScope.localUsers).toEqual([]);
    expect(Object.hasOwn(missingScope, "graph")).toBe(false);
    const opened = await (await fetch(`${base}/api/file?path=packages/demo/src/index.ts`)).json() as { content: string; hash: string };
    const formattedResponse = await fetch(`${base}/api/file/format`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "export const other=2\n" }) });
    expect((await formattedResponse.json() as { content: string }).content).toContain("other = 2;");
    expect(await readFile(file, "utf8")).toBe("export const value=1\n");
    const saved = await fetch(`${base}/api/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "export const other = 2;\n", baseHash: opened.hash }) });
    expect(saved.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe("export const other = 2;\n");
  } finally {
    try {
      await server.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);
