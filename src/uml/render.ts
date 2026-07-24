import { getMermaidDSL, TsUML2Settings } from "tsuml2";
import {
  Clazz,
  Enum,
  Interface,
  MemberAssociation,
  TypeAlias,
  type FileDeclaration,
  type HeritageClause,
  type MethodDetails,
  type PropertyDetails,
} from "tsuml2/dist/core/model";
import {
  DIAGRAM_GRAPH_FORMAT_VERSION,
  type RenderedDiagram,
  type UmlDiagramGraph,
} from "../diagram-graph.ts";
import { hydrateUmlGraph, type UmlGraph } from "./graph.ts";
import { UML_ENTITY_COLLECTIONS } from "./entities.ts";
import { STYLE_DEFS, escapeMermaidLabel, mermaidEntityId, mermaidEntityLabel } from "./mermaid.ts";
import type {
  CategoryMap,
  ExternalUserNode,
  LocalUserNode,
  UmlDependency,
} from "./model.ts";

type UmlEntityKind = UmlDiagramGraph["entities"][number]["entityKind"];

function cloneWith<T extends object>(value: T, overrides: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(value)) as T, value, overrides);
}

type StructuredEntityInstance = Clazz | Interface | TypeAlias;

type RenderInput = {
  settings: TsUML2Settings;
  categories: CategoryMap;
  methodReturnDependencies: readonly UmlDependency[];
  usageEdges: readonly UmlDependency[];
  localUserNodes: readonly LocalUserNode[];
  externalUserNodes: readonly ExternalUserNode[];
};

function cloneMermaidEntity<T extends StructuredEntityInstance>(entity: T): T {
  const clone = cloneWith(entity, {});
  clone.name = mermaidEntityId(entity.name);
  clone.heritageClauses = entity.heritageClauses.map((clause) => cloneWith(clause, {
    className: mermaidEntityId(clause.className),
    clause: mermaidEntityId(clause.clause),
  }));
  return clone;
}

function mermaidDeclarations(declarations: readonly FileDeclaration[]): FileDeclaration[] {
  return declarations.map((declaration) => {
    const result = cloneWith(declaration, {
      classes: [],
      interfaces: [],
      enums: [],
      types: [],
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
    });
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      if (descriptor.kind === "enum") {
        result.enums.push(...descriptor.entities(declaration).map((entity) => cloneWith(entity, {
          name: mermaidEntityId(entity.name),
        })));
      } else if (descriptor.kind === "class") {
        result.classes.push(...descriptor.entities(declaration).map(
          (entity) => cloneMermaidEntity(entity)
        ));
      } else if (descriptor.kind === "interface") {
        result.interfaces.push(...descriptor.entities(declaration).map(
          (entity) => cloneMermaidEntity(entity)
        ));
      } else {
        result.types.push(...descriptor.entities(declaration).map(
          (entity) => cloneMermaidEntity(entity)
        ));
      }
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
  declarations: FileDeclaration[],
  model: RenderInput,
): string {
  const renderDeclarations = mermaidDeclarations(declarations);
  const labeledEntityIds = new Set<string>();
  const presentIds = new Set<string>();
  const presentNames = new Set<string>();
  let entityLabels = "";
  for (const declaration of declarations) {
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const entity of descriptor.entities(declaration)) {
        presentIds.add(entity.id);
        presentNames.add(entity.name);
        const entityId = mermaidEntityId(entity.name);
        if (entityId === entity.name || labeledEntityIds.has(entityId)) continue;
        entityLabels += `\nclass ${entityId}["${mermaidEntityLabel(entity.name)}"]`;
        labeledEntityIds.add(entityId);
      }
    }
  }
  let dsl = (presentIds.size
    ? getMermaidDSL(renderDeclarations, model.settings).trimEnd()
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
    const targets = local.targets.filter((target) => presentIds.has(target.id));
    if (!targets.length) continue;
    const { nodeId, label, path } = local.navigation;
    dsl += `\nclass ${nodeId}["${formatUserNodeLabel(label, path)}"]`;
    for (const target of targets) dsl += `\n${nodeId} --> ${mermaidEntityId(target.name)}`;
    emittedLocalIds.push(nodeId);
  }
  const emittedExternalIds: string[] = [];
  for (const external of model.externalUserNodes) {
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

function partitionUmlCommunities(
  declarations: FileDeclaration[],
  graph: UmlGraph,
): FileDeclaration[][] {
  const communityIds = new Map<number, Set<string>>();
  const register = (id: string): void => {
    if (!graph.hasNode(id)) throw new Error(`Missing UML graph entity node: ${id}`);
    const attributes = graph.getNodeAttributes(id);
    const community = attributes.community;
    if (attributes.kind !== "entity" || community === undefined || !Number.isInteger(community)) {
      throw new Error(`Missing UML graph community for entity: ${id}`);
    }
    let ids = communityIds.get(community);
    if (!ids) {
      ids = new Set<string>();
      communityIds.set(community, ids);
    }
    ids.add(id);
  };

  for (const declaration of declarations) {
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const entity of descriptor.entities(declaration)) register(entity.id);
    }
  }

  if (!communityIds.size) return [];
  if (communityIds.size === 1) return [declarations];

  const communities: FileDeclaration[][] = [];
  for (const baseIds of communityIds.values()) {
    const ids = new Set<string>();
    const includeNode = (id: string): void => {
      ids.add(id);
      for (const alias of graph.getNodeAttributes(id).aliases ?? []) ids.add(alias);
    };
    for (const id of baseIds) {
      includeNode(id);
      for (const neighbor of graph.neighbors(id)) {
        const { kind } = graph.getNodeAttributes(neighbor);
        if (kind === "entity" || kind === "boundary") includeNode(neighbor);
      }
    }

    const communityDeclarations: FileDeclaration[] = [];
    for (const declaration of declarations) {
      const communityDeclaration: FileDeclaration = {
        ...declaration,
        classes: declaration.classes.filter((entity) => ids.has(entity.id)),
        interfaces: declaration.interfaces.filter((entity) => ids.has(entity.id)),
        enums: declaration.enums.filter((entity) => ids.has(entity.id)),
        types: declaration.types.filter((entity) => ids.has(entity.id)),
        heritageClauses: declaration.heritageClauses
          .map((clauses) => clauses.filter(
            (clause) => ids.has(clause.classTypeId) && ids.has(clause.clauseTypeId),
          ))
          .filter((clauses) => clauses.length > 0),
        memberAssociations: declaration.memberAssociations?.filter(
          (association) => ids.has(association.a.typeId) && ids.has(association.b.typeId),
        ),
      };
      if (
        !communityDeclaration.classes.length
        && !communityDeclaration.interfaces.length
        && !communityDeclaration.enums.length
        && !communityDeclaration.types.length
      ) continue;
      communityDeclarations.push(communityDeclaration);
    }
    if (communityDeclarations.length) communities.push(communityDeclarations);
  }
  return communities;
}

