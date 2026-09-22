import { lstat, readFile as readFileBytes } from "node:fs/promises";
import { basename, join } from "node:path";
import { format, formatWithCursor } from "prettier";
import {
  Cache,
  type CacheFileWrite,
  type CachePackageDiagramInput,
  DiagramMaterializationError,
} from "./cache.ts";
import type { PackageDiagramGraph, UmlDiagramGraph, UmlFileOutcome } from "./diagram-graph.ts";
import { collectFileDefinitionNodes, parseDefinitionSpans } from "./goto-definition.ts";
import { computeHighlightSpans } from "./highlight.ts";
import { highlightLanguageForPath } from "./lang/registry.ts";
import { parseRustSource } from "./lang/rust.ts";
import { parseTypeScriptSource } from "./lang/typescript.ts";
import {
  discoverPackages,
  extractPackageDiagramGraph,
  renderPackageDiagramGraph,
} from "./packages.ts";
import { ensureRegularFile, normalizeRelativePath, PathError, resolveInside } from "./paths.ts";
import type {
  PreprocessCause,
  PreprocessErrorCode,
  PreprocessFailure,
  PreprocessProgressEvent,
  PreprocessRequest,
  PreprocessResponse,
  PreprocessResultMap,
  PreprocessScope,
  PreprocessSuccess,
  SourceLocation,
} from "./preprocess-protocol.ts";
import { isRecord } from "./preprocess-protocol.ts";
import {
  decodeSourceBytes,
  isPrettierFormattablePath,
  isSourcePath,
} from "./source.ts";
import { buildTree, collectTreeEntries, computeSourceFingerprint } from "./tree.ts";
import type {
  DiagramRequest,
  EditorGotoDefinition,
  GotoDefinition,
  PackageInfo,
  TreeNode,
  UmlTarget,
} from "./types.ts";
import { bareUmlDiagramGraph, extractFileUmlGraph } from "./uml.ts";
import { buildCatalogue, collectFileFacts, type FileFacts } from "./uml/catalogue.ts";
import { collectEditorDefinitions } from "./uml/definitions.ts";

class PreprocessRequestError extends Error {
  constructor(
    readonly code: PreprocessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreprocessRequestError";
  }
}

type PreprocessState = {
  sourceDir: string;
  cache: Cache;
};

let state: PreprocessState | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRequestId(value: unknown): number {
  if (!isRecord(value)) return -1;
  return typeof value.id === "number" && Number.isSafeInteger(value.id) ? value.id : -1;
}

