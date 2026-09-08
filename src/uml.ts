import { readFile, stat } from "node:fs/promises";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type UmlDiagramGraph,
  type UmlEntityKind,
} from "./diagram-graph.ts";
import { parseDefinitionSpans } from "./goto-definition.ts";
import { analysisLanguageForPath } from "./lang/registry.ts";
import { resolveInside } from "./paths.ts";
import {
  decodeSourceBytes,
  isCargoTargetPath,
  isDeclarationPath,
  isUmlIgnoredPath,
} from "./source.ts";
import type { PackageInfo } from "./types.ts";
import { parseUmlAssociations, removeSelfMemberAssociations } from "./uml/associations.ts";
import { UML_ENTITY_COLLECTIONS } from "./uml/entities.ts";
import { extractUmlTopology } from "./uml/graph.ts";
import {
  isTestPath,
  posix,
  scopeRelativePath,
  syntheticTypeId,
  umlFileKey,
} from "./uml/keys.ts";
import { bareUmlName, escapeStructuredMemberTypes } from "./uml/mermaid.ts";
import type {
  CategoryMap,
  FileDeclaration,
  HeritageClause,
  UmlEntityModel,
  UmlReference,
} from "./uml/model.ts";
import { parseUmlProject, resolveUmlTypeReferences } from "./uml/parse.ts";
import { buildSymbolTable } from "./uml/resolve.ts";
import { analyzeUmlTypes } from "./uml/usage.ts";

const CATEGORY_ENTITY_COLLECTIONS = [
  UML_ENTITY_COLLECTIONS[1],
  UML_ENTITY_COLLECTIONS[3],
  UML_ENTITY_COLLECTIONS[2],
  UML_ENTITY_COLLECTIONS[0],
] as const;

/** Language of a declaration file; every UML declaration comes from an analysable source file. */
function declarationLanguage(fileName: string): UmlDiagramGraph["declarations"][number]["language"] {
  const language = analysisLanguageForPath(fileName);
  if (!language) throw new Error(`UML declaration file has no language: ${fileName}`);
  return language;
}

