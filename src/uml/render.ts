import { getMermaidDSL, type TsUML2Settings } from "tsuml2";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import { STYLE_DEFS, escapeMermaidLabel, mermaidEntityId, mermaidEntityLabel } from "./mermaid.ts";
import type {
  CategoryMap,
  ExternalUserNode,
  LocalUserNode,
  MethodReturnDependency,
  UmlUsageEdge,
} from "./model.ts";

function cloneWith<T extends object>(value: T, overrides: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(value)) as T, value, overrides);
}

function mermaidDeclarations(declarations: readonly FileDeclaration[]): FileDeclaration[] {
  return declarations.map((declaration) => cloneWith(declaration, {
    classes: declaration.classes.map((entity) => cloneWith(entity, {
      name: mermaidEntityId(entity.name),
      heritageClauses: entity.heritageClauses.map((clause) => cloneWith(clause, {
        className: mermaidEntityId(clause.className),
        clause: mermaidEntityId(clause.clause),
      })),
    })),
    interfaces: declaration.interfaces.map((entity) => cloneWith(entity, {
      name: mermaidEntityId(entity.name),
      heritageClauses: entity.heritageClauses.map((clause) => cloneWith(clause, {
        className: mermaidEntityId(clause.className),
        clause: mermaidEntityId(clause.clause),
      })),
    })),
    enums: declaration.enums.map((entity) => cloneWith(entity, {
      name: mermaidEntityId(entity.name),
    })),
    types: declaration.types.map((entity) => cloneWith(entity, {
      name: mermaidEntityId(entity.name),
      heritageClauses: entity.heritageClauses.map((clause) => cloneWith(clause, {
        className: mermaidEntityId(clause.className),
        clause: mermaidEntityId(clause.clause),
      })),
    })),
    heritageClauses: declaration.heritageClauses.map((clauses) =>
      clauses.map((clause) => cloneWith(clause, {
        className: mermaidEntityId(clause.className),
        clause: mermaidEntityId(clause.clause),
      }))
    ),
    memberAssociations: declaration.memberAssociations?.map((association) => cloneWith(association, {
      a: cloneWith(association.a, { name: mermaidEntityId(association.a.name) }),
      b: cloneWith(association.b, { name: mermaidEntityId(association.b.name) }),
    })),
  }));
}

function formatUserNodeLabel(label: string, scopePath: string): string {
  const separator = `: ${scopePath}: `;
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex === -1) return escapeMermaidLabel(label);
  const signatureStart = separatorIndex + separator.length;
  return `${escapeMermaidLabel(label.slice(0, signatureStart - 2))}<br/>${escapeMermaidLabel(label.slice(signatureStart))}`;
}

export function renderUmlDsl(
  declarations: FileDeclaration[],
  settings: TsUML2Settings,
  categories: CategoryMap,
  methodReturnDependencies: readonly MethodReturnDependency[],
  usageEdges: readonly UmlUsageEdge[],
  localUserNodes: readonly LocalUserNode[],
  externalUserNodes: readonly ExternalUserNode[],
): string {
  const renderDeclarations = mermaidDeclarations(declarations);
  const hasEntities = renderDeclarations.some((declaration) =>
    declaration.classes.length > 0
    || declaration.interfaces.length > 0
    || declaration.enums.length > 0
    || declaration.types.length > 0
  );
  let dsl = hasEntities ? getMermaidDSL(renderDeclarations, settings).trimEnd() : "classDiagram";

  const labeledEntityIds = new Set<string>();
  for (const declaration of declarations) {
    for (const entity of [
      ...declaration.classes,
      ...declaration.interfaces,
      ...declaration.enums,
      ...declaration.types,
    ]) {
      const entityId = mermaidEntityId(entity.name);
      if (entityId === entity.name || labeledEntityIds.has(entityId)) continue;
      dsl += `\nclass ${entityId}["${mermaidEntityLabel(entity.name)}"]`;
      labeledEntityIds.add(entityId);
    }
  }

  const presentIds = new Set<string>();
  const presentNames = new Set<string>();
  for (const declaration of declarations) {
    for (const entity of declaration.classes) {
      presentIds.add(entity.id);
      presentNames.add(entity.name);
    }
    for (const entity of declaration.interfaces) {
      presentIds.add(entity.id);
      presentNames.add(entity.name);
    }
    for (const entity of declaration.enums) {
      presentIds.add(entity.id);
      presentNames.add(entity.name);
    }
    for (const entity of declaration.types) {
      presentIds.add(entity.id);
      presentNames.add(entity.name);
    }
  }

  for (const dependency of methodReturnDependencies) {
    if (!presentIds.has(dependency.sourceId) || !presentIds.has(dependency.targetId)) continue;
    dsl += `\n${mermaidEntityId(dependency.sourceName)} --> ${mermaidEntityId(dependency.targetName)}`;
  }
  for (const edge of usageEdges) {
    if (!presentIds.has(edge.sourceId) || !presentIds.has(edge.targetId)) continue;
    dsl += `\n${mermaidEntityId(edge.sourceName)} --> ${mermaidEntityId(edge.targetName)}`;
  }
  const emittedLocalIds: string[] = [];
  for (const local of localUserNodes) {
    const targets = local.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, path } = local.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, path)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${mermaidEntityId(target.name)}`;
    emittedLocalIds.push(nodeId);
  }
  const emittedExternalIds: string[] = [];
  for (const external of externalUserNodes) {
    const targets = external.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, scopePath } = external.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, scopePath)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${mermaidEntityId(target.name)}`;
    emittedExternalIds.push(nodeId);
  }
  dsl += "\n" + STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n");

  for (const [name, info] of [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!presentNames.has(name)) continue;
    const category = info.test ? `test${info.category[0].toUpperCase()}${info.category.slice(1)}` : info.category;
    dsl += `\ncssClass "${mermaidEntityId(name)}" ${category}`;
  }
  for (const nodeId of emittedLocalIds) dsl += `\ncssClass "${nodeId}" local`;
  for (const nodeId of emittedExternalIds) dsl += `\ncssClass "${nodeId}" external`;
  return dsl + "\n";
}
