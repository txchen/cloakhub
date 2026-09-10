import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveBrowserBin, type BrowserBinInfo } from "./browser-bin";
import { withoutLicenseSecrets } from "./browser-license";

export const DEFAULT_BROWSER_VERSION = "151.0.7922.108.4";

export async function prepareBrowserBinary(options: {
  browserBin?: string;
  dataRoot: string;
  licenseKeys: string[];
  installer?: string;
  version?: string;
}): Promise<BrowserBinInfo> {
  if (options.browserBin || !options.installer) {
    return resolveBrowserBin(options.browserBin);
  }
  if (options.installer !== "bun") throw new Error("CLOAKHUB_BROWSER_INSTALLER must be bun");
  if (!options.licenseKeys.length) {
    throw new Error("CloakBrowser 151 requires a license key. Set CLOAKHUB_LICENSE_KEYS_FILE or CLOAKBROWSER_LICENSE_KEY.");
  }
  const version = options.version ?? DEFAULT_BROWSER_VERSION;
  if (!/^151\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error("CLOAKHUB_BROWSER_VERSION must be an exact CloakBrowser 151 release version");
  }
  console.log(`Preparing CloakBrowser ${version} in the persistent browser cache`);
  const cacheDir = join(options.dataRoot, "browser-cache");
  await mkdir(cacheDir, { recursive: true });
  // flock also interoperates with the prior Python installer's lock, and releases
  // on exit/crash without stale lock-directory recovery or another runtime.
  const child = Bun.spawn([
    "flock", "--exclusive", join(cacheDir, ".install.lock"),
    process.execPath,
    join(import.meta.dir, "browser-installer.ts"),
    cacheDir,
    version
  ], {
    env: {
      ...withoutLicenseSecrets(process.env),
      CLOAKBROWSER_LICENSE_KEY: options.licenseKeys[0]
    },
    stdout: "pipe", stderr: "pipe", stdin: "ignore"
  });
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  // Upstream logs can include signed URLs. Surface only our fixed diagnostic categories.
  if (code !== 0) {
    throw new Error(code === 2
      ? `Official download did not supply pinned CloakBrowser ${version}. Free keys only download the current stable release; explicitly select a reviewed 151 version or mount CLOAKHUB_BROWSER_BIN.`
      : "CloakBrowser installation failed; check the first license key, network access, cache permissions, and disk space");
  }
  return resolveBrowserBin(stdout.trim());
}