type EntityInstance = StructuredEntityInstance | Enum;


const UML_ENTITY_KINDS = new Set(UML_ENTITY_COLLECTIONS.map(({ kind }) => kind));
const UML_CATEGORY_KINDS = new Set(["interface", "type", "enum", "abstract", "concrete"]);
const UML_USER_KINDS = new Set([
  "method",
  "constructor",
  "property",
  "class",
  "function",
  "variable",
  "type",
  "export",
]);

function rowKey(...parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

type EntityOccurrence = {
  declarationOrdinal: number;
  entityKind: UmlEntityKind;
  entityOrdinal: number;
};
type PropertyOccurrence = EntityOccurrence & { propertyOrdinal: number };
type MethodOccurrence = EntityOccurrence & { methodOrdinal: number };

function entityOccurrenceKey(row: EntityOccurrence): string {
  return rowKey(row.declarationOrdinal, row.entityKind, row.entityOrdinal);
}

function propertyOccurrenceKey(row: PropertyOccurrence): string {
  return rowKey(row.declarationOrdinal, row.entityKind, row.entityOrdinal, row.propertyOrdinal);
}

function methodOccurrenceKey(row: MethodOccurrence): string {
  return rowKey(row.declarationOrdinal, row.entityKind, row.entityOrdinal, row.methodOrdinal);
}

function assertString(value: unknown, description: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid ${description}`);
  }
}

function assertBoolean(value: unknown, description: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${description}`);
}

function assertNonnegativeInteger(value: unknown, description: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${description}`);
}

function assertPositiveInteger(value: unknown, description: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${description}`);
}

function assertOrderedOrdinals<T>(
  rows: readonly T[],
  group: (row: T) => string,
  ordinal: (row: T) => number,
  description: string,
): void {
  const expectedByGroup = new Map<string, number>();
  for (const row of rows) {
    const key = group(row);
    const expected = expectedByGroup.get(key) ?? 0;
    if (!Number.isInteger(ordinal(row)) || ordinal(row) !== expected) {
      throw new Error(`Invalid ${description} ordinal: expected ${expected}, received ${ordinal(row)}`);
    }
    expectedByGroup.set(key, expected + 1);
  }
}

function grouped<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(key(row));
    if (group) group.push(row);
    else result.set(key(row), [row]);
  }
  return result;
}

function orderedGroups<Row>(
  rows: readonly Row[],
  group: (row: Row) => string,
  ordinal: (row: Row) => number,
  description: string,
): Map<string, Row[]> {
  assertOrderedOrdinals(rows, group, ordinal, description);
  return grouped(rows, group);
}

function hydrateDependencies(
  rows: readonly (
    | UmlDiagramGraph["methodReturnDependencies"][number]
    | UmlDiagramGraph["usageEdges"][number]
  )[],
  ordinalDescription: string,
  fieldDescription: string,
): UmlDependency[] {
  assertOrderedOrdinals(
    rows,
    () => ordinalDescription,
    (dependency) => dependency.dependencyOrdinal,
    ordinalDescription,
  );
  return rows.map((dependency) => {
    assertString(dependency.sourceId, `${fieldDescription} source ID`);
    assertString(dependency.sourceName, `${fieldDescription} source name`);
    assertString(dependency.targetId, `${fieldDescription} target ID`);
    assertString(dependency.targetName, `${fieldDescription} target name`);
    return {
      sourceId: dependency.sourceId,
      sourceName: dependency.sourceName,
      targetId: dependency.targetId,
      targetName: dependency.targetName,
    };
  });
}

