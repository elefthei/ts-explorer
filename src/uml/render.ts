import { getMermaidDSL, type TsUML2Settings } from "tsuml2";
import type { FileDeclaration } from "tsuml2/dist/core/model";
import { STYLE_DEFS, escapeMermaidLabel, escapeMermaidName } from "./mermaid.ts";
import type {
  CategoryMap,
  ExternalUserNode,
  LocalUserNode,
  MethodReturnDependency,
  UmlUsageEdge,
} from "./model.ts";

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
  let dsl = declarations.length ? getMermaidDSL(declarations, settings).trimEnd() : "classDiagram";

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
    dsl += `\n${escapeMermaidName(dependency.sourceName)} --> ${escapeMermaidName(dependency.targetName)}`;
  }
  for (const edge of usageEdges) {
    if (!presentIds.has(edge.sourceId) || !presentIds.has(edge.targetId)) continue;
    dsl += `\n${escapeMermaidName(edge.sourceName)} --> ${escapeMermaidName(edge.targetName)}`;
  }
  const emittedLocalIds: string[] = [];
  for (const local of localUserNodes) {
    const targets = local.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, path } = local.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, path)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${escapeMermaidName(target.name)}`;
    emittedLocalIds.push(nodeId);
  }
  const emittedExternalIds: string[] = [];
  for (const external of externalUserNodes) {
    const targets = external.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, scopePath } = external.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, scopePath)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${escapeMermaidName(target.name)}`;
    emittedExternalIds.push(nodeId);
  }
  dsl += "\n" + STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n");

  for (const [name, info] of [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!presentNames.has(name)) continue;
    const category = info.test ? `test${info.category[0].toUpperCase()}${info.category.slice(1)}` : info.category;
    dsl += `\ncssClass "${escapeMermaidName(name)}" ${category}`;
  }
  for (const nodeId of emittedLocalIds) dsl += `\ncssClass "${nodeId}" local`;
  for (const nodeId of emittedExternalIds) dsl += `\ncssClass "${nodeId}" external`;
  return dsl + "\n";
}
