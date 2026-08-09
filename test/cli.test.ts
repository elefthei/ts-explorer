import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  browserOpenCommand,
  browserUrl,
  cliVersion,
  formatSyncProgress,
  formatWatchInvalidation,
  parseCliOptions,
} from "../src/cli.ts";

test("parses explicit directory, host, and port options", () => {
  const directory = join("fixtures", "project");

  expect(parseCliOptions([directory, "--host", "0.0.0.0", "--port", "4242"])).toEqual({
    sourceDir: resolve(directory),
    host: "0.0.0.0",
    port: 4242,
    open: true,
  });
});

test("resolves the current directory while retaining host and port defaults", () => {
  expect(parseCliOptions(["."])).toEqual({
    sourceDir: resolve("."),
    host: "127.0.0.1",
    port: 8080,
    open: true,
  });
});

test("requires the directory positional", () => {
  expect(() => parseCliOptions([])).toThrow(
    "Not enough non-option arguments: got 0, need at least 1",
  );
});

test.each(["--source", "--dir"])("rejects the legacy %s option", (option) => {
  expect(() => parseCliOptions([".", option, "."])).toThrow(
    `Unknown argument: ${option.slice(2)}`,
  );
});

test("does not accept the directory as a --dir value", () => {
  expect(() => parseCliOptions(["--dir", "."])).toThrow(
    "Not enough non-option arguments: got 0, need at least 1",
  );
});

test("rejects a second positional argument", () => {
  expect(() => parseCliOptions([".", "extra"])).toThrow(
    "Too many non-option arguments: got 2, maximum of 1",
  );
});

test("disables the browser launch with --no-open", () => {
  expect(parseCliOptions([".", "--no-open"])?.open).toBe(false);
});

test("expands a bare ~ directory to the home directory", () => {
  expect(parseCliOptions(["~"])?.sourceDir).toBe(resolve(homedir()));
});

test("expands a ~/ prefixed directory relative to the home directory", () => {
  expect(parseCliOptions(["~/projects/demo"])?.sourceDir).toBe(
    resolve(homedir(), "projects/demo"),
  );
});

test("does not expand a directory that merely starts with ~ but has no separator", () => {
  expect(parseCliOptions(["~project"])?.sourceDir).toBe(resolve("~project"));
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
  expect(() => parseCliOptions([".", "--port", port])).toThrow(
    /^port must be an integer between 1 and 65535$/,
  );
});

test.each(["--help", "-h", "--version", "-v"])(
  "returns null for %s without requiring the directory positional",
  (flag) => {
    expect(parseCliOptions([flag])).toBeNull();
  },
);

test("reports the version declared in package.json", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  expect(cliVersion).toBe(manifest.version);
  expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
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
