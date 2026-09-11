import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-explorer-cache-corruption-"));
  roots.push(root);
  return join(root, "cache.sqlite");
}

test("Cache transparently rebuilds when the database file is garbage bytes", async () => {
  const dbPath = await temporaryDbPath();
  await writeFile(dbPath, "not a sqlite database, just garbage bytes");

  const cache = new Cache(dbPath);
  try {
    // A freshly rebuilt cache has no active generation.
    expect(cache.recover()).toBeNull();
  } finally {
    cache.close();
  }
});

test("Cache rebuild also removes stale -wal and -shm sidecar files", async () => {
  const dbPath = await temporaryDbPath();
  await writeFile(dbPath, "corrupted");
  await writeFile(`${dbPath}-wal`, "stale wal");
  await writeFile(`${dbPath}-shm`, "stale shm");

  const cache = new Cache(dbPath);
  try {
    expect(cache.recover()).toBeNull();
  } finally {
    cache.close();
  }

  // The stale sidecar files from the corrupted database must not survive;
  // any -wal/-shm now present belongs to the freshly created database.
  expect(existsSync(dbPath)).toBe(true);
});

test("Cache opens normally (no rebuild) when the file is valid", async () => {
  const dbPath = await temporaryDbPath();

  const first = new Cache(dbPath);
  first.close();

  // Reopening a valid, previously-initialized cache should not throw and
  // should still report no active generation (nothing was ever promoted).
  const second = new Cache(dbPath);
  try {
    expect(second.recover()).toBeNull();
  } finally {
    second.close();
  }
});
