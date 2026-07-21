import { lstat, readFile as readFileBytes } from "node:fs/promises";
import { basename, join } from "node:path";
import { format, formatWithCursor } from "prettier";
import {
  openCache,
  type CacheDiagramResponse,
  type CacheFileWrite,
  type CacheGotoDefinitionWrite,
  type ExplorerCacheDatabase,
} from "./cache.ts";
import { parseDefinitionSpans } from "./goto-definition.ts";
import { buildPackageDiagram, discoverPackages } from "./packages.ts";
import { ensureRegularFile, normalizeRelativePath, PathError, resolveInside } from "./paths.ts";
import type {
  PreprocessFailure,
  PreprocessRequest,
  PreprocessResponse,
  PreprocessProgressEvent,
  PreprocessResultMap,
  PreprocessScope,
  PreprocessSuccess,
  SourceLocation,
  PreprocessErrorCode,
} from "./preprocess-protocol.ts";
import { isDeclarationPath, isSourcePath, isTypeScriptPath } from "./source.ts";
import { buildTree, readDirectoryEntries } from "./tree.ts";
import type { DiagramKind, GotoDefinition, PackageInfo, TreeNode } from "./types.ts";
import { buildUmlDiagrams } from "./uml.ts";


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
  cache: ExplorerCacheDatabase;
};

