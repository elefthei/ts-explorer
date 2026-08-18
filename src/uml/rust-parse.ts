import type { Node } from "@vscode/tree-sitter-wasm";
import type { UmlEntityKind } from "../diagram-graph.ts";
import { namedChildren, renderedTypeName } from "../lang/ast.ts";
import {
  RUST_ENTITY_KIND_BY_NODE,
  RUST_METHOD_NODE_TYPES,
  RUST_PROPERTY_NODE_TYPES,
  rustFunctionModifiers,
  rustImplTargetName,
  rustTopLevelItems,
  rustTypeBaseName,
  rustVisibility,
} from "../lang/rust.ts";
import {
  createDeclarationBuilder,
  type DeclarationBuilder,
  type EntityCollection,
} from "./declaration.ts";
import {
  type FileDeclaration,
  type MethodDetails,
  orderUmlModifiers,
  type PendingTypeReference,
  type PropertyDetails,
  type SourceUnit,
  type UmlEntityModel,
  type UmlModifier,
  type UmlReference,
} from "./model.ts";

function parseField(field: Node, name: string, builder: DeclarationBuilder): PropertyDetails {
  const annotation = field.childForFieldName("type") ?? undefined;
  const details: PropertyDetails = {
    modifiers: [rustVisibility(field)],
    name,
    ...(annotation === undefined ? {} : { type: annotation.text }),
    typeIds: [],
    optional: false,
  };
  if (annotation) {
    builder.memberTypes(annotation, (typeIds) => {
      details.typeIds = typeIds;
    });
  }
  return details;
}

/** `struct Foo { a: T }` and `struct Foo(T)`; tuple fields are named by their position. */
function structProperties(body: Node, builder: DeclarationBuilder): PropertyDetails[] {
  const properties: PropertyDetails[] = [];
  if (body.type === "field_declaration_list") {
    for (const field of namedChildren(body)) {
      if (field.type !== "field_declaration") continue;
      const name = field.childForFieldName("name")?.text;
      if (name === undefined) continue;
      properties.push(parseField(field, name, builder));
    }
    return properties;
  }
  if (body.type !== "ordered_field_declaration_list") return properties;
  // A tuple field's `pub` is a sibling of its type node, so visibility is carried forward.
  let visibility: UmlModifier = "private";
  for (const field of namedChildren(body)) {
    if (field.type === "attribute_item") continue;
    if (field.type === "visibility_modifier") {
      visibility = field.text === "pub" ? "public" : "protected";
      continue;
    }
    const details: PropertyDetails = {
      modifiers: [visibility],
      name: String(properties.length),
      type: field.text,
      typeIds: [],
      optional: false,
    };
    builder.memberTypes(field, (typeIds) => {
      details.typeIds = typeIds;
    });
    properties.push(details);
    visibility = "private";
  }
  return properties;
}

type MemberOptions = {
  /** Enum entities render variants only, so their `impl` methods are dropped. */
  methods: boolean;
  /** A trait requirement and its implementations are reachable wherever the trait is. */
  visibility?: UmlModifier;
};

function parseMethod(
  node: Node,
  builder: DeclarationBuilder,
  options: MemberOptions,
): MethodDetails | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) return undefined;
  const annotation = node.childForFieldName("return_type") ?? undefined;
  const details: MethodDetails = {
    modifiers: orderUmlModifiers([
      options.visibility ?? rustVisibility(node),
      ...rustFunctionModifiers(node),
    ]),
    name,
    ...(annotation === undefined ? {} : { returnType: annotation.text, returnTypeIds: [] }),
  };
  if (annotation) {
    builder.memberTypes(annotation, (typeIds) => {
      details.returnTypeIds = typeIds;
    });
  }
  return details;
}

/** `const`/`static` items inside a `trait` or `impl` body become properties. */
function parseAssociatedConstant(
  node: Node,
  builder: DeclarationBuilder,
  options: MemberOptions,
): PropertyDetails | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) return undefined;
  const annotation = node.childForFieldName("type") ?? undefined;
  const details: PropertyDetails = {
    modifiers: orderUmlModifiers([
      options.visibility ?? rustVisibility(node),
      "const",
      "static",
    ]),
    name,
    ...(annotation === undefined ? {} : { type: annotation.text }),
    typeIds: [],
    optional: false,
  };
  if (annotation) {
    builder.memberTypes(annotation, (typeIds) => {
      details.typeIds = typeIds;
    });
  }
  return details;
}

