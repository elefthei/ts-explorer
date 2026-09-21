import { parseDefinitionSpans } from "../goto-definition.ts";
import type { GotoDefinition } from "../types.ts";

/**
 * Editor/search navigation rows for one file. This is the legacy `GotoDef` lane: it addresses the
 * raw declaration spans the editor maps to formatted offsets, and is deliberately independent of
 * the rooted UML catalogue. `path` is already source-root relative.
 */
export function collectEditorDefinitions(path: string, content: string): GotoDefinition[] {
  return parseDefinitionSpans(path, content)
    .map((span): GotoDefinition => ({
      key: span.key,
      kind: span.kind,
      name: span.name,
      qualifiedName: span.qualifiedName,
      source: { path, line: span.line, column: span.column },
      uml: {
        scopePath: path,
        entityName: span.renderedEntityName,
        ...(span.memberName === undefined ? {} : { memberName: span.memberName }),
        ...(span.sourceMemberOccurrence === undefined
          ? {}
          : { memberOccurrence: span.sourceMemberOccurrence }),
      },
    }))
    .sort((left, right) =>
      left.source.line - right.source.line
      || left.source.column - right.source.column
      || left.key.localeCompare(right.key)
    );
}
