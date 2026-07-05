import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureDataRoot } from "../src/data-root";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("ensureDataRoot", () => {
  test("creates the Data Root when it does not exist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cloakhub-data-root-"));
    cleanupPaths.push(parent);
    const dataRoot = join(parent, "nested", "data");

    await expect(ensureDataRoot(dataRoot)).resolves.toEqual({ path: dataRoot });
  });

  test("fails clearly when the Data Root path is unusable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cloakhub-data-root-"));
    cleanupPaths.push(parent);
    const dataRoot = join(parent, "data-file");
    await writeFile(dataRoot, "not a directory");

    await expect(ensureDataRoot(dataRoot)).rejects.toThrow(
      `Data Root "${dataRoot}" is unusable`
    );
  });
});
