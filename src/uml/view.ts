import type { UmlCategoryKind } from "../diagram-graph.ts";
import type { UmlExternalUser, UmlLocalUser } from "../types.ts";
import { emitMermaidClassDiagram } from "./emit.ts";
import { UML_ENTITY_COLLECTIONS } from "./entities.ts";
import { STYLE_DEFS, escapeMermaidLabel, mermaidEntityId } from "./mermaid.ts";
import type {
  FileDeclaration,
  UmlDependency,
  UmlEntityModel,
  UmlReference,
  UmlVisibility,
} from "./model.ts";

/** An importer node plus the flag that decides whether the Tests switch suppresses it. */
type UmlViewUser<Navigation> = {
  navigation: Navigation;
  targets: UmlReference[];
  test: boolean;
};

type UmlDslInput = {
  categories: ReadonlyMap<string, { category: UmlCategoryKind; test: boolean }>;
  methodReturnDependencies: readonly UmlDependency[];
  usageEdges: readonly UmlDependency[];
  localUserNodes: readonly UmlViewUser<UmlLocalUser>[];
  externalUserNodes: readonly UmlViewUser<UmlExternalUser>[];
};

function cloneMermaidEntity(entity: UmlEntityModel): UmlEntityModel {
  return {
    ...entity,
    name: mermaidEntityId(entity.name),
    heritageClauses: entity.heritageClauses.map((clause) => ({
      ...clause,
      className: mermaidEntityId(clause.className),
      clause: mermaidEntityId(clause.clause),
    })),
  };
}

function mermaidDeclarations(declarations: readonly FileDeclaration[]): FileDeclaration[] {
  return declarations.map((declaration) => {
    const result: FileDeclaration = {
      ...declaration,
      heritageClauses: declaration.heritageClauses.map((clauses) =>
        clauses.map((clause) => ({
          ...clause,
          className: mermaidEntityId(clause.className),
          clause: mermaidEntityId(clause.clause),
        }))
      ),
      memberAssociations: declaration.memberAssociations?.map((association) => ({
        ...association,
        a: { ...association.a, name: mermaidEntityId(association.a.name) },
        b: { ...association.b, name: mermaidEntityId(association.b.name) },
      })),
    };
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      result[descriptor.key] = descriptor.kind === "enum"
        ? declaration.enums.map((entity) => ({ ...entity, name: mermaidEntityId(entity.name) }))
        : declaration[descriptor.key].map((entity) => cloneMermaidEntity(entity));
    }
    return result;
  });
}

function formatUserNodeLabel(label: string, scopePath: string): string {
  const separator = `: ${scopePath}: `;
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex === -1) return escapeMermaidLabel(label);
  const signatureStart = separatorIndex + separator.length;
  return `${escapeMermaidLabel(label.slice(0, signatureStart - 2))}<br/>${escapeMermaidLabel(label.slice(signatureStart))}`;
}

function renderUmlDsl(
  declarations: readonly FileDeclaration[],
  model: UmlDslInput,
  visibility: UmlVisibility,
): string {
  const renderDeclarations = mermaidDeclarations(declarations);
  const labeledEntityIds = new Set<string>();
  const presentIds = new Set<string>();
  const presentNames = new Set<string>();
  let entityLabels = "";
  for (const declaration of declarations) {
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const entity of declaration[descriptor.key]) {
        presentIds.add(entity.id);
        presentNames.add(entity.name);
        const entityId = mermaidEntityId(entity.name);
        if (entityId === entity.name || labeledEntityIds.has(entityId)) continue;
        entityLabels += `\nclass ${entityId}["${escapeMermaidLabel(entity.name.replaceAll("<", "⟨").replaceAll(">", "⟩"))}"]`;
        labeledEntityIds.add(entityId);
      }
    }
  }
  let dsl = (presentIds.size
    ? emitMermaidClassDiagram(renderDeclarations, visibility).trimEnd()
    : "classDiagram") + entityLabels;

  for (const dependency of model.methodReturnDependencies) {
    if (!presentIds.has(dependency.sourceId) || !presentIds.has(dependency.targetId)) continue;
    dsl += `\n${mermaidEntityId(dependency.sourceName)} --> ${mermaidEntityId(dependency.targetName)}`;
  }
  for (const edge of model.usageEdges) {
    if (!presentIds.has(edge.sourceId) || !presentIds.has(edge.targetId)) continue;
    dsl += `\n${mermaidEntityId(edge.sourceName)} --> ${mermaidEntityId(edge.targetName)}`;
  }
  const emittedLocalIds: string[] = [];
  for (const local of model.localUserNodes) {
    if (!visibility.tests && local.test) continue;
    const targets = local.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, path } = local.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, path)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${mermaidEntityId(target.name)}`;
    emittedLocalIds.push(nodeId);
  }
  const emittedExternalIds: string[] = [];
  for (const external of model.externalUserNodes) {
    if (!visibility.tests && external.test) continue;
    const targets = external.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, scopePath } = external.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, scopePath)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${mermaidEntityId(target.name)}`;
    emittedExternalIds.push(nodeId);
  }
  dsl += `\n${STYLE_DEFS.map(([name, style]) => `classDef ${name} ${style}`).join("\n")}`;

  for (const [name, info] of [...model.categories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!presentNames.has(name)) continue;
    const category = info.test ? `test${info.category[0].toUpperCase()}${info.category.slice(1)}` : info.category;
    dsl += `\ncssClass "${mermaidEntityId(name)}" ${category}`;
  }
  for (const nodeId of emittedLocalIds) dsl += `\ncssClass "${nodeId}" local`;
  for (const nodeId of emittedExternalIds) dsl += `\ncssClass "${nodeId}" external`;
  return `${dsl}\n`;
}

