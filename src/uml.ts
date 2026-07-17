import { access, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Project } from "ts-morph";
import { getMermaidDSL, parseProject, TsUML2Settings } from "tsuml2";
import { resolveInside } from "./paths.ts";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import type { PackageInfo } from "./types.ts";
import { isDeclarationPath } from "./types.ts";

const STYLE_DEFS = [
  ["interface", "fill:#183a66,stroke:#69d2ff,color:#f4f7fb"],
  ["abstract", "fill:#4e2a66,stroke:#d39cff,color:#f4f7fb"],
  ["concrete", "fill:#1d4d3b,stroke:#58d68d,color:#f4f7fb"],
  ["type", "fill:#654b1a,stroke:#f4c95d,color:#f4f7fb"],
  ["enum", "fill:#3f4652,stroke:#aab4c3,color:#f4f7fb"],
  ["testInterface", "fill:#183a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testAbstract", "fill:#4e2a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testConcrete", "fill:#1d4d3b,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testType", "fill:#654b1a,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testEnum", "fill:#3f4652,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
] as const;

function posix(path: string): string {
  return path.split(sep).join("/");
}

function escapeMermaidName(name: string): string {
  return name.replace(/[<>]/g, "~").replace("{", "#123;").replace("}", "#125;");
}

function isTestFile(fileName: string): boolean {
  return /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[tj]sx?$/.test(fileName);
}

async function findTsFiles(scope: string): Promise<string[]> {
  const info = await stat(scope);
  if (info.isFile()) return isDeclarationPath(scope) ? [] : [scope];
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts}");
  for await (const file of glob.scan({ cwd: scope, absolute: true, onlyFiles: true, dot: true })) {
    if (!isDeclarationPath(file)) files.push(file);
  }
  return files.sort();
}

async function getTsConfig(sourceDir: string, scopePath: string, packages: readonly PackageInfo[]): Promise<string | undefined> {
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

function fileDeclarations(declarations: FileDeclaration[]): Map<string, { category: string; test: boolean }> {
  const result = new Map<string, { category: string; test: boolean }>();
  for (const declaration of declarations) {
    const test = isTestFile(declaration.fileName);
    for (const item of declaration.interfaces) result.set(item.name, { category: "interface", test });
    for (const item of declaration.types) result.set(item.name, { category: "type", test });
    for (const item of declaration.enums) result.set(item.name, { category: "enum", test });
    for (const item of declaration.classes) result.set(item.name, { category: "concrete", test });
  }
  return result;
}

function markAbstractClasses(sourceFiles: string[], categories: Map<string, { category: string; test: boolean }>): void {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  for (const file of sourceFiles) {
    const sourceFile = project.addSourceFileAtPath(file);
    for (const declaration of sourceFile.getClasses()) {
      if (declaration.isAbstract()) {
        const existing = categories.get(declaration.getName() ?? "");
        if (existing) existing.category = "abstract";
      }
    }
  }
}

export async function buildUmlDiagram(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<string> {
  const selected = await resolveInside(sourceDir, scopePath, true);
  const files = await findTsFiles(selected);
  const settings = new TsUML2Settings();
  settings.glob = files.length ? `{${files.join(",")}}` : "";
  settings.tsconfig = await getTsConfig(sourceDir, scopePath, packages);
  settings.propertyTypes = true;
  settings.modifiers = true;
  settings.typeLinks = true;
  settings.memberAssociations = true;
  settings.exportedTypesOnly = false;
  const declarations = files.length && settings.glob ? parseProject(settings) : [];
  const categories = fileDeclarations(declarations);
  markAbstractClasses(files, categories);
  let dsl = declarations.length ? getMermaidDSL(declarations, settings).trimEnd() : "classDiagram";
  dsl += "\n" + STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n");
  for (const [name, info] of [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const category = info.test ? `test${info.category[0].toUpperCase()}${info.category.slice(1)}` : info.category;
    dsl += `\ncssClass ${escapeMermaidName(name)} ${category}`;
  }
  return dsl + "\n";
}

export function scopeRelativePath(sourceDir: string, path: string): string {
  return posix(relative(sourceDir, path));
}