function hydrateStructuredMembers(
  entitiesByOccurrence: ReadonlyMap<string, UmlDiagramGraph["entities"][number]>,
  properties: UmlDiagramGraph["properties"],
  propertyTypeIdRows: UmlDiagramGraph["propertyTypeIds"],
  methods: UmlDiagramGraph["methods"],
  methodReturnTypeIdRows: UmlDiagramGraph["methodReturnTypeIds"],
): ReadonlyMap<string, { properties: PropertyDetails[]; methods: MethodDetails[] }> {
  const result = new Map<string, { properties: PropertyDetails[]; methods: MethodDetails[] }>();
  for (const [key, entity] of entitiesByOccurrence) {
    if (entity.entityKind !== "enum") result.set(key, { properties: [], methods: [] });
  }

  assertOrderedOrdinals(
    properties,
    (property) => entityOccurrenceKey(property),
    (property) => property.propertyOrdinal,
    "UML property",
  );
  const propertyDetails = new Map<string, PropertyDetails>();
  for (const property of properties) {
    const entityKey = entityOccurrenceKey(property);
    const entity = entitiesByOccurrence.get(entityKey);
    const members = result.get(entityKey);
    if (!entity || entity.entityKind === "enum" || !members) {
      throw new Error(`Invalid UML property parent: ${entityKey}`);
    }
    assertNonnegativeInteger(property.modifierFlags, "UML property modifier flags");
    assertString(property.name, "UML property name");
    if (property.type !== null) assertString(property.type, "UML property type", true);
    assertBoolean(property.optional, "UML property optional flag");
    const key = propertyOccurrenceKey(property);
    if (propertyDetails.has(key)) throw new Error(`Duplicate UML property occurrence: ${key}`);
    const details: PropertyDetails = {
      modifierFlags: property.modifierFlags,
      name: property.name,
      ...(property.type === null ? {} : { type: property.type }),
      typeIds: [],
      optional: property.optional,
    };
    propertyDetails.set(key, details);
    members.properties.push(details);
  }

  const propertyTypeIds = orderedGroups(
    propertyTypeIdRows,
    (typeId) => propertyOccurrenceKey(typeId),
    (typeId) => typeId.typeIdOrdinal,
    "UML property type ID",
  );
  for (const [key, typeIds] of propertyTypeIds) {
    const property = propertyDetails.get(key);
    if (!property) throw new Error(`Missing UML property for type IDs: ${key}`);
    for (const typeId of typeIds) assertString(typeId.typeId, "UML property type ID");
    property.typeIds.push(...typeIds.map(({ typeId }) => typeId));
  }

  assertOrderedOrdinals(
    methods,
    (method) => entityOccurrenceKey(method),
    (method) => method.methodOrdinal,
    "UML method",
  );
  const methodDetails = new Map<string, MethodDetails>();
  for (const method of methods) {
    const entityKey = entityOccurrenceKey(method);
    const entity = entitiesByOccurrence.get(entityKey);
    const members = result.get(entityKey);
    if (!entity || entity.entityKind === "enum" || !members) {
      throw new Error(`Invalid UML method parent: ${entityKey}`);
    }
    assertNonnegativeInteger(method.modifierFlags, "UML method modifier flags");
    assertString(method.name, "UML method name");
    if (method.returnType !== null) assertString(method.returnType, "UML method return type", true);
    assertBoolean(method.returnTypeIdsPresent, "UML method return type ID presence flag");
    const key = methodOccurrenceKey(method);
    if (methodDetails.has(key)) throw new Error(`Duplicate UML method occurrence: ${key}`);
    const details: MethodDetails = {
      modifierFlags: method.modifierFlags,
      name: method.name,
      ...(method.returnType === null ? {} : { returnType: method.returnType }),
      ...(method.returnTypeIdsPresent ? { returnTypeIds: [] } : {}),
    };
    methodDetails.set(key, details);
    members.methods.push(details);
  }

  const methodReturnTypeIds = orderedGroups(
    methodReturnTypeIdRows,
    (typeId) => methodOccurrenceKey(typeId),
    (typeId) => typeId.typeIdOrdinal,
    "UML method return type ID",
  );
  for (const [key, typeIds] of methodReturnTypeIds) {
    const method = methodDetails.get(key);
    if (!method?.returnTypeIds) throw new Error(`Invalid UML method return type IDs: ${key}`);
    for (const typeId of typeIds) assertString(typeId.typeId, "UML method return type ID");
    method.returnTypeIds.push(...typeIds.map(({ typeId }) => typeId));
  }
  return result;
}

