import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache, type CacheFileWrite, type UmlDiagramRead } from "../../src/cache.ts";
import type { UmlDiagramGraph } from "../../src/diagram-graph.ts";
import { collectFileDefinitionNodes } from "../../src/goto-definition.ts";
import { highlightLanguageForPath } from "../../src/lang/registry.ts";
import { parseRustSource } from "../../src/lang/rust.ts";
import { parseTypeScriptSource } from "../../src/lang/typescript.ts";
import { discoverPackages } from "../../src/packages.ts";
import { decodeSourceBytes, isSourcePath } from "../../src/source.ts";
import { collectTreeEntries } from "../../src/tree.ts";
import type { FileDefinition, TreeNode, UmlTarget } from "../../src/types.ts";
import { extractFileUmlGraph } from "../../src/uml.ts";
import { buildCatalogue, collectFileFacts, type FileFacts } from "../../src/uml/catalogue.ts";
import {
  FULL_UML_VISIBILITY,
  type DefinitionIndexSnapshot,
  type UmlVisibility,
} from "../../src/uml/model.ts";
import { renderUmlView, type RenderedUmlView } from "../../src/uml/view.ts";
import { createFixtureTracker } from "./fixtures.ts";

let projectOrdinal = 0;

export type UmlProject = {
  cache: Cache;
  /** The sqlite file the project was written to; tests may open it read-only for raw SQL. */
  dbPath: string;
  generationId: number;
  snapshot: DefinitionIndexSnapshot;
  /** Every visible source file, in tree order. */
  sourcePaths: string[];
  fileGraph(path: string): UmlDiagramGraph;
  /** Omitting `depth` selects `DEFAULT_UML_DEPTH`, exactly like an omitted request field. */
  read(target: UmlTarget, depth?: number): UmlDiagramRead;
  definitions(path: string): FileDefinition[];
  /** The catalogue key of one qualified declaration, asserted to exist. */
  key(path: string, qualifiedName: string): string;
  close(): void;
};

/**
 * Runs the real indexing and per-file UML extraction over a fixture root, in process. Tests get
 * exactly the rows the preprocess worker would persist, without spawning one.
 */
