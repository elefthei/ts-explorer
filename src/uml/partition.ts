import type { FileDeclaration } from "tsuml2/dist/core/model";
import type { UmlGraph } from "./model.ts";

export function partitionUmlCommunities(
  declarations: FileDeclaration[],
  graph: UmlGraph,
): FileDeclaration[][] {
  const communityIds = new Map<number, Set<string>>();
  const register = (id: string): void => {
    if (!graph.hasNode(id)) throw new Error(`Missing UML graph entity node: ${id}`);
    const attributes = graph.getNodeAttributes(id);
    const community = attributes.community;
    if (attributes.kind !== "entity" || community === undefined || !Number.isInteger(community)) {
      throw new Error(`Missing UML graph community for entity: ${id}`);
    }
    let ids = communityIds.get(community);
    if (!ids) {
      ids = new Set<string>();
      communityIds.set(community, ids);
    }
    ids.add(id);
  };

  for (const declaration of declarations) {
    for (const entity of declaration.classes) register(entity.id);
    for (const entity of declaration.interfaces) register(entity.id);
    for (const entity of declaration.enums) register(entity.id);
    for (const entity of declaration.types) register(entity.id);
  }

  if (!communityIds.size) return [];
  if (communityIds.size === 1) return [declarations];

  const communities: FileDeclaration[][] = [];
  for (const baseIds of communityIds.values()) {
    const ids = new Set<string>();
    const includeNode = (id: string): void => {
      ids.add(id);
      for (const alias of graph.getNodeAttributes(id).aliases ?? []) ids.add(alias);
    };
    for (const id of baseIds) {
      includeNode(id);
      for (const neighbor of graph.neighbors(id)) {
        const { kind } = graph.getNodeAttributes(neighbor);
        if (kind === "entity" || kind === "boundary") includeNode(neighbor);
      }
    }

    const communityDeclarations: FileDeclaration[] = [];
    for (const declaration of declarations) {
      const classes = declaration.classes.filter((entity) => ids.has(entity.id));
      const interfaces = declaration.interfaces.filter((entity) => ids.has(entity.id));
      const enums = declaration.enums.filter((entity) => ids.has(entity.id));
      const types = declaration.types.filter((entity) => ids.has(entity.id));
      if (!classes.length && !interfaces.length && !enums.length && !types.length) continue;

      const heritageClauses = declaration.heritageClauses
        .map((clauses) => clauses.filter(
          (clause) => ids.has(clause.classTypeId) && ids.has(clause.clauseTypeId),
        ))
        .filter((clauses) => clauses.length > 0);
      const memberAssociations = declaration.memberAssociations?.filter(
        (association) => ids.has(association.a.typeId) && ids.has(association.b.typeId),
      );
      communityDeclarations.push({
        ...declaration,
        classes,
        interfaces,
        enums,
        types,
        heritageClauses,
        memberAssociations,
      });
    }
    if (communityDeclarations.length) communities.push(communityDeclarations);
  }
  return communities;
}
