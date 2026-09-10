import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export class BrowserVersionMismatchError extends Error {}

// Called under the OS flock held by prepareBrowserBinary. Publish a complete install
// atomically: an interrupted extraction must never look like a usable cached browser.
export async function installPinnedBrowser(
  cacheDir: string,
  version: string,
  download: (stagingCache: string) => Promise<string>
): Promise<string> {
  if (!/^151\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error("Expected an exact CloakBrowser 151 release version");
  }
  const binaryDir = `chromium-${version}-pro`;
  const expected = resolve(cacheDir, binaryDir, "chrome");
  try {
    await access(expected, constants.X_OK);
    return expected; // Includes existing caches populated by the old Python installer.
  } catch { /* No usable cached install. */ }

  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(join(resolve(cacheDir), ".install-"));
  try {
    const actual = await download(staging);
    if (resolve(actual) !== join(staging, binaryDir, "chrome")) {
      // Free keys ignore the upstream download pin. Do not adopt an unreviewed build.
      throw new BrowserVersionMismatchError();
    }
    await access(actual, constants.X_OK);
    await rm(dirname(expected), { recursive: true, force: true });
    await rename(dirname(actual), dirname(expected));
    return expected;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // Keep upstream output (which can include signed URLs) out of the result protocol.
  console.log = console.info = console.warn = console.error = () => undefined;
  try {
    if (process.platform !== "linux") throw new Error("Managed installation requires Linux");
    const [, , cacheDir, version] = process.argv;
    if (!cacheDir || !version) throw new Error("Missing installer arguments");
    const key = process.env.CLOAKBROWSER_LICENSE_KEY;
    // Never inherit mirrors, binary overrides, update channels, or verification overrides.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CLOAKBROWSER_")) delete process.env[name];
    }
    const binary = await installPinnedBrowser(cacheDir, version, async (stagingCache) => {
      if (!key?.trim()) throw new Error("Missing license key");
      process.env.CLOAKBROWSER_CACHE_DIR = stagingCache;
      process.env.CLOAKBROWSER_AUTO_UPDATE = "false";
      process.env.CLOAKBROWSER_RELEASE_CHANNEL = "stable";
      const { ensureBinary } = await import("cloakbrowser");
      // The official JS package verifies Ed25519, manifest version, and SHA256.
      return ensureBinary(key, version, "stable");
    });
    process.stdout.write(`${binary}\n`);
  } catch (error) {
    // Only fixed exit categories cross the process boundary, never upstream errors.
    process.exitCode = error instanceof BrowserVersionMismatchError ? 2 : 1;
  }
}

if (import.meta.main) await main();