export async function buildUmlProject(root: string): Promise<UmlProject> {
  projectOrdinal += 1;
  // The database must live outside the indexed tree, or it would appear as a fixture file.
  const cacheDirectory = mkdtempSync(join(tmpdir(), "uml-project-"));
  const dbPath = join(cacheDirectory, `project-${projectOrdinal}.sqlite`);
  const cache = new Cache(dbPath);
  try {
    const generationId = cache.beginGeneration("startup", "");
    const entries = await collectTreeEntries(root, "");
    const rootEntry: TreeNode = { name: "root", path: "", kind: "directory" };
    const sourceEntries = entries.filter((entry) =>
      entry.kind === "file" && isSourcePath(entry.path)
    );
    const contents = new Map<string, string>();
    const facts: FileFacts[] = [];
    const snapshots: CacheFileWrite[] = [];
    for (const entry of sourceEntries) {
      const language = highlightLanguageForPath(entry.path) ?? null;
      const decoded = decodeSourceBytes(await readFile(join(root, entry.path)));
      if ("failure" in decoded) {
        snapshots.push({
          path: entry.path,
          rawContent: null,
          displayContent: null,
          sourceError: decoded.failure,
          formatError: null,
          language,
        });
        continue;
      }
      contents.set(entry.path, decoded.text);
      snapshots.push({
        path: entry.path,
        rawContent: decoded.text,
        displayContent: decoded.text,
        sourceError: null,
        formatError: null,
        language,
      });
      const parsed = language === "rust"
        ? parseRustSource(decoded.text)
        : parseTypeScriptSource(entry.path, decoded.text);
      if (!parsed) continue;
      try {
        facts.push(
          collectFileFacts(
            entry.path,
            parsed.root,
            collectFileDefinitionNodes(entry.path, parsed.root),
          ),
        );
      } finally {
        parsed.dispose();
      }
    }
    cache.writeSourceSnapshots(generationId, snapshots);
    const snapshot = buildCatalogue(facts, [rootEntry, ...entries], await discoverPackages(root));
    cache.writeDefinitionIndex(generationId, snapshot);

    const index = cache.createDefinitionResolutionIndex(generationId);
    const graphs = new Map<string, UmlDiagramGraph>();
    for (const entry of sourceEntries) {
      const content = contents.get(entry.path);
      if (content === undefined) continue;
      const graph = extractFileUmlGraph(entry.path, content, index);
      graphs.set(entry.path, graph);
      cache.writeScope(generationId, {
        diagram: { graph, outcome: { status: "ready" } },
        definitions: [],
      });
    }

    return {
      cache,
      dbPath,
      generationId,
      snapshot,
      sourcePaths: sourceEntries.map((entry) => entry.path),
      fileGraph(path) {
        const graph = graphs.get(path);
        if (!graph) throw new Error(`no UML graph for ${path}`);
        return graph;
      },
      read(target, depth) {
        return cache.readUmlDiagram(generationId, target, depth);
      },
      definitions(path) {
        return cache.readFileDefinitions(generationId, path);
      },
      key(path, qualifiedName) {
        const found = cache
          .readFileDefinitions(generationId, path)
          .find((definition) => definition.qualifiedName === qualifiedName);
        if (!found) throw new Error(`no definition ${qualifiedName} in ${path}`);
        return found.key;
      },
      close() {
        cache.close();
        rmSync(cacheDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    cache.close();
    rmSync(cacheDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** The completed selection for `target`, asserting the read did not report missing file graphs. */
export function readCompleteUml(project: UmlProject, target: UmlTarget, depth?: number) {
  const result = project.read(target, depth);
  if (result.state !== "complete") {
    throw new Error(`selection is pending: ${result.files.join(", ")}`);
  }
  return result.diagram;
}

/**
 * Renders one selection at full visibility, minus `overrides`. The render is a pure projection of
 * the completed read, so tests can vary visibility without re-indexing.
 */
export function renderSelection(
  project: UmlProject,
  target: UmlTarget,
  overrides: Partial<UmlVisibility> = {},
  depth?: number,
): RenderedUmlView {
  const diagram = readCompleteUml(project, target, depth);
  return renderUmlView(diagram.view, { ...FULL_UML_VISIBILITY, ...overrides }, target);
}

export type UmlProjectTracker = {
  /** A temporary fixture root holding `files`, removed by `cleanup`; nothing is indexed. */
  fixtureRoot(prefix: string, files: Record<string, string | Uint8Array>): Promise<string>;
  /**
   * Indexes a fresh fixture root and keeps the project open until `cleanup`. `prepare` runs after
   * the files are written and before indexing, for fixtures needing state no file content creates.
   */
  openProject(
    prefix: string,
    files: Record<string, string>,
    prepare?: (root: string) => Promise<void>,
  ): Promise<UmlProject>;
  /** Closes every project opened through this tracker, then removes every fixture root. */
  cleanup(): Promise<void>;
};

/**
 * The per-file lifecycle every UML suite needs: fixture roots plus the projects built over them,
 * torn down in one `afterEach(cleanup)`. Projects close before their roots are removed, or the
 * open sqlite handle would keep the cache directory alive on Windows.
 */
export function createUmlProjectTracker(): UmlProjectTracker {
  const fixtures = createFixtureTracker();
  const projects: UmlProject[] = [];
  return {
    fixtureRoot: (prefix, files) => fixtures.fixtureRoot(prefix, files),

    async openProject(prefix, files, prepare) {
      const root = await fixtures.fixtureRoot(prefix, files);
      await prepare?.(root);
      const project = await buildUmlProject(root);
      projects.push(project);
      return project;
    },

    async cleanup() {
      for (const project of projects.splice(0)) project.close();
      await fixtures.cleanup();
    },
  };
}
