import { readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type PackageDiagramGraph,
  type RenderedDiagram,
} from "./diagram-graph.ts";
import type { PackageDiagramNode, PackageInfo } from "./types.ts";

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function readManifest(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === "string");
  }
  return [];
}

async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(`${pattern.replace(/\\/g, "/")}/package.json`);
  const matches: string[] = [];
  for await (const match of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    matches.push(toPosix(match).replace(/\/package\.json$/, ""));
  }
  return matches;
}

export async function discoverPackages(sourceDir: string): Promise<readonly PackageInfo[]> {
  const root = await realpath(sourceDir).catch(() => sourceDir);
  const rootManifest = await readManifest(join(root, "package.json"));
  const rootText = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (rootText !== null && !rootManifest) throw new Error("root package.json is malformed");

  let directories: string[] = [];
  const patterns = workspacePatterns(rootManifest?.workspaces);
  if (patterns.length) {
    const expanded = await Promise.all(patterns.map((pattern) => expandPattern(root, pattern)));
    directories = expanded.flat();
  } else {
    const packagesDir = join(root, "packages");
    const entries = await readdir(packagesDir, { withFileTypes: true }).catch(() => []);
    directories = entries.filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`);
  }

  if (!directories.length && rootManifest?.name) directories = [""];
  const candidates = [...new Set(directories)].sort();
  const raw: Array<{ name: string; path: string; manifest: Record<string, unknown> }> = [];
  for (const path of candidates) {
    const manifestPath = join(root, path, "package.json");
    const manifest = await readManifest(manifestPath);
    if (!manifest || typeof manifest.name !== "string" || !manifest.name) continue;
    raw.push({ name: manifest.name, path: toPosix(path), manifest });
  }
  const names = new Set(raw.map((item) => item.name));
  const packages = raw.map(({ name, path, manifest }) => {
    const dependencyNames = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencies = manifest[field];
      if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
        for (const dependency of Object.keys(dependencies)) if (names.has(dependency)) dependencyNames.add(dependency);
      }
    }
    return { name, path, dependencies: [...dependencyNames].sort() };
  });
  return packages.sort((left, right) => left.path.localeCompare(right.path));
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

export function renderPackageDiagramGraph(graph: PackageDiagramGraph): RenderedDiagram {
  if (graph.kind !== "packages") invalidPackageGraph(`unexpected kind ${String(graph.kind)}`);
  if (graph.scopePath !== "") invalidPackageGraph("package scope path must be empty");
  if (graph.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION) {
    invalidPackageGraph(`unsupported format version ${String(graph.formatVersion)}`);
  }
  if (graph.renderMode !== "normal" && graph.renderMode !== "bare") {
    invalidPackageGraph(`unexpected render mode ${String(graph.renderMode)}`);
  }
  if (graph.aliases.length) invalidPackageGraph("package graphs cannot contain aliases");

  const nodeIds = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    if (node.nodeOrdinal !== index) invalidPackageGraph("node ordinals must be contiguous and ordered");
    if (nodeIds.has(node.nodeId)) invalidPackageGraph(`duplicate node ${node.nodeId}`);
    if (node.nodeKind !== "package" && node.nodeKind !== "placeholder") {
      invalidPackageGraph(`unexpected node kind ${node.nodeKind}`);
    }
    if (node.community !== null) invalidPackageGraph(`package node ${node.nodeId} has a community`);
    nodeIds.add(node.nodeId);
  }

  const packageRows = new Map<string, string | null>();
  for (const row of graph.packageNodes) {
    if (packageRows.has(row.nodeId)) invalidPackageGraph(`duplicate package row ${row.nodeId}`);
    if (!nodeIds.has(row.nodeId)) invalidPackageGraph(`package row has missing node ${row.nodeId}`);
    packageRows.set(row.nodeId, row.packagePath);
  }
  if (packageRows.size !== graph.nodes.length) invalidPackageGraph("each node must have one package row");

  if (graph.renderMode === "bare") {
    if (graph.nodes.length || graph.edges.length || graph.relations.length || graph.packageNodes.length) {
      invalidPackageGraph("bare package graph must be empty");
    }
    const dsl = "flowchart LR";
    return {
      dsl,
      dsls: [dsl],
      packageNodes: [],
      definitions: [],
      externalUsers: [],
      localUsers: [],
    };
  }

  if (!graph.nodes.length) invalidPackageGraph("normal package graph must contain a package or placeholder");
  const placeholders = graph.nodes.filter((node) => node.nodeKind === "placeholder");
  if (placeholders.length) {
    const placeholder = placeholders[0];
    if (!placeholder) invalidPackageGraph("normal empty graph must contain only the source placeholder");
    if (
      placeholders.length !== 1
      || graph.nodes.length !== 1
      || placeholder.nodeId !== "source"
      || placeholder.name !== "No workspace packages"
      || packageRows.get(placeholder.nodeId) !== null
      || graph.edges.length
      || graph.relations.length
    ) {
      invalidPackageGraph("normal empty graph must contain only the source placeholder");
    }
  } else {
    for (const node of graph.nodes) {
      if (packageRows.get(node.nodeId) === null) {
        invalidPackageGraph(`package node ${node.nodeId} has no package path`);
      }
    }
  }

  const edges = new Map<number, (typeof graph.edges)[number]>();
  const edgeKeys = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    if (edge.edgeOrdinal !== index) invalidPackageGraph("edge ordinals must be contiguous and ordered");
    if (edge.edgeKind !== "package-dependency" || !edge.directed || edge.weight !== 1) {
      invalidPackageGraph(`invalid package edge ${edge.edgeOrdinal}`);
    }
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      invalidPackageGraph(`edge ${edge.edgeOrdinal} has a missing endpoint`);
    }
    const edgeKey = `${edge.sourceNodeId}\0${edge.targetNodeId}`;
    if (edgeKeys.has(edgeKey)) invalidPackageGraph(`duplicate package edge ${edge.edgeOrdinal}`);
    edgeKeys.add(edgeKey);
    edges.set(edge.edgeOrdinal, edge);
  }

  if (graph.relations.length !== graph.edges.length) {
    invalidPackageGraph("each package edge must have one relation");
  }
  const relatedEdges = new Set<number>();
  for (const relation of graph.relations) {
    const edge = edges.get(relation.edgeOrdinal);
    if (
      !edge
      || relation.relationOrdinal !== 0
      || relation.relationKind !== "package-dependency"
      || relation.sourceNodeId !== edge.sourceNodeId
      || relation.targetNodeId !== edge.targetNodeId
      || relatedEdges.has(relation.edgeOrdinal)
    ) {
      invalidPackageGraph(`invalid relation for edge ${relation.edgeOrdinal}`);
    }
    relatedEdges.add(relation.edgeOrdinal);
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
