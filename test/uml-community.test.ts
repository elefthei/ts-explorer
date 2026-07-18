import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUmlDiagram, buildUmlDiagrams } from "../src/uml.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function classNames(dsl: string): string[] {
  return [...dsl.matchAll(/^class\s+([^\s{]+)\s*\{/gm)].map((match) => match[1]);
}

function cssAssignments(dsl: string): Array<{ name: string; style: string }> {
  return [...dsl.matchAll(/^cssClass\s+"([^"]+)"\s+(\S+)\s*$/gm)].map((match) => ({
    name: match[1],
    style: match[2],
  }));
}

function classDefNames(dsl: string): string[] {
  return [...dsl.matchAll(/^classDef\s+(\S+)\s+/gm)].map((match) => match[1]);
}

function lineCount(dsl: string, expected: string): number {
  return dsl.split(/\r?\n/).filter((line) => line === expected).length;
}

test("partitions UML into ordered self-contained communities", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-community-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    'import { B } from "./b";\nexport class A extends B {}\nexport interface I {}\n',
  );
  await writeFile(join(root, "src", "b.ts"), "export class B {}\nexport class C {}\n");
  await writeFile(
    join(root, "src", "d.ts"),
    'import { E } from "./e";\nexport class D { ref!: E; }\n',
  );
  await writeFile(join(root, "src", "e.ts"), "export class E {}\n");
  await writeFile(join(root, "tests", "example.test.ts"), "export class ExampleTest {}\n");

  const bundle = await buildUmlDiagrams(root, "", []);
  const expectedCommunities = [["A", "B"], ["I"], ["C"], ["D", "E"], ["ExampleTest"]];

  expect(bundle.dsls).toHaveLength(5);
  expect(
    bundle.dsls.map((dsl) => cssAssignments(dsl).map(({ name }) => name).sort()),
  ).toEqual(expectedCommunities);

  for (const [index, dsl] of bundle.dsls.entries()) {
    expect(dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);

    const declarations = classNames(dsl);
    const assignments = cssAssignments(dsl);
    const styles = classDefNames(dsl);
    expect(declarations.sort()).toEqual([...expectedCommunities[index]].sort());
    expect(assignments.filter(({ name }) => !declarations.includes(name))).toEqual([]);
    expect(assignments.filter(({ style }) => !styles.includes(style))).toEqual([]);
  }

  const inheritanceDsl = bundle.dsls[0];
  expect(inheritanceDsl).toContain("B<|--A");

  const associationDsl = bundle.dsls[3];
  expect(classNames(associationDsl).sort()).toEqual(["D", "E"]);
  expect(associationDsl).toMatch(/D\s+--\s+E/);

  const testAssignment = cssAssignments(bundle.dsls[4]).find(({ name }) => name === "ExampleTest");
  expect(testAssignment?.style).toBe("testConcrete");

  expect(bundle.dsl).toBe(await buildUmlDiagram(root, "", []));
});

test("keeps method-return-connected entities in one community frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-return-community-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "f.ts"),
    'import { G } from "./g";\nexport class F { make(): G { return new G(); } }\n',
  );
  await writeFile(join(root, "src", "g.ts"), "export class G {}\n");
  await writeFile(
    join(root, "src", "h.ts"),
    "export class H { self(): H { return this; } value(): number { return 1; } }\n",
  );

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.dsls.map((dsl) => classNames(dsl).sort())).toEqual([["F", "G"], ["H"]]);

  const methodReturnDsl = bundle.dsls[0];
  expect(classNames(methodReturnDsl).sort()).toEqual(["F", "G"]);
  expect(methodReturnDsl).toMatch(/^[ \t]*F[ \t]*-->[ \t]*G[ \t]*\r?$/m);

  const selfDsl = bundle.dsls[1];
  expect(classNames(selfDsl)).toEqual(["H"]);
  expect(selfDsl).not.toMatch(/-->/);

  expect(bundle.dsl).toMatch(/^[ \t]*F[ \t]*-->[ \t]*G[ \t]*\r?$/m);
});

