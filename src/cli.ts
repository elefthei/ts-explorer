import { homedir } from "node:os";
import { resolve } from "node:path";
import yargs from "yargs/yargs";
import { stat } from "node:fs/promises";
import type { PreprocessProgressEvent } from "./preprocess-protocol.ts";
import type { WatchEventName } from "./types.ts";
import { ExplorerServer } from "./server.ts";

type CliOptions = {
  sourceDir: string;
  host: string;
  port: number;
};

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

export function parseCliOptions(args: string[]): CliOptions | null {
  const parsed = yargs(args)
    .scriptName("ts-explorer")
    .usage("$0 [options]")
    .option("dir", {
      type: "string",
      demandOption: true,
      describe: "Source directory to explore",
    })
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
    .strict()
    .version(false)
    .help()
    .alias("help", "h")
    .showHelpOnFail(false)
    .exitProcess(false)
    .fail(false)
    .parseSync();
  if (parsed.help) return null;
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return { sourceDir: resolve(expandHome(parsed.dir)), host: parsed.host, port: parsed.port };
}

async function validateSourceDir(sourceDir: string): Promise<void> {
  try {
    const sourceStat = await stat(sourceDir);
    if (!sourceStat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`source directory does not exist or is not a directory: ${sourceDir}`);
  }
}

if (import.meta.main) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options) {
      await validateSourceDir(options.sourceDir);
      const server = await ExplorerServer.start({
        ...options,
        onSyncProgress(event) {
          console.log(formatSyncProgress(event));
        },
        onWatchBatch(paths, events, version) {
          console.log(formatWatchInvalidation(paths, events, version));
        },
      });
      console.log(`TS explorer listening at http://${options.host}:${server.port}`);
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