/**
 * Keeps only the entities `keep` accepts, together with the heritage clauses and member
 * associations whose both ends survive. `emitMermaidClassDiagram` emits relation rows
 * unconditionally, and mermaid materialises a bare box for any name a relation references,
 * so dropping an entity without dropping its relations would resurrect it as an empty box.
 */
function sliceUmlDeclarations(
  declarations: readonly FileDeclaration[],
  keep: (entityId: string) => boolean,
): FileDeclaration[] {
  const sliced: FileDeclaration[] = [];
  for (const declaration of declarations) {
    const slicedDeclaration: FileDeclaration = {
      ...declaration,
      classes: declaration.classes.filter((entity) => keep(entity.id)),
      interfaces: declaration.interfaces.filter((entity) => keep(entity.id)),
      enums: declaration.enums.filter((entity) => keep(entity.id)),
      types: declaration.types.filter((entity) => keep(entity.id)),
      heritageClauses: declaration.heritageClauses
        .map((clauses) => clauses.filter(
          (clause) => keep(clause.classTypeId) && keep(clause.clauseTypeId),
        ))
        .filter((clauses) => clauses.length > 0),
      memberAssociations: declaration.memberAssociations?.filter(
        (association) => keep(association.a.typeId) && keep(association.b.typeId),
      ),
    };
    if (
      !slicedDeclaration.classes.length
      && !slicedDeclaration.interfaces.length
      && !slicedDeclaration.enums.length
      && !slicedDeclaration.types.length
    ) continue;
    sliced.push(slicedDeclaration);
  }
  return sliced;
}

/** The maximal UML model for one scope; the browser filters it per toggle state. */
export type UmlViewModel = {
  declarations: FileDeclaration[];
  /** Entity-id sets, one per community frame; empty means one frame over all declarations. */
  frames: string[][];
  /** Ids of entities declared in test files. */
  testEntityIds: string[];
  categories: { name: string; category: UmlCategoryKind; test: boolean }[];
  methodReturnDependencies: UmlDependency[];
  usageEdges: UmlDependency[];
  localUsers: UmlViewUser<UmlLocalUser>[];
  externalUsers: UmlViewUser<UmlExternalUser>[];
};

export const EMPTY_UML_VIEW_MODEL: UmlViewModel = {
  declarations: [],
  frames: [],
  testEntityIds: [],
  categories: [],
  methodReturnDependencies: [],
  usageEdges: [],
  localUsers: [],
  externalUsers: [],
};

export function renderUmlView(
  model: UmlViewModel,
  visibility: UmlVisibility,
): { dsl: string; dsls: string[] } {
  const input: UmlDslInput = {
    categories: new Map(
      model.categories.map((entry) => [entry.name, { category: entry.category, test: entry.test }]),
    ),
    methodReturnDependencies: model.methodReturnDependencies,
    usageEdges: model.usageEdges,
    localUserNodes: model.localUsers,
    externalUserNodes: model.externalUsers,
  };
  const hidden = visibility.tests ? null : new Set(model.testEntityIds);
  const visible = hidden
    ? sliceUmlDeclarations(model.declarations, (id) => !hidden.has(id))
    : model.declarations;
  const dsl = renderUmlDsl(visible, input, visibility);
  const frames: string[] = [];
  for (const frameIds of model.frames) {
    const ids = new Set(frameIds);
    const sliced = sliceUmlDeclarations(visible, (id) => ids.has(id));
    if (!sliced.length) continue;
    frames.push(renderUmlDsl(sliced, input, visibility));
  }
  return { dsl, dsls: frames.length ? frames : [dsl] };
}
