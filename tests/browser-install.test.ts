import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_BROWSER_VERSION, prepareBrowserBinary } from "../src/browser-install";
import { BrowserVersionMismatchError, installPinnedBrowser } from "../src/browser-installer";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "cloakhub-installer-"));
  paths.push(path);
  return path;
}
async function binary(cache: string, version = DEFAULT_BROWSER_VERSION) {
  const path = join(cache, `chromium-${version}-pro`, "chrome");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  await writeFile(join(dirname(path), "resources.pak"), "complete browser resources");
  return path;
}

describe("pinned browser installation", () => {
  test("reuses the existing Python cache layout without downloading", async () => {
    const cache = await temp();
    const expected = await binary(cache);
    expect(await installPinnedBrowser(cache, DEFAULT_BROWSER_VERSION, async () => {
      throw new Error("must not download");
    })).toBe(expected);
  });

  test("publishes the entire verified browser directory and cleans staging", async () => {
    const cache = await temp();
    const path = await installPinnedBrowser(cache, DEFAULT_BROWSER_VERSION, stage => binary(stage));
    expect(path).toBe(join(cache, `chromium-${DEFAULT_BROWSER_VERSION}-pro`, "chrome"));
    expect(await readFile(join(dirname(path), "resources.pak"), "utf8")).toBe("complete browser resources");
    expect(await readdir(cache)).toEqual([`chromium-${DEFAULT_BROWSER_VERSION}-pro`]);
  });

  test("a verification or extraction failure never publishes a partial executable", async () => {
    const cache = await temp();
    await expect(installPinnedBrowser(cache, DEFAULT_BROWSER_VERSION, async stage => {
      await binary(stage);
      throw new Error("verification/extraction rejected");
    })).rejects.toThrow("rejected");
    expect(await readdir(cache)).toEqual([]);
    // A retry can install successfully after the failure.
    await expect(installPinnedBrowser(cache, DEFAULT_BROWSER_VERSION, stage => binary(stage))).resolves.toContain("chrome");
  });

  test("rejects free-key version substitution without adopting a different build", async () => {
    const cache = await temp();
    await expect(installPinnedBrowser(cache, DEFAULT_BROWSER_VERSION, stage => binary(stage, "151.0.7922.108.6")))
      .rejects.toBeInstanceOf(BrowserVersionMismatchError);
    expect(await readdir(cache)).toEqual([]);
  });

  test("Bun subprocess reuses cached browser and cannot honor inherited binary/download overrides", async () => {
    const dataRoot = await temp();
    const expected = await binary(join(dataRoot, "browser-cache"));
    const previous = process.env.CLOAKBROWSER_BINARY_PATH;
    process.env.CLOAKBROWSER_BINARY_PATH = "/unexpected/override";
    try {
      expect(await prepareBrowserBinary({ dataRoot, licenseKeys: ["test-key"], installer: "bun" })).toEqual({ path: expected });
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
      else process.env.CLOAKBROWSER_BINARY_PATH = previous;
    }
  });

  test("stable remains available through an explicit version and channel", async () => {
    const dataRoot = await temp();
    const version = "151.0.7922.108.6";
    const expected = await binary(join(dataRoot, "browser-cache"), version);
    expect(await prepareBrowserBinary({ dataRoot, licenseKeys: ["test-key"], installer: "bun", version, channel: "stable" })).toEqual({ path: expected });
  });

  test("waits for an existing OS cache lock and proceeds after its owner exits", async () => {
    const dataRoot = await temp();
    const cache = join(dataRoot, "browser-cache");
    await binary(cache);
    const owner = Bun.spawn(["flock", "--exclusive", join(cache, ".install.lock"), "sh", "-c", "echo locked; read release"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore"
    });
    const reader = owner.stdout.getReader();
    await reader.read();
    let completed = false;
    const pending = prepareBrowserBinary({ dataRoot, licenseKeys: ["test-key"], installer: "bun" })
      .then(result => { completed = true; return result; });
    try {
      await Bun.sleep(50);
      expect(completed).toBe(false);
    } finally {
      owner.stdin.write("release\n");
      owner.stdin.end();
      await owner.exited;
      reader.releaseLock();
    }
    await expect(pending).resolves.toMatchObject({ path: join(cache, `chromium-${DEFAULT_BROWSER_VERSION}-pro`, "chrome") });
  });

  test("validates configuration before downloading and keeps explicit binary overrides", async () => {
    const dataRoot = await temp();
    await expect(prepareBrowserBinary({ dataRoot, installer: "bun", licenseKeys: [] })).rejects.toThrow("requires a license key");
    await expect(prepareBrowserBinary({ dataRoot, installer: "bun", licenseKeys: ["key"], version: "latest" })).rejects.toThrow("exact CloakBrowser");
    await expect(prepareBrowserBinary({ dataRoot, installer: "/usr/local/bin/python", licenseKeys: ["key"] })).rejects.toThrow("must be bun");
    await expect(prepareBrowserBinary({ dataRoot, installer: "bun", licenseKeys: ["key"], channel: "nightly" })).rejects.toThrow("stable or preview");
    const browserBin = await binary(dataRoot);
    expect(await prepareBrowserBinary({ dataRoot, installer: "bun", licenseKeys: [], browserBin })).toEqual({ path: browserBin });
  });
});
