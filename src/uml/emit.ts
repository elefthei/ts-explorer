import type { FileDefinition } from "../types.ts";
import type { UmlEntityModel, UmlModifier, UmlVisibility } from "./model.ts";
import { escapeMermaidLabel, escapeMethodReturnType, escapeStructuredType } from "./mermaid.ts";

/** One emitted compartment line. `definitionKey` is null for a synthetic method-return row. */
export type EmittedRow = { text: string; definitionKey: string | null };

export type EmittedBlock = {
  dsl: string;
  /** Emitted as its own `class id["label"]` statement, exactly like the previous renderer. */
  label: string;
  /** `.members-group` order: properties, or an enum's values. */
  attributes: EmittedRow[];
  /** `.methods-group` order, including synthetic return rows. */
  methods: EmittedRow[];
};

/**
 * Kinds Mermaid renders with their own stereotype. Every other kind — module, function, constant —
 * carries none: a box names its kind through its font colour, not a `<<kind>>` prefix row.
 */
const STEREOTYPE_BY_KIND: Record<string, string | undefined> = {
  interface: "interface",
  trait: "trait",
  struct: "struct",
  union: "union",
  enum: "enumeration",
  type: "type",
};

function applyModifiers(modifiers: readonly UmlModifier[], text: string): string {
  let result = modifiers.includes("private") ? "-" : modifiers.includes("protected") ? "#" : "+";
  result += text;
  // UML2: a static member is underlined, an abstract member is italic.
  if (modifiers.includes("static")) result += "$";
  if (modifiers.includes("abstract")) result += "*";
  return result;
}

function escapeMermaidRow(value: string): string {
  return value.replace(/[<>]/g, "~").replaceAll("{", "#123;").replaceAll("}", "#125;");
}

/**
 * One box. Nominal entities render their compartments; every other definition renders its native
 * kind plus, when Types is on, its declared type or signature.
 */
export function emitMermaidClassBlock(input: {
  nodeId: string;
  definition: FileDefinition;
  detail: UmlEntityModel | null;
  visibility: UmlVisibility;
}): EmittedBlock {
  const { nodeId, definition, detail, visibility } = input;
  const attributes: EmittedRow[] = [];
  const methods: EmittedRow[] = [];
  if (detail) {
    if (visibility.attributes) {
      for (const item of detail.items) {
        attributes.push({ text: escapeMermaidRow(item.value), definitionKey: item.definitionKey });
      }
      for (const property of detail.properties) {
        let text = property.name;
        const type = visibility.types ? escapeStructuredType(property.type) : undefined;
        if (type) text += `${property.optional ? "?" : ""}: ${escapeMermaidRow(type)}`;
        attributes.push({
          text: applyModifiers(property.modifiers, text),
          definitionKey: property.definitionKey,
        });
      }
    }
    if (visibility.methods) {
      for (const method of detail.methods) {
        methods.push({
          text: applyModifiers(method.modifiers, `${method.name}()`),
          definitionKey: method.definitionKey,
        });
        const returnRow = visibility.types ? escapeMethodReturnType(method.returnType) : undefined;
        if (returnRow) methods.push({ text: escapeMermaidRow(returnRow), definitionKey: null });
      }
    }
  } else if (visibility.types) {
    attributes.push({
      text: escapeMermaidRow(escapeStructuredType(definition.type ?? undefined) ?? "—"),
      definitionKey: null,
    });
  }

  const stereotype = STEREOTYPE_BY_KIND[detail?.kind ?? definition.kind];
  const body = [
    ...(stereotype ? [`<<${stereotype}>>`] : []),
    ...attributes.map((row) => row.text),
    ...methods.map((row) => row.text),
  ];
  const label = escapeMermaidLabel(
    (detail?.name ?? definition.name).replaceAll("<", "⟨").replaceAll(">", "⟩"),
  );
  const dsl = [
    `class ${nodeId} {`,
    ...body.map((line) => `  ${line}`),
    "}",
  ].join("\n");
  return { dsl, label, attributes, methods };
}