type TopologyNodes = ReadonlyMap<string, UmlDiagramGraph["nodes"][number]>;
type LocalUserConfig = {
  kind: "local";
  users: UmlDiagramGraph["localUsers"];
  targets: UmlDiagramGraph["localUserTargets"];
  topologyNodes: TopologyNodes;
};
type ExternalUserConfig = {
  kind: "external";
  users: UmlDiagramGraph["externalUsers"];
  targets: UmlDiagramGraph["externalUserTargets"];
  topologyNodes: TopologyNodes;
};
type HydratedUsers<User> = { users: User[]; topologyNodeIds: Set<string> };
type UserRow = Pick<
  UmlDiagramGraph["localUsers"][number],
  "userOrdinal" | "nodeId" | "navigationNodeId" | "label" | "userKind"
>;
type UserTargetRow = UmlDiagramGraph["localUserTargets"][number];

function hydrateUsers(config: LocalUserConfig): HydratedUsers<LocalUserNode>;
function hydrateUsers(config: ExternalUserConfig): HydratedUsers<ExternalUserNode>;
function hydrateUsers(
  config: LocalUserConfig | ExternalUserConfig,
): HydratedUsers<LocalUserNode | ExternalUserNode> {
  const kind = config.kind;
  const rows: readonly UserRow[] = config.users;
  const targetRows: readonly UserTargetRow[] = config.targets;
  assertOrderedOrdinals(rows, () => `${kind}-users`, (user) => user.userOrdinal, `UML ${kind} user`);
  const targetsByUser = orderedGroups(
    targetRows,
    (target) => rowKey(target.userOrdinal),
    (target) => target.targetOrdinal,
    `UML ${kind} user target`,
  );
  const navigationIds = new Set<string>();
  const topologyNodeIds = new Set<string>();
  const users: Array<LocalUserNode | ExternalUserNode> = [];
  for (const [index, user] of rows.entries()) {
    if (user.nodeId !== `${kind}-user:${user.navigationNodeId}`) {
      throw new Error(`Invalid UML ${kind} user node identity: ${user.nodeId}`);
    }
    const node = config.topologyNodes.get(user.nodeId);
    if (!node || node.nodeKind !== `${kind}-user` || node.name !== user.label) {
      throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
    }
    assertString(user.navigationNodeId, `UML ${kind} navigation node ID`);
    assertString(user.label, `UML ${kind} user label`);
    if (config.kind === "local") {
      const local = config.users[index];
      if (!local) throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
      assertString(local.path, "UML local user path");
      assertPositiveInteger(local.line, "UML local user line");
      assertPositiveInteger(local.column, "UML local user column");
    } else {
      const external = config.users[index];
      if (!external) throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
      assertString(external.scopePath, "UML external user scope path");
    }
    if (!UML_USER_KINDS.has(user.userKind)) {
      throw new Error(`Invalid UML ${kind} user kind: ${user.userKind}`);
    }
    if (config.kind === "local") {
      const local = config.users[index];
      if (!local) throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
      if (local.ownerEntityId !== null) {
        assertString(local.ownerEntityId, "UML local user owner ID");
      }
    }
    if (navigationIds.has(user.navigationNodeId) || topologyNodeIds.has(user.nodeId)) {
      throw new Error(`Duplicate UML ${kind} user identity: ${user.nodeId}`);
    }
    navigationIds.add(user.navigationNodeId);
    topologyNodeIds.add(user.nodeId);
    const groupKey = rowKey(user.userOrdinal);
    const targets = (targetsByUser.get(groupKey) ?? []).map((target) => {
      assertString(target.targetId, `UML ${kind} user target ID`);
      assertString(target.targetName, `UML ${kind} user target name`);
      return { id: target.targetId, name: target.targetName };
    });
    targetsByUser.delete(groupKey);
    if (config.kind === "local") {
      const local = config.users[index];
      if (!local) throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
      users.push({
        navigation: {
          nodeId: local.navigationNodeId,
          label: local.label,
          path: local.path,
          line: local.line,
          column: local.column,
          kind: local.userKind,
        },
        ...(local.ownerEntityId === null ? {} : { ownerEntityId: local.ownerEntityId }),
        targets,
      });
    } else {
      const external = config.users[index];
      if (!external) throw new Error(`Mismatched UML ${kind} user topology: ${user.nodeId}`);
      users.push({
        navigation: {
          nodeId: external.navigationNodeId,
          label: external.label,
          scopePath: external.scopePath,
          kind: external.userKind,
        },
        targets,
      });
    }
  }
  if (targetsByUser.size) throw new Error(`UML ${kind} user target references a missing user`);
  return { users, topologyNodeIds };
}

