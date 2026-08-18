import type { Node } from "@vscode/tree-sitter-wasm";
import { bareUmlName, syntheticTypeId, umlEntityKey } from "./keys.ts";
import type {
  FileDeclaration,
  HeritageClause,
  PendingTypeReference,
  UmlEntityModel,
  UmlReference,
} from "./model.ts";

export type EntityCollection = "classes" | "interfaces" | "enums" | "types";

export type DeclarationBuilder = {
  /** Creates the entity, files it under `collection`, and registers it in the project entity map. */
  entity(renderedName: string, collection: EntityCollection): UmlEntityModel;
  memberTypes(annotation: Node, assign: (typeIds: string[]) => void): void;
  /** `base` must already be unwrapped to the bare type node the resolver should look up. */
  heritage(entity: UmlEntityModel, base: Node, relation: HeritageClause["relation"]): void;
  finish(): FileDeclaration;
};

/**
 * The one place a `FileDeclaration` is assembled: both the TypeScript and the Rust parser build
 * entities, member type references and heritage clauses through this, so the two languages cannot
 * drift into two shapes of the same model.
 */
export function createDeclarationBuilder(
  fileName: string,
  entities: Map<string, UmlReference>,
  pending: PendingTypeReference[],
): DeclarationBuilder {
  const declaration: FileDeclaration = {
    fileName,
    classes: [],
    interfaces: [],
    enums: [],
    types: [],
    heritageClauses: [],
  };
  return {
    entity(renderedName, collection) {
      const entity: UmlEntityModel = {
        name: renderedName,
        id: syntheticTypeId(fileName, renderedName),
        properties: [],
        methods: [],
        heritageClauses: [],
        items: [],
      };
      declaration[collection].push(entity);
      entities.set(umlEntityKey(fileName, bareUmlName(renderedName)), {
        id: entity.id,
        name: entity.name,
      });
      return entity;
    },
    memberTypes(annotation, assign) {
      pending.push({ kind: "member", file: fileName, annotation, assign });
    },
    heritage(entity, base, relation) {
      const clause: HeritageClause = {
        clause: "",
        clauseTypeId: "",
        className: entity.name,
        classTypeId: entity.id,
        relation,
      };
      entity.heritageClauses.push(clause);
      pending.push({ kind: "heritage", file: fileName, base, clause });
    },
    finish() {
      for (const entity of [...declaration.classes, ...declaration.interfaces]) {
        if (entity.heritageClauses.length) declaration.heritageClauses.push(entity.heritageClauses);
      }
      return declaration;
    },
  };
}
