import type { FileDeclaration } from "./model.ts";
import type { UmlEntityKind } from "../diagram-graph.ts";

export const UML_ENTITY_COLLECTIONS = [
  { kind: "class", key: "classes" },
  { kind: "interface", key: "interfaces" },
  { kind: "enum", key: "enums" },
  { kind: "type", key: "types" },
] as const satisfies readonly {
  kind: UmlEntityKind;
  key: keyof Pick<FileDeclaration, "classes" | "interfaces" | "enums" | "types">;
}[];