function hydrateSettings(record: UmlDiagramGraph): TsUML2Settings {
  if (!record.settings) throw new Error("Missing normal UML settings");
  const source = record.settings;
  assertString(source.glob, "UML settings glob", true);
  if (source.tsconfig !== null) assertString(source.tsconfig, "UML settings tsconfig");
  assertString(source.outFile, "UML settings output file", true);
  assertString(source.outDsl, "UML settings DSL output", true);
  assertString(source.outMermaidDsl, "UML settings Mermaid output", true);
  assertBoolean(source.propertyTypes, "UML propertyTypes setting");
  assertBoolean(source.modifiers, "UML modifiers setting");
  assertBoolean(source.typeLinks, "UML typeLinks setting");
  assertBoolean(source.memberAssociations, "UML memberAssociations setting");
  assertBoolean(source.exportedTypesOnly, "UML exportedTypesOnly setting");

  assertOrderedOrdinals(
    record.settingLines,
    (line) => line.settingKind,
    (line) => line.lineOrdinal,
    "UML setting line",
  );
  const nomnoml: string[] = [];
  const mermaid: string[] = [];
  for (const line of record.settingLines) {
    if (line.settingKind !== "nomnoml" && line.settingKind !== "mermaid") {
      throw new Error(`Invalid UML setting line kind: ${String(line.settingKind)}`);
    }
    assertString(line.value, "UML setting line", true);
    (line.settingKind === "nomnoml" ? nomnoml : mermaid).push(line.value);
  }

  const settings = new TsUML2Settings();
  settings.glob = source.glob;
  if (source.tsconfig === null) delete settings.tsconfig;
  else settings.tsconfig = source.tsconfig;
  settings.outFile = source.outFile;
  settings.propertyTypes = source.propertyTypes;
  settings.modifiers = source.modifiers;
  settings.typeLinks = source.typeLinks;
  settings.nomnoml = nomnoml;
  settings.outDsl = source.outDsl;
  settings.outMermaidDsl = source.outMermaidDsl;
  settings.mermaid = mermaid;
  settings.memberAssociations = source.memberAssociations;
  settings.exportedTypesOnly = source.exportedTypesOnly;
  return settings;
}

function hydrateHeritageClause(
  row:
    | UmlDiagramGraph["entityHeritageClauses"][number]
    | UmlDiagramGraph["declarationHeritageClauses"][number],
): HeritageClause {
  assertString(row.clause, "UML heritage clause");
  assertString(row.clauseTypeId, "UML heritage target ID");
  assertString(row.className, "UML heritage owner name");
  assertString(row.classTypeId, "UML heritage owner ID");
  if (row.clauseType !== 0 && row.clauseType !== 1) {
    throw new Error(`Invalid UML heritage clause type: ${String(row.clauseType)}`);
  }
  return {
    clause: row.clause,
    clauseTypeId: row.clauseTypeId,
    className: row.className,
    classTypeId: row.classTypeId,
    type: row.clauseType,
  };
}

function sameHeritageClause(
  left: UmlDiagramGraph["entityHeritageClauses"][number],
  right: UmlDiagramGraph["declarationHeritageClauses"][number],
): boolean {
  return left.clause === right.clause
    && left.clauseTypeId === right.clauseTypeId
    && left.className === right.className
    && left.classTypeId === right.classTypeId
    && left.clauseType === right.clauseType;
}

