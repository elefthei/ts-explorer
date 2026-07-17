import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.ts";

test("serves tree, packages, diagrams, files, format, and save routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-server-"));
  await mkdir(join(root, "packages", "demo", "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await writeFile(join(root, "packages", "demo", "package.json"), JSON.stringify({ name: "demo" }));
  const file = join(root, "packages", "demo", "src", "index.ts");
  await writeFile(file, "export const value=1\n");
  const server = await startServer({ sourceDir: root, host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const tree = await (await fetch(`${base}/api/tree`)).json() as { root: { children?: Array<{ name: string }> } };
    expect(tree.root.children?.map((child) => child.name)).toContain("packages");
    const packages = await (await fetch(`${base}/api/packages`)).json() as { packages: Array<{ name: string }> };
    expect(packages.packages.map((pkg) => pkg.name)).toEqual(["demo"]);
    const diagram = await (await fetch(`${base}/api/diagram?kind=packages&path=`)).json() as { dsl: string };
    expect(diagram.dsl).toContain("flowchart LR");
    const uml = await (await fetch(`${base}/api/diagram?kind=uml&path=packages/demo`)).json() as { dsl: string };
    expect(uml.dsl).toContain("classDiagram");
    const opened = await (await fetch(`${base}/api/file?path=packages/demo/src/index.ts`)).json() as { content: string; hash: string };
    const formattedResponse = await fetch(`${base}/api/file/format`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "export const other=2\n" }) });
    expect((await formattedResponse.json() as { content: string }).content).toContain("other = 2;");
    expect(await readFile(file, "utf8")).toBe("export const value=1\n");
    const saved = await fetch(`${base}/api/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "packages/demo/src/index.ts", content: "export const other = 2;\n", baseHash: opened.hash }) });
    expect(saved.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe("export const other = 2;\n");
  } finally {
    await server.stop();
  }
});