test("keeps external-user fan-out targets in one community frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-external-community-"));
  roots.push(root);
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "lib", "first-target.ts"), "export class FirstTarget {}\n");
  await writeFile(join(root, "src", "lib", "second-target.ts"), "export class SecondTarget {}\n");
  await writeFile(
    join(root, "src", "app", "consumer.ts"),
    [
      'import { FirstTarget } from "../lib/first-target";',
      'import { SecondTarget } from "../lib/second-target";',
      "export class Consumer {",
      "  build(): void {",
      "    new FirstTarget();",
      "    new SecondTarget();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "src/lib", []);
  const externalDeclaration =
    'class extern0["extern: src/app/consumer.ts<br/>Consumer.build()"]';
  const firstEdge = "extern0 --> FirstTarget";
  const secondEdge = "extern0 --> SecondTarget";

  expect(bundle.dsls.map((dsl) => classNames(dsl).sort())).toEqual([
    ["FirstTarget", "SecondTarget"],
  ]);
  expect(bundle.dsls.map((dsl) => lineCount(dsl, externalDeclaration))).toEqual([1]);

  const fanOutFrame = bundle.dsls[0];
  expect(lineCount(fanOutFrame, firstEdge)).toBe(1);
  expect(lineCount(fanOutFrame, secondEdge)).toBe(1);

  expect(lineCount(bundle.dsl, externalDeclaration)).toBe(1);
  expect(lineCount(bundle.dsl, firstEdge)).toBe(1);
  expect(lineCount(bundle.dsl, secondEdge)).toBe(1);
});

test("keeps an empty UML scope as one renderable frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-empty-"));
  roots.push(root);

  const bundle = await buildUmlDiagrams(root, "", []);

  expect(bundle.dsls).toEqual([bundle.dsl]);
  expect(bundle.dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);
  expect(bundle.graph.order).toBe(0);
  expect(bundle.graph.size).toBe(0);
});

test("keeps local-user fan-out targets in one community frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-local-community-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "first-target.ts"), "export class FirstTarget {}\n");
  await writeFile(join(root, "src", "second-target.ts"), "export class SecondTarget {}\n");
  await writeFile(join(root, "src", "unrelated.ts"), "export class Unrelated {}\n");
  await writeFile(
    join(root, "src", "target-union.ts"),
    [
      'import { FirstTarget } from "./first-target";',
      'import { SecondTarget } from "./second-target";',
      "",
      "export type TargetUnion = FirstTarget | SecondTarget;",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);
  const localDeclaration = 'class local0["local: src/target-union.ts<br/>TargetUnion"]';
  const firstEdge = "local0 --> FirstTarget";
  const secondEdge = "local0 --> SecondTarget";

  expect(
    bundle.localUsers.map(({ nodeId, label, kind, path }) => ({ nodeId, label, kind, path })),
  ).toEqual([
    {
      nodeId: "local0",
      label: "local: src/target-union.ts: TargetUnion",
      kind: "type",
      path: "src/target-union.ts",
    },
  ]);
  expect(bundle.dsls).toHaveLength(2);

  const fanOutFrames = bundle.dsls.filter((dsl) => classNames(dsl).includes("FirstTarget"));
  expect(fanOutFrames).toHaveLength(1);
  const fanOutFrame = fanOutFrames[0]!;
  expect(classNames(fanOutFrame).sort()).toEqual(["FirstTarget", "SecondTarget"]);
  expect(lineCount(fanOutFrame, localDeclaration)).toBe(1);
  expect(lineCount(fanOutFrame, firstEdge)).toBe(1);
  expect(lineCount(fanOutFrame, secondEdge)).toBe(1);

  const unrelatedFrame = bundle.dsls.find((dsl) => classNames(dsl).includes("Unrelated"));
  expect(unrelatedFrame).toBeDefined();
  expect(classNames(unrelatedFrame!).sort()).toEqual(["Unrelated"]);
  expect(lineCount(unrelatedFrame!, localDeclaration)).toBe(0);
  expect(lineCount(unrelatedFrame!, firstEdge)).toBe(0);
  expect(lineCount(unrelatedFrame!, secondEdge)).toBe(0);

  expect(bundle.dsls.reduce((count, dsl) => count + lineCount(dsl, localDeclaration), 0)).toBe(1);
  expect(lineCount(bundle.dsl, localDeclaration)).toBe(1);
  expect(lineCount(bundle.dsl, firstEdge)).toBe(1);
  expect(lineCount(bundle.dsl, secondEdge)).toBe(1);
});

