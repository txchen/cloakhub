import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface BrowserBinInfo {
  path: string;
}

export interface BrowserBinDiscoveryOptions {
  packagedDockerPath?: string;
  pathEnv?: string;
}

export class BrowserBinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserBinError";
  }
}

const DEFAULT_PACKAGED_DOCKER_PATH = "/opt/cloakbrowser/cloakbrowser";

export async function resolveBrowserBin(
  configuredBrowserBin: string | undefined,
  options: BrowserBinDiscoveryOptions = {}
): Promise<BrowserBinInfo> {
  const candidates = [
    configuredBrowserBin,
    options.packagedDockerPath ?? DEFAULT_PACKAGED_DOCKER_PATH,
    ...pathCandidates(options.pathEnv ?? process.env.PATH)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return { path: candidate };
    }
  }

  throw new BrowserBinError(
    "Missing CloakBrowser Binary. Set CLOAKHUB_BROWSER_BIN or install cloakbrowser on PATH."
  );
}

function pathCandidates(pathEnv: string | undefined): string[] {
  if (!pathEnv) {
    return [];
  }

  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((pathEntry) => join(pathEntry, "cloakbrowser"));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