function hydrateModel(record: UmlDiagramGraph) {
  const settings = hydrateSettings(record);
  const topology = hydrateUmlGraph(record.nodes, record.aliases, record.edges, record.relations);
  const topologyNodes = new Map(record.nodes.map((node) => [node.nodeId, node]));

  for (const [expectedOrdinal, declaration] of record.declarations.entries()) {
    if (declaration.declarationOrdinal !== expectedOrdinal) {
      throw new Error(
        `Invalid UML declaration ordinal: expected ${expectedOrdinal}, received ${declaration.declarationOrdinal}`,
      );
    }
    assertString(declaration.fileName, "UML declaration file name");
    assertBoolean(declaration.memberAssociationsPresent, "UML association presence flag");
  }
  const fileNames = new Set(record.declarations.map((declaration) => declaration.fileName));
  if (fileNames.size !== record.declarations.length) throw new Error("Duplicate UML declaration file name");

  assertOrderedOrdinals(
    record.entities,
    (entity) => rowKey(entity.declarationOrdinal, entity.entityKind),
    (entity) => entity.entityOrdinal,
    "UML entity",
  );
  const entityRows = new Map<string, UmlDiagramGraph["entities"][number]>();
  const occurrenceNodeIds = new Set<string>();
  for (const entity of record.entities) {
    if (!record.declarations[entity.declarationOrdinal]) {
      throw new Error(`Missing UML entity declaration: ${entity.declarationOrdinal}`);
    }
    if (!UML_ENTITY_KINDS.has(entity.entityKind)) {
      throw new Error(`Invalid UML entity kind: ${String(entity.entityKind)}`);
    }
    const key = entityOccurrenceKey(entity);
    if (entityRows.has(key)) throw new Error(`Duplicate UML entity occurrence: ${key}`);
    const node = topologyNodes.get(entity.nodeId);
    if (node?.nodeKind !== "entity") {
      throw new Error(`Missing UML topology entity node: ${entity.nodeId}`);
    }
    entityRows.set(key, entity);
    occurrenceNodeIds.add(entity.nodeId);
  }
  for (const node of record.nodes) {
    if (node.nodeKind === "entity" && !occurrenceNodeIds.has(node.nodeId)) {
      throw new Error(`UML topology entity has no model occurrence: ${node.nodeId}`);
    }
  }

  const structuredMembers = hydrateStructuredMembers(
    entityRows,
    record.properties,
    record.propertyTypeIds,
    record.methods,
    record.methodReturnTypeIds,
  );
  const enumItems = orderedGroups(
    record.enumItems,
    (item) => entityOccurrenceKey(item),
    (item) => item.itemOrdinal,
    "UML enum item",
  );
  for (const [key, items] of enumItems) {
    const entity = entityRows.get(key);
    if (entity?.entityKind !== "enum") throw new Error(`Invalid UML enum item parent: ${key}`);
    for (const item of items) assertString(item.value, "UML enum item", true);
  }

  const entityHeritage = orderedGroups(
    record.entityHeritageClauses,
    (clause) => entityOccurrenceKey(clause),
    (clause) => clause.clauseOrdinal,
    "UML entity heritage clause",
  );
  for (const [key, clauses] of entityHeritage) {
    const entity = entityRows.get(key);
    if (!entity || entity.entityKind === "enum") {
      throw new Error(`Invalid UML entity heritage parent: ${key}`);
    }
    for (const clause of clauses) hydrateHeritageClause(clause);
  }

  const declarations: FileDeclaration[] = record.declarations.map((declaration) => ({
    fileName: declaration.fileName,
    classes: [],
    interfaces: [],
    enums: [],
    types: [],
    heritageClauses: [],
    ...(declaration.memberAssociationsPresent ? { memberAssociations: [] } : {}),
  }));
  const instances = new Map<string, EntityInstance>();
  for (const entity of record.entities) {
    const key = entityOccurrenceKey(entity);
    const node = topologyNodes.get(entity.nodeId);
    if (node?.nodeKind !== "entity") {
      throw new Error(`Missing UML topology entity node: ${entity.nodeId}`);
    }
    const members = structuredMembers.get(key);
    const declaration = declarations[entity.declarationOrdinal];
    if (!declaration) throw new Error(`Missing UML entity declaration: ${entity.declarationOrdinal}`);
    const properties = members?.properties ?? [];
    const methods = members?.methods ?? [];
    const heritageClauses = (entityHeritage.get(key) ?? []).map(hydrateHeritageClause);
    let instance: EntityInstance;
    if (entity.entityKind === "class") {
      instance = new Clazz({ name: node.name, id: entity.nodeId, properties, methods, heritageClauses });
      declaration.classes[entity.entityOrdinal] = instance;
    } else if (entity.entityKind === "interface") {
      instance = new Interface({ name: node.name, id: entity.nodeId, properties, methods, heritageClauses });
      declaration.interfaces[entity.entityOrdinal] = instance;
    } else if (entity.entityKind === "type") {
      instance = new TypeAlias({ name: node.name, id: entity.nodeId, properties, methods, heritageClauses });
      declaration.types[entity.entityOrdinal] = instance;
    } else {
      if (properties.length || methods.length || heritageClauses.length) {
        throw new Error(`Enum UML occurrence has structured members: ${key}`);
      }
      instance = new Enum({
        name: node.name,
        id: entity.nodeId,
        enumItems: (enumItems.get(key) ?? []).map((item) => item.value),
      });
      declaration.enums[entity.entityOrdinal] = instance;
    }
    instances.set(key, instance);
  }

  assertOrderedOrdinals(
    record.declarationHeritageGroups,
    (group) => rowKey(group.declarationOrdinal),
    (group) => group.groupOrdinal,
    "UML declaration heritage group",
  );
  const groupRows = new Map<string, UmlDiagramGraph["declarationHeritageGroups"][number]>();
  const heritageOwners = new Set<string>();
  for (const group of record.declarationHeritageGroups) {
    if (!record.declarations[group.declarationOrdinal]) {
      throw new Error(`Missing UML heritage group declaration: ${group.declarationOrdinal}`);
    }
    const groupKey = rowKey(group.declarationOrdinal, group.groupOrdinal);
    if (groupRows.has(groupKey)) throw new Error(`Duplicate UML declaration heritage group: ${groupKey}`);
    const ownerKey = entityOccurrenceKey(group);
    const owner = entityRows.get(ownerKey);
    if (!owner || owner.entityKind === "enum" || heritageOwners.has(ownerKey)) {
      throw new Error(`Invalid UML declaration heritage owner: ${ownerKey}`);
    }
    groupRows.set(groupKey, group);
    heritageOwners.add(ownerKey);
  }
  const declarationHeritage = orderedGroups(
    record.declarationHeritageClauses,
    (clause) => rowKey(clause.declarationOrdinal, clause.groupOrdinal),
    (clause) => clause.clauseOrdinal,
    "UML declaration heritage clause",
  );
  for (const [key, clauses] of declarationHeritage) {
    if (!groupRows.has(key)) throw new Error(`Missing UML declaration heritage group: ${key}`);
    for (const clause of clauses) hydrateHeritageClause(clause);
  }
  for (const [groupKey, group] of groupRows) {
    const ownerKey = entityOccurrenceKey(group);
    const entityClauses = entityHeritage.get(ownerKey) ?? [];
    const groupClauses = declarationHeritage.get(groupKey) ?? [];
    if (
      entityClauses.length === 0
      || entityClauses.length !== groupClauses.length
      || entityClauses.some((clause, index) => {
        const groupClause = groupClauses[index];
        return !groupClause || !sameHeritageClause(clause, groupClause);
      })
    ) {
      throw new Error(`Mismatched UML declaration heritage group: ${groupKey}`);
    }
    const instance = instances.get(ownerKey);
    if (
      !(instance instanceof Clazz)
      && !(instance instanceof Interface)
      && !(instance instanceof TypeAlias)
    ) {
      throw new Error(`Invalid UML declaration heritage instance: ${ownerKey}`);
    }
    const declaration = declarations[group.declarationOrdinal];
    if (!declaration) {
      throw new Error(`Missing UML heritage group declaration: ${group.declarationOrdinal}`);
    }
    declaration.heritageClauses[group.groupOrdinal] = instance.heritageClauses;
  }
  for (const [key, clauses] of entityHeritage) {
    if (clauses.length && !heritageOwners.has(key)) {
      throw new Error(`Missing UML declaration heritage group for entity: ${key}`);
    }
  }

  assertOrderedOrdinals(
    record.memberAssociations,
    (association) => rowKey(association.declarationOrdinal),
    (association) => association.associationOrdinal,
    "UML member association",
  );
  for (const association of record.memberAssociations) {
    const declaration = record.declarations[association.declarationOrdinal];
    if (!declaration?.memberAssociationsPresent) {
      throw new Error(`Invalid UML association declaration: ${association.declarationOrdinal}`);
    }
    assertString(association.aTypeId, "UML association endpoint ID");
    assertString(association.aName, "UML association endpoint name");
    assertString(association.bTypeId, "UML association endpoint ID");
    assertString(association.bName, "UML association endpoint name");
    if (association.aMultiplicity !== null && association.aMultiplicity !== "0..*") {
      throw new Error("Invalid UML association multiplicity");
    }
    if (association.bMultiplicity !== null && association.bMultiplicity !== "0..*") {
      throw new Error("Invalid UML association multiplicity");
    }
    if (association.associationType !== 0) throw new Error("Invalid UML association type");
    assertBoolean(association.inherited, "UML association inherited flag");
    const memberAssociations = declarations[association.declarationOrdinal]?.memberAssociations;
    if (!memberAssociations) {
      throw new Error(`Invalid UML association declaration: ${association.declarationOrdinal}`);
    }
    memberAssociations.push(
      new MemberAssociation(
        {
          typeId: association.aTypeId,
          name: association.aName,
          ...(association.aMultiplicity === null ? {} : { multiplicity: association.aMultiplicity }),
        },
        {
          typeId: association.bTypeId,
          name: association.bName,
          ...(association.bMultiplicity === null ? {} : { multiplicity: association.bMultiplicity }),
        },
        association.associationType,
        association.inherited,
      ),
    );
  }

  for (const declaration of record.declarations) {
    if (!declaration.memberAssociationsPresent) {
      const unexpected = record.memberAssociations.some(
        (association) => association.declarationOrdinal === declaration.declarationOrdinal,
      );
      if (unexpected) throw new Error(`Unexpected UML member associations: ${declaration.declarationOrdinal}`);
    }
  }

  assertOrderedOrdinals(record.categories, () => "categories", (category) => category.categoryOrdinal, "UML category");
  const categories: CategoryMap = new Map();
  for (const category of record.categories) {
    assertString(category.entityName, "UML category entity name");
    if (!UML_CATEGORY_KINDS.has(category.category)) {
      throw new Error(`Invalid UML category: ${String(category.category)}`);
    }
    assertBoolean(category.isTest, "UML category test flag");
    if (categories.has(category.entityName)) throw new Error(`Duplicate UML category: ${category.entityName}`);
    categories.set(category.entityName, {
      category: category.category,
      test: category.isTest,
    });
  }
  const entityNames = new Set(
    record.entities.map((entity) => {
      const node = topologyNodes.get(entity.nodeId);
      if (node?.nodeKind !== "entity") {
        throw new Error(`Missing UML topology entity node: ${entity.nodeId}`);
      }
      return node.name;
    }),
  );
  if ([...entityNames].some((name) => !categories.has(name))) {
    throw new Error("UML categories do not match model entities");
  }

  const methodReturnDependencies = hydrateDependencies(
    record.methodReturnDependencies,
    "UML method return dependency",
    "UML method return",
  );
  const usageEdges = hydrateDependencies(
    record.usageEdges,
    "UML usage edge",
    "UML usage",
  );

  const {
    users: localUserNodes,
    topologyNodeIds: localNodeIds,
  } = hydrateUsers({
    kind: "local",
    users: record.localUsers,
    targets: record.localUserTargets,
    topologyNodes,
  });
  const {
    users: externalUserNodes,
    topologyNodeIds: externalNodeIds,
  } = hydrateUsers({
    kind: "external",
    users: record.externalUsers,
    targets: record.externalUserTargets,
    topologyNodes,
  });
  for (const node of record.nodes) {
    if (node.nodeKind === "local-user" && !localNodeIds.has(node.nodeId)) {
      throw new Error(`UML topology local user has no model row: ${node.nodeId}`);
    }
    if (node.nodeKind === "external-user" && !externalNodeIds.has(node.nodeId)) {
      throw new Error(`UML topology external user has no model row: ${node.nodeId}`);
    }
  }

  assertOrderedOrdinals(record.definitions, () => "definitions", (definition) => definition.definitionOrdinal, "UML definition");
  const definitionLocations = new Set<string>();
  const definitions = record.definitions.map((definition) => {
    assertString(definition.definitionKey, "UML definition key");
    assertString(definition.name, "UML definition name");
    assertString(definition.qualifiedName, "UML definition qualified name");
    assertString(definition.sourcePath, "UML definition source path");
    assertPositiveInteger(definition.sourceLine, "UML definition source line");
    assertPositiveInteger(definition.sourceColumn, "UML definition source column");
    assertString(definition.umlScopePath, "UML definition scope path", true);
    assertString(definition.umlEntityName, "UML definition entity name");
    if (definition.definitionKind === "method") {
      if (definition.umlMemberName === null) throw new Error("Missing UML method definition member name");
      assertString(definition.umlMemberName, "UML definition member name");
      assertNonnegativeInteger(
        definition.umlMemberOccurrence,
        "UML definition member occurrence",
      );
    } else {
      if (
        !["class", "interface", "enum", "type"].includes(definition.definitionKind)
        || definition.umlMemberName !== null
        || definition.umlMemberOccurrence !== null
      ) {
        throw new Error(`Invalid UML definition kind or member fields: ${definition.definitionKey}`);
      }
    }
    const locationKey = rowKey(definition.sourcePath, definition.definitionKey);
    if (definitionLocations.has(locationKey)) {
      throw new Error(`Duplicate UML definition location: ${locationKey}`);
    }
    definitionLocations.add(locationKey);
    return {
      key: definition.definitionKey,
      kind: definition.definitionKind,
      name: definition.name,
      qualifiedName: definition.qualifiedName,
      source: {
        path: definition.sourcePath,
        line: definition.sourceLine,
        column: definition.sourceColumn,
      },
      uml: {
        scopePath: definition.umlScopePath,
        entityName: definition.umlEntityName,
        ...(definition.umlMemberName === null ? {} : { memberName: definition.umlMemberName }),
        ...(definition.umlMemberOccurrence === null
          ? {}
          : { memberOccurrence: definition.umlMemberOccurrence }),
      },
    };
  });

  return {
    topology,
    settings,
    declarations,
    categories,
    methodReturnDependencies,
    usageEdges,
    localUserNodes,
    externalUserNodes,
    definitions,
  };
}

