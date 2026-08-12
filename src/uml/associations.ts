import type {
  FileDeclaration,
  MemberAssociation,
  PropertyDetails,
  UmlEntityModel,
} from "./model.ts";

// Ported from tsuml2's association parser, with the `inerhited` typo corrected.
function multiplicityOf(property: PropertyDetails): "0..*" | undefined {
  return property.type?.includes("[") ? "0..*" : undefined;
}

function associationsOf(
  entity: UmlEntityModel,
  associationMap: Map<string, MemberAssociation>,
  typeMap: ReadonlyMap<string, UmlEntityModel>,
): MemberAssociation[] {
  const associations: MemberAssociation[] = [];
  for (const property of entity.properties) {
    for (const id of property.typeIds) {
      const reverseId = `${id}_${entity.id}`;
      const existing = associationMap.get(reverseId);
      if (existing) {
        existing.a.multiplicity = multiplicityOf(property);
        continue;
      }
      const propertyType = typeMap.get(id);
      if (!propertyType) continue;
      const association: MemberAssociation = {
        a: { typeId: entity.id, name: entity.name },
        b: { typeId: id, name: propertyType.name, ...(multiplicityOf(property) ? { multiplicity: "0..*" as const } : {}) },
        associationType: 0,
        inherited: false,
      };
      associationMap.set(`${entity.id}_${id}`, association);
      associations.push(association);
    }
  }
  return associations;
}

function checkInheritedAssociation(
  sourceTypeId: string,
  associatedTypeId: string,
  associationMap: Map<string, MemberAssociation>,
  typeMap: ReadonlyMap<string, UmlEntityModel>,
): boolean {
  let inherited = false;
  const type = typeMap.get(sourceTypeId);
  for (const clause of type?.heritageClauses ?? []) {
    const base = typeMap.get(clause.clauseTypeId);
    if (!base) continue;
    inherited = associationMap.has(`${base.id}_${associatedTypeId}`);
    inherited = checkInheritedAssociation(base.id, associatedTypeId, associationMap, typeMap)
      || inherited;
    if (inherited) {
      const association = associationMap.get(`${sourceTypeId}_${associatedTypeId}`);
      if (association) association.inherited = true;
    }
  }
  return inherited;
}

export function parseUmlAssociations(declarations: readonly FileDeclaration[]): void {
  const associationMap = new Map<string, MemberAssociation>();
  const typeMap = new Map<string, UmlEntityModel>();
  for (const declaration of declarations) {
    for (const entity of declaration.classes) typeMap.set(entity.id, entity);
    for (const entity of declaration.interfaces) typeMap.set(entity.id, entity);
    for (const entity of declaration.types) typeMap.set(entity.id, entity);
    for (const entity of declaration.enums) typeMap.set(entity.id, entity);
  }
  for (const declaration of declarations) {
    declaration.memberAssociations = [
      ...declaration.classes.map((entity) => associationsOf(entity, associationMap, typeMap)),
      ...declaration.interfaces.map((entity) => associationsOf(entity, associationMap, typeMap)),
      ...declaration.types.map((entity) => associationsOf(entity, associationMap, typeMap)),
    ].flat();
  }
  for (const [id, association] of associationMap) {
    if (checkInheritedAssociation(association.a.typeId, association.b.typeId, associationMap, typeMap)) {
      associationMap.delete(id);
    }
  }
  for (const declaration of declarations) {
    declaration.memberAssociations = declaration.memberAssociations?.filter(
      (association) => !association.inherited,
    );
  }
}

export function removeSelfMemberAssociations(declarations: FileDeclaration[]): void {
  for (const declaration of declarations) {
    declaration.memberAssociations = declaration.memberAssociations?.filter(
      (association) => association.a.typeId !== association.b.typeId,
    );
  }
}
