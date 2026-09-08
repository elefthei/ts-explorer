import type {
  FileDeclaration,
  HeritageClause,
  MemberAssociation,
  MethodDetails,
  PropertyDetails,
  UmlEntityModel,
  UmlModifier,
  UmlVisibility,
} from "./model.ts";

// Ported verbatim from tsuml2's mermaid template: the brace replacements are deliberately
// non-global, and every space in the class/interface/type/enum templates is load-bearing.
function escapeMermaid(value: string): string {
  return value.replace(/[<>]/g, "~").replace("{", "#123;").replace("}", "#125;");
}

function applyModifiers(modifiers: readonly UmlModifier[], text: string): string {
  let result = "";
  if (modifiers.includes("private")) result = "-";
  else if (modifiers.includes("protected")) result = "#";
  else result = "+";
  result += text;
  // UML2: a static member is underlined, an abstract member is italic.
  if (modifiers.includes("static")) result += "$";
  if (modifiers.includes("abstract")) result += "*";
  return result;
}

function propertyRow(property: PropertyDetails, types: boolean): string {
  let result = property.name;
  if (types && property.type) {
    if (property.optional) result += "?";
    result += `: ${escapeMermaid(property.type)}`;
  }
  return applyModifiers(property.modifiers, result);
}

function methodRow(method: MethodDetails, types: boolean): string {
  let result = `${method.name}()`;
  if (types && method.returnType) result += ` ${escapeMermaid(method.returnType)}`;
  return applyModifiers(method.modifiers, result);
}

function members(entity: UmlEntityModel, visibility: UmlVisibility): { props: string; methods: string } {
  return {
    props: visibility.attributes
      ? entity.properties.map((property) => propertyRow(property, visibility.types)).join("\n")
      : "",
    methods: visibility.methods
      ? entity.methods.map((method) => methodRow(method, visibility.types)).join("\n")
      : "",
  };
}

function classBlock(entity: UmlEntityModel, visibility: UmlVisibility): string {
  const { props, methods } = members(entity, visibility);
  return `class ${escapeMermaid(entity.name)}{
            ${props}
            ${methods}
        }`;
}

function structuredBlock(entity: UmlEntityModel, stereotype: "interface" | "type", visibility: UmlVisibility): string {
  const { props, methods } = members(entity, visibility);
  return `class ${escapeMermaid(entity.name)} {
            <<${stereotype}>>
            ${props}
            ${methods}
        }`;
}

function enumBlock(entity: UmlEntityModel, visibility: UmlVisibility): string {
  return `class ${escapeMermaid(entity.name)} {
        <<enumeration>>
        ${visibility.attributes ? entity.items.join("\n") : ""}
      }`;
}

function heritageRow(clause: HeritageClause): string {
  const separator = clause.relation === "extends" ? "<|--" : "<|..";
  return `${escapeMermaid(clause.clause)}${separator}${escapeMermaid(clause.className)}`;
}

function associationRow(association: MemberAssociation): string {
  const multiplicityA = association.a.multiplicity ? `"${association.a.multiplicity}"` : "";
  const multiplicityB = association.b.multiplicity ? `"${association.b.multiplicity}"` : "";
  return `${escapeMermaid(association.a.name)} ${multiplicityA} -- ${multiplicityB} ${
    escapeMermaid(association.b.name)
  }`;
}

export function emitMermaidClassDiagram(
  declarations: readonly FileDeclaration[],
  visibility: UmlVisibility,
): string {
  const entities = declarations.flatMap((declaration) => [
    ...declaration.classes.map((entity) => classBlock(entity, visibility)),
    ...declaration.interfaces.map((entity) => structuredBlock(entity, "interface", visibility)),
    ...declaration.enums.map((entity) => enumBlock(entity, visibility)),
    ...declaration.types.map((entity) => structuredBlock(entity, "type", visibility)),
    ...declaration.heritageClauses.flat().map(heritageRow),
    ...(declaration.memberAssociations ?? []).map(associationRow),
  ]);
  if (entities.length === 0) entities.push("[Could not process any class / interface / enum / type]");
  // tsuml2's header is `'\nclassDiagram\n' + settings.mermaid.join("\n") + '\n'`, joined to the
  // body with one more newline; `settings.mermaid` was always empty.
  return `\nclassDiagram\n\n\n${entities.join("\n")}`;
}