function assertBareUmlGraph(record: UmlDiagramGraph): void {
  if (record.settings !== null) throw new Error("Bare UML graph cannot contain settings");
  const rowCollections: readonly (readonly unknown[])[] = [
    record.nodes,
    record.aliases,
    record.edges,
    record.relations,
    record.settingLines,
    record.declarations,
    record.entities,
    record.properties,
    record.propertyTypeIds,
    record.methods,
    record.methodReturnTypeIds,
    record.enumItems,
    record.entityHeritageClauses,
    record.declarationHeritageGroups,
    record.declarationHeritageClauses,
    record.memberAssociations,
    record.categories,
    record.methodReturnDependencies,
    record.usageEdges,
    record.localUsers,
    record.externalUsers,
    record.localUserTargets,
    record.externalUserTargets,
    record.definitions,
  ];
  if (rowCollections.some((rows) => rows.length !== 0)) {
    throw new Error("Bare UML graph cannot contain topology or model rows");
  }
}

export function validateUmlDiagramGraph(record: UmlDiagramGraph): void {
  if (record.renderMode === "bare") {
    assertBareUmlGraph(record);
    return;
  }
  if (record.renderMode !== "normal") {
    throw new Error(`Invalid UML render mode: ${String(record.renderMode)}`);
  }
  hydrateModel(record);
}

