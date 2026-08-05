import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  browserOpenCommand,
  browserUrl,
  formatSyncProgress,
  formatWatchInvalidation,
  parseCliOptions,
} from "../src/cli.ts";

test("parses explicit directory, host, and port options", () => {
  const directory = join("fixtures", "project");

  expect(parseCliOptions(["--dir", directory, "--host", "0.0.0.0", "--port", "4242"])).toEqual({
    sourceDir: resolve(directory),
    host: "0.0.0.0",
    port: 4242,
    open: true,
  });
});

test("resolves the current directory while retaining host and port defaults", () => {
  expect(parseCliOptions(["--dir", "."])).toEqual({
    sourceDir: resolve("."),
    host: "127.0.0.1",
    port: 8080,
    open: true,
  });
});

test("requires --dir", () => {
  expect(() => parseCliOptions([])).toThrow("Missing required argument: dir");
});

test("rejects the legacy --source option", () => {
  expect(() => parseCliOptions(["--dir", ".", "--source", "."])).toThrow("Unknown argument: source");
});

test("disables the browser launch with --no-open", () => {
  expect(parseCliOptions(["--dir", ".", "--no-open"])?.open).toBe(false);
});

test("browses the loopback address when bound to a wildcard host", () => {
  expect(browserUrl("0.0.0.0", 8080)).toBe("http://127.0.0.1:8080");
  expect(browserUrl("::", 8080)).toBe("http://127.0.0.1:8080");
});

test("browses the bound host and actual port", () => {
  expect(browserUrl("127.0.0.1", 4242)).toBe("http://127.0.0.1:4242");
  expect(browserUrl("::1", 4242)).toBe("http://[::1]:4242");
});

test.each([
  ["win32", { command: "cmd", args: ["/c", "start", "", "http://127.0.0.1:8080"] }],
  ["darwin", { command: "open", args: ["http://127.0.0.1:8080"] }],
  ["linux", { command: "xdg-open", args: ["http://127.0.0.1:8080"] }],
] satisfies [NodeJS.Platform, { command: string; args: string[] }][])("builds the %s browser launch command", (platform, expected) => {
  expect(browserOpenCommand("http://127.0.0.1:8080", platform)).toEqual(expected);
});

test.each(["0", "65536", "1.5"])("rejects invalid port %s", (port) => {
  expect(() => parseCliOptions(["--dir", ".", "--port", port])).toThrow(
    /^port must be an integer between 1 and 65535$/,
  );
});

test.each(["--help", "-h"])("returns null for %s without requiring --dir", (helpFlag) => {
  expect(parseCliOptions([helpFlag])).toBeNull();
});

test("formats generation-aware phase progress exactly", () => {
  expect(formatSyncProgress({
    event: "done",
    component: "code",
    resource: "./packages/dataflow-values",
    generationId: 42,
    cause: "watch",
  })).toBe(
    "[sync] done code ./packages/dataflow-values generation=42 cause=watch",
  );
});

test("formats path-sorted watch invalidation arrays exactly without losing JSON escaping", () => {
  expect(formatWatchInvalidation(
    ["packages/a file.ts", 'packages/b"quoted".ts'],
    ["change", "unlink"],
    17,
  )).toBe(
    '[sync] invalidate watch version=17 paths=["packages/a file.ts","packages/b\\"quoted\\".ts"] events=["change","unlink"]',
  );
});
