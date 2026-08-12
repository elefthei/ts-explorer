import { dirname, join } from "node:path/posix";
import type { Node } from "@vscode/tree-sitter-wasm";
import {
  declarationName,
  ENTITY_KIND_BY_NODE,
  firstAncestor,
  namedChildren,
  TYPE_REFERENCE_NODE_TYPES,
  typeReferenceNodes,
} from "../lang/typescript.ts";
import {
  bareUmlName,
  posix,
  umlEntityKey,
  umlFileKey,
} from "./keys.ts";
import type { SourceUnit, UmlReference } from "./model.ts";

export type EntityReference = { file: string; node: Node; target: UmlReference };

export type SymbolTable = {
  resolve(file: string, name: string): UmlReference | undefined;
  resolveTypeReferences(file: string, annotation: Node): UmlReference[];
  references(): readonly EntityReference[];
};

type ImportBinding = { imported: string; source: string };

type UnitIndex = {
  path: string;
  key: string;
  root: Node;
  declarations: Map<string, Node[]>;
  defaultExport?: Node;
  imports: Map<string, ImportBinding>;
  localExports: Map<string, string>;
  reexports: Map<string, ImportBinding>;
  starExports: string[];
};

const RESOLUTION_DEPTH_LIMIT = 16;

const NAMED_DECLARATION_TYPES = new Set([
  ...Object.keys(ENTITY_KIND_BY_NODE),
  "function_declaration",
  "generator_function_declaration",
]);

const DECLARATION_NAME_PARENTS = new Set([
  ...NAMED_DECLARATION_TYPES,
  "class",
  "variable_declarator",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "public_field_definition",
  "property_signature",
  "required_parameter",
  "optional_parameter",
  "enum_assignment",
  "type_parameter",
  "internal_module",
  "module",
  "labeled_statement",
]);

const IMPORT_BINDING_PARENTS = new Set([
  "import_specifier",
  "namespace_import",
  "import_clause",
  "import_alias",
]);

function stringLiteralText(node: Node): string {
  return namedChildren(node).find((child) => child.type === "string_fragment")?.text ?? "";
}

function recordDeclaration(index: UnitIndex, node: Node): void {
  if (node.type === "class") {
    index.defaultExport ??= node;
    return;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const declarator of namedChildren(node)) {
      if (declarator.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name");
      if (name?.type !== "identifier") continue;
      push(index.declarations, name.text, declarator);
    }
    return;
  }
  if (!NAMED_DECLARATION_TYPES.has(node.type)) return;
  const name = declarationName(node);
  if (name !== undefined) push(index.declarations, name, node);
}

function push(map: Map<string, Node[]>, key: string, node: Node): void {
  const existing = map.get(key);
  if (existing) existing.push(node);
  else map.set(key, [node]);
}

function indexImport(index: UnitIndex, statement: Node): void {
  const sourceNode = statement.childForFieldName("source");
  if (!sourceNode) return;
  const source = stringLiteralText(sourceNode);
  for (const clause of namedChildren(statement)) {
    if (clause.type !== "import_clause") continue;
    for (const binding of namedChildren(clause)) {
      if (binding.type === "identifier") {
        index.imports.set(binding.text, { imported: "default", source });
      } else if (binding.type === "namespace_import") {
        const name = namedChildren(binding).find((child) => child.type === "identifier");
        if (name) index.imports.set(name.text, { imported: "*", source });
      } else if (binding.type === "named_imports") {
        for (const specifier of namedChildren(binding)) {
          if (specifier.type !== "import_specifier") continue;
          const imported = specifier.childForFieldName("name")?.text;
          const alias = specifier.childForFieldName("alias")?.text;
          if (imported === undefined) continue;
          index.imports.set(alias ?? imported, { imported, source });
        }
      }
    }
  }
}

