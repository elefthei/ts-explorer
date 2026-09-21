import { DIAGRAM_GRAPH_FORMAT_VERSION, type UmlDiagramGraph } from "./diagram-graph.ts";
import { collectFileDefinitionNodes } from "./goto-definition.ts";
import { highlightLanguageForPath } from "./lang/registry.ts";
import { parseRustSource } from "./lang/rust.ts";
import { parseTypeScriptSource } from "./lang/typescript.ts";
import { normalizeRelativePath } from "./paths.ts";
import { extractUmlTopology } from "./uml/graph.ts";
import type { DefinitionResolutionIndex, UmlEntityModel } from "./uml/model.ts";
import { buildNominalModel } from "./uml/parse.ts";
import { collectFileReferences } from "./uml/usage.ts";

export function bareUmlDiagramGraph(scopePath: string): UmlDiagramGraph {
  return {
    kind: "uml",
    scopePath: normalizeRelativePath(scopePath),
    formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
    renderMode: "bare",
    nodes: [],
    edges: [],
    relations: [],
    entities: [],
    properties: [],
    methods: [],
    memberModifiers: [],
    enumItems: [],
    categories: [],
  };
}

function serializeEntities(entities: readonly UmlEntityModel[]): Pick<
  UmlDiagramGraph,
  "entities" | "properties" | "methods" | "memberModifiers" | "enumItems"
> {
  const rows: Pick<
    UmlDiagramGraph,
    "entities" | "properties" | "methods" | "memberModifiers" | "enumItems"
  > = { entities: [], properties: [], methods: [], memberModifiers: [], enumItems: [] };
  for (const [entityOrdinal, entity] of entities.entries()) {
    rows.entities.push({
      entityOrdinal,
      definitionKey: entity.id,
      entityKind: entity.kind,
      name: entity.name,
    });
    for (const [propertyOrdinal, property] of entity.properties.entries()) {
      rows.properties.push({
        entityOrdinal,
        propertyOrdinal,
        definitionKey: property.definitionKey,
        name: property.name,
        type: property.type ?? null,
        optional: property.optional,
      });
      for (const [modifierOrdinal, modifier] of property.modifiers.entries()) {
        rows.memberModifiers.push({
          entityOrdinal,
          memberKind: "property",
          memberOrdinal: propertyOrdinal,
          modifierOrdinal,
          modifier,
        });
      }
    }
    for (const [methodOrdinal, method] of entity.methods.entries()) {
      rows.methods.push({
        entityOrdinal,
        methodOrdinal,
        definitionKey: method.definitionKey,
        name: method.name,
        returnType: method.returnType ?? null,
      });
      for (const [modifierOrdinal, modifier] of method.modifiers.entries()) {
        rows.memberModifiers.push({
          entityOrdinal,
          memberKind: "method",
          memberOrdinal: methodOrdinal,
          modifierOrdinal,
          modifier,
        });
      }
    }
    for (const [itemOrdinal, item] of entity.items.entries()) {
      rows.enumItems.push({
        entityOrdinal,
        itemOrdinal,
        definitionKey: item.definitionKey,
        value: item.value,
      });
    }
  }
  return rows;
}

/**
 * One source file's direct UML facts: every definition it declares as a node, the nominal detail
 * it contributes, and every outgoing reference its declarations resolve to. Transitive closure is
 * computed at read time from these per-file graphs; nothing here is scope-wide.
 */
export function extractFileUmlGraph(
  path: string,
  content: string,
  index: DefinitionResolutionIndex,
): UmlDiagramGraph {
  const scopePath = normalizeRelativePath(path);
  const language = highlightLanguageForPath(scopePath);
  if (language === undefined) return { ...bareUmlDiagramGraph(scopePath), renderMode: "normal" };
  const parsed = language === "rust"
    ? parseRustSource(content)
    : parseTypeScriptSource(scopePath, content);
  if (!parsed) return { ...bareUmlDiagramGraph(scopePath), renderMode: "normal" };
  try {
    const definitions = collectFileDefinitionNodes(scopePath, parsed.root);
    // A Rust `impl` member's owner is only known project-wide; adopt the catalogue's answer.
    for (const entry of definitions) {
      if (entry.definition.parentKey !== null) continue;
      const indexed = index.definition(entry.definition.key);
      if (indexed?.parentKey) entry.definition.parentKey = indexed.parentKey;
    }
    const nominal = buildNominalModel(scopePath, definitions, index);
    const references = collectFileReferences(scopePath, parsed.root, definitions, index);
    const entityIds = new Set(nominal.entities.map((entity) => entity.id));
    const contributed = new Map<string, { name: string; entity: boolean }>();
    for (const entry of definitions) {
      contributed.set(entry.definition.key, {
        name: entry.definition.qualifiedName,
        entity: entityIds.has(entry.definition.key),
      });
    }
    for (const entity of nominal.entities) {
      if (contributed.has(entity.id)) {
        contributed.set(entity.id, { name: entity.name, entity: true });
        continue;
      }
      const indexed = index.definition(entity.id);
      contributed.set(entity.id, { name: indexed?.qualifiedName ?? entity.name, entity: true });
    }
    const boundaries = new Map<string, string>();
    for (const reference of references) {
      for (const key of [reference.ownerKey, reference.targetKey]) {
        if (contributed.has(key) || boundaries.has(key)) continue;
        const indexed = index.definition(key);
        if (indexed) boundaries.set(key, indexed.qualifiedName);
      }
    }
    return {
      kind: "uml",
      scopePath,
      formatVersion: DIAGRAM_GRAPH_FORMAT_VERSION,
      renderMode: "normal",
      ...extractUmlTopology({ contributed, boundaries, references }),
      ...serializeEntities(nominal.entities),
      categories: nominal.categories.map((category, categoryOrdinal) => ({
        categoryOrdinal,
        definitionKey: category.definitionKey,
        category: category.category,
        isTest: category.isTest,
      })),
    };
  } finally {
    parsed.dispose();
  }
}
