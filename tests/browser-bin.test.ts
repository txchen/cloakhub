import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { resolveBrowserBin } from "../src/browser-bin";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("resolveBrowserBin", () => {
  test("uses an executable CLOAKHUB_BROWSER_BIN override", async () => {
    const browserBin = await fakeExecutable("cloakbrowser-custom");

    await expect(resolveBrowserBin(browserBin, { pathEnv: "" })).resolves.toEqual({
      path: browserBin
    });
  });

  test("discovers cloakbrowser on PATH", async () => {
    const browserBin = await fakeExecutable("cloakbrowser");
    const pathEnv = dirname(browserBin);

    await expect(resolveBrowserBin(undefined, { pathEnv })).resolves.toEqual({ path: browserBin });
  });

  test("fails clearly when the CloakBrowser Binary is missing", async () => {
    await expect(resolveBrowserBin(undefined, { pathEnv: delimiter })).rejects.toThrow(
      "Missing CloakBrowser Binary"
    );
  });
});

async function fakeExecutable(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cloakhub-browser-bin-"));
  cleanupPaths.push(directory);
  const browserBin = join(directory, name);

  await writeFile(browserBin, "#!/bin/sh\nexit 0\n");
  await chmod(browserBin, 0o755);

  return browserBin;
}
