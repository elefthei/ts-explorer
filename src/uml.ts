import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseProject, TsUML2Settings } from "tsuml2";
import { TypeAlias, type FileDeclaration } from "tsuml2/dist/core/model";
import { parseDefinitionSpans } from "./goto-definition.ts";
import { resolveInside } from "./paths.ts";
import { isDeclarationPath, isUmlIgnoredPath } from "./source.ts";
import type { PackageInfo } from "./types.ts";
import { assignUmlCommunities, buildUmlGraph } from "./uml/graph.ts";
import {
  bareUmlName,
  isTestPath,
  posix,
  scopeRelativePath,
  umlEntityKey,
  umlFileKey,
} from "./uml/keys.ts";
import {
  escapeStructuredMemberTypes,
  removeSelfMemberAssociations,
} from "./uml/mermaid.ts";
import type { CategoryMap, UmlDiagramBundle } from "./uml/model.ts";
import { partitionUmlCommunities } from "./uml/partition.ts";
import { renderUmlDsl } from "./uml/render.ts";
import { analyzeUmlTypes } from "./uml/usage.ts";

function isProjectSourcePath(path: string): boolean {
  return !isUmlIgnoredPath(path);
}

async function findTsFiles(scope: string): Promise<string[]> {
  const info = await stat(scope);
  if (info.isFile()) return isDeclarationPath(scope) || !isProjectSourcePath(scope) ? [] : [scope];
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts}");
  for await (const file of glob.scan({ cwd: scope, absolute: true, onlyFiles: true, dot: true })) {
    if (!isDeclarationPath(file) && isProjectSourcePath(file)) files.push(file);
  }
  return files.sort();
}

function packageForScope(
  scopePath: string,
  packages: readonly PackageInfo[],
): PackageInfo | undefined {
  const normalizedScopePath = posix(scopePath);
  return packages
    .filter((pkg) =>
      pkg.path === ""
      || normalizedScopePath === pkg.path
      || normalizedScopePath.startsWith(`${pkg.path}/`)
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
}

async function getTsConfig(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<string | undefined> {
  const selected = packageForScope(scopePath, packages);
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
    const test = isTestPath(declaration.fileName);
    for (const item of declaration.interfaces) result.set(item.name, { category: "interface", test });
    for (const item of declaration.types) result.set(item.name, { category: "type", test });
    for (const item of declaration.enums) result.set(item.name, { category: "enum", test });
    for (const item of declaration.classes) result.set(item.name, { category: "concrete", test });
  }
  return result;
}

function syntheticTypeId(filePath: string, renderedName: string): string {
  const normalized = posix(filePath);
  const extension = normalized.lastIndexOf(".");
  const withoutExtension = extension < 0 ? normalized : normalized.slice(0, extension);
  return `"${withoutExtension}".${renderedName}`;
}

async function addMissingTypeAliases(
  files: readonly string[],
  declarations: FileDeclaration[],
): Promise<void> {
  const byFile = new Map(declarations.map((declaration) => [
    umlFileKey(declaration.fileName),
    declaration,
  ]));
  for (const file of files) {
    const declaration = byFile.get(umlFileKey(file));
    if (!declaration) continue;
    const parsed = parseDefinitionSpans(file, await readFile(file, "utf8"))
      .filter((definition) => definition.kind === "type");
    const order = new Map(parsed.map((definition, index) => [
      `${definition.entityName}\0${definition.entityOccurrence}`,
      index,
    ]));
    const occurrences = new Map<string, number>();
    const existing = new Set<string>();
    for (const type of declaration.types) {
      const name = bareUmlName(type.name);
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      existing.add(`${name}\0${occurrence}`);
    }
    for (const definition of parsed) {
      const key = `${definition.entityName}\0${definition.entityOccurrence}`;
      if (existing.has(key)) continue;
      declaration.types.push(new TypeAlias({
        name: definition.renderedEntityName,
        id: syntheticTypeId(file, definition.renderedEntityName),
        properties: [],
        methods: [],
        heritageClauses: [],
      }));
      existing.add(key);
    }
    const typeOccurrences = new Map<string, number>();
    const orderedTypes = declaration.types.map((type, insertionOrder) => {
      const name = bareUmlName(type.name);
      const occurrence = typeOccurrences.get(name) ?? 0;
      typeOccurrences.set(name, occurrence + 1);
      return {
        type,
        insertionOrder,
        sourceOrder: order.get(`${name}\0${occurrence}`) ?? Number.MAX_SAFE_INTEGER,
      };
    });
    orderedTypes.sort((left, right) =>
      left.sourceOrder - right.sourceOrder || left.insertionOrder - right.insertionOrder
    );
    declaration.types.splice(0, declaration.types.length, ...orderedTypes.map(({ type }) => type));
  }
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
  const normalizedScopePath = posix(scopePath);
  const selectedPackage = packageForScope(normalizedScopePath, packages);
  const packageSourcePath = selectedPackage
    ? selectedPackage.path ? `${selectedPackage.path}/src` : "src"
    : undefined;
  const filterSamePackageTests = packageSourcePath !== undefined
    && (
      normalizedScopePath === packageSourcePath
      || normalizedScopePath.startsWith(`${packageSourcePath}/`)
    );
  const ignoredExternalUserFiles = new Set<string>();
  if (filterSamePackageTests && selectedPackage) {
    for (const file of projectFiles) {
      const relativePath = scopeRelativePath(canonicalSourceDir, file);
      if (
        packageForScope(relativePath, packages)?.path === selectedPackage.path
        && isTestPath(relativePath)
      ) {
        ignoredExternalUserFiles.add(umlFileKey(file));
      }
    }
  }
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
  await addMissingTypeAliases(files, declarations);
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
    ignoredExternalUserFiles,
  );
  const localOwnerEntityIds = new Set<string>();
  for (const local of analysis.localUserNodes) {
    if (local.ownerEntityId) localOwnerEntityIds.add(local.ownerEntityId);
  }
  if (localOwnerEntityIds.size) {
    for (const declaration of declarations) {
      for (let index = declaration.types.length - 1; index >= 0; index -= 1) {
        if (localOwnerEntityIds.has(declaration.types[index]!.id)) declaration.types.splice(index, 1);
      }
    }
  }

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
    definitions: analysis.definitions,
    externalUsers: analysis.externalUserNodes.map((node) => node.navigation),
    localUsers: analysis.localUserNodes.map((node) => node.navigation),
    graph,
  };
}
