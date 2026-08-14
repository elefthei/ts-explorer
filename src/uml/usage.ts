import type { Node } from "@vscode/tree-sitter-wasm";
import { firstAncestor, namedChildren } from "../lang/ast.ts";
import {
  annotationType,
  declarationName,
  ENTITY_KIND_BY_NODE,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  topLevelDeclarations,
} from "../lang/typescript.ts";
import { analysisLanguageForPath } from "../lang/registry.ts";
import { rustTopLevelItems } from "../lang/rust.ts";
import { isDeclarationPath } from "../source.ts";
import type {
  GotoDefinition,
  UmlExternalUserKind,
  UmlSourceLocation,
} from "../types.ts";
import { collectRenderedModel } from "./definitions.ts";
import {
  bareUmlName,
  scopeRelativePath,
  umlEntityKey,
  umlFileKey,
} from "./keys.ts";
import { formatSignatureType } from "./mermaid.ts";
import type {
  CategoryMap,
  ExternalUserNode,
  FileDeclaration,
  LocalUserNode,
  UmlDependency,
  UmlReference,
} from "./model.ts";
import { parseSourceUnits } from "./parse.ts";
import { classifyRustReferenceOwner, rustMethodReturnAnnotations } from "./rust-usage.ts";
import { buildSymbolTable, type EntityReference, type SymbolTable } from "./resolve.ts";

type ReferenceOwner = {
  scopePath: string;
  signature: string;
  kind: UmlExternalUserKind;
  source: UmlSourceLocation;
  ownerEntityKey?: string;
};

const ENTITY_DECLARATION_TYPES = new Set([...Object.keys(ENTITY_KIND_BY_NODE), "class"]);

const OWNING_TYPE_TYPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
  "interface_declaration",
  "type_alias_declaration",
]);

const PROPERTY_TYPES = new Set(["public_field_definition", "property_signature"]);

const PARAMETER_TYPES = new Set(["required_parameter", "optional_parameter"]);

const WRAPPER_EXPRESSIONS = new Set([
  "as_expression",
  "satisfies_expression",
  "parenthesized_expression",
  "type_assertion",
  "non_null_expression",
]);

const CALLABLE_TYPES = new Set(["arrow_function", "function_expression"]);

function unwrapExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && WRAPPER_EXPRESSIONS.has(current.type)) {
    current = current.type === "type_assertion"
      ? current.namedChild(1) ?? undefined
      : current.namedChild(0) ?? undefined;
  }
  return current;
}

function parameterNodes(callable: Node): Node[] {
  const parameters = callable.childForFieldName("parameters");
  if (!parameters) return [];
  return namedChildren(parameters).filter((parameter) => PARAMETER_TYPES.has(parameter.type));
}

/**
 * `fallback` supplies positional parameter types for an unannotated arrow bound to a variable that
 * carries a `function_type` annotation of its own.
 */
function parameterTypes(callable: Node, fallback?: Node): string {
  const fallbackParameters = fallback ? parameterNodes(fallback) : [];
  return parameterNodes(callable)
    .map((parameter, index) => {
      const annotation = annotationType(parameter, "type")
        ?? (fallbackParameters[index] && annotationType(fallbackParameters[index], "type"));
      return formatSignatureType(annotation?.text);
    })
    .join(", ");
}

function owningTypeName(node: Node): string | undefined {
  const owner = firstAncestor(node, (candidate) => OWNING_TYPE_TYPES.has(candidate.type));
  return owner ? declarationName(owner) : undefined;
}

function enclosingEntityDeclaration(node: Node): Node | undefined {
  return firstAncestor(node, (candidate) => ENTITY_DECLARATION_TYPES.has(candidate.type));
}

