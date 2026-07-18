import type { FileDeclaration } from "tsuml2/dist/core/model";
import { UML_METHOD_RETURN_MARKER } from "../types.ts";

export const STYLE_DEFS = [
  ["interface", "fill:#183a66,stroke:#69d2ff,color:#f4f7fb"],
  ["abstract", "fill:#4e2a66,stroke:#d39cff,color:#f4f7fb"],
  ["concrete", "fill:#1d4d3b,stroke:#58d68d,color:#f4f7fb"],
  ["type", "fill:#654b1a,stroke:#f4c95d,color:#f4f7fb"],
  ["enum", "fill:#3f4652,stroke:#aab4c3,color:#f4f7fb"],
  ["testInterface", "fill:#183a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testAbstract", "fill:#4e2a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testConcrete", "fill:#1d4d3b,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testType", "fill:#654b1a,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testEnum", "fill:#3f4652,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["local", "fill:#3a2b52,stroke:#b58bff,color:#f4f7fb,stroke-dasharray: 2 3"],
  ["external", "fill:#2b3340,stroke:#8ba3bd,color:#f4f7fb,stroke-dasharray: 4 3"],
] as const;

export function escapeMermaidName(name: string): string {
  return name.replace(/[<>]/g, "~").replace("{", "#123;").replace("}", "#125;");
}

export function escapeMermaidLabel(label: string): string {
  return label.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function escapeStructuredType(type: string | undefined): string | undefined {
  return type
    ?.replace(/\s*\r?\n\s*/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "⟨")
    .replaceAll(">", "⟩")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝");
}

function escapeMethodReturnType(type: string | undefined): string | undefined {
  const escaped = escapeStructuredType(type);
  return escaped ? `\n${UML_METHOD_RETURN_MARKER}() ${escaped}` : undefined;
}

export function escapeStructuredMemberTypes(declarations: FileDeclaration[]): void {
  for (const declaration of declarations) {
    for (const entity of [...declaration.classes, ...declaration.interfaces, ...declaration.types]) {
      for (const property of entity.properties) property.type = escapeStructuredType(property.type);
      for (const method of entity.methods) method.returnType = escapeMethodReturnType(method.returnType);
    }
  }
}

export function removeSelfMemberAssociations(declarations: FileDeclaration[]): void {
  for (const declaration of declarations) {
    declaration.memberAssociations = declaration.memberAssociations?.filter(
      (association) => association.a.typeId !== association.b.typeId,
    );
  }
}

export function formatSignatureType(type: string | undefined): string {
  return (type?.replace(/\s*\r?\n\s*/g, " ").trim() || "unknown")
    .replaceAll("<", "⟨")
    .replace(/(?<!=)>/g, "⟩")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝");
}
