import type { FileDeclaration } from "tsuml2/dist/core/model";
import type { UmlDiagramGraph } from "../diagram-graph.ts";

type UmlEntityKind = UmlDiagramGraph["entities"][number]["entityKind"];

type UmlEntityCollectionDescriptor =
  | {
    kind: Extract<UmlEntityKind, "class">;
    structured: true;
    entities: (declaration: FileDeclaration) => FileDeclaration["classes"];
  }
  | {
    kind: Extract<UmlEntityKind, "interface">;
    structured: true;
    entities: (declaration: FileDeclaration) => FileDeclaration["interfaces"];
  }
  | {
    kind: Extract<UmlEntityKind, "enum">;
    structured: false;
    entities: (declaration: FileDeclaration) => FileDeclaration["enums"];
  }
  | {
    kind: Extract<UmlEntityKind, "type">;
    structured: true;
    entities: (declaration: FileDeclaration) => FileDeclaration["types"];
  };

export const UML_ENTITY_COLLECTIONS = [
  {
    kind: "class",
    structured: true,
    entities: (declaration: FileDeclaration) => declaration.classes,
  },
  {
    kind: "interface",
    structured: true,
    entities: (declaration: FileDeclaration) => declaration.interfaces,
  },
  {
    kind: "enum",
    structured: false,
    entities: (declaration: FileDeclaration) => declaration.enums,
  },
  {
    kind: "type",
    structured: true,
    entities: (declaration: FileDeclaration) => declaration.types,
  },
] as const satisfies readonly UmlEntityCollectionDescriptor[];
