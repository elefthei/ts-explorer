import { afterEach, expect, test } from "bun:test";
import { computeHighlightSpans } from "../src/highlight.ts";
import { parseDefinitionSpans, parseFileDefinitions } from "../src/goto-definition.ts";
import { discoverPackages } from "../src/packages.ts";
import type { UmlTarget } from "../src/types.ts";
import { HIGHLIGHT_TOKENS } from "../src/types.ts";
import { validateUmlDiagramGraph } from "../src/uml/graph.ts";
import { FULL_UML_VISIBILITY } from "../src/uml/model.ts";
import { renderUmlView, type UmlDefinitionNode } from "../src/uml/view.ts";
import { expectFileGraphRoundTrips } from "./support/normalized-graph.ts";
import { umlLabel } from "./support/uml-contract.ts";
import {
  createUmlProjectTracker,
  readCompleteUml,
  type UmlProject,
} from "./support/uml-project.ts";

const { fixtureRoot, openProject, cleanup } = createUmlProjectTracker();

afterEach(cleanup);

/** Node identities, directed edges and frames of one rooted selection. */
function definitionView(project: UmlProject, target: UmlTarget) {
  const diagram = readCompleteUml(project, target);
  const view = diagram.view;
  if (view.kind !== "definitions") {
    throw new Error(`expected a definition view for ${JSON.stringify(target)}`);
  }
  const names = new Map(view.nodes.map((node) => [node.definition.key, umlLabel(node.definition)]));
  const named = (key: string): string => names.get(key) ?? `<outside the view: ${key}>`;
  return {
    status: diagram.status,
    error: diagram.error,
    nodes: view.nodes.map((node) => umlLabel(node.definition)),
    kinds: view.nodes.map((node) => `${umlLabel(node.definition)} ${node.definition.kind}`),
    edges: view.edges.map((edge) =>
      `${named(edge.sourceKey)} -${edge.kind}-> ${named(edge.targetKey)}`
    ),
    frames: view.frames.map((frame) =>
      `${named(frame.rootKey)} => ${frame.nodeKeys.map(named).join(", ")}`
    ),
    node(wanted: string): UmlDefinitionNode {
      const found = view.nodes.find((node) => umlLabel(node.definition) === wanted);
      if (!found) throw new Error(`no node ${wanted} in ${view.nodes.map((n) => umlLabel(n.definition)).join(", ")}`);
      return found;
    },
  };
}

/** The compartment rows one box draws, by the label of the declaration each row navigates to. */
function drawnBox(project: UmlProject, target: UmlTarget, box: string) {
  const diagram = readCompleteUml(project, target);
  if (diagram.view.kind !== "definitions") {
    throw new Error(`expected a definition view for ${JSON.stringify(target)}`);
  }
  const frame = renderUmlView(diagram.view, FULL_UML_VISIBILITY, target).frames[0];
  const drawn = frame?.definitionLinks.find((entry) => umlLabel(entry.definition) === box);
  if (!frame || !drawn) throw new Error(`no box ${box} in ${JSON.stringify(target)}`);
  return {
    dsl: frame.dsl,
    nodeId: drawn.nodeId,
    attributes: drawn.attributes.map((definition) => umlLabel(definition)),
    methods: drawn.methods.map((definition) => umlLabel(definition)),
  };
}

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

/**
 * The declaring file, the trait, the marker implementation, the method implementation and the
 * leaf are deliberately five separate files, so cross-file ownership and empty `impl` blocks are
 * exercised independently.
 */
const ROOTED_FIXTURE: Record<string, string> = {
  "lib.rs": `mod root;
mod contracts;
mod marker_impl;
mod methods;
mod leaf;
mod child;
`,
  "root.rs": "pub struct Root;\n",
  "contracts.rs": "pub trait LocalTrait {}\n",
  "marker_impl.rs": `use crate::root::Root;
use crate::contracts::LocalTrait;

impl LocalTrait for Root {}
`,
  "methods.rs": `use crate::root::Root;
use crate::leaf::Leaf;

impl Root {
    pub fn make(&self) -> Leaf {
        Leaf
    }
}
`,
  "leaf.rs": "pub struct Leaf;\n",
  "child.rs": `use crate::leaf::Leaf;

pub fn make() -> Leaf {
    Leaf
}
`,
};