async function findSourceFiles(scope: string): Promise<string[]> {
  const info = await stat(scope);
  if (info.isFile()) {
    return isDeclarationPath(scope)
        || isUmlIgnoredPath(scope)
        || isCargoTargetPath(scope)
        || analysisLanguageForPath(scope) === undefined
      ? []
      : [scope];
  }
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts,rs}");
  for await (const file of glob.scan({ cwd: scope, absolute: true, onlyFiles: true, dot: true })) {
    if (isDeclarationPath(file) || isUmlIgnoredPath(file) || isCargoTargetPath(file)) continue;
    files.push(file);
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

function fileDeclarations(declarations: FileDeclaration[]): CategoryMap {
  const result: CategoryMap = new Map();
  for (const declaration of declarations) {
    const test = isTestPath(declaration.fileName);
    for (const descriptor of CATEGORY_ENTITY_COLLECTIONS) {
      const category = descriptor.kind === "class" ? "concrete" : descriptor.kind;
      for (const entity of declaration[descriptor.key]) {
        result.set(entity.name, { category, test });
      }
    }
  }
  return result;
}

function addMissingTypeAliases(
  files: readonly string[],
  declarations: FileDeclaration[],
  contents: ReadonlyMap<string, string>,
): void {
  const byFile = new Map(declarations.map((declaration) => [
    umlFileKey(declaration.fileName),
    declaration,
  ]));
  for (const file of files) {
    const declaration = byFile.get(umlFileKey(file));
    if (!declaration) continue;
    const parsed = parseDefinitionSpans(file, contents.get(umlFileKey(file)) ?? "")
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
      declaration.types.push({
        name: definition.renderedEntityName,
        id: syntheticTypeId(file, definition.renderedEntityName),
        properties: [],
        methods: [],
        heritageClauses: [],
        items: [],
      });
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


type UmlModelRows = Pick<
  UmlDiagramGraph,
  | "declarations"
  | "entities"
  | "properties"
  | "propertyTypeIds"
  | "methods"
  | "methodReturnTypeIds"
  | "memberModifiers"
  | "enumItems"
  | "entityHeritageClauses"
  | "declarationHeritageGroups"
  | "declarationHeritageClauses"
  | "memberAssociations"
>;


function emptyUmlModelRows(): UmlModelRows {
  return {
    declarations: [],
    entities: [],
    properties: [],
    propertyTypeIds: [],
    methods: [],
    methodReturnTypeIds: [],
    memberModifiers: [],
    enumItems: [],
    entityHeritageClauses: [],
    declarationHeritageGroups: [],
    declarationHeritageClauses: [],
    memberAssociations: [],
  };
}

function serializeHeritageClause(
  clause: HeritageClause,
): Pick<
  UmlDiagramGraph["entityHeritageClauses"][number],
  "clause" | "clauseTypeId" | "className" | "classTypeId" | "relation"
> {
  if (clause.relation !== "extends" && clause.relation !== "implements") {
    throw new Error(`Invalid UML heritage clause relation: ${String(clause.relation)}`);
  }
  return {
    clause: clause.clause,
    clauseTypeId: clause.clauseTypeId,
    className: clause.className,
    classTypeId: clause.classTypeId,
    relation: clause.relation,
  };
}

function serializeEntity(
  declarationOrdinal: number,
  entityKind: UmlEntityKind,
  entityOrdinal: number,
  entity: UmlEntityModel,
  rows: UmlModelRows,
): void {
  rows.entities.push({
    declarationOrdinal,
    entityKind,
    entityOrdinal,
    nodeId: entity.id,
  });
  if (entityKind === "enum") {
    for (const [itemOrdinal, value] of entity.items.entries()) {
      rows.enumItems.push({
        declarationOrdinal,
        entityKind,
        entityOrdinal,
        itemOrdinal,
        value,
      });
    }
    return;
  }
  for (const [propertyOrdinal, property] of entity.properties.entries()) {
    rows.properties.push({
      declarationOrdinal,
      entityKind,
      entityOrdinal,
      propertyOrdinal,
      name: property.name,
      type: property.type ?? null,
      optional: property.optional,
    });
    for (const [modifierOrdinal, modifier] of property.modifiers.entries()) {
      rows.memberModifiers.push({
        declarationOrdinal,
        entityKind,
        entityOrdinal,
        memberKind: "property",
        memberOrdinal: propertyOrdinal,
        modifierOrdinal,
        modifier,
      });
    }
    for (const [typeIdOrdinal, typeId] of property.typeIds.entries()) {
      rows.propertyTypeIds.push({
        declarationOrdinal,
        entityKind,
        entityOrdinal,
        propertyOrdinal,
        typeIdOrdinal,
        typeId,
      });
    }
  }
  for (const [methodOrdinal, method] of entity.methods.entries()) {
    rows.methods.push({
      declarationOrdinal,
      entityKind,
      entityOrdinal,
      methodOrdinal,
      name: method.name,
      returnType: method.returnType ?? null,
      returnTypeIdsPresent: method.returnTypeIds !== undefined,
    });
    for (const [modifierOrdinal, modifier] of method.modifiers.entries()) {
      rows.memberModifiers.push({
        declarationOrdinal,
        entityKind,
        entityOrdinal,
        memberKind: "method",
        memberOrdinal: methodOrdinal,
        modifierOrdinal,
        modifier,
      });
    }
    for (const [typeIdOrdinal, typeId] of (method.returnTypeIds ?? []).entries()) {
      rows.methodReturnTypeIds.push({
        declarationOrdinal,
        entityKind,
        entityOrdinal,
        methodOrdinal,
        typeIdOrdinal,
        typeId,
      });
    }
  }
  for (const [clauseOrdinal, clause] of entity.heritageClauses.entries()) {
    rows.entityHeritageClauses.push({
      declarationOrdinal,
      entityKind,
      entityOrdinal,
      clauseOrdinal,
      ...serializeHeritageClause(clause),
    });
  }
}

function serializeDeclarations(declarations: readonly FileDeclaration[]): UmlModelRows {
  const rows = emptyUmlModelRows();
  for (const [declarationOrdinal, declaration] of declarations.entries()) {
    rows.declarations.push({
      declarationOrdinal,
      fileName: declaration.fileName,
      language: declarationLanguage(declaration.fileName),
      memberAssociationsPresent: declaration.memberAssociations !== undefined,
    });
    const heritageOwners = new Map<
      readonly HeritageClause[],
      { entityKind: UmlEntityKind; entityOrdinal: number }
    >();
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const [entityOrdinal, entity] of declaration[descriptor.key].entries()) {
        serializeEntity(declarationOrdinal, descriptor.kind, entityOrdinal, entity, rows);
        if (descriptor.kind !== "enum") {
          heritageOwners.set(entity.heritageClauses, {
            entityKind: descriptor.kind,
            entityOrdinal,
          });
        }
      }
    }
    for (const [groupOrdinal, clauses] of declaration.heritageClauses.entries()) {
      const owner = heritageOwners.get(clauses);
      if (!owner) {
        throw new Error(
          `Missing UML declaration heritage owner at declaration ${declarationOrdinal}, group ${groupOrdinal}`,
        );
      }
      rows.declarationHeritageGroups.push({
        declarationOrdinal,
        groupOrdinal,
        ...owner,
      });
      for (const [clauseOrdinal, clause] of clauses.entries()) {
        rows.declarationHeritageClauses.push({
          declarationOrdinal,
          groupOrdinal,
          clauseOrdinal,
          ...serializeHeritageClause(clause),
        });
      }
    }
    for (const [associationOrdinal, association] of (declaration.memberAssociations ?? []).entries()) {
      if (association.associationType !== 0) {
        throw new Error(`Invalid UML association type: ${String(association.associationType)}`);
      }
      rows.memberAssociations.push({
        declarationOrdinal,
        associationOrdinal,
        aTypeId: association.a.typeId,
        aName: association.a.name,
        aMultiplicity: association.a.multiplicity ?? null,
        bTypeId: association.b.typeId,
        bName: association.b.name,
        bMultiplicity: association.b.multiplicity ?? null,
        associationType: association.associationType,
        inherited: association.inherited,
      });
    }
  }
  return rows;
}

function serializeUserTargets(
  users: readonly { targets: readonly UmlReference[] }[],
): UmlDiagramGraph["localUserTargets"] {
  return users.flatMap((user, userOrdinal) =>
    user.targets.map((target, targetOrdinal) => ({
      userOrdinal,
      targetOrdinal,
      targetId: target.id,
      targetName: target.name,
    }))
  );
}

export function bareUmlDiagramGraph(scopePath: string): UmlDiagramGraph {
  return {
    kind: "uml",
    scopePath: posix(scopePath),
    formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
    renderMode: "bare",
    nodes: [],
    aliases: [],
    edges: [],
    relations: [],
    ...emptyUmlModelRows(),
    categories: [],
    methodReturnDependencies: [],
    usageEdges: [],
    localUsers: [],
    externalUsers: [],
    localUserTargets: [],
    externalUserTargets: [],
    definitions: [],
  };
}

async function readUmlSources(files: readonly string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) {
    const decoded = decodeSourceBytes(await readFile(file));
    if ("failure" in decoded) throw new Error(`${decoded.failure}: ${file}`);
    contents.set(umlFileKey(file), decoded.text);
  }
  return contents;
}

