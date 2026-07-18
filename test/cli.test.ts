import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { parseCliOptions } from "../src/cli.ts";

test("parses explicit directory, host, and port options", () => {
  const directory = join("fixtures", "project");

  expect(parseCliOptions(["--dir", directory, "--host", "0.0.0.0", "--port", "4242"])).toEqual({
    sourceDir: resolve(directory),
    host: "0.0.0.0",
    port: 4242,
  });
});

test("resolves the current directory while retaining host and port defaults", () => {
  expect(parseCliOptions(["--dir", "."])).toEqual({
    sourceDir: resolve("."),
    host: "127.0.0.1",
    port: 8080,
  });
});

test("requires --dir", () => {
  expect(() => parseCliOptions([])).toThrow("Missing required argument: dir");
});

test("rejects the legacy --source option", () => {
  expect(() => parseCliOptions(["--dir", ".", "--source", "."])).toThrow("Unknown argument: source");
});

test.each(["0", "65536", "1.5"])("rejects invalid port %s", (port) => {
  expect(() => parseCliOptions(["--dir", ".", "--port", port])).toThrow(
    /^port must be an integer between 1 and 65535$/,
  );
});

test.each(["--help", "-h"])("returns null for %s without requiring --dir", (helpFlag) => {
  expect(parseCliOptions([helpFlag])).toBeNull();
});
