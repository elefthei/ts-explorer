import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  browserOpenCommand,
  browserUrl,
  cliVersion,
  describeSourceDirError,
  describeStartupError,
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

test("describeSourceDirError reports a missing directory", () => {
  const error = Object.assign(new Error("boom"), { code: "ENOENT" });
  expect(describeSourceDirError(error, "/no/such/dir")).toBe(
    "source directory does not exist: /no/such/dir",
  );
});

test.each(["EACCES", "EPERM"])(
  "describeSourceDirError reports a permission error for %s",
  (code) => {
    const error = Object.assign(new Error("boom"), { code });
    expect(describeSourceDirError(error, "/restricted")).toBe(
      "cannot access source directory (permission denied): /restricted",
    );
  },
);

test("describeSourceDirError reports a non-directory path", () => {
  expect(describeSourceDirError(new Error("not a directory"), "/some/file")).toBe(
    "source path exists but is not a directory: /some/file",
  );
});

test("describeSourceDirError falls back to a generic message for unknown errors", () => {
  expect(describeSourceDirError(new Error("weird"), "/x")).toBe(
    "source directory does not exist or is not a directory: /x",
  );
});

test("describeStartupError explains a port already in use", () => {
  const error = Object.assign(new Error("boom"), { code: "EADDRINUSE" });
  expect(describeStartupError(error, 8080)).toBe(
    "Port 8080 is already in use. Try a different --port, or run with --port 0 to let the OS choose a free port.",
  );
});

test("describeStartupError explains a permission error binding a privileged port", () => {
  const error = Object.assign(new Error("boom"), { code: "EACCES" });
  expect(describeStartupError(error, 80)).toBe(
    "Permission denied binding to port 80 (ports below 1024 usually require elevated privileges). Try a port >= 1024.",
  );
});

test("describeStartupError falls back to the original error message", () => {
  expect(describeStartupError(new Error("client bundle failed"), 8080)).toBe(
    "client bundle failed",
  );
});
