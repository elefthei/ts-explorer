import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseProject, TsUML2Settings } from "tsuml2";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import { resolveInside } from "./paths.ts";
import { isDeclarationPath, type PackageInfo } from "./types.ts";
import { assignUmlCommunities, buildUmlGraph } from "./uml/graph.ts";
import { posix } from "./uml/keys.ts";
import {
  escapeStructuredMemberTypes,
  removeSelfMemberAssociations,
} from "./uml/mermaid.ts";
import type { CategoryMap, UmlDiagramBundle } from "./uml/model.ts";
import { partitionUmlCommunities } from "./uml/partition.ts";
import { renderUmlDsl } from "./uml/render.ts";
import { analyzeUmlTypes } from "./uml/usage.ts";

export type { UmlDiagramBundle, UmlGraph } from "./uml/model.ts";

function isTestFile(fileName: string): boolean {
  return /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[tj]sx?$/.test(fileName);
}

function isProjectSourcePath(path: string): boolean {
  return !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(path);
}

async function findTsFiles(scope: string): Promise<string[]> {
  const info = await stat(scope);
  if (info.isFile()) return isDeclarationPath(scope) ? [] : [scope];
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts}");
  for await (const file of glob.scan({ cwd: scope, absolute: true, onlyFiles: true, dot: true })) {
    if (!isDeclarationPath(file) && isProjectSourcePath(file)) files.push(file);
  }
  return files.sort();
}

async function getTsConfig(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<string | undefined> {
  const selected = packages
    .filter((pkg) => pkg.path === "" ? true : scopePath === pkg.path || scopePath.startsWith(`${pkg.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  const candidates = [
    selected ? join(sourceDir, selected.path, "tsconfig.json") : undefined,
    join(sourceDir, "tsconfig.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

function fileDeclarations(declarations: FileDeclaration[]): CategoryMap {
  const result: CategoryMap = new Map();
  for (const declaration of declarations) {
    const test = isTestFile(declaration.fileName);
    for (const item of declaration.interfaces) result.set(item.name, { category: "interface", test });
    for (const item of declaration.types) result.set(item.name, { category: "type", test });
    for (const item of declaration.enums) result.set(item.name, { category: "enum", test });
    for (const item of declaration.classes) result.set(item.name, { category: "concrete", test });
  }
  return result;
}

export async function buildUmlDiagrams(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<UmlDiagramBundle> {
  const canonicalSourceDir = await resolveInside(sourceDir, "", true);
  const selected = scopePath ? await resolveInside(canonicalSourceDir, scopePath, true) : canonicalSourceDir;
  const files = await findTsFiles(selected);
  const projectFiles = selected === canonicalSourceDir ? files : await findTsFiles(canonicalSourceDir);
  const settings = new TsUML2Settings();
  const normalizedFiles = files.map(posix);
  settings.glob = normalizedFiles.length === 1
    ? normalizedFiles[0]
    : normalizedFiles.length ? `{${normalizedFiles.join(",")}}` : "";
  settings.tsconfig = await getTsConfig(sourceDir, scopePath, packages);
  settings.propertyTypes = true;
  settings.modifiers = true;
  settings.typeLinks = true;
  settings.memberAssociations = true;
  settings.exportedTypesOnly = false;
  const declarations = files.length && settings.glob ? parseProject(settings) : [];
  removeSelfMemberAssociations(declarations);
  escapeStructuredMemberTypes(declarations);
  const categories = fileDeclarations(declarations);
  const analysis = analyzeUmlTypes(
    canonicalSourceDir,
    files,
    projectFiles,
    declarations,
    settings.tsconfig,
    categories,
  );

  const dsl = renderUmlDsl(
    declarations,
    settings,
    categories,
    analysis.methodReturnDependencies,
    analysis.usageEdges,
    analysis.localUserNodes,
    analysis.externalUserNodes,
  );
  const graph = buildUmlGraph(
    declarations,
    analysis.methodReturnDependencies,
    analysis.usageEdges,
    analysis.localUserNodes,
    analysis.externalUserNodes,
  );
  assignUmlCommunities(graph);
  const communities = partitionUmlCommunities(declarations, graph);
  return {
    dsl,
    dsls: communities.length
      ? communities.map((communityDeclarations) => renderUmlDsl(
        communityDeclarations,
        settings,
        categories,
        analysis.methodReturnDependencies,
        analysis.usageEdges,
        analysis.localUserNodes,
        analysis.externalUserNodes,
      ))
      : [dsl],
    sources: analysis.sources,
    externalUsers: analysis.externalUserNodes.map((node) => node.navigation),
    localUsers: analysis.localUserNodes.map((node) => node.navigation),
    graph,
  };
}

export async function buildUmlDiagram(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<string> {
  return (await buildUmlDiagrams(sourceDir, scopePath, packages)).dsl;
}
