import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { PackageInfo } from "./types.ts";

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

export function buildPackageDiagram(packages: readonly PackageInfo[]): string {
  const lines = ["flowchart LR"];
  const ids = new Map(packages.map((pkg, index) => [pkg.name, `p${index}`]));
  if (!packages.length) lines.push('  source["No workspace packages"]');
  for (const [index, pkg] of packages.entries()) lines.push(`  p${index}["${escapeLabel(pkg.name)}"]`);
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      const target = ids.get(dependency);
      if (target) lines.push(`  ${ids.get(pkg.name)} --> ${target}`);
    }
  }
  lines.push("  classDef package fill:#17324d,stroke:#69d2ff,color:#f4f7fb");
  for (const [, id] of ids) lines.push(`  class ${id} package`);
  return lines.join("\n");
}

function escapeLabel(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
