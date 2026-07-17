import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { startServer } from "./server.ts";

export type CliOptions = {
  sourceDir: string;
  host: string;
  port: number;
};

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function parseCliOptions(args: string[]): CliOptions {
  const parsed = parseArgs({
    args,
    options: {
      source: { type: "string", default: "/home/eioannidis/git/junco-runtime" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8080" },
    },
    allowPositionals: false,
  });
  const sourceDir = resolve(expandHome(parsed.values.source ?? ""));
  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return { sourceDir, host: parsed.values.host ?? "127.0.0.1", port };
}

export async function validateSourceDir(sourceDir: string): Promise<void> {
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
    await validateSourceDir(options.sourceDir);
    const server = await startServer(options);
    console.log(`TS explorer listening at http://${options.host}:${server.port}`);
    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
