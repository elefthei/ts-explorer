import ts from "typescript";
import { isDeclarationPath, isTypeScriptPath } from "./source.ts";
import type { GotoDefinitionKind } from "./types.ts";

export type ParsedEntityKind = Exclude<GotoDefinitionKind, "method">;

export type ParsedDefinitionSpan = {
  key: string;
  kind: GotoDefinitionKind;
  name: string;
  qualifiedName: string;
  entityKind: ParsedEntityKind;
  entityName: string;
  renderedEntityName: string;
  entityOccurrence: number;
  memberName?: string;
  sourceMemberOccurrence?: number;
  line: number;
  column: number;
  from: number;
  to: number;
};

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".mts")) return ts.ScriptKind.TS;
  if (path.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function entityKind(node: ts.Statement): ParsedEntityKind | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  return undefined;
}

function methodName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function renderedEntityName(
  name: string,
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
): string {
  if (!typeParameters?.length) return name;
  return `${name}<${typeParameters.map((parameter) => parameter.name.text).join(",")}>`;
}

function entityMethods(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): readonly (ts.MethodDeclaration | ts.MethodSignature)[] {
  if (ts.isClassDeclaration(node)) return node.members.filter(ts.isMethodDeclaration);
  if (ts.isInterfaceDeclaration(node)) return node.members.filter(ts.isMethodSignature);
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members.filter(ts.isMethodSignature);
  }
  return [];
}

function location(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Pick<ParsedDefinitionSpan, "line" | "column" | "from" | "to"> {
  const from = node.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(from);
  return {
    line: line + 1,
    column: character + 1,
    from,
    to: node.getEnd(),
  };
}

export function parseDefinitionSpans(path: string, content: string): ParsedDefinitionSpan[] {
  if (!isTypeScriptPath(path) || isDeclarationPath(path)) return [];
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const entityOccurrences = new Map<string, number>();
  const memberOccurrences = new Map<string, number>();
  const definitions: ParsedDefinitionSpan[] = [];

  for (const statement of sourceFile.statements) {
    const kind = entityKind(statement);
    if (!kind || !(
      ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
    )) continue;
    const nameNode = statement.name;
    if (!nameNode) continue;
    const name = nameNode.text;
    const entityCounterKey = `${kind}\0${name}`;
    const entityOccurrence = entityOccurrences.get(entityCounterKey) ?? 0;
    entityOccurrences.set(entityCounterKey, entityOccurrence + 1);
    const renderedName = renderedEntityName(
      name,
      "typeParameters" in statement ? statement.typeParameters : undefined,
    );
    definitions.push({
      key: JSON.stringify([kind, name, entityOccurrence, null, null]),
      kind,
      name,
      qualifiedName: name,
      entityKind: kind,
      entityName: name,
      renderedEntityName: renderedName,
      entityOccurrence,
      ...location(sourceFile, nameNode),
    });

    for (const method of entityMethods(statement)) {
      const name = methodName(method.name);
      if (name === undefined) continue;
      const memberCounterKey = `${kind}\0${statement.name.text}\0${name}`;
      const sourceMemberOccurrence = memberOccurrences.get(memberCounterKey) ?? 0;
      memberOccurrences.set(memberCounterKey, sourceMemberOccurrence + 1);
      definitions.push({
        key: JSON.stringify([
          kind,
          statement.name.text,
          entityOccurrence,
          name,
          sourceMemberOccurrence,
        ]),
        kind: "method",
        name,
        qualifiedName: `${statement.name.text}.${name}`,
        entityKind: kind,
        entityName: statement.name.text,
        renderedEntityName: renderedName,
        entityOccurrence,
        memberName: name,
        sourceMemberOccurrence,
        ...location(sourceFile, method.name),
      });
    }
  }
  return definitions;
}