test("keeps a weak bridge visible across deterministic dense Louvain communities", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-uml-louvain-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "clusters.ts"),
    [
      "export class A1<T> { a2!: A2; a3!: A3; bridge!: B1; }",
      "export class A2 extends A1<string> { a3!: A3; }",
      "export class A3 { a1!: A1<string>; a2!: A2; }",
      "export class B1 { b2!: B2; b3!: B3; }",
      "export class B2 { b1!: B1; b3!: B3; }",
      "export class B3 { b1!: B1; b2!: B2; }",
      "",
    ].join("\n"),
  );

  const bundle = await buildUmlDiagrams(root, "", []);
  const entityCommunities = new Map(
    bundle.graph
      .nodes()
      .filter((id) => bundle.graph.getNodeAttribute(id, "kind") === "entity")
      .map((id) => [
        bundle.graph.getNodeAttribute(id, "name").replace(/<.*$/, ""),
        bundle.graph.getNodeAttribute(id, "community"),
      ]),
  );
  const communityOf = (name: string): number => {
    const community = entityCommunities.get(name);
    if (typeof community !== "number" || !Number.isInteger(community)) {
      throw new Error(`Expected an integer community for ${name}`);
    }
    return community;
  };
  const clusterA = ["A1", "A2", "A3"];
  const clusterB = ["B1", "B2", "B3"];
  const communityA = communityOf("A1");
  const communityB = communityOf("B1");
  const genericBaseId = bundle.graph.nodes().find(
    (id) => bundle.graph.getNodeAttribute(id, "name").replace(/<.*$/, "") === "A1",
  );
  const genericChildId = bundle.graph.nodes().find(
    (id) => bundle.graph.getNodeAttribute(id, "name") === "A2",
  );
  if (genericBaseId === undefined || genericChildId === undefined) {
    throw new Error("Expected declared generic base and child graph nodes");
  }
  const genericHeritage = bundle.graph.edges().flatMap(
    (edge) => bundle.graph.getEdgeAttribute(edge, "relations"),
  ).find(({ kind, sourceId, targetId }) =>
    kind === "heritage" && sourceId === genericChildId && targetId === genericBaseId
  );

  expect(genericHeritage).toEqual({
    kind: "heritage",
    sourceId: genericChildId,
    targetId: genericBaseId,
  });
  expect(new Set(entityCommunities.values())).toHaveLength(2);
  expect(new Set(clusterA.map(communityOf))).toEqual(new Set([communityA]));
  expect(new Set(clusterB.map(communityOf))).toEqual(new Set([communityB]));
  expect(communityA).not.toBe(communityB);
  expect(
    bundle.dsls.map((dsl) =>
      classNames(dsl).map((name) => name.replace(/~.*$/, "")).sort()
    ),
  ).toEqual([
    ["A1", "A2", "A3", "B1"],
    ["A1", "B1", "B2", "B3"],
  ]);

  const bridge = /^[ \t]*(?:A1(?:~[^~\r\n]+~)?[ \t]*--[ \t]*B1|B1[ \t]*--[ \t]*A1(?:~[^~\r\n]+~)?)[ \t]*\r?$/m;
  const genericInheritance = /^[ \t]*A1(?:~[^~\r\n]+~)?<\|--A2[ \t]*\r?$/m;
  for (const dsl of bundle.dsls) {
    expect(dsl).toMatch(/^\s*classDiagram(?:\r?\n|$)/);
    expect(dsl.match(/^[ \t]*classDiagram[ \t]*$/gm) ?? []).toHaveLength(1);
    expect(dsl).toMatch(bridge);
  }
  expect(classNames(bundle.dsl).map((name) => name.replace(/~.*$/, "")).sort()).toEqual(
    [...clusterA, ...clusterB].sort(),
  );
  expect(bundle.dsl).toMatch(bridge);
  expect(bundle.dsl).toMatch(genericInheritance);
  expect(bundle.dsls.filter((dsl) => genericInheritance.test(dsl))).toHaveLength(1);

  const rebuilt = await buildUmlDiagrams(root, "", []);
  expect(rebuilt.dsls).toEqual(bundle.dsls);
});
