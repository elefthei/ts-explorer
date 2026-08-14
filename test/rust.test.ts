import { afterEach, expect, test } from "bun:test";
import { computeHighlightSpans } from "../src/highlight.ts";
import { parseDefinitionSpans } from "../src/goto-definition.ts";
import { discoverPackages } from "../src/packages.ts";
import { HIGHLIGHT_TOKENS } from "../src/types.ts";
import { extractUmlDiagramGraph } from "../src/uml.ts";
import { validateUmlDiagramGraph } from "../src/uml/render.ts";
import { createFixtureTracker } from "./support/fixtures.ts";
import { expectNormalizedUmlRoundTrip, materializeUmlGraph } from "./support/normalized-graph.ts";
import { contractFile, extractContract, normalizeRoot } from "./support/uml-contract.ts";

const fixtures = createFixtureTracker();

afterEach(async () => {
  await fixtures.cleanup();
});

const RUST_SOURCE = `use std::fmt;

/// A widget.
#[derive(Debug)]
pub struct Widget<'a, T> {
    pub name: &'a str,
    kind: Kind,
    payload: T,
}

pub enum Kind {
    Simple,
    Fancy,
}

pub trait Render: fmt::Display {
    fn render(&self) -> String;
}

impl<'a, T> Render for Widget<'a, T> {
    fn render(&self) -> String {
        let count = 1 + 2;
        format!("{}{}", self.name, count)
    }
}

impl<'a, T> Widget<'a, T> {
    pub unsafe fn build(name: &'a str) -> Kind {
        Kind::Simple
    }
}
`;

test("highlights Rust with the shared token vocabulary", () => {
  const spans = computeHighlightSpans("lib.rs", RUST_SOURCE);

  expect(spans.length).toBeGreaterThan(0);
  const vocabulary = [...new Set(spans.map((span) => span.token))];
  expect(vocabulary.filter((token) => !HIGHLIGHT_TOKENS.includes(token))).toEqual([]);
  for (const [index, span] of spans.entries()) {
    const previous = spans[index - 1];
    expect(span.from, `span ${index}`).toBeLessThan(span.to);
    if (previous) expect(previous.to, `span ${index}`).toBeLessThanOrEqual(span.from);
  }

  const structStart = RUST_SOURCE.indexOf("pub struct Widget");
  expect(
    spans
      .filter((span) => span.from >= structStart)
      .slice(0, 3)
      .map((span) => ({ token: span.token, text: RUST_SOURCE.slice(span.from, span.to) })),
  ).toEqual([
    { token: "keyword", text: "pub" },
    { token: "keyword", text: "struct" },
    { token: "className", text: "Widget" },
  ]);

  // A `///` doc comment holds a nested `/` marker token that must not repaint the comment.
  const docStart = RUST_SOURCE.indexOf("/// A widget.");
  expect(spans.find((span) => span.from === docStart)).toEqual({
    from: docStart,
    to: docStart + "/// A widget.\n".length,
    token: "comment",
  });
});

test("parses Rust definition spans for entities and impl-contributed methods", () => {
  const spans = parseDefinitionSpans("src/lib.rs", RUST_SOURCE);

  expect(
    spans.map(({ key, kind, qualifiedName, line, column }) => ({
      key,
      kind,
      qualifiedName,
      line,
      column,
    })),
  ).toEqual([
    {
      key: '["class","Widget",0,null,null]',
      kind: "class",
      qualifiedName: "Widget",
      line: 5,
      column: 12,
    },
    {
      key: '["class","Widget",0,"render",0]',
      kind: "method",
      qualifiedName: "Widget.render",
      line: 21,
      column: 8,
    },
    {
      key: '["class","Widget",0,"build",0]',
      kind: "method",
      qualifiedName: "Widget.build",
      line: 28,
      column: 19,
    },
    {
      key: '["enum","Kind",0,null,null]',
      kind: "enum",
      qualifiedName: "Kind",
      line: 11,
      column: 10,
    },
    {
      key: '["interface","Render",0,null,null]',
      kind: "interface",
      qualifiedName: "Render",
      line: 16,
      column: 11,
    },
    {
      key: '["interface","Render",0,"render",0]',
      kind: "method",
      qualifiedName: "Render.render",
      line: 17,
      column: 8,
    },
  ]);

  expect(spans[0]?.renderedEntityName).toBe("Widget<T>");
  expect(parseDefinitionSpans("src/lib.rs", RUST_SOURCE).map(({ from, to }) => ({ from, to })))
    .toEqual(spans.map(({ from, to }) => ({ from, to })));
});

