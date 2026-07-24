import { Node, Project } from "ts-morph";
import type {
  ClassDeclaration,
  EnumDeclaration,
  InterfaceDeclaration,
  ParameterDeclaration,
  Symbol as MorphSymbol,
  Type,
  TypeAliasDeclaration,
} from "ts-morph";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import {
  parseDefinitionSpans,
  type ParsedDefinitionSpan,
  type ParsedEntityKind,
} from "../goto-definition.ts";
import { bareUmlName, scopeRelativePath, umlEntityKey, umlFileKey } from "./keys.ts";
import { UML_ENTITY_COLLECTIONS } from "./entities.ts";
import { formatSignatureType } from "./mermaid.ts";
import type {
  CategoryMap,
  ExternalUserNode,
  LocalUserNode,
  UmlDependency,
  UmlReference,
} from "./model.ts";
import { isDeclarationPath } from "../source.ts";
import type {
  GotoDefinition,
  UmlExternalUserKind,
  UmlSourceLocation,
} from "../types.ts";

type ReferenceOwner = {
  scopePath: string;
  signature: string;
  kind: UmlExternalUserKind;
  source: UmlSourceLocation;
  ownerEntityKey?: string;
};

type ReferenceDeclaration = {
  declarationNode: Node;
  nameNode: Node;
  target: UmlReference;
};

type UmlEntityDeclaration =
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration;

function isUmlEntityDeclaration(node: Node | undefined): node is UmlEntityDeclaration {
  return Node.isClassDeclaration(node)
    || Node.isInterfaceDeclaration(node)
    || Node.isTypeAliasDeclaration(node)
    || Node.isEnumDeclaration(node);
}

function parameterTypes(parameters: readonly ParameterDeclaration[]): string {
  return parameters.map((parameter) =>
    formatSignatureType(parameter.getTypeNode()?.getText() ?? parameter.getType().getText(parameter))
  ).join(", ");
}

function unwrapExpression(node: Node | undefined): Node | undefined {
  let expression = node;
  while (
    Node.isAsExpression(expression)
    || Node.isSatisfiesExpression(expression)
    || Node.isParenthesizedExpression(expression)
    || Node.isTypeAssertion(expression)
    || Node.isNonNullExpression(expression)
  ) {
    expression = expression.getExpression();
  }
  return expression;
}

function owningTypeName(node: Node): string | undefined {
  const owner = node.getFirstAncestor((ancestor) =>
    Node.isClassDeclaration(ancestor)
    || Node.isInterfaceDeclaration(ancestor)
    || Node.isTypeAliasDeclaration(ancestor)
  );
  return owner?.getName();
}

function enclosingEntityDeclaration(node: Node): UmlEntityDeclaration | undefined {
  return node.getFirstAncestor(isUmlEntityDeclaration);
}

function entityDeclarationName(node: Node | undefined): string | undefined {
  return isUmlEntityDeclaration(node) ? node.getName() : undefined;
}

function referenceSource(sourceDir: string, node: Node): UmlSourceLocation {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    path: scopeRelativePath(sourceDir, sourceFile.getFilePath()),
    line,
    column,
  };
}

function isDeclarationName(node: Node): boolean {
  const parent = node.getParent();
  if (
    !parent
    || !(
      isUmlEntityDeclaration(parent)
      || Node.isFunctionDeclaration(parent)
      || Node.isVariableDeclaration(parent)
      || Node.isMethodDeclaration(parent)
      || Node.isMethodSignature(parent)
      || Node.isPropertyDeclaration(parent)
      || Node.isPropertySignature(parent)
      || Node.isParameterDeclaration(parent)
      || Node.isEnumMember(parent)
    )
  ) {
    return false;
  }
  return parent.getNameNode() === node;
}

