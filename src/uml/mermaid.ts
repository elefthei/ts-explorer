import { UML_METHOD_RETURN_MARKER } from "../types.ts";

export const STYLE_DEFS = [
  ["interface", "fill:#183a66,stroke:#69d2ff,color:#f4f7fb"],
  ["abstract", "fill:#4e2a66,stroke:#d39cff,color:#f4f7fb"],
  ["concrete", "fill:#1d4d3b,stroke:#58d68d,color:#f4f7fb"],
  ["type", "fill:#654b1a,stroke:#f4c95d,color:#f4f7fb"],
  ["enum", "fill:#3f4652,stroke:#aab4c3,color:#f4f7fb"],
  ["plain", "fill:#2b313b,stroke:#8fa0b6,color:#f4f7fb"],
  ["testInterface", "fill:#183a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testAbstract", "fill:#4e2a66,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testConcrete", "fill:#1d4d3b,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testType", "fill:#654b1a,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testEnum", "fill:#3f4652,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["testPlain", "fill:#2b313b,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["rootNode", "stroke:#f4f7fb,stroke-width:4px"],
] as const;

export const FILE_STYLE_DEFS = [
  ["file", "fill:#1d4d3b,stroke:#58d68d,color:#f4f7fb"],
  ["testFile", "fill:#1d4d3b,stroke:#ff5c5c,color:#f4f7fb,stroke-dasharray: 6 4"],
  ["boundaryFile", "fill:#2b313b,stroke:#8fa0b6,color:#f4f7fb,stroke-dasharray: 6 4"],
] as const;

/** Source-derived text becomes one safe Mermaid label line; a filename cannot add a statement. */
export function escapeMermaidLabel(label: string): string {
  return label
    .replace(/\s*\r?\n\s*/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
}

function stripImportTypeQualifiers(type: string): string {
  return type.replace(/import\((?:"[^"]*"|'[^']*')\)\./g, "");
}

/** Pure: callers escape while emitting a visible row and never mutate a cached model. */
export function escapeStructuredType(type: string | undefined): string | undefined {
  return type === undefined
    ? undefined
    : stripImportTypeQualifiers(type)
      .replace(/\s*\r?\n\s*/g, " ")
      .trim()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "⟨")
      .replaceAll(">", "⟩")
      .replaceAll("{", "｛")
      .replaceAll("}", "｝")
      .replaceAll("(", "（")
      .replaceAll(")", "）");
}

export function escapeMethodReturnType(type: string | undefined): string | undefined {
  const escaped = escapeStructuredType(type);
  return escaped ? `${UML_METHOD_RETURN_MARKER}() ${escaped}` : undefined;
}