/** Members of a `trait` or `impl` body; associated types are not modelled. */
function declarationListMembers(
  body: Node,
  entity: UmlEntityModel,
  builder: DeclarationBuilder,
  options: MemberOptions,
): void {
  for (const member of namedChildren(body)) {
    if (RUST_METHOD_NODE_TYPES.has(member.type)) {
      if (!options.methods) continue;
      const method = parseMethod(member, builder, options);
      if (method) entity.methods.push(method);
      continue;
    }
    if (!RUST_PROPERTY_NODE_TYPES.has(member.type)) continue;
    const property = parseAssociatedConstant(member, builder, options);
    if (property) entity.properties.push(property);
  }
}

const TRAIT_BOUND_TYPES: ReadonlySet<string> = new Set([
  "type_identifier",
  "generic_type",
  "scoped_type_identifier",
]);

const ENTITY_COLLECTION: Record<UmlEntityKind, EntityCollection> = {
  class: "classes",
  interface: "interfaces",
  enum: "enums",
  type: "types",
};

export function parseRustFileDeclaration(
  unit: SourceUnit,
  entities: Map<string, UmlReference>,
  pending: PendingTypeReference[],
): FileDeclaration {
  const fileName = unit.path;
  const builder = createDeclarationBuilder(fileName, entities, pending);
  const items = rustTopLevelItems(unit.root);
  const byBareName = new Map<string, { entity: UmlEntityModel; isEnum: boolean }>();

  for (const node of items) {
    const kind = RUST_ENTITY_KIND_BY_NODE[node.type];
    if (!kind) continue;
    const bare = node.childForFieldName("name")?.text;
    if (bare === undefined) continue;
    const entity = builder.entity(renderedTypeName(bare, node), ENTITY_COLLECTION[kind]);

    if (node.type === "struct_item" || node.type === "union_item") {
      const body = node.childForFieldName("body");
      if (body) entity.properties = structProperties(body, builder);
    } else if (node.type === "trait_item") {
      const bounds = node.childForFieldName("bounds");
      for (const base of bounds ? namedChildren(bounds) : []) {
        if (TRAIT_BOUND_TYPES.has(base.type)) {
          builder.heritage(entity, rustTypeBaseName(base), "extends");
        }
      }
      const body = node.childForFieldName("body");
      if (body) {
        declarationListMembers(body, entity, builder, { methods: true, visibility: "public" });
      }
    } else if (node.type === "enum_item") {
      const body = node.childForFieldName("body");
      for (const variant of body ? namedChildren(body) : []) {
        if (variant.type !== "enum_variant") continue;
        const variantName = variant.childForFieldName("name")?.text;
        if (variantName !== undefined) entity.items.push(variantName);
      }
    }
    byBareName.set(bare, { entity, isEnum: node.type === "enum_item" });
  }

  // `impl` blocks contribute members to the entity declared in the same file; a cross-file `impl`
  // is left to `rust-usage.ts`, which surfaces it as a local user rather than faking ownership.
  for (const node of items) {
    if (node.type !== "impl_item") continue;
    const ownerName = rustImplTargetName(node);
    if (ownerName === undefined) continue;
    const owner = byBareName.get(ownerName);
    if (!owner) continue;
    const body = node.childForFieldName("body");
    const trait = node.childForFieldName("trait");
    if (body) {
      declarationListMembers(body, owner.entity, builder, {
        // A Mermaid enum renders its variants only, so impl members would be dropped downstream.
        methods: !owner.isEnum,
        // A trait implementation is reachable wherever the trait is; an inherent `impl` is not.
        ...(trait ? { visibility: "public" as const } : {}),
      });
    }
    if (trait) builder.heritage(owner.entity, rustTypeBaseName(trait), "implements");
  }

  return builder.finish();
}