function rootedProject(): Promise<UmlProject> {
  return openProject("ts-explorer-rust-rooted-", ROOTED_FIXTURE);
}

test("highlights Rust with the shared token vocabulary", () => {
  const spans = computeHighlightSpans("lib.rs", RUST_SOURCE);

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

test("a Rust type reaches its cross-file trait implementation and method dependencies", async () => {
  const project = await rootedProject();

  // `impl LocalTrait for Root {}` declares no member at all, so the type's closure can only be
  // complete if that file's own graph was processed.
  expect(project.definitions("marker_impl.rs")).toEqual([]);
  const markerGraph = project.fileGraph("marker_impl.rs");
  validateUmlDiagramGraph(markerGraph);
  expect(markerGraph.relations.map(({ relationKind }) => relationKind)).toEqual(["implements"]);

  const view = definitionView(project, {
    kind: "definition",
    path: "root.rs",
    definitionKey: project.key("root.rs", "Root"),
  });

  expect(view.status).toBe("ready");
  expect(view.nodes).toEqual(["LocalTrait@contracts.rs", "Leaf@leaf.rs", "Root@root.rs"]);
  expect(view.edges).toEqual([
    "Root@root.rs -implements-> LocalTrait@contracts.rs",
    "Root@root.rs -references-> Leaf@leaf.rs",
  ]);
  expect(view.frames).toEqual([
    "Root@root.rs => LocalTrait@contracts.rs, Leaf@leaf.rs, Root@root.rs",
  ]);
});

test("selecting an implemented trait excludes the types that implement it", async () => {
  const project = await rootedProject();

  const view = definitionView(project, {
    kind: "definition",
    path: "contracts.rs",
    definitionKey: project.key("contracts.rs", "LocalTrait"),
  });

  // Closures follow outgoing references only; `Root` implements `LocalTrait`, not the reverse.
  expect(view.nodes).toEqual(["LocalTrait@contracts.rs"]);
  expect(view.edges).toEqual([]);
  expect(view.frames).toEqual(["LocalTrait@contracts.rs => LocalTrait@contracts.rs"]);
});

test("the view keeps native Rust kinds instead of normalizing them to class and interface", async () => {
  const project = await rootedProject();

  const view = definitionView(project, {
    kind: "definition",
    path: "root.rs",
    definitionKey: project.key("root.rs", "Root"),
  });

  expect(view.kinds).toEqual([
    "LocalTrait@contracts.rs trait",
    "Leaf@leaf.rs struct",
    "Root@root.rs struct",
  ]);
  const trait = view.node("LocalTrait@contracts.rs");
  expect(trait.detail?.kind).toBe("trait");
  // The colour category is still the interface style; only the rendered kind label is native.
  expect(trait.category).toBe("interface");
  expect(view.node("Root@root.rs").detail?.kind).toBe("struct");
  expect(view.node("Root@root.rs").category).toBe("concrete");
});

test("a displayed method row addresses the implementation that declares it", async () => {
  const project = await rootedProject();

  const view = definitionView(project, {
    kind: "definition",
    path: "root.rs",
    definitionKey: project.key("root.rs", "Root"),
  });
  const root = view.node("Root@root.rs");
  const makeKey = project.key("methods.rs", "Root.make");

  expect(root.detail?.methods).toEqual([
    { definitionKey: makeKey, modifiers: ["public"], name: "make", returnType: "Leaf" },
  ]);
  expect(root.detail?.properties).toEqual([]);
  // The row navigates to `methods.rs`, not to the type declaration or `child.rs`'s free `make`.
  expect(root.memberDefinitions.map((member) => ({
    key: member.key,
    source: member.source,
  }))).toEqual([
    { key: makeKey, source: { path: "methods.rs", line: 5, column: 12 } },
  ]);
});

test("a Rust impl member is owned by its type and never becomes a file root", async () => {
  const project = await rootedProject();

  const [method, ...rest] = project.definitions("methods.rs");
  expect(rest).toEqual([]);
  expect(method?.qualifiedName).toBe("Root.make");
  expect(method?.isTopLevel).toBe(false);
  expect(method?.parentKey).toBe(project.key("root.rs", "Root"));

  // The implementation file therefore contributes no root frame of its own …
  const fileView = definitionView(project, { kind: "file", path: "methods.rs" });
  expect(fileView.status).toBe("ready");
  expect(fileView.frames).toEqual([]);
  expect(fileView.nodes).toEqual([]);

  // … while the method stays selectable on its own, with only its own dependencies.
  const methodView = definitionView(project, {
    kind: "definition",
    path: "methods.rs",
    definitionKey: project.key("methods.rs", "Root.make"),
  });
  expect(methodView.nodes).toEqual(["Leaf@leaf.rs", "Root.make@methods.rs"]);
  expect(methodView.edges).toEqual(["Root.make@methods.rs -references-> Leaf@leaf.rs"]);
});

test("a module declaration reaches the dependencies of its body file", async () => {
  const project = await rootedProject();

  const moduleView = definitionView(project, {
    kind: "definition",
    path: "lib.rs",
    definitionKey: project.key("lib.rs", "child"),
  });

  // `mod child;` has no body in `lib.rs`; its outgoing references come from `child.rs`.
  expect(moduleView.nodes).toEqual(["Leaf@leaf.rs", "child@lib.rs"]);
  expect(moduleView.edges).toEqual(["child@lib.rs -references-> Leaf@leaf.rs"]);

  // Opening the body file itself still roots at its own top-level function.
  const fileView = definitionView(project, { kind: "file", path: "child.rs" });
  expect(fileView.frames).toEqual(["make@child.rs => make@child.rs, Leaf@leaf.rs"]);
  expect(fileView.edges).toEqual(["make@child.rs -references-> Leaf@leaf.rs"]);
});

test("a module box lists its body's declarations and what its `pub use` re-exports", async () => {
  const project = await openProject("ts-explorer-rust-module-members-", {
    "Cargo.toml": `[workspace]
members = ["crates/dep"]

[package]
name = "app"
version = "0.1.0"

[dependencies]
dep-crate = { path = "crates/dep" }
`,
    "crates/dep/Cargo.toml": `[package]
name = "dep-crate"
version = "0.1.0"
`,
    "crates/dep/src/lib.rs": `pub struct Widget;

pub fn build() -> Widget {
    Widget
}
`,
    "src/lib.rs": "pub mod outer;\n",
    // `outer.rs` is not a module root, so `#[path]` resolves against `src/`, not `src/outer/`.
    "src/outer.rs": `#[path = "nested/facade.rs"]
pub mod facade;

pub struct Holder {
    widget: facade::Widget,
}
`,
    "src/nested/facade.rs": `pub use dep_crate::{build, Widget};

pub struct Local;

pub mod inner {
    pub use dep_crate::Widget;
}
`,
  });

  // The out-of-line body's own declarations plus the names it re-exports from the `dep-crate`
  // workspace member; every row addresses the file the declaration actually lives in.
  const facade = drawnBox(project, {
    kind: "definition",
    path: "src/outer.rs",
    definitionKey: project.key("src/outer.rs", "facade"),
  }, "facade@src/outer.rs");
  expect(facade.attributes).toEqual([
    "Widget@crates/dep/src/lib.rs",
    "Local@src/nested/facade.rs",
    "inner@src/nested/facade.rs",
  ]);
  expect(facade.methods).toEqual(["build@crates/dep/src/lib.rs"]);
  // The box names its kind through its font colour, not through a `<<module>>` prefix row.
  expect(facade.dsl).toContain(`cssClass "${facade.nodeId}" kindModule`);
  expect(facade.dsl).not.toContain("<<module>>");

  // A `pub use` inside an inline module is that module's surface, not the surrounding file's.
  const inner = drawnBox(project, {
    kind: "definition",
    path: "src/nested/facade.rs",
    definitionKey: project.key("src/nested/facade.rs", "inner"),
  }, "inner@src/nested/facade.rs");
  expect(inner.attributes).toEqual(["Widget@crates/dep/src/lib.rs"]);
  expect(inner.methods).toEqual([]);

  // `facade::Widget` names a re-export, so the reference lands on the declaring crate.
  const holder = definitionView(project, {
    kind: "definition",
    path: "src/outer.rs",
    definitionKey: project.key("src/outer.rs", "Holder"),
  });
  expect(holder.edges).toEqual([
    "Holder@src/outer.rs -references-> Widget@crates/dep/src/lib.rs",
  ]);

  // The `#[path]` body is linked, and a workspace crate name roots a path at its lib target.
  expect(project.snapshot.imports).toEqual([
    { sourcePath: "src/lib.rs", targetPath: "src/outer.rs" },
    { sourcePath: "src/nested/facade.rs", targetPath: "crates/dep/src/lib.rs" },
    { sourcePath: "src/outer.rs", targetPath: "src/nested/facade.rs" },
  ]);
});

test("every top-level declaration of a Rust file gets its own frame in source order", async () => {
  const project = await rootedProject();

  const view = definitionView(project, { kind: "file", path: "lib.rs" });

  expect(view.frames).toEqual([
    "root@lib.rs => LocalTrait@contracts.rs, Leaf@leaf.rs, root@lib.rs",
    "contracts@lib.rs => contracts@lib.rs",
    "marker_impl@lib.rs => marker_impl@lib.rs",
    "methods@lib.rs => Leaf@leaf.rs, methods@lib.rs",
    "leaf@lib.rs => leaf@lib.rs",
    "child@lib.rs => Leaf@leaf.rs, child@lib.rs",
  ]);
});

test("use aliases, grouped uses, crate/self/super paths and wildcard modules resolve", async () => {
  const project = await openProject("ts-explorer-rust-paths-", {
    "lib.rs": "pub mod shapes;\npub mod consumers;\npub struct Crate;\n",
    "shapes.rs": "pub struct Circle;\npub struct Square;\npub struct Triangle;\n",
    "consumers/mod.rs": `pub mod inner;

pub struct Local;

use self::inner::Consumer;

pub struct Holder {
    held: Consumer,
}
`,
    "consumers/inner/mod.rs": `pub mod deep;

use crate::shapes::{Circle, Square as Boxy};
use super::Local;
use crate::shapes::*;

pub struct Consumer {
    circle: Circle,
    aliased: Boxy,
    parent: Local,
    starred: Triangle,
}
`,
    "consumers/inner/deep.rs": `use super::super::Local;
use crate::Crate;

pub struct Deep {
    local: Local,
    root: Crate,
}
`,
  });

  const consumer = definitionView(project, {
    kind: "definition",
    path: "consumers/inner/mod.rs",
    definitionKey: project.key("consumers/inner/mod.rs", "Consumer"),
  });
  expect(consumer.edges).toEqual([
    "Consumer@consumers/inner/mod.rs -references-> Local@consumers/mod.rs",
    "Consumer@consumers/inner/mod.rs -references-> Circle@shapes.rs",
    "Consumer@consumers/inner/mod.rs -references-> Square@shapes.rs",
    "Consumer@consumers/inner/mod.rs -references-> Triangle@shapes.rs",
  ]);

  // `use self::inner::Consumer;` names the current module's own child module.
  const holder = definitionView(project, {
    kind: "definition",
    path: "consumers/mod.rs",
    definitionKey: project.key("consumers/mod.rs", "Holder"),
  });
  expect(holder.edges).toContain(
    "Holder@consumers/mod.rs -references-> Consumer@consumers/inner/mod.rs",
  );
  // The closure is transitive, so the alias and wildcard targets are reached through `Consumer`.
  expect(holder.nodes).toEqual([
    "Consumer@consumers/inner/mod.rs",
    "Local@consumers/mod.rs",
    "Holder@consumers/mod.rs",
    "Circle@shapes.rs",
    "Square@shapes.rs",
    "Triangle@shapes.rs",
  ]);

  // Repeated `super` climbs two module levels; `crate` addresses the crate root file.
  const deep = definitionView(project, {
    kind: "definition",
    path: "consumers/inner/deep.rs",
    definitionKey: project.key("consumers/inner/deep.rs", "Deep"),
  });
  expect(deep.edges).toEqual([
    "Deep@consumers/inner/deep.rs -references-> Local@consumers/mod.rs",
    "Deep@consumers/inner/deep.rs -references-> Crate@lib.rs",
  ]);
});

test("an unresolvable external crate produces no node and no edge", async () => {
  const project = await openProject("ts-explorer-rust-external-", {
    "src/lib.rs": `use other_crate::Thing;

pub struct Holder {
    thing: Thing,
}
`,
  });

  const view = definitionView(project, {
    kind: "definition",
    path: "src/lib.rs",
    definitionKey: project.key("src/lib.rs", "Holder"),
  });

  expect(view.nodes).toEqual(["Holder@src/lib.rs"]);
  expect(view.edges).toEqual([]);
  expect(view.frames).toEqual(["Holder@src/lib.rs => Holder@src/lib.rs"]);
});

test("discovers Cargo workspace members and their internal dependencies", async () => {
  const root = await fixtureRoot("ts-explorer-cargo-", {
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

test("a mixed TypeScript and Rust project keeps each language's closure separate", async () => {
  const project = await openProject("ts-explorer-mixed-", {
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

  const service = definitionView(project, {
    kind: "definition",
    path: "src/ts/model.ts",
    definitionKey: project.key("src/ts/model.ts", "TsService"),
  });
  expect(service.nodes).toEqual(["TsPayload@src/ts/model.ts", "TsService@src/ts/model.ts"]);
  expect(service.edges).toEqual([
    "TsService@src/ts/model.ts -references-> TsPayload@src/ts/model.ts",
  ]);

  const payload = definitionView(project, {
    kind: "definition",
    path: "src/rs/model.rs",
    definitionKey: project.key("src/rs/model.rs", "RsPayload"),
  });
  expect(payload.nodes).toEqual(["RsPayload@src/rs/model.rs", "RsRender@src/rs/model.rs"]);
  // `RsRender::render` returns `RsPayload`, so the pair is a genuine cycle: both directions are
  // real edges and each is preserved exactly once.
  expect(payload.edges).toEqual([
    "RsPayload@src/rs/model.rs -implements-> RsRender@src/rs/model.rs",
    "RsRender@src/rs/model.rs -references-> RsPayload@src/rs/model.rs",
  ]);
  // A same-named declaration in the other language is never pulled in by name.
  expect(payload.nodes.every((node) => node.endsWith(".rs"))).toBe(true);
  expect(service.nodes.every((node) => node.endsWith(".ts"))).toBe(true);

  // Both languages' per-file graphs survive the normalized tables unchanged, so a later
  // selection read sees exactly what extraction produced.
  expectFileGraphRoundTrips(project);
});

test("outlines Rust declarations with native kinds instead of the UML normalization", () => {
  const source = [
    "pub const LIMIT: i32 = 3;",
    "pub fn greet(name: &str) -> String { let local = name; local.to_owned() }",
    "pub trait Greeter { fn greet(&self) -> String; }",
    "pub struct Boxed { pub value: i32 }",
    "pub union Raw { bits: u32 }",
    "pub struct Pair(pub i32, String);",
    "impl Boxed { pub fn read(&self) -> i32 { self.value } }",
    "pub mod tools { pub const FLAG: bool = true; }",
    "",
  ].join("\n");
  // UML renders `struct`/`union` as `class` and `trait` as `interface`; the outline must not.
  expect(
    parseDefinitionSpans("outline.rs", source)
      .filter((span) => span.kind !== "method")
      .map((span) => `${span.name} ${span.kind}`),
  ).toEqual(["Greeter interface", "Boxed class", "Raw class", "Pair class"]);
  expect(
    parseFileDefinitions("outline.rs", source).map((definition) =>
      `${definition.qualifiedName} ${definition.kind} ${definition.type ?? "—"} ${definition.source.line}:${definition.source.column}`
    ),
  ).toEqual([
    "LIMIT constant i32 1:11",
    "greet function (name: &str) -> String 2:8",
    "Greeter trait Greeter 3:11",
    "Greeter.greet method (&self) -> String 3:24",
    "Boxed struct Boxed 4:12",
    "Boxed.value property i32 4:24",
    "Raw union Raw 5:11",
    "Raw.bits property u32 5:17",
    "Pair struct Pair 6:12",
    "Pair.0 property i32 6:21",
    "Pair.1 property String 6:26",
    "Boxed.read method (&self) -> i32 7:21",
    "tools module — 8:9",
    "tools.FLAG constant bool 8:27",
  ]);
});