let state: PreprocessState | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parsePackages(value: unknown): PackageInfo[] {
  if (!Array.isArray(value)) {
    throw new PreprocessRequestError("BAD_REQUEST", "packages must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new PreprocessRequestError("BAD_REQUEST", `packages[${index}] must be an object`);
    }
    const name = requireString(item.name, `packages[${index}].name`);
    const path = normalizeRelativePath(requireString(item.path, `packages[${index}].path`));
    if (!Array.isArray(item.dependencies) || !item.dependencies.every((dependency) => typeof dependency === "string")) {
      throw new PreprocessRequestError("BAD_REQUEST", `packages[${index}].dependencies must be a string array`);
    }
    return { name, path, dependencies: [...item.dependencies] };
  });
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
    case "begin-generation": {
      if (value.cause !== "startup" && value.cause !== "watch") {
        throw new PreprocessRequestError("BAD_REQUEST", "cause must be startup or watch");
      }
      return { id, type, cause: value.cause };
    }
    case "discover-packages":
    case "read-tree":
    case "read-packages":
    case "promote-generation":
      return { id, type, generationId: requireSafeInteger(value.generationId, "generationId") };
    case "preprocess-scope":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        scope: parseScope(value.scope),
        packages: parsePackages(value.packages),
      };
    case "read-diagram": {
      if (value.kind !== "packages" && value.kind !== "uml") {
        throw new PreprocessRequestError("BAD_REQUEST", "kind must be packages or uml");
      }
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        kind: value.kind,
        scopePath: normalizeRelativePath(requireString(value.scopePath, "scopePath")),
      };
    }
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
    case "search":
      return {
        id,
        type,
        generationId: requireSafeInteger(value.generationId, "generationId"),
        query: requireString(value.query, "query"),
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

async function resolveValidatedPath(preprocessState: PreprocessState, relativePath: string): Promise<string> {
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

function emptyDiagram(kind: DiagramKind, scopePath: string, dsl: string): CacheDiagramResponse {
  return {
    kind,
    scopePath,
    status: "ready",
    dsl,
    dsls: [dsl],
    packageNodes: [],
    definitions: [],
    externalUsers: [],
    localUsers: [],
  };
}

function errorDiagram(
  scopePath: string,
  message: string,
  previous: CacheDiagramResponse | null,
): CacheDiagramResponse {
  const fallback = previous ?? emptyDiagram("uml", scopePath, "classDiagram");
  return {
    kind: "uml",
    scopePath,
    status: "error",
    dsl: fallback.dsl,
    dsls: fallback.dsls,
    packageNodes: fallback.packageNodes,
    definitions: fallback.definitions,
    externalUsers: fallback.externalUsers,
    localUsers: fallback.localUsers,
    error: message,
  };
}

async function discoverAndPersist(
  preprocessState: PreprocessState,
  generationId: number,
): Promise<{ packages: PackageInfo[] }> {
  let packages: PackageInfo[];
  let diagram: CacheDiagramResponse;
  try {
    packages = [...await discoverPackages(preprocessState.sourceDir)].map((pkg) => ({
      name: pkg.name,
      path: normalizeRelativePath(pkg.path),
      dependencies: [...pkg.dependencies],
    }));
    const built = buildPackageDiagram(packages);
    diagram = {
      ...emptyDiagram("packages", "", built.dsl),
      packageNodes: built.packageNodes,
    };
  } catch (error) {
    packages = [];
    let previous: CacheDiagramResponse | null = null;
    try {
      const activeGenerationId = preprocessState.cache.getActiveGenerationId();
      if (activeGenerationId !== null && activeGenerationId !== generationId) {
        previous = preprocessState.cache.readDiagram(activeGenerationId, "packages", "");
      }
    } catch {
      previous = null;
    }
    const fallback = previous ?? emptyDiagram("packages", "", "flowchart LR");
    diagram = {
      kind: "packages",
      scopePath: "",
      status: "error",
      dsl: fallback.dsl,
      dsls: fallback.dsls,
      packageNodes: fallback.packageNodes,
      definitions: fallback.definitions,
      externalUsers: fallback.externalUsers,
      localUsers: fallback.localUsers,
      error: errorMessage(error),
    };
  }
  preprocessState.cache.writeDiscovery(generationId, packages, diagram);
  return { packages };
}

async function buildScopeDiagram(
  preprocessState: PreprocessState,
  generationId: number,
  scopePath: string,
  shouldBuild: boolean,
  packages: readonly PackageInfo[],
): Promise<CacheDiagramResponse> {
  if (!shouldBuild) return emptyDiagram("uml", scopePath, "classDiagram");
  try {
    const uml = await buildUmlDiagrams(preprocessState.sourceDir, scopePath, packages);
    return {
      kind: "uml",
      scopePath,
      status: "ready",
      dsl: uml.dsl,
      dsls: uml.dsls,
      packageNodes: [],
      definitions: uml.definitions,
      externalUsers: uml.externalUsers,
      localUsers: uml.localUsers,
    };
  } catch (error) {
    let previous: CacheDiagramResponse | null = null;
    try {
      const activeGenerationId = preprocessState.cache.getActiveGenerationId();
      if (activeGenerationId !== null && activeGenerationId !== generationId) {
        previous = preprocessState.cache.readDiagram(activeGenerationId, "uml", scopePath);
      }
    } catch {
      previous = null;
    }
    return errorDiagram(scopePath, errorMessage(error), previous);
  }
}

type PreprocessedFile = {
  file: CacheFileWrite;
  definitions: CacheGotoDefinitionWrite[];
};

function indexDisplayDefinitions(
  path: string,
  displayContent: string | null,
  rawDefinitions: readonly GotoDefinition[],
): CacheGotoDefinitionWrite[] {
  if (displayContent === null || rawDefinitions.length === 0) return [];
  const displaySpans = new Map(
    parseDefinitionSpans(path, displayContent).map((definition) => [definition.key, definition]),
  );
  return rawDefinitions.flatMap((definition) => {
    if (definition.source.path !== path) return [];
    const display = displaySpans.get(definition.key);
    return display
      ? [{
        ...definition,
        displayFrom: display.from,
        displayTo: display.to,
      }]
      : [];
  });
}

async function preprocessFile(
  absolutePath: string,
  path: string,
  rawDefinitions: readonly GotoDefinition[],
): Promise<PreprocessedFile> {
  let rawContent: string;
  try {
    rawContent = new TextDecoder("utf-8", { fatal: true }).decode(await readFileBytes(absolutePath));
  } catch {
    return {
      file: {
        path,
        rawContent: null,
        displayContent: null,
        sourceError: "file is not valid UTF-8 text",
        formatError: null,
      },
      definitions: [],
    };
  }
  if (rawContent.includes("\0")) {
    return {
      file: {
        path,
        rawContent: null,
        displayContent: null,
        sourceError: "file contains NUL bytes",
        formatError: null,
      },
      definitions: [],
    };
  }
  let file: CacheFileWrite;
  if (!isSourcePath(path)) {
    file = {
      path,
      rawContent,
      displayContent: null,
      sourceError: null,
      formatError: null,
    };
  } else {
    try {
      file = {
        path,
        rawContent,
        displayContent: await format(rawContent, { filepath: absolutePath }),
        sourceError: null,
        formatError: null,
      };
    } catch (error) {
      file = {
        path,
        rawContent,
        displayContent: rawContent,
        sourceError: null,
        formatError: errorMessage(error),
      };
    }
  }
  return {
    file,
    definitions: indexDisplayDefinitions(path, file.displayContent, rawDefinitions),
  };
}

async function runPhase<Value>(
  component: PreprocessProgressEvent["component"],
  resource: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  await sendMessage({ event: "start", component, resource });
  const value = await operation();
  await sendMessage({ event: "done", component, resource });
  return value;
}

async function preprocessScope(
  preprocessState: PreprocessState,
  generationId: number,
  requestedScope: PreprocessScope,
  packages: readonly PackageInfo[],
): Promise<{ children: PreprocessScope[] }> {
  const scope = { ...requestedScope, path: normalizeRelativePath(requestedScope.path) };
  const absolutePath = await resolveValidatedPath(preprocessState, scope.path);
  const info = await lstat(absolutePath);
  const isDirectoryScope = scope.kind === "package" || scope.kind === "directory";
  if (isDirectoryScope && !info.isDirectory()) {
    throw new PreprocessRequestError("BAD_REQUEST", "directory scope path is not a directory");
  }
  if (!isDirectoryScope) await ensureRegularFile(absolutePath);

  let children: TreeNode[] = [];
  const ownEntry: TreeNode = isDirectoryScope
    ? {
      name: scope.path ? basename(scope.path) : basename(preprocessState.sourceDir),
      path: scope.path,
      kind: "directory",
    }
    : {
      name: basename(scope.path),
      path: scope.path,
      kind: "file",
      viewable: isSourcePath(scope.path),
    };
  if (isDirectoryScope) {
    children = await readDirectoryEntries(preprocessState.sourceDir, scope.path);
  }

  const shouldBuildUml = isDirectoryScope
    || (isTypeScriptPath(scope.path) && !isDeclarationPath(scope.path));
  const resource = scope.path ? `./${scope.path}` : ".";
  const buildDiagram = () => buildScopeDiagram(
    preprocessState,
    generationId,
    scope.path,
    shouldBuildUml,
    packages,
  );
  const diagram = shouldBuildUml
    ? await runPhase("uml", resource, buildDiagram)
    : await buildDiagram();
  const processedFile = isDirectoryScope
    ? undefined
    : await runPhase(
      "code",
      resource,
      () => preprocessFile(
        absolutePath,
        scope.path,
        diagram.status === "ready" ? diagram.definitions : [],
      ),
    );
  preprocessState.cache.writeScope(generationId, {
    entries: [ownEntry, ...children],
    diagram,
    file: processedFile?.file,
    definitions: processedFile?.definitions ?? [],
  });
  return {
    children: children.map((child) => ({
      path: child.path,
      kind: child.kind,
    })),
  };
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
      "only TypeScript and JavaScript source files can be viewed",
    );
  }
  const record = preprocessState.cache.readFile(generationId, path);
  if (!record) throw new PreprocessRequestError("NOT_FOUND", `cached file not found: ${path}`);
  if (record.sourceError) throw new PreprocessRequestError("INVALID_INPUT", record.sourceError);
  if (record.rawContent === null || record.displayContent === null) {
    throw new PreprocessRequestError("INVALID_INPUT", "source file has no display content");
  }
  const definitions = preprocessState.cache.readDefinitions(generationId, path);
  if (!location) return { path, content: record.displayContent, definitions };

  const rawOffset = rawOffsetForLocation(record.rawContent, location);
  if (record.formatError) {
    return { path, content: record.rawContent, definitions, cursorOffset: rawOffset };
  }
  const result = await formatWithCursor(record.rawContent, {
    filepath: absolutePath,
    cursorOffset: rawOffset,
  });
  return { path, content: result.formatted, definitions, cursorOffset: result.cursorOffset };
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
    const cache = openCache(request.dbPath);
    try {
      const activeGenerationId = request.recover
        ? cache.recover()
        : cache.getActiveGenerationId();
      state = { sourceDir, cache };
      return success(request, { activeGenerationId });
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
        generationId: preprocessState.cache.beginGeneration(request.cause),
      });
    case "discover-packages":
      return success(request, await discoverAndPersist(preprocessState, request.generationId));
    case "preprocess-scope":
      return success(
        request,
        await preprocessScope(preprocessState, request.generationId, request.scope, request.packages),
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
      if (request.kind === "packages" && request.scopePath !== "") {
        throw new PreprocessRequestError("BAD_REQUEST", "packages diagram scope must be the source root");
      }
      const diagram = preprocessState.cache.readDiagram(
        request.generationId,
        request.kind,
        request.scopePath,
      );
      if (!diagram) {
        throw new PreprocessRequestError(
          "NOT_FOUND",
          `cached ${request.kind} diagram not found: ${request.scopePath}`,
        );
      }
      return success(request, diagram);
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
    case "search":
      return success(request, preprocessState.cache.searchFiles(request.generationId, request.query));
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

const sendToParent = process.send?.bind(process);
if (!sendToParent) throw new Error("preprocess child requires an IPC channel");

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
      sendToParent!(message, (error: Error | null) => settle(error));
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
    response = failure(request?.id ?? readRequestId(value), error);
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