function classifyReferenceOwner(
  reference: Node,
  sourceDir: string,
): ReferenceOwner | undefined {
  if (reference.getFirstAncestor(Node.isJSDoc)) return undefined;
  const sourceFile = reference.getSourceFile();
  if (isDeclarationPath(sourceFile.getFilePath())) return undefined;

  const exportSpecifier = reference.getFirstAncestor(Node.isExportSpecifier);
  if (exportSpecifier) {
    const exportedName = exportSpecifier.getAliasNode()?.getText() ?? exportSpecifier.getName();
    return {
      scopePath: scopeRelativePath(sourceDir, sourceFile.getFilePath()),
      signature: exportedName,
      kind: "export",
      source: referenceSource(sourceDir, exportSpecifier.getNameNode()),
    };
  }
  if (
    reference.getFirstAncestor((ancestor) =>
      Node.isImportDeclaration(ancestor)
      || Node.isImportEqualsDeclaration(ancestor)
      || Node.isExportDeclaration(ancestor)
    )
    || isDeclarationName(reference)
  ) {
    return undefined;
  }

  const scopePath = scopeRelativePath(sourceDir, sourceFile.getFilePath());
  const ownerDeclaration = enclosingEntityDeclaration(reference);
  const ownerName = entityDeclarationName(ownerDeclaration);
  const ownerEntityKey = ownerDeclaration && ownerName
    ? umlEntityKey(ownerDeclaration.getSourceFile().getFilePath(), bareUmlName(ownerName))
    : undefined;
  const result = (
    signature: string,
    kind: UmlExternalUserKind,
    sourceNode: Node,
  ): ReferenceOwner => ({
    scopePath,
    signature,
    kind,
    source: referenceSource(sourceDir, sourceNode),
    ...(ownerEntityKey ? { ownerEntityKey } : {}),
  });

  const propertyAssignment = reference.getFirstAncestor(Node.isPropertyAssignment);
  const callable = reference.getFirstAncestor((ancestor) =>
    Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)
  );
  if (
    propertyAssignment
    && callable
    && (Node.isArrowFunction(callable) || Node.isFunctionExpression(callable))
    && unwrapExpression(propertyAssignment.getInitializer()) === callable
  ) {
    const objectLiteral = propertyAssignment.getFirstAncestor(Node.isObjectLiteralExpression);
    const variable = propertyAssignment.getFirstAncestor(Node.isVariableDeclaration);
    if (
      objectLiteral
      && variable
      && Node.isIdentifier(variable.getNameNode())
      && unwrapExpression(variable.getInitializer()) === objectLiteral
    ) {
      return result(
        `${variable.getName()}.${propertyAssignment.getName()}(${parameterTypes(callable.getParameters())})`,
        "method",
        propertyAssignment.getNameNode(),
      );
    }
  }

  const method = reference.getFirstAncestor((ancestor) =>
    Node.isMethodDeclaration(ancestor)
    || Node.isMethodSignature(ancestor)
    || Node.isGetAccessorDeclaration(ancestor)
    || Node.isSetAccessorDeclaration(ancestor)
  );
  if (
    method
    && (
      Node.isMethodDeclaration(method)
      || Node.isMethodSignature(method)
      || Node.isGetAccessorDeclaration(method)
      || Node.isSetAccessorDeclaration(method)
    )
  ) {
    const owner = owningTypeName(method);
    if (owner) {
      return result(
        `${owner}.${method.getName()}(${parameterTypes(method.getParameters())})`,
        "method",
        method.getNameNode(),
      );
    }
  }

  const constructorDeclaration = reference.getFirstAncestor(Node.isConstructorDeclaration);
  if (constructorDeclaration) {
    const owner = owningTypeName(constructorDeclaration);
    if (owner) {
      return result(
        `${owner}.constructor(${parameterTypes(constructorDeclaration.getParameters())})`,
        "constructor",
        constructorDeclaration,
      );
    }
  }

  const property = reference.getFirstAncestor((ancestor) =>
    Node.isPropertyDeclaration(ancestor) || Node.isPropertySignature(ancestor)
  );
  if (property && (Node.isPropertyDeclaration(property) || Node.isPropertySignature(property))) {
    const owner = owningTypeName(property);
    if (owner) {
      const type = property.getTypeNode()?.getText() ?? property.getType().getText(property);
      return result(
        `${owner}.${property.getName()}: ${formatSignatureType(type)}`,
        "property",
        property.getNameNode(),
      );
    }
  }

  if (
    ownerDeclaration
    && (
      Node.isClassDeclaration(ownerDeclaration)
      || Node.isInterfaceDeclaration(ownerDeclaration)
      || Node.isEnumDeclaration(ownerDeclaration)
    )
  ) {
    const name = ownerDeclaration.getName();
    return name ? result(name, "class", ownerDeclaration.getNameNode() ?? ownerDeclaration) : undefined;
  }

  const fn = reference.getFirstAncestor(Node.isFunctionDeclaration);
  if (fn) {
    const name = fn.getName();
    const nameNode = fn.getNameNode();
    if (name && nameNode) {
      return result(`${name}(${parameterTypes(fn.getParameters())})`, "function", nameNode);
    }
    return undefined;
  }

  const variable = reference.getFirstAncestor(Node.isVariableDeclaration);
  if (variable) {
    const statement = variable.getVariableStatement();
    const initializer = unwrapExpression(variable.getInitializer());
    if (
      statement
      && Node.isIdentifier(variable.getNameNode())
      && Node.isSourceFile(statement.getParent())
      && initializer
      && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    ) {
      return result(
        `${variable.getName()}(${parameterTypes(initializer.getParameters())})`,
        "function",
        variable.getNameNode(),
      );
    }
    const type = variable.getTypeNode()?.getText() ?? variable.getType().getText(variable);
    return result(
      `${variable.getName()}: ${formatSignatureType(type)}`,
      "variable",
      variable.getNameNode(),
    );
  }

  const alias = reference.getFirstAncestor(Node.isTypeAliasDeclaration);
  return alias ? result(alias.getName(), "type", alias.getNameNode()) : undefined;
}

