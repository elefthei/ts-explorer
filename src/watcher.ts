import { watch, type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { WatchEventName } from "./types.ts";

const IGNORED = /(^|[\\/])(?:\.git|node_modules|dist|coverage|\.cache|build|out)(?:[\\/]|$)/;
const EVENTS: WatchEventName[] = ["add", "change", "unlink", "addDir", "unlinkDir"];

export async function startSourceWatcher(
  sourceDir: string,
  onBatch: (paths: string[], events: WatchEventName[]) => void,
  onError: (error: Error) => void,
): Promise<{ close(): Promise<void> }> {
  const watcher: FSWatcher = watch(sourceDir, {
    followSymlinks: false,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (path) => IGNORED.test(path),
    persistent: true,
  });
  const pending = new Map<string, WatchEventName>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const entries = [...pending.entries()].sort(([left], [right]) => left.localeCompare(right));
    pending.clear();
    onBatch(entries.map(([path]) => path), entries.map(([, event]) => event));
  };
  const handleEvent = (event: WatchEventName, path: string) => {
    const relativePath = relative(sourceDir, path).split(sep).join("/");
    pending.set(relativePath, event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 150);
  };
  for (const event of EVENTS) watcher.on(event, (path) => handleEvent(event, path));
  watcher.on("error", (error) => onError(error instanceof Error ? error : new Error(String(error))));
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  }).catch((error) => {
    void watcher.close();
    throw error;
  });
  return {
    async close() {
      if (timer) clearTimeout(timer);
      pending.clear();
      await watcher.close();
    },
  };
}
