import type { Node } from "@vscode/tree-sitter-wasm";
import { namedChildren, renderedTypeName } from "./lang/ast.ts";
import { analysisLanguageForPath } from "./lang/registry.ts";
import {
  parseRustSource,
  RUST_ENTITY_KIND_BY_NODE,
  rustBodyMethods,
  rustImplTargetName,
  rustTopLevelItems,
} from "./lang/rust.ts";
import {
  ENTITY_KIND_BY_NODE,
  isAccessor,
  METHOD_NODE_TYPES,
  memberName,
  parseTypeScriptSource,
  topLevelDeclarations,
} from "./lang/typescript.ts";
import { isDeclarationPath } from "./source.ts";
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
    for (const member of namedChildren(body)) {
      if (!METHOD_NODE_TYPES.has(member.type) || isAccessor(member)) continue;
      methods.push(member);
    }
    return methods;
  }
  if (kind === "interface") {
    if (body?.type !== "interface_body") return methods;
    for (const member of namedChildren(body)) {
      if (member.type === "method_signature") methods.push(member);
    }
    return methods;
  }
  if (kind === "type") {
    const value = declaration.childForFieldName("value");
    if (value?.type !== "object_type") return methods;
    for (const member of namedChildren(value)) {
      if (member.type === "method_signature") methods.push(member);
    }
  }
  return methods;
}

/** One declared entity and the members the definition index addresses under it, in source order. */
type DefinitionEntity = {
  kind: ParsedEntityKind;
  nameNode: Node;
  renderedName: string;
  members: { name: string; node: Node }[];
};

/**
 * Language-neutral span builder. `key` is the persisted `DefinitionIndex.key` and is asserted
 * verbatim by the definition-lookup suites, so its shape must not move.
 */
function definitionSpans(entities: readonly DefinitionEntity[]): ParsedDefinitionSpan[] {
  const entityOccurrences = new Map<string, number>();
  const memberOccurrences = new Map<string, number>();
  const spans: ParsedDefinitionSpan[] = [];
  for (const entity of entities) {
    const { kind, nameNode, renderedName } = entity;
    const name = nameNode.text;
    const entityCounterKey = `${kind}\0${name}`;
    const entityOccurrence = entityOccurrences.get(entityCounterKey) ?? 0;
    entityOccurrences.set(entityCounterKey, entityOccurrence + 1);
    spans.push({
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
    for (const member of entity.members) {
      const memberCounterKey = `${kind}\0${name}\0${member.name}`;
      const sourceMemberOccurrence = memberOccurrences.get(memberCounterKey) ?? 0;
      memberOccurrences.set(memberCounterKey, sourceMemberOccurrence + 1);
      spans.push({
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
  return spans;
}

function typescriptDefinitionEntities(root: Node): DefinitionEntity[] {
  const entities: DefinitionEntity[] = [];
  for (const declaration of topLevelDeclarations(root)) {
    const kind = ENTITY_KIND_BY_NODE[declaration.type];
    if (!kind) continue;
    const nameNode = declaration.childForFieldName("name");
    if (!nameNode) continue;
    const members: DefinitionEntity["members"] = [];
    for (const method of entityMethodNodes(declaration, kind)) {
      const member = memberName(method);
      // The definition index addresses members by source name; `#private` members are unaddressable.
      if (!member || member.node.type === "private_property_identifier") continue;
      if (member.name === "constructor") continue;
      members.push(member);
    }
    entities.push({
      kind,
      nameNode,
      renderedName: renderedTypeName(nameNode.text, declaration),
      members,
    });
  }
  return entities;
}

/** Same-file `impl` blocks keyed by the bare name of the type they apply to, in source order. */
function rustImplBlocks(items: readonly Node[]): Map<string, Node[]> {
  const blocks = new Map<string, Node[]>();
  for (const item of items) {
    if (item.type !== "impl_item") continue;
    const name = rustImplTargetName(item);
    if (name === undefined) continue;
    const existing = blocks.get(name);
    if (existing) existing.push(item);
    else blocks.set(name, [item]);
  }
  return blocks;
}

/** Methods a Rust entity contributes: trait requirements, or every same-file `impl` block's. */
function rustEntityMethodNodes(
  declaration: Node,
  implBlocks: ReadonlyMap<string, Node[]>,
  bareName: string,
): Node[] {
  if (declaration.type === "trait_item") {
    return rustBodyMethods(declaration.childForFieldName("body"));
  }
  const methods: Node[] = [];
  if (declaration.type === "type_item") return methods;
  for (const block of implBlocks.get(bareName) ?? []) {
    methods.push(...rustBodyMethods(block.childForFieldName("body")));
  }
  return methods;
}

function rustDefinitionEntities(root: Node): DefinitionEntity[] {
  const items = rustTopLevelItems(root);
  const implBlocks = rustImplBlocks(items);
  const entities: DefinitionEntity[] = [];
  for (const declaration of items) {
    const kind = RUST_ENTITY_KIND_BY_NODE[declaration.type];
    if (!kind) continue;
    const nameNode = declaration.childForFieldName("name");
    if (!nameNode) continue;
    const members: DefinitionEntity["members"] = [];
    for (const method of rustEntityMethodNodes(declaration, implBlocks, nameNode.text)) {
      const memberNode = method.childForFieldName("name");
      if (!memberNode) continue;
      members.push({ name: memberNode.text, node: memberNode });
    }
    entities.push({
      kind,
      nameNode,
      renderedName: renderedTypeName(nameNode.text, declaration),
      members,
    });
  }
  return entities;
}

export function parseDefinitionSpans(path: string, content: string): ParsedDefinitionSpan[] {
  if (isDeclarationPath(path)) return [];
  const language = analysisLanguageForPath(path);
  if (language === undefined) return [];
  const parsed = language === "rust" ? parseRustSource(content) : parseTypeScriptSource(path, content);
  if (!parsed) return [];
  try {
    return definitionSpans(
      language === "rust"
        ? rustDefinitionEntities(parsed.root)
        : typescriptDefinitionEntities(parsed.root),
    );
  } finally {
    parsed.dispose();
  }
}
