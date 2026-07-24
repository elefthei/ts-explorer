import type { UmlDiagramGraph } from "../diagram-graph.ts";
import type { UmlExternalUser, UmlLocalUser } from "../types.ts";

export type UmlDependency = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
};

export type UmlReference = {
  id: string;
  name: string;
};

export type ExternalUserNode = {
  navigation: UmlExternalUser;
  targets: UmlReference[];
};

export type LocalUserNode = {
  navigation: UmlLocalUser;
  ownerEntityId?: string;
  targets: UmlReference[];
};

type UmlCategory = {
  category: UmlDiagramGraph["categories"][number]["category"];
  test: boolean;
};

export type CategoryMap = Map<string, UmlCategory>;