function requireSafeInteger(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new PreprocessRequestError("BAD_REQUEST", `${field} must be an integer of at least ${minimum}`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PreprocessRequestError("BAD_REQUEST", `${field} must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PreprocessRequestError("BAD_REQUEST", `${field} must be a boolean`);
  }
  return value;
}

function parseCause(value: unknown): PreprocessCause {
  if (value !== "startup" && value !== "watch") {
    throw new PreprocessRequestError("BAD_REQUEST", "cause must be startup or watch");
  }
  return value;
}

function parseLocation(value: unknown): SourceLocation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new PreprocessRequestError("BAD_REQUEST", "location must be an object");
  }
  return {
    line: requireSafeInteger(value.line, "location.line"),
    column: requireSafeInteger(value.column, "location.column"),
  };
}

function parseScope(value: unknown): PreprocessScope {
  if (!isRecord(value)) {
    throw new PreprocessRequestError("BAD_REQUEST", "scope must be an object");
  }
  const path = normalizeRelativePath(requireString(value.path, "scope.path"));
  if (value.kind !== "package" && value.kind !== "directory" && value.kind !== "file") {
    throw new PreprocessRequestError("BAD_REQUEST", "scope.kind is invalid");
  }
  return { path, kind: value.kind };
}

function parseUmlTarget(value: unknown): UmlTarget {
  if (!isRecord(value)) {
    throw new PreprocessRequestError("BAD_REQUEST", "target must be an object");
  }
  const path = normalizeRelativePath(requireString(value.path, "target.path"));
  if (value.kind === "directory") return { kind: "directory", path };
  if (value.kind === "file") {
    if (!path) throw new PreprocessRequestError("BAD_REQUEST", "path is required");
    return { kind: "file", path };
  }
  if (value.kind !== "definition") {
    throw new PreprocessRequestError("BAD_REQUEST", "target.kind is invalid");
  }
  const definitionKey = requireString(value.definitionKey, "target.definitionKey");
  if (!path) throw new PreprocessRequestError("BAD_REQUEST", "path is required");
  if (!definitionKey) throw new PreprocessRequestError("BAD_REQUEST", "definition is required");
  return { kind: "definition", path, definitionKey };
}

function parseDiagramRequest(value: unknown): DiagramRequest {
  if (!isRecord(value)) {
    throw new PreprocessRequestError("BAD_REQUEST", "request must be an object");
  }
  if (value.kind === "packages") {
    if (value.scopePath !== "") {
      throw new PreprocessRequestError("BAD_REQUEST", "packages diagram scope must be the source root");
    }
    return { kind: "packages", scopePath: "" };
  }
  if (value.kind !== "uml") {
    throw new PreprocessRequestError("BAD_REQUEST", "kind must be packages or uml");
  }
  return { kind: "uml", target: parseUmlTarget(value.target) };
}

function parseRequest(value: unknown): PreprocessRequest {
  if (!isRecord(value)) throw new PreprocessRequestError("BAD_REQUEST", "request must be an object");
  const id = requireSafeInteger(value.id, "id", 0);
  const type = requireString(value.type, "type");
  switch (type) {
    case "init":
      return {
        id,
        type,
        sourceDir: requireString(value.sourceDir, "sourceDir"),
        dbPath: requireString(value.dbPath, "dbPath"),
        recover: requireBoolean(value.recover, "recover"),
      };
    case "begin-generation":
      return { id, type, cause: parseCause(value.cause) };
    case "discover-packages":
    case "read-tree":
    case "read-packages":
    case "promote-generation":
      return { id, type, generationId: requireSafeInteger(value.generationId, "generationId") };
    case "index-definitions":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        cause: parseCause(value.cause),
      };
    case "preprocess-scope":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        cause: parseCause(value.cause),
        scope: parseScope(value.scope),
      };
    case "read-diagram":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        request: parseDiagramRequest(value.request),
      };
    case "read-file":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        path: normalizeRelativePath(requireString(value.path, "path")),
        location: parseLocation(value.location),
      };
    case "read-definition":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        path: normalizeRelativePath(requireString(value.path, "path")),
        line: requireSafeInteger(value.line, "line"),
        column: requireSafeInteger(value.column, "column"),
      };
    case "read-file-definitions":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        path: normalizeRelativePath(requireString(value.path, "path")),
      };
    case "lookup-definition":
      return {
        id,
        type,
        path: normalizeRelativePath(requireString(value.path, "path")),
        name: requireString(value.name, "name"),
        qualifiedName: requireString(value.qualifiedName, "qualifiedName"),
      };
    case "search":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        query: requireString(value.query, "query"),
        caseInsensitive: requireBoolean(value.caseInsensitive, "caseInsensitive"),
      };
    case "discard-generation": {
      if (value.mode !== "delete" && value.mode !== "failed") {
        throw new PreprocessRequestError("BAD_REQUEST", "mode must be delete or failed");
      }
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        mode: value.mode,
      };
    }
    case "shutdown":
      return { id, type };
    default:
      throw new PreprocessRequestError("BAD_REQUEST", `unknown request type: ${type}`);
  }
}

function requireState(): PreprocessState {
  if (!state) throw new PreprocessRequestError("BAD_REQUEST", "preprocess child is not initialized");
  return state;
}

async function resolveValidatedPath(
  preprocessState: PreprocessState,
  relativePath: string,
): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  let candidate = preprocessState.sourceDir;
  for (const segment of normalized.split("/")) {
    if (!segment) continue;
    candidate = join(candidate, segment);
    const info = await lstat(candidate).catch(() => null);
    if (!info) throw new PathError("NOT_FOUND", `path not found: ${normalized}`);
    if (info.isSymbolicLink()) throw new PathError("FORBIDDEN", "symbolic links are not allowed");
  }
  return resolveInside(preprocessState.sourceDir, normalized, true);
}

function failedPackageDiagram(
  preprocessState: PreprocessState,
  generationId: number,
  graph: PackageDiagramGraph,
  error: string,
): CachePackageDiagramInput {
  const activeGenerationId = preprocessState.cache.getActiveGenerationId();
  return activeGenerationId === null || activeGenerationId === generationId
    ? { graph, outcome: { status: "error", error } }
    : { fallbackSource: { sourceGenerationId: activeGenerationId }, outcome: { status: "error", error } };
}

async function discoverAndPersist(
  preprocessState: PreprocessState,
  generationId: number,
): Promise<{ packages: PackageInfo[] }> {
  let packages: PackageInfo[];
  let diagram: CachePackageDiagramInput;
  try {
    packages = [...await discoverPackages(preprocessState.sourceDir)].map((pkg) => ({
      name: pkg.name,
      path: normalizeRelativePath(pkg.path),
      dependencies: [...pkg.dependencies],
    }));
    diagram = {
      graph: extractPackageDiagramGraph(packages),
      outcome: { status: "ready" },
    };
  } catch (error) {
    packages = [];
    diagram = failedPackageDiagram(
      preprocessState,
      generationId,
      extractPackageDiagramGraph([], "bare"),
      errorMessage(error),
    );
  }
  preprocessState.cache.writeDiscovery(
    generationId,
    packages,
    diagram,
    renderPackageDiagramGraph,
  );
  return { packages };
}

const DEFINITION_INDEX_READ_BATCH = 64;

/**
 * One pass over every visible source file: raw snapshots are written batch by batch, and the
 * declaration/binding catalogue is published atomically once every file has been parsed. No tree
 * or AST is retained past its batch.
 */
async function indexDefinitions(
  preprocessState: PreprocessState,
  generationId: number,
): Promise<{ definitionCount: number }> {
  const entries = await collectTreeEntries(preprocessState.sourceDir, "");
  const rootEntry: TreeNode = {
    name: basename(preprocessState.sourceDir),
    path: "",
    kind: "directory",
  };
  const files = entries.filter((entry) => entry.kind === "file" && isSourcePath(entry.path));
  // Discovery also runs as its own job, where a malformed manifest becomes the package diagram's
  // error; here it only means no crate name roots a Rust path, so it must not fail indexing.
  let packages: PackageInfo[] = [];
  try {
    packages = (await discoverPackages(preprocessState.sourceDir)).map((pkg) => ({
      ...pkg,
      path: normalizeRelativePath(pkg.path),
    }));
  } catch {
    packages = [];
  }
  const facts: FileFacts[] = [];
  for (let start = 0; start < files.length; start += DEFINITION_INDEX_READ_BATCH) {
    const batch = files.slice(start, start + DEFINITION_INDEX_READ_BATCH);
    const decoded = await Promise.all(batch.map(async (entry) => {
      try {
        const bytes = await readFileBytes(join(preprocessState.sourceDir, entry.path));
        return decodeSourceBytes(bytes);
      } catch (error) {
        return { failure: errorMessage(error) } as const;
      }
    }));
    const snapshots: CacheFileWrite[] = [];
    for (const [index, entry] of batch.entries()) {
      const result = decoded[index];
      if (!result) continue;
      const language = highlightLanguageForPath(entry.path) ?? null;
      snapshots.push(
        "failure" in result
          ? {
            path: entry.path,
            rawContent: null,
            displayContent: null,
            sourceError: result.failure,
            formatError: null,
            language,
          }
          : {
            path: entry.path,
            rawContent: result.text,
            displayContent: null,
            sourceError: null,
            formatError: null,
            language,
          },
      );
    }
    preprocessState.cache.writeSourceSnapshots(generationId, snapshots);
    for (const [index, entry] of batch.entries()) {
      const result = decoded[index];
      if (!result || "failure" in result) continue;
      const parsed = highlightLanguageForPath(entry.path) === "rust"
        ? parseRustSource(result.text)
        : parseTypeScriptSource(entry.path, result.text);
      if (!parsed) continue;
      try {
        facts.push(
          collectFileFacts(entry.path, parsed.root, collectFileDefinitionNodes(entry.path, parsed.root)),
        );
      } finally {
        parsed.dispose();
      }
    }
  }
  const snapshot = buildCatalogue(facts, [rootEntry, ...entries], packages);
  preprocessState.cache.writeDefinitionIndex(generationId, snapshot);
  return { definitionCount: snapshot.definitions.length };
}

type PreprocessedFile = {
  file: CacheFileWrite;
  definitions: EditorGotoDefinition[];
};

function indexDisplayDefinitions(
  path: string,
  displayContent: string | null,
  rawDefinitions: readonly GotoDefinition[],
): EditorGotoDefinition[] {
  if (displayContent === null || rawDefinitions.length === 0) return [];
  const displaySpans = new Map(
    parseDefinitionSpans(path, displayContent).map((definition) => [definition.key, definition]),
  );
  return rawDefinitions.flatMap((definition) => {
    if (definition.source.path !== path) return [];
    const display = displaySpans.get(definition.key);
    return display
      ? [{ ...definition, displayFrom: display.from, displayTo: display.to }]
      : [];
  });
}

async function preprocessFile(
  absolutePath: string,
  path: string,
  source: CacheFileWrite,
  rawDefinitions: readonly GotoDefinition[],
): Promise<PreprocessedFile> {
  if (source.sourceError !== null || source.rawContent === null) {
    return { file: { ...source, displayContent: null }, definitions: [] };
  }
  const rawContent = source.rawContent;
  let file: CacheFileWrite;
  if (!isSourcePath(path)) {
    file = { ...source, displayContent: null, formatError: null };
  } else if (!isPrettierFormattablePath(path)) {
    // Rust is served exactly as written: there is no formatter in this pipeline.
    file = { ...source, displayContent: rawContent, formatError: null };
  } else {
    try {
      file = {
        ...source,
        displayContent: await format(rawContent, { filepath: absolutePath }),
        formatError: null,
      };
    } catch (error) {
      file = { ...source, displayContent: rawContent, formatError: errorMessage(error) };
    }
  }
  return {
    file,
    definitions: indexDisplayDefinitions(path, file.displayContent, rawDefinitions),
  };
}

async function runPhase<Value>(
  generationId: number,
  cause: PreprocessCause,
  component: PreprocessProgressEvent["component"],
  resource: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  await sendMessage({ event: "start", component, resource, generationId, cause });
  const value = await operation();
  await sendMessage({ event: "done", component, resource, generationId, cause });
  return value;
}

type FileDiagram = { graph: UmlDiagramGraph; outcome: UmlFileOutcome };

function extractFileDiagram(
  preprocessState: PreprocessState,
  generationId: number,
  path: string,
  content: string,
): FileDiagram {
  try {
    const index = preprocessState.cache.createDefinitionResolutionIndex(generationId);
    return { graph: extractFileUmlGraph(path, content, index), outcome: { status: "ready" } };
  } catch (error) {
    return { graph: bareUmlDiagramGraph(path), outcome: { status: "error", error: errorMessage(error) } };
  }
}

async function preprocessScope(
  preprocessState: PreprocessState,
  generationId: number,
  cause: PreprocessCause,
  requestedScope: PreprocessScope,
): Promise<{ children: PreprocessScope[] }> {
  const scope = { ...requestedScope, path: normalizeRelativePath(requestedScope.path) };
  if (scope.kind === "package" || scope.kind === "directory") {
    // The indexed tree already holds every entry; a directory scope only fans its cascade out.
    return {
      children: preprocessState.cache
        .readTreeChildren(generationId, scope.path)
        .map((child) => ({ path: child.path, kind: child.kind })),
    };
  }

  const absolutePath = await resolveValidatedPath(preprocessState, scope.path);
  await ensureRegularFile(absolutePath);
  const resource = scope.path ? `./${scope.path}` : ".";
  let source = preprocessState.cache.readFile(generationId, scope.path);
  if (!source) {
    const decoded = await readFileBytes(absolutePath).then(decodeSourceBytes, () => ({
      failure: "file is not valid UTF-8 text" as const,
    }));
    source = "failure" in decoded
      ? {
        path: scope.path,
        rawContent: null,
        displayContent: null,
        sourceError: decoded.failure,
        formatError: null,
        language: highlightLanguageForPath(scope.path) ?? null,
      }
      : {
        path: scope.path,
        rawContent: decoded.text,
        displayContent: null,
        sourceError: null,
        formatError: null,
        language: highlightLanguageForPath(scope.path) ?? null,
      };
  }

  const buildsUml = isSourcePath(scope.path);
  const content = source.rawContent;
  let diagram: FileDiagram | undefined;
  let rawDefinitions: GotoDefinition[] = [];
  if (buildsUml && content !== null) {
    diagram = await runPhase(
      generationId,
      cause,
      "uml",
      resource,
      async () => extractFileDiagram(preprocessState, generationId, scope.path, content),
    );
    rawDefinitions = collectEditorDefinitions(scope.path, content);
  } else if (buildsUml) {
    diagram = {
      graph: bareUmlDiagramGraph(scope.path),
      outcome: { status: "error", error: source.sourceError ?? "source file could not be read" },
    };
  }

  const processedFile = buildsUml
    ? await runPhase(
      generationId,
      cause,
      "code",
      resource,
      () => preprocessFile(absolutePath, scope.path, source, rawDefinitions),
    )
    : await preprocessFile(absolutePath, scope.path, source, rawDefinitions);

  const persist = (nextDiagram: typeof diagram, definitions: readonly EditorGotoDefinition[]) =>
    preprocessState.cache.writeScope(generationId, {
      ...(nextDiagram ? { diagram: nextDiagram } : {}),
      file: processedFile.file,
      definitions,
    });
  try {
    persist(diagram, processedFile.definitions);
  } catch (error) {
    if (!(error instanceof DiagramMaterializationError) || !diagram || diagram.outcome.status !== "ready") {
      throw error;
    }
    persist(
      {
        graph: bareUmlDiagramGraph(scope.path),
        outcome: { status: "error", error: errorMessage(error) },
      },
      [],
    );
  }
  return { children: [] };
}

function rawOffsetForLocation(content: string, location: SourceLocation): number {
  let line = 1;
  let lineStart = 0;
  while (line < location.line && lineStart < content.length) {
    const lf = content.indexOf("\n", lineStart);
    const cr = content.indexOf("\r", lineStart);
    let lineBreak: number;
    if (lf === -1) lineBreak = cr;
    else if (cr === -1) lineBreak = lf;
    else lineBreak = Math.min(lf, cr);
    if (lineBreak === -1) {
      lineStart = content.length;
      break;
    }
    lineStart = content[lineBreak] === "\r" && content[lineBreak + 1] === "\n"
      ? lineBreak + 2
      : lineBreak + 1;
    line += 1;
  }
  const lf = content.indexOf("\n", lineStart);
  const cr = content.indexOf("\r", lineStart);
  let lineEnd = content.length;
  if (lf !== -1) lineEnd = Math.min(lineEnd, lf);
  if (cr !== -1) lineEnd = Math.min(lineEnd, cr);
  return lineStart + Math.min(location.column - 1, lineEnd - lineStart);
}

async function readCachedFile(
  preprocessState: PreprocessState,
  generationId: number,
  requestedPath: string,
  location?: SourceLocation,
): Promise<PreprocessResultMap["read-file"]> {
  const path = normalizeRelativePath(requestedPath);
  const absolutePath = await resolveValidatedPath(preprocessState, path);
  await ensureRegularFile(absolutePath);
  if (!isSourcePath(path)) {
    throw new PreprocessRequestError(
      "INVALID_INPUT",
      "only TypeScript, JavaScript, and Rust source files can be viewed",
    );
  }
  const record = preprocessState.cache.readFile(generationId, path);
  if (!record) throw new PreprocessRequestError("NOT_FOUND", `cached file not found: ${path}`);
  if (record.sourceError) throw new PreprocessRequestError("INVALID_INPUT", record.sourceError);
  if (record.rawContent === null || record.displayContent === null) {
    throw new PreprocessRequestError("NOT_FOUND", `cached file not found: ${path}`);
  }
  const definitions = preprocessState.cache.readDefinitions(generationId, path);
  if (!location) {
    return {
      path,
      content: record.displayContent,
      definitions,
      highlights: computeHighlightSpans(path, record.displayContent),
    };
  }

  const rawOffset = rawOffsetForLocation(record.rawContent, location);
  if (record.formatError || !isPrettierFormattablePath(path)) {
    return {
      path,
      content: record.rawContent,
      definitions,
      highlights: computeHighlightSpans(path, record.rawContent),
      cursorOffset: rawOffset,
    };
  }
  const result = await formatWithCursor(record.rawContent, {
    filepath: absolutePath,
    cursorOffset: rawOffset,
  });
  return {
    path,
    content: result.formatted,
    definitions,
    highlights: computeHighlightSpans(path, result.formatted),
    cursorOffset: result.cursorOffset,
  };
}

function success<Type extends PreprocessRequest["type"]>(
  request: Extract<PreprocessRequest, { type: Type }>,
  value: PreprocessResultMap[Type],
): PreprocessSuccess<Type> {
  return { id: request.id, ok: true, value };
}

async function handleRequest(request: PreprocessRequest): Promise<PreprocessResponse> {
  if (request.type === "init") {
    if (state) throw new PreprocessRequestError("BAD_REQUEST", "preprocess child is already initialized");
    const sourceDir = await resolveInside(request.sourceDir, "", true);
    const sourceFingerprint = await computeSourceFingerprint(sourceDir);
    const cache = new Cache(request.dbPath);
    try {
      const activeGenerationId = request.recover
        ? cache.recover(sourceFingerprint)
        : cache.getActiveGenerationId();
      state = { sourceDir, cache };
      return success(request, {
        activeGenerationId,
        hasFailedDiagrams: activeGenerationId !== null && cache.hasFailedDiagrams(activeGenerationId),
      });
    } catch (error) {
      cache.close();
      throw error;
    }
  }
  if (request.type === "shutdown") {
    if (state) {
      state.cache.close();
      state = undefined;
    }
    return success(request, null);
  }

  const preprocessState = requireState();
  switch (request.type) {
    case "begin-generation":
      return success(request, {
        generationId: preprocessState.cache.beginGeneration(
          request.cause,
          await computeSourceFingerprint(preprocessState.sourceDir),
        ),
      });
    case "discover-packages":
      return success(request, await discoverAndPersist(preprocessState, request.generationId));
    case "index-definitions":
      return success(
        request,
        await runPhase(
          request.generationId,
          request.cause,
          "definitions",
          ".",
          () => indexDefinitions(preprocessState, request.generationId),
        ),
      );
    case "preprocess-scope":
      return success(
        request,
        await preprocessScope(
          preprocessState,
          request.generationId,
          request.cause,
          request.scope,
        ),
      );
    case "read-tree": {
      const entries = preprocessState.cache.readTreeEntries(request.generationId);
      if (!entries.some((entry) => entry.path === "")) {
        throw new PreprocessRequestError("NOT_FOUND", "cached tree is not ready");
      }
      return success(request, buildTree(preprocessState.sourceDir, entries));
    }
    case "read-packages":
      try {
        return success(request, preprocessState.cache.readPackages(request.generationId));
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith("cache package snapshot not found")) {
          throw new PreprocessRequestError("NOT_FOUND", message);
        }
        throw error;
      }
    case "read-diagram": {
      if (request.request.kind === "packages") {
        const diagram = preprocessState.cache.readPackageDiagram(request.generationId);
        if (!diagram) {
          throw new PreprocessRequestError("NOT_FOUND", "cached packages diagram not found");
        }
        return success(request, { state: "complete", diagram });
      }
      const target = request.request.target;
      if (target.kind !== "directory") {
        await resolveValidatedPath(preprocessState, target.path);
      } else if (target.path) {
        await resolveValidatedPath(preprocessState, target.path);
      }
      return success(
        request,
        preprocessState.cache.readUmlDiagram(request.generationId, target),
      );
    }
    case "read-file":
      return success(
        request,
        await readCachedFile(
          preprocessState,
          request.generationId,
          request.path,
          request.location,
        ),
      );
    case "read-definition":
      return success(
        request,
        preprocessState.cache.readDefinition(
          request.generationId,
          request.path,
          request.line,
          request.column,
        ),
      );
    case "read-file-definitions":
      // A pure index read: no cached file, highlighting or UML work is involved.
      return success(
        request,
        preprocessState.cache.readFileDefinitions(request.generationId, request.path),
      );
    case "lookup-definition":
      return success(
        request,
        preprocessState.cache.lookupDefinition(
          request.path,
          request.name,
          request.qualifiedName,
        ),
      );
    case "search":
      return success(
        request,
        preprocessState.cache.searchFiles(
          request.generationId,
          request.query,
          request.caseInsensitive,
        ),
      );
    case "promote-generation":
      preprocessState.cache.promoteGeneration(request.generationId);
      return success(request, null);
    case "discard-generation":
      if (request.mode === "failed") preprocessState.cache.failGeneration(request.generationId);
      else preprocessState.cache.discardGeneration(request.generationId);
      return success(request, null);
  }
}

function failure(id: number, error: unknown): PreprocessFailure {
  if (error instanceof PreprocessRequestError || error instanceof PathError) {
    return { id, ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    id,
    ok: false,
    error: { code: "INTERNAL", message: errorMessage(error) },
  };
}

const sendToParent = process.send?.bind(process) ?? (() => {
  throw new Error("preprocess child requires an IPC channel");
})();

function sendMessage(message: PreprocessResponse | PreprocessProgressEvent): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onDisconnect = () => settle(new Error("preprocess parent IPC disconnected"));
    const settle = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    process.once("disconnect", onDisconnect);
    try {
      sendToParent(message, (error: Error | null) => settle(error));
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

let processing = Promise.resolve();
let finalizing = false;

function closeCacheAndExit(exitCode: number): void {
  try {
    if (state) {
      state.cache.close();
      state = undefined;
    }
  } finally {
    process.exit(exitCode);
  }
}

function finalizeChild(exitCode: number): void {
  if (finalizing) return;
  finalizing = true;
  process.off("message", onMessage);
  processing = processing.then(
    () => closeCacheAndExit(exitCode),
    () => closeCacheAndExit(exitCode),
  );
}

async function processMessage(value: unknown): Promise<void> {
  let request: PreprocessRequest | undefined;
  let response: PreprocessResponse;
  try {
    request = parseRequest(value);
    response = await handleRequest(request);
  } catch (error) {
    let responseError = error;
    if (request?.type !== "init" && state) {
      try {
        const recoveredTable = state.cache.repairTableForSchemaError(error);
        if (recoveredTable) {
          responseError = new PreprocessRequestError(
            "SCHEMA_RETRY",
            `recovered cache table ${recoveredTable}; retry request`,
          );
        }
      } catch (recoveryError) {
        responseError = recoveryError;
      }
    }
    response = failure(request?.id ?? readRequestId(value), responseError);
  }

  try {
    await sendMessage(response);
  } catch {
    finalizeChild(1);
    return;
  }

  if (request?.type === "shutdown") {
    finalizeChild(0);
    process.disconnect();
  }
}

function onMessage(value: unknown): void {
  if (finalizing) return;
  processing = processing.then(
    () => processMessage(value),
    () => processMessage(value),
  );
}

process.on("message", onMessage);
process.once("disconnect", () => finalizeChild(0));
