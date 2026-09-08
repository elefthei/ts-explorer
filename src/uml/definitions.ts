import { parseDefinitionSpans, type ParsedDefinitionSpan, type ParsedEntityKind } from "../goto-definition.ts";
import type { GotoDefinition } from "../types.ts";
import { UML_ENTITY_COLLECTIONS } from "./entities.ts";
import { scopeRelativePath, umlEntityKey, umlFileKey } from "./keys.ts";
import { bareUmlName } from "./mermaid.ts";
import type { FileDeclaration, UmlReference } from "./model.ts";

function parsedDeclarationKey(
  kind: ParsedEntityKind,
  name: string,
  occurrence: number,
): string {
  return `${kind}\0${name}\0${occurrence}`;
}

export function collectRenderedModel(
  sourceDir: string,
  declarations: readonly FileDeclaration[],
  contents: ReadonlyMap<string, string>,
): { definitions: GotoDefinition[]; entities: Map<string, UmlReference> } {
  const definitions: GotoDefinition[] = [];
  const entities = new Map<string, UmlReference>();
  for (const declaration of declarations) {
    const source = contents.get(umlFileKey(declaration.fileName)) ?? "";
    const parsed = parseDefinitionSpans(declaration.fileName, source);
    const entitiesByKey = new Map<string, ParsedDefinitionSpan>();
    const methodsByEntity = new Map<string, ParsedDefinitionSpan[]>();
    for (const definition of parsed) {
      const key = parsedDeclarationKey(
        definition.entityKind,
        definition.entityName,
        definition.entityOccurrence,
      );
      if (definition.kind === "method") {
        const methods = methodsByEntity.get(key) ?? [];
        methods.push(definition);
        methodsByEntity.set(key, methods);
      } else {
        entitiesByKey.set(key, definition);
      }
    }

    const entityOccurrences = new Map<string, number>();
    const renderedMethodOccurrences = new Map<string, number>();
    const scopePath = scopeRelativePath(sourceDir, declaration.fileName);
    for (const descriptor of UML_ENTITY_COLLECTIONS) {
      for (const entity of declaration[descriptor.key]) {
        const bareName = bareUmlName(entity.name);
        entities.set(umlEntityKey(declaration.fileName, bareName), {
          id: entity.id,
          name: entity.name,
        });
        const counterKey = `${descriptor.kind}\0${bareName}`;
        const entityOccurrence = entityOccurrences.get(counterKey) ?? 0;
        entityOccurrences.set(counterKey, entityOccurrence + 1);
        const declarationKey = parsedDeclarationKey(descriptor.kind, bareName, entityOccurrence);
        const parsedEntity = entitiesByKey.get(declarationKey);
        if (!parsedEntity) continue;
        definitions.push({
          key: parsedEntity.key,
          kind: parsedEntity.kind,
          name: parsedEntity.name,
          qualifiedName: parsedEntity.qualifiedName,
          source: {
            path: scopePath,
            line: parsedEntity.line,
            column: parsedEntity.column,
          },
          uml: {
            scopePath,
            entityName: entity.name,
          },
        });

        const parsedMethods = methodsByEntity.get(declarationKey) ?? [];
        const usedMethods = new Set<string>();
        for (const renderedMethod of entity.methods) {
          const occurrenceKey = `${bareName}\0${renderedMethod.name}`;
          const memberOccurrence = renderedMethodOccurrences.get(occurrenceKey) ?? 0;
          renderedMethodOccurrences.set(occurrenceKey, memberOccurrence + 1);
          const parsedMethod = parsedMethods.find((candidate) =>
            candidate.memberName === renderedMethod.name && !usedMethods.has(candidate.key)
          );
          if (!parsedMethod) continue;
          usedMethods.add(parsedMethod.key);
          definitions.push({
            key: parsedMethod.key,
            kind: "method",
            name: parsedMethod.name,
            qualifiedName: parsedMethod.qualifiedName,
            source: {
              path: scopePath,
              line: parsedMethod.line,
              column: parsedMethod.column,
            },
            uml: {
              scopePath,
              entityName: entity.name,
              memberName: renderedMethod.name,
              memberOccurrence,
            },
          });
        }
      }
    }
  }
  definitions.sort((left, right) =>
    left.source.path.localeCompare(right.source.path)
    || left.source.line - right.source.line
    || left.source.column - right.source.column
    || left.key.localeCompare(right.key)
  );
  return { definitions, entities };
}