function indexExport(index: UnitIndex, statement: Node): void {
  const sourceNode = statement.childForFieldName("source");
  const source = sourceNode ? stringLiteralText(sourceNode) : undefined;
  const clause = namedChildren(statement).find((child) => child.type === "export_clause");
  if (clause) {
    for (const specifier of namedChildren(clause)) {
      if (specifier.type !== "export_specifier") continue;
      const name = specifier.childForFieldName("name")?.text;
      const alias = specifier.childForFieldName("alias")?.text;
      if (name === undefined) continue;
      if (source === undefined) index.localExports.set(alias ?? name, name);
      else index.reexports.set(alias ?? name, { imported: name, source });
    }
    return;
  }
  if (source !== undefined) {
    index.starExports.push(source);
    return;
  }
  const declaration = statement.childForFieldName("declaration");
  if (declaration) {
    if (declaration.type === "ambient_declaration") {
      const inner = declaration.namedChild(0);
      if (inner) recordDeclaration(index, inner);
    } else {
      recordDeclaration(index, declaration);
    }
    return;
  }
  const value = statement.childForFieldName("value");
  if (value) recordDeclaration(index, value);
}

function indexUnit(unit: SourceUnit): UnitIndex {
  const index: UnitIndex = {
    path: unit.path,
    key: umlFileKey(unit.path),
    root: unit.root,
    declarations: new Map(),
    imports: new Map(),
    localExports: new Map(),
    reexports: new Map(),
    starExports: [],
  };
  for (const statement of namedChildren(unit.root)) {
    if (statement.type === "import_statement") indexImport(index, statement);
    else if (statement.type === "export_statement") indexExport(index, statement);
    else if (statement.type === "ambient_declaration") {
      const inner = statement.namedChild(0);
      if (inner) recordDeclaration(index, inner);
    } else recordDeclaration(index, statement);
  }
  return index;
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const JS_SPECIFIER_SUFFIX = /\.(?:js|mjs|cjs)$/;

function moduleCandidates(base: string): string[] {
  return [
    base,
    ...MODULE_EXTENSIONS.map((extension) => base + extension),
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
}

export function buildSymbolTable(
  units: readonly SourceUnit[],
  entities: ReadonlyMap<string, UmlReference>,
): SymbolTable {
  const byKey = new Map<string, UnitIndex>();
  for (const unit of units) {
    const index = indexUnit(unit);
    byKey.set(index.key, index);
  }

  const resolveModule = (fromFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    const base = join(dirname(posix(fromFile)), specifier);
    const candidates = moduleCandidates(base);
    const stripped = base.replace(JS_SPECIFIER_SUFFIX, "");
    if (stripped !== base) candidates.push(...moduleCandidates(stripped));
    for (const candidate of candidates) {
      const key = umlFileKey(candidate);
      if (byKey.has(key)) return key;
    }
    return undefined;
  };

  type Resolved = { key: string; node: Node };

  const pickDeclaration = (nodes: readonly Node[]): Node | undefined =>
    nodes.find((node) => node.type !== "variable_declarator" && node.type !== "function_declaration")
      ?? nodes[0];

  const resolveExport = (key: string, name: string, depth: number): Resolved | undefined => {
    if (depth > RESOLUTION_DEPTH_LIMIT) return undefined;
    const index = byKey.get(key);
    if (!index) return undefined;
    if (name === "default" && index.defaultExport) return { key, node: index.defaultExport };
    const local = index.declarations.get(name);
    if (local) {
      const node = pickDeclaration(local);
      if (node) return { key, node };
    }
    const aliased = index.localExports.get(name);
    if (aliased !== undefined) {
      const nodes = index.declarations.get(aliased);
      const node = nodes && pickDeclaration(nodes);
      if (node) return { key, node };
    }
    const reexport = index.reexports.get(name);
    if (reexport) {
      const target = resolveModule(index.path, reexport.source);
      if (target) return resolveExport(target, reexport.imported, depth + 1);
      return undefined;
    }
    for (const source of index.starExports) {
      const target = resolveModule(index.path, source);
      if (!target) continue;
      const found = resolveExport(target, name, depth + 1);
      if (found) return found;
    }
    return undefined;
  };

  const resolveDeclaration = (key: string, name: string): Resolved | undefined => {
    const index = byKey.get(key);
    if (!index) return undefined;
    const local = index.declarations.get(name);
    if (local) {
      const node = pickDeclaration(local);
      if (node) return { key, node };
    }
    const binding = index.imports.get(name);
    if (!binding || binding.imported === "*") return undefined;
    const target = resolveModule(index.path, binding.source);
    if (!target) return undefined;
    return resolveExport(target, binding.imported, 0);
  };

  const entityOf = (resolved: Resolved): UmlReference | undefined => {
    const index = byKey.get(resolved.key);
    const declared = resolved.node.type === "class"
      ? declarationName(resolved.node) ?? "default"
      : declarationName(resolved.node);
    if (!index || declared === undefined) return undefined;
    return entities.get(umlEntityKey(index.path, bareUmlName(declared)));
  };

  const resolve = (file: string, name: string): UmlReference | undefined => {
    const resolved = resolveDeclaration(umlFileKey(file), name);
    return resolved ? entityOf(resolved) : undefined;
  };

  const resolveName = (
    key: string,
    name: string,
    depth: number,
    out: UmlReference[],
    seen: Set<string>,
  ): void => {
    const guard = `${key}\0${name}`;
    if (depth > RESOLUTION_DEPTH_LIMIT || seen.has(guard)) return;
    seen.add(guard);
    const resolved = resolveDeclaration(key, name);
    if (!resolved) return;
    if (resolved.node.type === "type_alias_declaration") {
      const value = resolved.node.childForFieldName("value");
      // A structural alias is its own entity; every other alias forwards to what it names.
      if (value && value.type !== "object_type") {
        for (const reference of typeReferenceNodes(value)) {
          resolveName(resolved.key, reference.text, depth + 1, out, seen);
        }
        return;
      }
    }
    const entity = entityOf(resolved);
    if (entity) out.push(entity);
  };

  const resolveTypeReferences = (file: string, annotation: Node): UmlReference[] => {
    const key = umlFileKey(file);
    const out: UmlReference[] = [];
    const seen = new Set<string>();
    for (const reference of typeReferenceNodes(annotation)) {
      resolveName(key, reference.text, 0, out, seen);
    }
    return out;
  };

  const isUsage = (node: Node): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    if (IMPORT_BINDING_PARENTS.has(parent.type)) return false;
    if (parent.type === "export_specifier") {
      return parent.childForFieldName("alias")?.id !== node.id;
    }
    if (parent.type === "member_expression") {
      return parent.childForFieldName("property")?.id !== node.id;
    }
    if (parent.type === "nested_type_identifier") {
      return parent.childForFieldName("name")?.id !== node.id;
    }
    if (parent.type === "pair") return parent.childForFieldName("key")?.id !== node.id;
    if (DECLARATION_NAME_PARENTS.has(parent.type)) {
      if (parent.childForFieldName("name")?.id === node.id) return false;
      if (parent.childForFieldName("pattern")?.id === node.id) return false;
    }
    return true;
  };

  const resolveUsage = (index: UnitIndex, node: Node): UmlReference | undefined => {
    if (node.parent?.type === "export_specifier") {
      const statement = firstAncestor(node, (candidate) => candidate.type === "export_statement");
      const sourceNode = statement?.childForFieldName("source");
      if (sourceNode) {
        const target = resolveModule(index.path, stringLiteralText(sourceNode));
        if (!target) return undefined;
        const resolved = resolveExport(target, node.text, 0);
        return resolved ? entityOf(resolved) : undefined;
      }
    }
    const resolved = resolveDeclaration(index.key, node.text);
    return resolved ? entityOf(resolved) : undefined;
  };

  let index: EntityReference[] | undefined;
  const references = (): readonly EntityReference[] => {
    if (index) return index;
    const collected: EntityReference[] = [];
    for (const unit of byKey.values()) {
      const visit = (node: Node): void => {
        if (TYPE_REFERENCE_NODE_TYPES.has(node.type) && isUsage(node)) {
          const target = resolveUsage(unit, node);
          if (target) collected.push({ file: unit.path, node, target });
        }
        for (const child of namedChildren(node)) visit(child);
      };
      visit(unit.root);
    }
    index = collected;
    return index;
  };

  return { resolve, resolveTypeReferences, references };
}
