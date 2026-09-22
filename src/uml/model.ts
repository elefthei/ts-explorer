import type { UmlCategoryKind } from "../diagram-graph.ts";
import type { FileDefinition, FileDefinitionKind, TreeNode } from "../types.ts";

/**
 * Canonical order: a member's modifiers are always emitted in this order, in every language.
 * `const`, `unsafe` and `mutable` are Rust-only; the rest are shared with TypeScript.
 */
export const UML_MODIFIERS = [
  "ambient",
  "public",
  "private",
  "protected",
  "abstract",
  "static",
  "readonly",
  "accessor",
  "async",
  "const",
  "override",
  "unsafe",
  "mutable",
] as const;

export type UmlModifier = (typeof UML_MODIFIERS)[number];

const UML_MODIFIER_ORDER: ReadonlyMap<string, number> = new Map(
  UML_MODIFIERS.map((modifier, index) => [modifier, index]),
);

/** Deduplicates `modifiers` and sorts them into `UML_MODIFIERS` order. */
export function orderUmlModifiers(modifiers: Iterable<UmlModifier>): UmlModifier[] {
  return [...new Set(modifiers)].sort(
    (left, right) => (UML_MODIFIER_ORDER.get(left) ?? 0) - (UML_MODIFIER_ORDER.get(right) ?? 0),
  );
}

export type PropertyDetails = {
  /** The exact outline declaration this compartment row renders. */
  definitionKey: string;
  modifiers: UmlModifier[];
  name: string;
  type?: string;
  optional: boolean;
};

export type MethodDetails = {
  definitionKey: string;
  modifiers: UmlModifier[];
  name: string;
  returnType?: string;
};

export type EnumItemDetails = {
  definitionKey: string;
  value: string;
};

/**
 * One nominal box. `id` is the canonical `DefinitionIndex.definition_key` of the declaring
 * definition; `kind` is the native outline kind, never normalized across languages.
 */
export type UmlEntityModel = {
  id: string;
  name: string;
  kind: FileDefinitionKind;
  properties: PropertyDetails[];
  methods: MethodDetails[];
  items: EnumItemDetails[];
};

/** Global UML detail switches; every flag on reproduces the maximal diagram. */
export type UmlVisibility = {
  attributes: boolean;
  methods: boolean;
  types: boolean;
  tests: boolean;
};

export const FULL_UML_VISIBILITY: UmlVisibility = {
  attributes: true,
  methods: true,
  types: true,
  tests: true,
};

export type { UmlCategoryKind };

/** A catalogue definition plus the body flag overload and module resolution need. */
export type IndexedFileDefinition = FileDefinition & { hasBody: boolean };

export type DefinitionBindingTarget =
  | { kind: "definition"; key: string }
  | { kind: "module"; path: string };

export type DefinitionBindingSpace = "type" | "value";

export type DefinitionBindingKind = "local" | "import" | "export";

export type DefinitionBinding = {
  sourcePath: string;
  /** `""` for file scope, otherwise an indexed namespace/module definition key. */
  scopeKey: string;
  name: string;
  space: DefinitionBindingSpace;
  bindingKind: DefinitionBindingKind;
  /** Distinguishes genuine overload/merged-declaration targets, never alternative guesses. */
  ordinal: number;
  target: DefinitionBindingTarget;
};

export type DefinitionContributionKind = "declaration" | "implementation" | "module";

export type DefinitionContributor = {
  definitionKey: string;
  sourcePath: string;
  kind: DefinitionContributionKind;
};

export type FileImportEdge = {
  sourcePath: string;
  targetPath: string;
};

/** Everything one generation's catalogue transaction publishes atomically. */
export type DefinitionIndexSnapshot = {
  entries: readonly TreeNode[];
  definitions: readonly IndexedFileDefinition[];
  bindings: readonly DefinitionBinding[];
  contributors: readonly DefinitionContributor[];
  imports: readonly FileImportEdge[];
};

/**
 * The read side of the catalogue, backed by prepared generation-bound queries. Lexical
 * shadowing is resolved by the AST visitor before this interface is consulted.
 */
export type DefinitionResolutionIndex = {
  definition(key: string): IndexedFileDefinition | undefined;
  definitions(path: string): readonly IndexedFileDefinition[];
  members(parentKey: string): readonly IndexedFileDefinition[];
  /**
   * `exported=false` returns local bindings when present, otherwise imports; `exported=true`
   * returns only the scope's public exports.
   */
  bindings(
    path: string,
    scopeKey: string,
    name: string,
    space: DefinitionBindingSpace,
    exported: boolean,
  ): readonly DefinitionBindingTarget[];
  /** Module definition keys whose out-of-line body is `path`. */
  moduleOwners(path: string): readonly string[];
  /**
   * What a module or namespace re-exports with `pub use`: its own lexical scope, plus the file
   * scope of its out-of-line body file. Deduplicated by exported name.
   */
  moduleExports(definitionKey: string): readonly { name: string; key: string }[];
};
