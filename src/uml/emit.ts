import {
  type FileDeclaration,
  type HeritageClause,
  type MemberAssociation,
  type MethodDetails,
  type PropertyDetails,
  UML_MODIFIER_ABSTRACT,
  UML_MODIFIER_PRIVATE,
  UML_MODIFIER_PROTECTED,
  UML_MODIFIER_STATIC,
  type UmlEntityModel,
} from "./model.ts";

// Ported verbatim from tsuml2's mermaid template: the brace replacements are deliberately
// non-global, and every space in the class/interface/type/enum templates is load-bearing.
function escapeMermaid(value: string): string {
  return value.replace(/[<>]/g, "~").replace("{", "#123;").replace("}", "#125;");
}

function applyModifiers(modifierFlags: number, text: string): string {
  let result = "";
  if (modifierFlags & UML_MODIFIER_PRIVATE) result = "-";
  else if (modifierFlags & UML_MODIFIER_PROTECTED) result = "#";
  else result = "+";
  result += text;
  // UML2: a static member is underlined, an abstract member is italic.
  if (modifierFlags & UML_MODIFIER_STATIC) result += "$";
  if (modifierFlags & UML_MODIFIER_ABSTRACT) result += "*";
  return result;
}

function propertyRow(property: PropertyDetails): string {
  let result = property.name;
  if (property.type) {
    if (property.optional) result += "?";
    result += `: ${escapeMermaid(property.type)}`;
  }
  return applyModifiers(property.modifierFlags, result);
}

function methodRow(method: MethodDetails): string {
  let result = `${method.name}()`;
  if (method.returnType) result += ` ${escapeMermaid(method.returnType)}`;
  return applyModifiers(method.modifierFlags, result);
}

function members(entity: UmlEntityModel): { props: string; methods: string } {
  return {
    props: entity.properties.map(propertyRow).join("\n"),
    methods: entity.methods.map(methodRow).join("\n"),
  };
}

function classBlock(entity: UmlEntityModel): string {
  const { props, methods } = members(entity);
  return `class ${escapeMermaid(entity.name)}{
            ${props}
            ${methods}
        }`;
}

function structuredBlock(entity: UmlEntityModel, stereotype: "interface" | "type"): string {
  const { props, methods } = members(entity);
  return `class ${escapeMermaid(entity.name)} {
            <<${stereotype}>>
            ${props}
            ${methods}
        }`;
}

function enumBlock(entity: UmlEntityModel): string {
  return `class ${escapeMermaid(entity.name)} {
        <<enumeration>>
        ${entity.items.join("\n")}
      }`;
}

function heritageRow(clause: HeritageClause): string {
  const separator = clause.type === 0 ? "<|--" : "<|..";
  return `${escapeMermaid(clause.clause)}${separator}${escapeMermaid(clause.className)}`;
}

function associationRow(association: MemberAssociation): string {
  const multiplicityA = association.a.multiplicity ? `"${association.a.multiplicity}"` : "";
  const multiplicityB = association.b.multiplicity ? `"${association.b.multiplicity}"` : "";
  return `${escapeMermaid(association.a.name)} ${multiplicityA} -- ${multiplicityB} ${
    escapeMermaid(association.b.name)
  }`;
}

export function emitMermaidClassDiagram(declarations: readonly FileDeclaration[]): string {
  const entities = declarations.flatMap((declaration) => [
    ...declaration.classes.map(classBlock),
    ...declaration.interfaces.map((entity) => structuredBlock(entity, "interface")),
    ...declaration.enums.map(enumBlock),
    ...declaration.types.map((entity) => structuredBlock(entity, "type")),
    ...declaration.heritageClauses.flat().map(heritageRow),
    ...(declaration.memberAssociations ?? []).map(associationRow),
  ]);
  if (entities.length === 0) entities.push("[Could not process any class / interface / enum / type]");
  // tsuml2's header is `'\nclassDiagram\n' + settings.mermaid.join("\n") + '\n'`, joined to the
  // body with one more newline; `settings.mermaid` was always empty.
  return `\nclassDiagram\n\n\n${entities.join("\n")}`;
}
