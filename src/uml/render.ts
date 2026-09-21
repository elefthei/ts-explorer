import type { UmlCategoryKind, UmlDiagramGraph } from "../diagram-graph.ts";
import { validateUmlDiagramGraph } from "./graph.ts";
import type {
  EnumItemDetails,
  MethodDetails,
  PropertyDetails,
  UmlEntityModel,
  UmlModifier,
} from "./model.ts";

export type HydratedFileNominalModel = {
  entities: Map<string, UmlEntityModel>;
  categories: Map<string, { category: UmlCategoryKind; isTest: boolean }>;
};

/**
 * Rebuilds one contributing file's nominal detail from its normalized rows. Fragments produced by
 * cross-file implementations hydrate exactly like a declaring file's entity and are merged by
 * canonical ID when a selection is assembled.
 */
export function hydrateUmlNominalModel(graph: UmlDiagramGraph): HydratedFileNominalModel {
  validateUmlDiagramGraph(graph);
  const entities = new Map<string, UmlEntityModel>();
  const byOrdinal: UmlEntityModel[] = [];
  for (const row of graph.entities) {
    const entity: UmlEntityModel = {
      id: row.definitionKey,
      name: row.name,
      kind: row.entityKind,
      properties: [],
      methods: [],
      items: [],
    };
    byOrdinal[row.entityOrdinal] = entity;
    entities.set(entity.id, entity);
  }
  const modifiers = new Map<string, UmlModifier[]>();
  for (const row of graph.memberModifiers) {
    const key = `${row.entityOrdinal}\u0000${row.memberKind}\u0000${row.memberOrdinal}`;
    const existing = modifiers.get(key);
    if (existing) existing.push(row.modifier);
    else modifiers.set(key, [row.modifier]);
  }
  for (const row of graph.properties) {
    const entity = byOrdinal[row.entityOrdinal];
    if (!entity) continue;
    const details: PropertyDetails = {
      definitionKey: row.definitionKey,
      modifiers: modifiers.get(`${row.entityOrdinal}\u0000property\u0000${row.propertyOrdinal}`) ?? [],
      name: row.name,
      ...(row.type === null ? {} : { type: row.type }),
      optional: row.optional,
    };
    entity.properties.push(details);
  }
  for (const row of graph.methods) {
    const entity = byOrdinal[row.entityOrdinal];
    if (!entity) continue;
    const details: MethodDetails = {
      definitionKey: row.definitionKey,
      modifiers: modifiers.get(`${row.entityOrdinal}\u0000method\u0000${row.methodOrdinal}`) ?? [],
      name: row.name,
      ...(row.returnType === null ? {} : { returnType: row.returnType }),
    };
    entity.methods.push(details);
  }
  for (const row of graph.enumItems) {
    const entity = byOrdinal[row.entityOrdinal];
    if (!entity) continue;
    const item: EnumItemDetails = { definitionKey: row.definitionKey, value: row.value };
    entity.items.push(item);
  }
  const categories = new Map<string, { category: UmlCategoryKind; isTest: boolean }>();
  for (const row of graph.categories) {
    categories.set(row.definitionKey, { category: row.category, isTest: row.isTest });
  }
  return { entities, categories };
}