function collectUsageGraph(
  sourceDir: string,
  inScopeFiles: ReadonlySet<string>,
  declarations: readonly ReferenceDeclaration[],
  entities: ReadonlyMap<string, UmlReference>,
  fileDeclarations: readonly FileDeclaration[],
  methodReturnDependencies: readonly UmlDependency[],
  ignoredExternalUserFiles: ReadonlySet<string>,
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

  for (const declaration of declarations) {
    if (!Node.isIdentifier(declaration.nameNode)) continue;
    for (const reference of declaration.nameNode.findReferencesAsNodes()) {
      if (
        reference.getSourceFile() === declaration.nameNode.getSourceFile()
        && reference.getStart() === declaration.nameNode.getStart()
      ) {
        continue;
      }
      const user = classifyReferenceOwner(reference, sourceDir);
      if (!user) continue;
      const ownerDeclaration = enclosingEntityDeclaration(reference);
      const userEntity = user.ownerEntityKey ? entities.get(user.ownerEntityKey) : undefined;
      const isLocalTypeAlias = Node.isTypeAliasDeclaration(ownerDeclaration)
        && ownerDeclaration.getTypeParameters().length === 0;
      if (ownerDeclaration === declaration.declarationNode || userEntity?.id === declaration.target.id) continue;

      const referenceFileKey = umlFileKey(reference.getSourceFile().getFilePath());
      if (inScopeFiles.has(referenceFileKey)) {
        if (userEntity && !isLocalTypeAlias) {
          const key = `${userEntity.id}\0${declaration.target.id}`;
          if (directedKeys.has(key)) continue;
          directedKeys.add(key);
          usageEdges.push({
            sourceId: userEntity.id,
            sourceName: userEntity.name,
            targetId: declaration.target.id,
            targetName: declaration.target.name,
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
        group.targets.set(declaration.target.id, declaration.target);
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
      group.targets.set(declaration.target.id, declaration.target);
    }
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


function parsedDeclarationKey(
  kind: ParsedEntityKind,
  name: string,
  occurrence: number,
): string {
  return `${kind}\0${name}\0${occurrence}`;
}

function collectRenderedModel(
  sourceDir: string,
  project: Project,
  declarations: readonly FileDeclaration[],
): { definitions: GotoDefinition[]; entities: Map<string, UmlReference> } {
  const definitions: GotoDefinition[] = [];
  const entities = new Map<string, UmlReference>();
  for (const declaration of declarations) {
    const sourceFile = project.getSourceFileOrThrow(declaration.fileName);
    const parsed = parseDefinitionSpans(sourceFile.getFilePath(), sourceFile.getFullText());
    const entitiesByKey = new Map<string, ParsedDefinitionSpan>();
    const methodsByEntity = new Map<string, ParsedDefinitionSpan[]>();
    for (const definition of parsed) {
      const key = parsedDeclarationKey(
        definition.entityKind,
        definition.entityName,
        definition.entityOccurrence,
      );
      if (definition.kind === "method") {
        const methods = methodsByEntity.get(key) ?? [];
        methods.push(definition);
        methodsByEntity.set(key, methods);
      } else {
        entitiesByKey.set(key, definition);
      }
    }

    const entityOccurrences = new Map<string, number>();
    const renderedMethodOccurrences = new Map<string, number>();
    const scopePath = scopeRelativePath(sourceDir, sourceFile.getFilePath());
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const entity of descriptor.entities(declaration)) {
        const bareName = bareUmlName(entity.name);
        entities.set(umlEntityKey(declaration.fileName, bareName), entity);
        const counterKey = `${descriptor.kind}\0${bareName}`;
        const entityOccurrence = entityOccurrences.get(counterKey) ?? 0;
        entityOccurrences.set(counterKey, entityOccurrence + 1);
        const declarationKey = parsedDeclarationKey(descriptor.kind, bareName, entityOccurrence);
        const parsedEntity = entitiesByKey.get(declarationKey);
        if (!parsedEntity) continue;
        definitions.push({
          key: parsedEntity.key,
          kind: parsedEntity.kind,
          name: parsedEntity.name,
          qualifiedName: parsedEntity.qualifiedName,
          source: {
            path: scopePath,
            line: parsedEntity.line,
            column: parsedEntity.column,
          },
          uml: {
            scopePath,
            entityName: entity.name,
          },
        });

        const parsedMethods = methodsByEntity.get(declarationKey) ?? [];
        const usedMethods = new Set<string>();
        for (const renderedMethod of "methods" in entity ? entity.methods : []) {
          const occurrenceKey = `${bareName}\0${renderedMethod.name}`;
          const memberOccurrence = renderedMethodOccurrences.get(occurrenceKey) ?? 0;
          renderedMethodOccurrences.set(occurrenceKey, memberOccurrence + 1);
          const parsedMethod = parsedMethods.find((candidate) =>
            candidate.memberName === renderedMethod.name && !usedMethods.has(candidate.key)
          );
          if (!parsedMethod) continue;
          usedMethods.add(parsedMethod.key);
          definitions.push({
            key: parsedMethod.key,
            kind: "method",
            name: parsedMethod.name,
            qualifiedName: parsedMethod.qualifiedName,
            source: {
              path: scopePath,
              line: parsedMethod.line,
              column: parsedMethod.column,
            },
            uml: {
              scopePath,
              entityName: entity.name,
              memberName: renderedMethod.name,
              memberOccurrence,
            },
          });
        }
      }
    }
  }
  definitions.sort((left, right) =>
    left.source.path.localeCompare(right.source.path)
    || left.source.line - right.source.line
    || left.source.column - right.source.column
    || left.key.localeCompare(right.key)
  );
  return { definitions, entities };
}

export function analyzeUmlTypes(
  sourceDir: string,
  sourceFiles: string[],
  projectFiles: string[],
  declarations: FileDeclaration[],
  tsconfig: string | undefined,
  categories: CategoryMap,
  ignoredExternalUserFiles: ReadonlySet<string>,
): {
  methodReturnDependencies: UmlDependency[];
  usageEdges: UmlDependency[];
  definitions: GotoDefinition[];
  localUserNodes: LocalUserNode[];
  externalUserNodes: ExternalUserNode[];
} {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    ...(tsconfig ? { tsConfigFilePath: tsconfig } : {}),
  });
  for (const file of projectFiles) project.addSourceFileAtPath(file);

  const { definitions, entities } = collectRenderedModel(sourceDir, project, declarations);

  const resolveSymbol = (symbol: MorphSymbol | undefined): UmlReference | undefined => {
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (!isUmlEntityDeclaration(declaration)) continue;
      const name = declaration.getName();
      if (!name) continue;
      const entity = entities.get(umlEntityKey(declaration.getSourceFile().getFilePath(), name));
      if (entity) return entity;
    }
    return undefined;
  };

  const methodReturnDependencies: UmlDependency[] = [];
  const dependencyKeys = new Set<string>();
  const collectDependencies = (
    type: Type,
    source: UmlReference,
    visited: Set<object>,
  ): void => {
    if (visited.has(type.compilerType)) return;
    visited.add(type.compilerType);

    for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
      const target = resolveSymbol(symbol);
      if (!target || source.id === target.id) continue;
      const key = `${source.id}\0${target.id}`;
      if (dependencyKeys.has(key)) continue;
      dependencyKeys.add(key);
      methodReturnDependencies.push({
        sourceId: source.id,
        sourceName: source.name,
        targetId: target.id,
        targetName: target.name,
      });
    }

    for (const nested of type.getUnionTypes()) collectDependencies(nested, source, visited);
    for (const nested of type.getIntersectionTypes()) collectDependencies(nested, source, visited);
    const arrayElement = type.getArrayElementType();
    if (arrayElement) collectDependencies(arrayElement, source, visited);
    for (const nested of type.getTypeArguments()) collectDependencies(nested, source, visited);
  };

  const referenceDeclarations: ReferenceDeclaration[] = [];
  const registerReferenceDeclaration = (
    declaration: UmlEntityDeclaration,
  ): UmlReference | undefined => {
    const name = declaration.getName();
    const nameNode = declaration.getNameNode();
    if (!name || !nameNode) return undefined;
    const source = entities.get(umlEntityKey(declaration.getSourceFile().getFilePath(), name));
    if (!source) return undefined;
    referenceDeclarations.push({ declarationNode: declaration, nameNode, target: source });
    return source;
  };

  for (const file of sourceFiles) {
    const sourceFile = project.getSourceFileOrThrow(file);

    for (const declaration of sourceFile.getClasses()) {
      const source = registerReferenceDeclaration(declaration);
      if (!source) continue;
      if (declaration.isAbstract()) {
        const existing = categories.get(source.name);
        if (existing) existing.category = "abstract";
      }
      const methods = declaration.getMethods();
      for (const method of methods) collectDependencies(method.getReturnType(), source, new Set());
    }

    for (const declaration of sourceFile.getInterfaces()) {
      const source = registerReferenceDeclaration(declaration);
      if (!source) continue;
      const methods = declaration.getMethods();
      for (const method of methods) collectDependencies(method.getReturnType(), source, new Set());
    }

    for (const declaration of sourceFile.getTypeAliases()) {
      const source = registerReferenceDeclaration(declaration);
      if (!source) continue;
      const typeNode = declaration.getTypeNode();
      if (Node.isTypeLiteral(typeNode)) {
        for (const method of typeNode.getMethods()) {
          collectDependencies(method.getReturnType(), source, new Set());
        }
      }
    }

    for (const declaration of sourceFile.getEnums()) {
      if (!registerReferenceDeclaration(declaration)) continue;
    }
  }

  const inScopeFiles = new Set(sourceFiles.map(umlFileKey));
  const { usageEdges, localUserNodes, externalUserNodes } = collectUsageGraph(
    sourceDir,
    inScopeFiles,
    referenceDeclarations,
    entities,
    declarations,
    methodReturnDependencies,
    ignoredExternalUserFiles,
  );
  return {
    methodReturnDependencies,
    usageEdges,
    definitions,
    localUserNodes,
    externalUserNodes,
  };
}