export async function extractUmlDiagramGraph(
  sourceDir: string,
  scopePath: string,
  packages: readonly PackageInfo[],
): Promise<UmlDiagramGraph> {
  const canonicalSourceDir = await resolveInside(sourceDir, "", true);
  const selected = scopePath ? await resolveInside(canonicalSourceDir, scopePath, true) : canonicalSourceDir;
  const files = await findSourceFiles(selected);
  const projectFiles = selected === canonicalSourceDir ? files : await findSourceFiles(canonicalSourceDir);
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

  const contents = await readUmlSources(projectFiles);
  const project = parseUmlProject(files, contents);
  let declarations: FileDeclaration[];
  try {
    resolveUmlTypeReferences(project, buildSymbolTable(project.units, project.entities));
    parseUmlAssociations(project.declarations);
    declarations = project.declarations;
  } finally {
    project.dispose();
  }
  addMissingTypeAliases(files, declarations, contents);
  removeSelfMemberAssociations(declarations);
  escapeStructuredMemberTypes(declarations);
  const categories = fileDeclarations(declarations);
  const analysis = analyzeUmlTypes({
    sourceDir: canonicalSourceDir,
    sourceFiles: files,
    projectFiles,
    contents,
    declarations,
    categories,
    ignoredExternalUserFiles,
  });
  const localOwnerEntityIds = new Set<string>();
  for (const local of analysis.localUserNodes) {
    if (local.ownerEntityId) localOwnerEntityIds.add(local.ownerEntityId);
  }
  if (localOwnerEntityIds.size) {
    for (const declaration of declarations) {
      for (let index = declaration.types.length - 1; index >= 0; index -= 1) {
        const type = declaration.types[index];
        if (type === undefined) {
          throw new Error(`Missing UML declaration type at index ${index}`);
        }
        if (localOwnerEntityIds.has(type.id)) declaration.types.splice(index, 1);
      }
    }
  }

  const topology = extractUmlTopology(
    declarations,
    analysis.methodReturnDependencies,
    analysis.usageEdges,
    analysis.localUserNodes,
    analysis.externalUserNodes,
  );
  const modelRows = serializeDeclarations(declarations);
  return {
    kind: "uml",
    scopePath: normalizedScopePath,
    formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
    renderMode: "normal",
    ...topology,
    ...modelRows,
    categories: [...categories.entries()].map(([entityName, info], categoryOrdinal) => ({
      categoryOrdinal,
      entityName,
      category: info.category,
      isTest: info.test,
    })),
    methodReturnDependencies: analysis.methodReturnDependencies.map((dependency, dependencyOrdinal) => ({
      dependencyOrdinal,
      ...dependency,
    })),
    usageEdges: analysis.usageEdges.map((dependency, dependencyOrdinal) => ({
      dependencyOrdinal,
      ...dependency,
    })),
    localUsers: analysis.localUserNodes.map((user, userOrdinal) => ({
      userOrdinal,
      nodeId: `local-user:${user.navigation.nodeId}`,
      navigationNodeId: user.navigation.nodeId,
      label: user.navigation.label,
      path: user.navigation.path,
      line: user.navigation.line,
      column: user.navigation.column,
      userKind: user.navigation.kind,
      ownerEntityId: user.ownerEntityId ?? null,
    })),
    externalUsers: analysis.externalUserNodes.map((user, userOrdinal) => ({
      userOrdinal,
      nodeId: `external-user:${user.navigation.nodeId}`,
      navigationNodeId: user.navigation.nodeId,
      label: user.navigation.label,
      scopePath: user.navigation.scopePath,
      userKind: user.navigation.kind,
    })),
    localUserTargets: serializeUserTargets(analysis.localUserNodes),
    externalUserTargets: serializeUserTargets(analysis.externalUserNodes),
    definitions: analysis.definitions.map((definition, definitionOrdinal) => ({
      definitionOrdinal,
      definitionKey: definition.key,
      definitionKind: definition.kind,
      name: definition.name,
      qualifiedName: definition.qualifiedName,
      sourcePath: definition.source.path,
      sourceLine: definition.source.line,
      sourceColumn: definition.source.column,
      umlScopePath: definition.uml.scopePath,
      umlEntityName: definition.uml.entityName,
      umlMemberName: definition.uml.memberName ?? null,
      umlMemberOccurrence: definition.uml.memberOccurrence ?? null,
    })),
  };
}
