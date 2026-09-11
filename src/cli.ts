#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import yargs from "yargs/yargs";
import type { PreprocessProgressEvent } from "./preprocess-protocol.ts";
import type { WatchEventName } from "./types.ts";
import { ExplorerServer } from "./server.ts";


export function formatSyncProgress(event: PreprocessProgressEvent): string {
  return `[sync] ${event.event} ${event.component} ${event.resource} generation=${event.generationId} cause=${event.cause}`;
}

export function formatWatchInvalidation(
  paths: readonly string[],
  events: readonly WatchEventName[],
  version: number,
): string {
  return `[sync] invalidate watch version=${version} paths=${JSON.stringify(paths)} events=${JSON.stringify(events)}`;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function parsePackageVersion(manifestJson: string): string {
  let manifest: { version?: unknown };
  try {
    manifest = JSON.parse(manifestJson) as { version?: unknown };
  } catch (error) {
    throw new Error(
      "failed to parse package.json — this likely indicates a corrupted install; try reinstalling with `bun install` or filing an issue with the log above",
      { cause: error },
    );
  }
  if (typeof manifest.version !== "string") {
    throw new Error(
      "package.json is missing a version — this likely indicates a corrupted install; try reinstalling with `bun install` or filing an issue with the log above",
    );
  }
  return manifest.version;
}

function readPackageVersion(): string {
  let manifestJson: string;
  try {
    manifestJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  } catch (error) {
    throw new Error(
      "failed to read package.json — this likely indicates a corrupted install; try reinstalling with `bun install` or filing an issue with the log above",
      { cause: error },
    );
  }
  return parsePackageVersion(manifestJson);
}

export const cliVersion = readPackageVersion();

export function parseCliOptions(args: string[]) {
  const parsed = yargs(args)
    .scriptName("ts-explorer")
    .usage(
      "$0 <dir> [options]\n\nExplore a TypeScript or Rust project in the browser. <dir> is the source directory to explore.",
    )
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      describe: "Host address to bind",
    })
    .option("port", {
      type: "number",
      default: 8080,
      describe: "Port to listen on",
    })
    .option("open", {
      type: "boolean",
      default: true,
      describe: "Open the explorer in the default browser (--no-open to disable)",
    })
    .demandCommand(1, 1)
    .strict()
    .version(cliVersion)
    .alias("version", "v")
    .help()
    .alias("help", "h")
    .showHelpOnFail(false)
    .exitProcess(false)
    .fail(false)
    .parseSync();
  if (parsed.help || parsed.version) return null;
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return {
    sourceDir: resolve(expandHome(String(parsed._[0]))),
    host: parsed.host,
    port: parsed.port,
    open: parsed.open,
  };
}

async function validateSourceDir(sourceDir: string): Promise<void> {
  try {
    const sourceStat = await stat(sourceDir);
    if (!sourceStat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`source directory does not exist or is not a directory: ${sourceDir}`);
  }
}

export function browserUrl(host: string, port: number): string {
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${target.includes(":") ? `[${target}]` : target}:${port}`;
}

export function browserOpenCommand(url: string, platform: NodeJS.Platform) {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = browserOpenCommand(url, process.platform);
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  } catch (error) {
    console.error(
      `could not open a browser at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (import.meta.main) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options) {
      await validateSourceDir(options.sourceDir);
      const server = await ExplorerServer.start({
        sourceDir: options.sourceDir,
        host: options.host,
        port: options.port,
        onSyncProgress(event) {
          console.log(formatSyncProgress(event));
        },
        onWatchBatch(paths, events, version) {
          console.log(formatWatchInvalidation(paths, events, version));
        },
      });
      const url = browserUrl(options.host, server.port);
      console.log(`TS explorer listening at ${url}`);
      if (options.open) openBrowser(url);
      const shutdown = async () => {
        await server.stop();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