export function renderUmlDiagramGraph(record: UmlDiagramGraph): RenderedDiagram {
  if (record.kind !== "uml") throw new Error("Cannot render a non-UML graph as UML");
  if (record.formatVersion !== DIAGRAM_GRAPH_FORMAT_VERSION) {
    throw new Error(`Unsupported UML graph format version: ${String(record.formatVersion)}`);
  }
  assertString(record.scopePath, "UML scope path", true);
  if (record.renderMode === "bare") {
    assertBareUmlGraph(record);
    return {
      dsl: "classDiagram",
      dsls: ["classDiagram"],
      packageNodes: [],
      definitions: [],
      externalUsers: [],
      localUsers: [],
    };
  }
  if (record.renderMode !== "normal") {
    throw new Error(`Invalid UML render mode: ${String(record.renderMode)}`);
  }

  const hydrated = hydrateModel(record);
  const dsl = renderUmlDsl(hydrated.declarations, hydrated);
  const communities = partitionUmlCommunities(hydrated.declarations, hydrated.topology);
  return {
    dsl,
    dsls: communities.length
      ? communities.map((declarations) => renderUmlDsl(declarations, hydrated))
      : [dsl],
    packageNodes: [],
    definitions: hydrated.definitions,
    externalUsers: hydrated.externalUserNodes.map((node) => node.navigation),
    localUsers: hydrated.localUserNodes.map((node) => node.navigation),
  };
}