test("resolves Rust entities, heritage and cross-file usage into the shared model", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-rust-model-", {
    "src/lib.rs": `mod model;

pub use model::Widget;

pub fn build() -> Widget {
    Widget::new()
}
`,
    "src/model.rs": `pub struct Widget {
    pub name: String,
    kind: Kind,
}

pub enum Kind {
    Simple,
}

pub trait Render {
    fn render(&self) -> String;
}

impl Render for Widget {
    fn render(&self) -> String {
        self.name.clone()
    }
}

impl Widget {
    pub fn new() -> Widget {
        Widget { name: String::new(), kind: Kind::Simple }
    }

    pub fn kind(&self) -> Kind {
        Kind::Simple
    }
}
`,
  });

  const { contract } = await extractContract(root);

  expect(contract.entities.map(({ kind, name, file }) => ({ kind, name, file }))).toEqual([
    { kind: "class", name: "Widget", file: "src/model.rs" },
    { kind: "interface", name: "Render", file: "src/model.rs" },
    { kind: "enum", name: "Kind", file: "src/model.rs" },
  ]);

  const widget = contract.entities[0];
  expect(widget?.properties).toEqual([
    { name: "name", type: "String", optional: false, modifiers: ["public"] },
    { name: "kind", type: "Kind", optional: false, modifiers: ["private"] },
  ]);
  // A trait implementation is public through the trait; an inherent `impl` keeps its own `pub`.
  expect(widget?.methods.map(({ name, modifiers }) => ({ name, modifiers }))).toEqual([
    { name: "render", modifiers: ["public"] },
    { name: "new", modifiers: ["public", "static"] },
    { name: "kind", modifiers: ["public"] },
  ]);
  expect(widget?.heritage).toEqual([
    { kind: "implements", clause: "Render", className: "Widget" },
  ]);
  expect(contract.entities[1]?.methods).toEqual([
    { name: "render", type: "\n§() String", modifiers: ["public", "abstract"] },
  ]);
  expect(contract.entities[2]?.enumItems).toEqual(["Simple"]);

  // `Widget::new()` in lib.rs resolves through `mod model;` + `pub use model::Widget`.
  expect(contract.localUsers).toEqual([
    {
      label: "local: src/lib.rs: build()",
      path: "src/lib.rs",
      line: 5,
      column: 8,
      kind: "function",
      owner: null,
      targets: ["Widget"],
    },
  ]);
  expect(contract.methodReturns).toEqual([{ source: "Widget", target: "Kind" }]);
});

test("an unresolvable external crate produces no usage edge and no boundary node", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-rust-external-", {
    "src/lib.rs": `use other_crate::Thing;

pub struct Holder {
    thing: Thing,
}
`,
  });

  const { contract } = await extractContract(root);

  expect(contract.nodes).toEqual([{ name: "Holder", kind: "entity", community: 0 }]);
  expect(contract.usage).toEqual([]);
  expect(contract.localUsers).toEqual([]);
  expect(contract.edges).toEqual([]);
  expect(contract.relations).toEqual([]);
});

test("discovers Cargo workspace members and their internal dependencies", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-cargo-", {
    "Cargo.toml": `[workspace]
members = ["crates/*"]
`,
    "crates/core/Cargo.toml": `[package]
name = "fixture-core"
version = "0.1.0"
`,
    "crates/core/src/lib.rs": "pub struct Core;\n",
    "crates/app/Cargo.toml": `[package]
name = "fixture-app"
version = "0.1.0"

[dependencies]
fixture-core = { path = "../core" }
serde = "1"
`,
    "crates/app/src/lib.rs": "pub struct App;\n",
  });

  expect(await discoverPackages(root)).toEqual([
    { name: "fixture-app", path: "crates/app", dependencies: ["fixture-core"] },
    { name: "fixture-core", path: "crates/core", dependencies: [] },
  ]);
});

test("a mixed TypeScript and Rust scope yields one shared graph", async () => {
  const root = await fixtures.fixtureRoot("ts-explorer-mixed-", {
    "src/ts/model.ts": `export class TsPayload {}
export class TsService {
  build(): TsPayload {
    return new TsPayload();
  }
}
`,
    "src/rs/model.rs": `pub struct RsPayload {
    pub label: String,
}

pub trait RsRender {
    fn render(&self) -> RsPayload;
}

impl RsRender for RsPayload {
    fn render(&self) -> RsPayload {
        RsPayload { label: String::new() }
    }
}
`,
  });

  const extracted = await extractUmlDiagramGraph(root, "", []);
  validateUmlDiagramGraph(extracted);

  const graph = await normalizeRoot(root, extracted);
  expect(graph.declarations.map(({ fileName, language }) => ({
    fileName: contractFile(fileName),
    language,
  }))).toEqual([
    { fileName: "src/rs/model.rs", language: "rust" },
    { fileName: "src/ts/model.ts", language: "typescript" },
  ]);

  const nodeNames = new Set(graph.nodes.map((node) => node.name));
  expect(nodeNames.has("TsService")).toBe(true);
  expect(nodeNames.has("TsPayload")).toBe(true);
  expect(nodeNames.has("RsPayload")).toBe(true);
  expect(nodeNames.has("RsRender")).toBe(true);

  expect(graph.nodes.map((node) => node.nodeOrdinal)).toEqual(
    graph.nodes.map((_, index) => index),
  );

  const languageOf = (id: string): "rust" | "typescript" =>
    id.includes("/rs/") ? "rust" : "typescript";
  for (const edge of [...graph.usageEdges, ...graph.methodReturnDependencies]) {
    expect(languageOf(edge.sourceId), edge.sourceId).toBe(languageOf(edge.targetId));
  }
  expect(graph.methodReturnDependencies.map(({ sourceName, targetName }) =>
    `${sourceName}->${targetName}`
  )).toEqual(["RsRender->RsPayload", "TsService->TsPayload"]);

  const cacheRoot = await fixtures.temporaryRoot("ts-explorer-mixed-cache-");
  const materialized = await materializeUmlGraph(cacheRoot, extracted);
  expectNormalizedUmlRoundTrip(materialized.record as typeof extracted, extracted);
}, 30_000);
