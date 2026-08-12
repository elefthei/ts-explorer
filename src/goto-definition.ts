import type { Node } from "@vscode/tree-sitter-wasm";
import {
  ENTITY_KIND_BY_NODE,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  parseTypeScriptSource,
  renderedTypeName,
  topLevelDeclarations,
} from "./lang/typescript.ts";
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

function entityMethodNodes(declaration: Node, kind: ParsedEntityKind): Node[] {
  const body = declaration.childForFieldName("body");
  const methods: Node[] = [];
  if (kind === "class") {
    if (body?.type !== "class_body") return methods;
    for (const member of body.namedChildren) {
      if (!member || !METHOD_NODE_TYPES.has(member.type) || isAccessor(member)) continue;
      methods.push(member);
    }
    return methods;
  }
  if (kind === "interface") {
    if (body?.type !== "interface_body") return methods;
    for (const member of body.namedChildren) {
      if (member?.type === "method_signature") methods.push(member);
    }
    return methods;
  }
  if (kind === "type") {
    const value = declaration.childForFieldName("value");
    if (value?.type !== "object_type") return methods;
    for (const member of value.namedChildren) {
      if (member?.type === "method_signature") methods.push(member);
    }
  }
  return methods;
}

export function parseDefinitionSpans(path: string, content: string): ParsedDefinitionSpan[] {
  if (!isTypeScriptPath(path) || isDeclarationPath(path)) return [];
  const parsed = parseTypeScriptSource(path, content);
  if (!parsed) return [];
  const entityOccurrences = new Map<string, number>();
  const memberOccurrences = new Map<string, number>();
  const definitions: ParsedDefinitionSpan[] = [];

  try {
    for (const declaration of topLevelDeclarations(parsed.root)) {
      const kind = ENTITY_KIND_BY_NODE[declaration.type];
      if (!kind) continue;
      const nameNode = declaration.childForFieldName("name");
      if (!nameNode) continue;
      const name = nameNode.text;
      const entityCounterKey = `${kind}\0${name}`;
      const entityOccurrence = entityOccurrences.get(entityCounterKey) ?? 0;
      entityOccurrences.set(entityCounterKey, entityOccurrence + 1);
      const renderedName = renderedTypeName(name, declaration);
      definitions.push({
        key: JSON.stringify([kind, name, entityOccurrence, null, null]),
        kind,
        name,
        qualifiedName: name,
        entityKind: kind,
        entityName: name,
        renderedEntityName: renderedName,
        entityOccurrence,
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column + 1,
        from: nameNode.startIndex,
        to: nameNode.endIndex,
      });

      for (const method of entityMethodNodes(declaration, kind)) {
        const member = memberName(method);
        // The definition index addresses members by source name; `#private` members are unaddressable.
        if (!member || member.node.type === "private_property_identifier") continue;
        if (member.name === "constructor") continue;
        const memberCounterKey = `${kind}\0${name}\0${member.name}`;
        const sourceMemberOccurrence = memberOccurrences.get(memberCounterKey) ?? 0;
        memberOccurrences.set(memberCounterKey, sourceMemberOccurrence + 1);
        definitions.push({
          key: JSON.stringify([kind, name, entityOccurrence, member.name, sourceMemberOccurrence]),
          kind: "method",
          name: member.name,
          qualifiedName: `${name}.${member.name}`,
          entityKind: kind,
          entityName: name,
          renderedEntityName: renderedName,
          entityOccurrence,
          memberName: member.name,
          sourceMemberOccurrence,
          line: member.node.startPosition.row + 1,
          column: member.node.startPosition.column + 1,
          from: member.node.startIndex,
          to: member.node.endIndex,
        });
      }
    }
  } finally {
    parsed.dispose();
  }
  return definitions;
}