function referenceSource(sourceDir: string, file: string, node: Node): UmlSourceLocation {
  return {
    path: scopeRelativePath(sourceDir, file),
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
}

function isExportDeclarationStatement(node: Node): boolean {
  if (node.type !== "export_statement") return false;
  if (node.childForFieldName("source")) return true;
  return namedChildren(node).some((child) => child.type === "export_clause");
}

function classifyReferenceOwner(
  reference: Node,
  file: string,
  sourceDir: string,
  entityKeyOf: (declaration: Node, file: string) => string | undefined,
): ReferenceOwner | undefined {
  if (isDeclarationPath(file)) return undefined;

  const exportSpecifier = firstAncestor(
    reference,
    (candidate) => candidate.type === "export_specifier",
  );
  if (exportSpecifier) {
    const nameNode = exportSpecifier.childForFieldName("name");
    const exportedName = exportSpecifier.childForFieldName("alias")?.text ?? nameNode?.text;
    if (!nameNode || exportedName === undefined) return undefined;
    return {
      scopePath: scopeRelativePath(sourceDir, file),
      signature: exportedName,
      kind: "export",
      source: referenceSource(sourceDir, file, nameNode),
    };
  }
  if (
    firstAncestor(reference, (candidate) =>
      candidate.type === "import_statement"
      || candidate.type === "import_alias"
      || isExportDeclarationStatement(candidate))
  ) {
    return undefined;
  }

  const scopePath = scopeRelativePath(sourceDir, file);
  const ownerDeclaration = enclosingEntityDeclaration(reference);
  const ownerEntityKey = ownerDeclaration ? entityKeyOf(ownerDeclaration, file) : undefined;
  const result = (
    signature: string,
    kind: UmlExternalUserKind,
    sourceNode: Node,
  ): ReferenceOwner => ({
    scopePath,
    signature,
    kind,
    source: referenceSource(sourceDir, file, sourceNode),
    ...(ownerEntityKey ? { ownerEntityKey } : {}),
  });

  const propertyAssignment = firstAncestor(reference, (candidate) => candidate.type === "pair");
  const callable = firstAncestor(reference, (candidate) => CALLABLE_TYPES.has(candidate.type));
  if (
    propertyAssignment
    && callable
    && unwrapExpression(propertyAssignment.childForFieldName("value") ?? undefined)?.id === callable.id
  ) {
    const objectLiteral = firstAncestor(
      propertyAssignment,
      (candidate) => candidate.type === "object",
    );
    const variable = firstAncestor(
      propertyAssignment,
      (candidate) => candidate.type === "variable_declarator",
    );
    const variableName = variable?.childForFieldName("name");
    const keyNode = propertyAssignment.childForFieldName("key");
    if (
      objectLiteral
      && variable
      && keyNode
      && variableName?.type === "identifier"
      && unwrapExpression(variable.childForFieldName("value") ?? undefined)?.id === objectLiteral.id
    ) {
      return result(
        `${variableName.text}.${memberName(propertyAssignment)?.name ?? keyNode.text}(${
          parameterTypes(callable)
        })`,
        "method",
        keyNode,
      );
    }
  }

  const method = firstAncestor(
    reference,
    (candidate) => METHOD_NODE_TYPES.has(candidate.type) && memberName(candidate)?.name !== "constructor",
  );
  if (method) {
    const owner = owningTypeName(method);
    const nameNode = method.childForFieldName("name");
    if (owner && nameNode) {
      return result(
        `${owner}.${memberName(method)?.name ?? nameNode.text}(${parameterTypes(method)})`,
        "method",
        nameNode,
      );
    }
  }

  const constructorDeclaration = firstAncestor(
    reference,
    (candidate) => candidate.type === "method_definition" && memberName(candidate)?.name === "constructor",
  );
  if (constructorDeclaration) {
    const owner = owningTypeName(constructorDeclaration);
    if (owner) {
      return result(
        `${owner}.constructor(${parameterTypes(constructorDeclaration)})`,
        "constructor",
        constructorDeclaration,
      );
    }
  }

  const property = firstAncestor(reference, (candidate) => PROPERTY_TYPES.has(candidate.type));
  if (property) {
    const owner = owningTypeName(property);
    const nameNode = property.childForFieldName("name");
    if (owner && nameNode) {
      return result(
        `${owner}.${memberName(property)?.name ?? nameNode.text}: ${
          formatSignatureType(annotationType(property, "type")?.text)
        }`,
        "property",
        nameNode,
      );
    }
  }

  if (
    ownerDeclaration
    && ownerDeclaration.type !== "type_alias_declaration"
  ) {
    const name = declarationName(ownerDeclaration);
    const nameNode = ownerDeclaration.childForFieldName("name");
    return name ? result(name, "class", nameNode ?? ownerDeclaration) : undefined;
  }

  const fn = firstAncestor(reference, (candidate) => candidate.type === "function_declaration");
  if (fn) {
    const nameNode = fn.childForFieldName("name");
    return nameNode
      ? result(`${nameNode.text}(${parameterTypes(fn)})`, "function", nameNode)
      : undefined;
  }

  const variable = firstAncestor(
    reference,
    (candidate) => candidate.type === "variable_declarator",
  );
  if (variable) {
    const nameNode = variable.childForFieldName("name");
    const declaration = variable.parent;
    const statement = declaration?.parent?.type === "export_statement"
      ? declaration.parent
      : declaration;
    const initializer = unwrapExpression(variable.childForFieldName("value") ?? undefined);
    const annotation = annotationType(variable, "type");
    if (
      nameNode?.type === "identifier"
      && statement?.parent?.type === "program"
      && initializer
      && CALLABLE_TYPES.has(initializer.type)
    ) {
      return result(
        `${nameNode.text}(${
          parameterTypes(initializer, annotation?.type === "function_type" ? annotation : undefined)
        })`,
        "function",
        nameNode,
      );
    }
    if (nameNode) {
      return result(
        `${nameNode.text}: ${formatSignatureType(annotation?.text)}`,
        "variable",
        nameNode,
      );
    }
  }

  const alias = firstAncestor(
    reference,
    (candidate) => candidate.type === "type_alias_declaration",
  );
  if (alias) {
    const nameNode = alias.childForFieldName("name");
    const name = declarationName(alias);
    if (name && nameNode) return result(name, "type", nameNode);
  }
  return undefined;
}

/** The Rust classifier's result in the shape `collectUsageGraph` consumes. */
function rustReferenceOwner(
  reference: Node,
  file: string,
  sourceDir: string,
): ReferenceOwner | undefined {
  const owner = classifyRustReferenceOwner(reference);
  if (!owner) return undefined;
  return {
    scopePath: scopeRelativePath(sourceDir, file),
    signature: owner.signature,
    kind: owner.kind,
    source: referenceSource(sourceDir, file, owner.source),
    ...(owner.ownerName === undefined
      ? {}
      : { ownerEntityKey: umlEntityKey(file, bareUmlName(owner.ownerName)) }),
  };
}

function collectUsageGraph(
  sourceDir: string,
  inScopeFiles: ReadonlySet<string>,
  references: readonly EntityReference[],
  entities: ReadonlyMap<string, UmlReference>,
  fileDeclarations: readonly FileDeclaration[],
  methodReturnDependencies: readonly UmlDependency[],
  ignoredExternalUserFiles: ReadonlySet<string>,
  entityKeyOf: (declaration: Node, file: string) => string | undefined,
): {
  usageEdges: UmlDependency[];
  localUserNodes: LocalUserNode[];
  externalUserNodes: ExternalUserNode[];
} {
  const directedKeys = new Set<string>();
  for (const declaration of fileDeclarations) {
    for (const clauses of declaration.heritageClauses) {
      for (const clause of clauses) directedKeys.add(`${clause.classTypeId}\0${clause.clauseTypeId}`);
    }
  }
  for (const dependency of methodReturnDependencies) {
    directedKeys.add(`${dependency.sourceId}\0${dependency.targetId}`);
  }

  const usageEdges: UmlDependency[] = [];
  const localGroups = new Map<string, ReferenceOwner & {
    ownerEntityId?: string;
    targets: Map<string, UmlReference>;
  }>();
  const externalGroups = new Map<string, {
    scopePath: string;
    signature: string;
    kind: UmlExternalUserKind;
    targets: Map<string, UmlReference>;
  }>();

  for (const reference of references) {
    const user = analysisLanguageForPath(reference.file) === "rust"
      ? rustReferenceOwner(reference.node, reference.file, sourceDir)
      : classifyReferenceOwner(reference.node, reference.file, sourceDir, entityKeyOf);
    if (!user) continue;
    const ownerDeclaration = enclosingEntityDeclaration(reference.node);
    const userEntity = user.ownerEntityKey ? entities.get(user.ownerEntityKey) : undefined;
    const isLocalTypeAlias = ownerDeclaration?.type === "type_alias_declaration"
      && !ownerDeclaration.childForFieldName("type_parameters");
    if (userEntity?.id === reference.target.id) continue;

    const referenceFileKey = umlFileKey(reference.file);
    if (inScopeFiles.has(referenceFileKey)) {
      if (userEntity && !isLocalTypeAlias) {
        const key = `${userEntity.id}\0${reference.target.id}`;
        if (directedKeys.has(key)) continue;
        directedKeys.add(key);
        usageEdges.push({
          sourceId: userEntity.id,
          sourceName: userEntity.name,
          targetId: reference.target.id,
          targetName: reference.target.name,
        });
        continue;
      }
      const key = `${user.scopePath}\0${user.signature}\0${user.kind}`;
      let group = localGroups.get(key);
      if (!group) {
        group = {
          ...user,
          ...(userEntity ? { ownerEntityId: userEntity.id } : {}),
          targets: new Map<string, UmlReference>(),
        };
        localGroups.set(key, group);
      }
      group.targets.set(reference.target.id, reference.target);
      continue;
    }

    if (ignoredExternalUserFiles.has(referenceFileKey)) continue;

    const key = `${user.scopePath}\0${user.signature}`;
    let group = externalGroups.get(key);
    if (!group) {
      group = {
        scopePath: user.scopePath,
        signature: user.signature,
        kind: user.kind,
        targets: new Map<string, UmlReference>(),
      };
      externalGroups.set(key, group);
    }
    group.targets.set(reference.target.id, reference.target);
  }

  usageEdges.sort((left, right) =>
    left.sourceName.localeCompare(right.sourceName)
    || left.targetName.localeCompare(right.targetName)
    || left.sourceId.localeCompare(right.sourceId)
    || left.targetId.localeCompare(right.targetId)
  );
  const localUserNodes = [...localGroups.values()]
    .sort((left, right) =>
      left.scopePath.localeCompare(right.scopePath)
      || left.signature.localeCompare(right.signature)
      || left.kind.localeCompare(right.kind)
    )
    .map((group, index) => {
      const nodeId = `local${index}`;
      return {
        navigation: {
          nodeId,
          label: `${group.kind === "export" ? "export" : "local"}: ${group.scopePath}: ${group.signature}`,
          kind: group.kind,
          ...group.source,
        },
        ...(group.ownerEntityId ? { ownerEntityId: group.ownerEntityId } : {}),
        targets: [...group.targets.values()].sort((left, right) =>
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        ),
      };
    });
  const externalUserNodes = [...externalGroups.values()]
    .sort((left, right) =>
      left.scopePath.localeCompare(right.scopePath)
      || left.signature.localeCompare(right.signature)
      || left.kind.localeCompare(right.kind)
    )
    .map((group, index) => {
      const nodeId = `extern${index}`;
      return {
        navigation: {
          nodeId,
          label: `extern: ${group.scopePath}: ${group.signature}`,
          scopePath: group.scopePath,
          kind: group.kind,
        },
        targets: [...group.targets.values()].sort((left, right) =>
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        ),
      };
    });
  return { usageEdges, localUserNodes, externalUserNodes };
}


function methodNodes(declaration: Node): Node[] {
  const nodes: Node[] = [];
  const body = declaration.type === "type_alias_declaration"
    ? declaration.childForFieldName("value")
    : declaration.childForFieldName("body");
  if (!body) return nodes;
  if (declaration.type === "type_alias_declaration" && body.type !== "object_type") return nodes;
  for (const member of namedChildren(body)) {
    if (!METHOD_NODE_TYPES.has(member.type) || isAccessor(member)) continue;
    if (memberName(member)?.name === "constructor") continue;
    nodes.push(member);
  }
  return nodes;
}

export type UmlAnalysisInput = {
  sourceDir: string;
  sourceFiles: readonly string[];
  projectFiles: readonly string[];
  contents: ReadonlyMap<string, string>;
  declarations: FileDeclaration[];
  categories: CategoryMap;
  ignoredExternalUserFiles: ReadonlySet<string>;
};

export function analyzeUmlTypes(input: UmlAnalysisInput): {
  methodReturnDependencies: UmlDependency[];
  usageEdges: UmlDependency[];
  definitions: GotoDefinition[];
  localUserNodes: LocalUserNode[];
  externalUserNodes: ExternalUserNode[];
} {
  const { sourceDir, sourceFiles, declarations, categories, ignoredExternalUserFiles } = input;
  const parsed = parseSourceUnits(input.projectFiles, input.contents);
  try {
    const { definitions, entities } = collectRenderedModel(sourceDir, declarations, input.contents);
    const symbols: SymbolTable = buildSymbolTable(parsed.units, entities);
    const entityKeyOf = (declaration: Node, file: string): string | undefined => {
      const name = declarationName(declaration);
      return name === undefined ? undefined : umlEntityKey(file, bareUmlName(name));
    };

    const methodReturnDependencies: UmlDependency[] = [];
    const dependencyKeys = new Set<string>();
    const addMethodReturns = (path: string, source: UmlReference, annotation: Node): void => {
      for (const target of symbols.resolveTypeReferences(path, annotation)) {
        if (source.id === target.id) continue;
        const dependencyKey = `${source.id}\0${target.id}`;
        if (dependencyKeys.has(dependencyKey)) continue;
        dependencyKeys.add(dependencyKey);
        methodReturnDependencies.push({
          sourceId: source.id,
          sourceName: source.name,
          targetId: target.id,
          targetName: target.name,
        });
      }
    };
    for (const file of sourceFiles) {
      const unit = parsed.byKey.get(umlFileKey(file));
      if (!unit) continue;
      if (analysisLanguageForPath(unit.path) === "rust") {
        for (const owner of rustMethodReturnAnnotations(rustTopLevelItems(unit.root))) {
          const source = entities.get(umlEntityKey(unit.path, bareUmlName(owner.ownerName)));
          if (!source) continue;
          addMethodReturns(unit.path, source, owner.annotation);
        }
        continue;
      }
      for (const declaration of topLevelDeclarations(unit.root)) {
        if (!ENTITY_DECLARATION_TYPES.has(declaration.type)) continue;
        const key = entityKeyOf(declaration, unit.path);
        const source = key === undefined ? undefined : entities.get(key);
        if (!source) continue;
        if (declaration.type === "abstract_class_declaration") {
          const existing = categories.get(source.name);
          if (existing) existing.category = "abstract";
        }
        for (const method of methodNodes(declaration)) {
          const annotation = annotationType(method, "return_type");
          if (!annotation) continue;
          addMethodReturns(unit.path, source, annotation);
        }
      }
    }

    const inScopeFiles = new Set(sourceFiles.map(umlFileKey));
    const { usageEdges, localUserNodes, externalUserNodes } = collectUsageGraph(
      sourceDir,
      inScopeFiles,
      symbols.references(),
      entities,
      declarations,
      methodReturnDependencies,
      ignoredExternalUserFiles,
      entityKeyOf,
    );
    return {
      methodReturnDependencies,
      usageEdges,
      definitions,
      localUserNodes,
      externalUserNodes,
    };
  } finally {
    parsed.dispose();
  }
}
