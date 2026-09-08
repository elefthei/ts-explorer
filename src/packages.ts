import { readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type PackageDiagramGraph,
  type RenderedPackageDiagram,
} from "./diagram-graph.ts";
import { normalizeRelativePath } from "./paths.ts";
import type { PackageDiagramNode, PackageInfo } from "./types.ts";

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

type Manifest = Record<string, unknown>;

function table(value: unknown): Manifest | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Manifest : undefined;
}

async function readManifest(
  path: string,
  parse: (text: string) => unknown,
): Promise<Manifest | undefined> {
  try {
    return table(parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function workspacePatterns(value: unknown): string[] {
  return Array.isArray(value) ? stringList(value) : stringList(table(value)?.packages);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Directories under `root` holding `manifest`; the anchored suffix keeps a root match as `""`. */
async function expandPattern(root: string, pattern: string, manifest: string): Promise<string[]> {
  const glob = new Bun.Glob(`${pattern.replace(/\\/g, "/")}/${manifest}`);
  const suffix = `/${manifest}`;
  const matches: string[] = [];
  for await (const match of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    const path = toPosix(match);
    matches.push(path.endsWith(suffix) ? path.slice(0, -suffix.length) : path);
  }
  return matches;
}

/** Keeps only dependencies that resolve to another discovered package, sorted by name. */
function resolvePackages(
  raw: readonly { name: string; path: string; manifest: Manifest }[],
  fields: readonly string[],
  dependencyName: (key: string, value: unknown) => string,
): PackageInfo[] {
  const names = new Set(raw.map((item) => item.name));
  return raw.map(({ name, path, manifest }) => {
    const dependencies = new Set<string>();
    for (const field of fields) {
      for (const [key, value] of Object.entries(table(manifest[field]) ?? {})) {
        const dependency = dependencyName(key, value);
        if (names.has(dependency)) dependencies.add(dependency);
      }
    }
    return { name, path, dependencies: [...dependencies].sort() };
  });
}

/** Cargo crates normalize to the same `PackageInfo`; a missing manifest is not an error. */
async function discoverCargoPackages(root: string): Promise<PackageInfo[]> {
  const rootManifest = await readManifest(join(root, "Cargo.toml"), Bun.TOML.parse);
  if (!rootManifest) return [];

  const workspace = table(rootManifest.workspace);
  const members = stringList(workspace?.members);
  const expanded = await Promise.all(
    members.map((pattern) => expandPattern(root, pattern, "Cargo.toml")),
  );
  const excluded = new Set(stringList(workspace?.exclude).map((path) => toPosix(path)));
  const directories = expanded.flat().filter((path) => !excluded.has(path));
  if (table(rootManifest.package)?.name) directories.push("");

  const candidates = [...new Set(directories)].sort();
  const raw: Array<{ name: string; path: string; manifest: Manifest }> = [];
  for (const path of candidates) {
    const manifest = path === ""
      ? rootManifest
      : await readManifest(join(root, path, "Cargo.toml"), Bun.TOML.parse);
    const name = manifest && table(manifest.package)?.name;
    if (!manifest || typeof name !== "string" || !name) continue;
    raw.push({ name, path: toPosix(path), manifest });
  }
  // `alias = { package = "real-name" }` renames a dependency; the real name is the identity.
  return resolvePackages(raw, ["dependencies", "dev-dependencies", "build-dependencies"], (key, value) => {
    const renamed = table(value)?.package;
    return typeof renamed === "string" ? renamed : key;
  });
}

async function discoverNpmPackages(root: string): Promise<PackageInfo[]> {
  const rootManifest = await readManifest(join(root, "package.json"), JSON.parse);
  const rootText = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (rootText !== null && !rootManifest) throw new Error("root package.json is malformed");

  let directories: string[] = [];
  const patterns = workspacePatterns(rootManifest?.workspaces);
  if (patterns.length) {
    const expanded = await Promise.all(
      patterns.map((pattern) => expandPattern(root, pattern, "package.json")),
    );
    directories = expanded.flat();
  } else {
    const packagesDir = join(root, "packages");
    const entries = await readdir(packagesDir, { withFileTypes: true }).catch(() => []);
    directories = entries.filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`);
  }

  if (!directories.length && rootManifest?.name) directories = [""];
  const candidates = [...new Set(directories)].sort();
  const raw: Array<{ name: string; path: string; manifest: Manifest }> = [];
  for (const path of candidates) {
    const manifest = await readManifest(join(root, path, "package.json"), JSON.parse);
    if (!manifest || typeof manifest.name !== "string" || !manifest.name) continue;
    raw.push({ name: manifest.name, path: toPosix(path), manifest });
  }
  return resolvePackages(
    raw,
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"],
    (key) => key,
  );
}

export async function discoverPackages(sourceDir: string): Promise<readonly PackageInfo[]> {
  const root = await realpath(sourceDir).catch(() => sourceDir);
  const [npm, cargo] = await Promise.all([
    discoverNpmPackages(root),
    discoverCargoPackages(root),
  ]);
  // Keyed by path with npm winning: a hybrid napi-rs directory carries both manifests and its
  // consumer-facing identity is the npm name, which keeps every existing npm result unchanged.
  const byPath = new Map<string, PackageInfo>();
  for (const pkg of cargo) byPath.set(pkg.path, pkg);
  for (const pkg of npm) byPath.set(pkg.path, pkg);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function extractPackageDiagramGraph(
  packages: readonly PackageInfo[],
  renderMode: "normal" | "bare" = "normal",
): PackageDiagramGraph {
  const graph: PackageDiagramGraph = {
    kind: "packages",
    scopePath: "",
    formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
    renderMode,
    nodes: [],
    aliases: [],
    edges: [],
    relations: [],
    packageNodes: [],
  };
  if (renderMode === "bare") return graph;

  if (!packages.length) {
    graph.nodes.push({
      nodeId: "source",
      nodeOrdinal: 0,
      nodeKind: "placeholder",
      name: "No workspace packages",
      community: null,
    });
    graph.packageNodes.push({ nodeId: "source", packagePath: null });
    return graph;
  }

  const ids = new Map<string, string>();
  for (const [nodeOrdinal, pkg] of packages.entries()) {
    const nodeId = `p${nodeOrdinal}`;
    ids.set(pkg.name, nodeId);
    graph.nodes.push({
      nodeId,
      nodeOrdinal,
      nodeKind: "package",
      name: pkg.name,
      community: null,
    });
    graph.packageNodes.push({ nodeId, packagePath: pkg.path });
  }

  for (const pkg of packages) {
    const sourceNodeId = ids.get(pkg.name);
    if (!sourceNodeId) continue;
    for (const dependency of pkg.dependencies) {
      const targetNodeId = ids.get(dependency);
      if (!targetNodeId) continue;
      const edgeOrdinal = graph.edges.length;
      graph.edges.push({
        edgeOrdinal,
        sourceNodeId,
        targetNodeId,
        edgeKind: "package-dependency",
        directed: true,
        weight: 1,
      });
      graph.relations.push({
        edgeOrdinal,
        relationOrdinal: 0,
        relationKind: "package-dependency",
        sourceNodeId,
        targetNodeId,
      });
    }
  }
  return graph;
}

function invalidPackageGraph(detail: string): never {
  throw new Error(`Invalid package diagram graph: ${detail}`);
}

export function validatePackageDiagramGraph(
  graph: PackageDiagramGraph,
): ReadonlyMap<string, string | null> {
  if (graph.kind !== "packages") invalidPackageGraph(`unexpected kind ${String(graph.kind)}`);
  if (graph.scopePath !== "") invalidPackageGraph("package scope path must be empty");
  if (graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION) {
    invalidPackageGraph(`unsupported format version ${String(graph.formatVersion)}`);
  }
  if (graph.renderMode !== "normal" && graph.renderMode !== "bare") {
    invalidPackageGraph(`unexpected render mode ${String(graph.renderMode)}`);
  }
  if (graph.aliases.length) invalidPackageGraph("package graphs cannot contain aliases");

  const nodes = new Map<string, PackageDiagramGraph["nodes"][number]>();
  for (const [index, node] of graph.nodes.entries()) {
    if (node.nodeOrdinal !== index) invalidPackageGraph("node ordinals must be contiguous and ordered");
    if (typeof node.nodeId !== "string" || !node.nodeId) invalidPackageGraph("package node ID must be nonempty");
    if (nodes.has(node.nodeId)) invalidPackageGraph(`duplicate node ${node.nodeId}`);
    if (typeof node.name !== "string" || !node.name) invalidPackageGraph(`package node ${node.nodeId} has an empty name`);
    if (node.nodeKind !== "package" && node.nodeKind !== "placeholder") {
      invalidPackageGraph(`unexpected node kind ${String(node.nodeKind)}`);
    }
    if (node.community !== null) invalidPackageGraph(`package node ${node.nodeId} has a community`);
    nodes.set(node.nodeId, node);
  }

  const packageRows = new Map<string, string | null>();
  for (const row of graph.packageNodes) {
    if (typeof row.nodeId !== "string" || !row.nodeId || !nodes.has(row.nodeId)) {
      invalidPackageGraph(`package row has missing node ${String(row.nodeId)}`);
    }
    if (packageRows.has(row.nodeId)) invalidPackageGraph(`duplicate package row ${row.nodeId}`);
    if (row.packagePath !== null) {
      let normalizedPath: string;
      try {
        normalizedPath = normalizeRelativePath(row.packagePath);
      } catch {
        invalidPackageGraph(`package path is not normalized: ${String(row.packagePath)}`);
      }
      if (normalizedPath !== row.packagePath) {
        invalidPackageGraph(`package path is not normalized: ${row.packagePath}`);
      }
    }
    packageRows.set(row.nodeId, row.packagePath);
  }
  if (packageRows.size !== nodes.size) invalidPackageGraph("each node must have one package row");

  if (graph.renderMode === "bare") {
    if (nodes.size || graph.edges.length || graph.relations.length || packageRows.size) {
      invalidPackageGraph("bare package graph must be empty");
    }
    return packageRows;
  }

  if (!nodes.size) invalidPackageGraph("normal package graph must contain a package or placeholder");
  const placeholders = [...nodes.values()].filter((node) => node.nodeKind === "placeholder");
  if (placeholders.length) {
    const placeholder = placeholders[0];
    if (
      placeholders.length !== 1
      || nodes.size !== 1
      || placeholder?.nodeId !== "source"
      || placeholder.name !== "No workspace packages"
      || packageRows.get("source") !== null
      || graph.edges.length
      || graph.relations.length
    ) {
      invalidPackageGraph("normal empty graph must contain only the source placeholder");
    }
  } else {
    for (const [nodeId, packagePath] of packageRows) {
      if (nodes.get(nodeId)?.nodeKind !== "package" || packagePath === null) {
        invalidPackageGraph(`package node ${nodeId} has no package path`);
      }
    }
  }

  const edges = new Map<number, PackageDiagramGraph["edges"][number]>();
  const edgeKeys = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    if (edge.edgeOrdinal !== index) invalidPackageGraph("edge ordinals must be contiguous and ordered");
    if (edge.edgeKind !== "package-dependency" || !edge.directed || edge.weight !== 1) {
      invalidPackageGraph(`invalid package edge ${edge.edgeOrdinal}`);
    }
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
      invalidPackageGraph(`edge ${edge.edgeOrdinal} has a missing endpoint`);
    }
    const edgeKey = JSON.stringify([edge.sourceNodeId, edge.targetNodeId]);
    if (edgeKeys.has(edgeKey)) invalidPackageGraph(`duplicate package edge ${edge.edgeOrdinal}`);
    edgeKeys.add(edgeKey);
    edges.set(edge.edgeOrdinal, edge);
  }

  if (graph.relations.length !== graph.edges.length) {
    invalidPackageGraph("each package edge must have one relation");
  }
  for (const [index, relation] of graph.relations.entries()) {
    const edge = edges.get(relation.edgeOrdinal);
    if (
      relation.edgeOrdinal !== index
      || !edge
      || relation.relationOrdinal !== 0
      || relation.relationKind !== "package-dependency"
      || relation.sourceNodeId !== edge.sourceNodeId
      || relation.targetNodeId !== edge.targetNodeId
    ) {
      invalidPackageGraph(`invalid relation for edge ${relation.edgeOrdinal}`);
    }
  }
  return packageRows;
}

export function renderPackageDiagramGraph(graph: PackageDiagramGraph): RenderedPackageDiagram {
  const packageRows = validatePackageDiagramGraph(graph);
  if (graph.renderMode === "bare") {
    const dsl = "flowchart LR";
    return {
      kind: "packages",
      dsl,
      dsls: [dsl],
      packageNodes: [],
      definitions: [],
      externalUsers: [],
      localUsers: [],
    };
  }

  const lines = ["flowchart LR"];
  const packageNodes: PackageDiagramNode[] = [];
  for (const node of graph.nodes) {
    lines.push(`  ${node.nodeId}["${escapeLabel(node.name)}"]`);
    if (node.nodeKind === "package") {
      const packagePath = packageRows.get(node.nodeId);
      if (packagePath === undefined || packagePath === null) {
        invalidPackageGraph(`package node ${node.nodeId} has no package path`);
      }
      packageNodes.push({
        nodeId: node.nodeId,
        name: node.name,
        path: packagePath,
      });
    }
  }
  for (const edge of graph.edges) lines.push(`  ${edge.sourceNodeId} --> ${edge.targetNodeId}`);
  lines.push("  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb");
  for (const node of graph.nodes) {
    if (node.nodeKind === "package") lines.push(`  class ${node.nodeId} package`);
  }

  const dsl = lines.join("\n");
  return {
    kind: "packages",
    dsl,
    dsls: [dsl],
    packageNodes,
    definitions: [],
    externalUsers: [],
    localUsers: [],
  };
}


function escapeLabel(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
