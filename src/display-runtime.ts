import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type {
  BrowserDisplayRuntime,
  BrowserDisplayRuntimeCommand,
  BrowserProcessHandle
} from "./browser-runtime";
import { MissingDisplayRuntimeError } from "./browser-runtime";
import {
  createOwnedProcessRegistry,
  OwnedSubprocessHandle,
  type OwnedProcessRegistry
} from "./owned-process";

export interface KasmVncBinInfo {
  path?: string;
  warning: string | null;
}

export interface KasmVncDiscoveryOptions {
  packagedDockerPath?: string;
  pathEnv?: string;
}

export interface KasmVncDisplayRuntimeOptions {
  dataRoot: string;
  ownedProcesses?: OwnedProcessRegistry;
  spawn?: typeof Bun.spawn;
  xvncBin?: string;
}

type DisplaySubprocess = Pick<
  Bun.NullSubprocess,
  "exitCode" | "exited" | "kill" | "pid" | "unref"
>;

const DEFAULT_PACKAGED_DOCKER_PATH = "/usr/bin/Xvnc";
const KASMVNC_MISSING_WARNING =
  "Missing KasmVNC Xvnc display runtime. Headed Browser Instances will fail until Xvnc is installed.";

export async function resolveKasmVncBin(
  options: KasmVncDiscoveryOptions = {}
): Promise<KasmVncBinInfo> {
  const candidates = [
    options.packagedDockerPath ?? DEFAULT_PACKAGED_DOCKER_PATH,
    ...pathCandidates(options.pathEnv ?? process.env.PATH)
  ];

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return { path: candidate, warning: null };
    }
  }

  return { path: undefined, warning: KASMVNC_MISSING_WARNING };
}

export function createKasmVncDisplayRuntime(
  options: KasmVncDisplayRuntimeOptions
): BrowserDisplayRuntime {
  const ownedProcesses =
    options.ownedProcesses ?? createOwnedProcessRegistry({ dataRoot: options.dataRoot });
  const spawn = options.spawn ?? Bun.spawn;

  return {
    async start(command: BrowserDisplayRuntimeCommand): Promise<BrowserProcessHandle> {
      if (!options.xvncBin) {
        throw new MissingDisplayRuntimeError();
      }

      await ownedProcesses.cleanupOwnedProcesses([command.profileId], { kinds: ["display"] });
      const subprocess = spawn(displayCommand(options.xvncBin, command), {
        detached: true,
        env: ownedProcesses.env(command.profileId),
        stderr: "inherit",
        stdin: "ignore",
        stdout: "ignore"
      }) as DisplaySubprocess;
      subprocess.unref();

      try {
        await ownedProcesses.writePid(command.profileId, "display", subprocess.pid);
      } catch (error) {
        await new OwnedSubprocessHandle(subprocess).kill();
        throw error;
      }

      void subprocess.exited.catch(() => undefined);
      return new OwnedSubprocessHandle(subprocess);
    }
  };
}

function displayCommand(xvncBin: string, command: BrowserDisplayRuntimeCommand): string[] {
  return [
    xvncBin,
    `:${command.displayNumber}`,
    "-ac",
    "-localhost",
    "-rfbport",
    String(command.vncPort),
    "-geometry",
    `${command.screenWidth}x${command.screenHeight}`,
    "-SecurityTypes",
    "None",
    "-DisableBasicAuth",
    "1",
    "-noWebsocket",
    "-publicIP",
    "127.0.0.1"
  ];
}

function pathCandidates(pathEnv: string | undefined): string[] {
  if (!pathEnv) {
    return [];
  }

  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((pathEntry) => join(pathEntry, "Xvnc"));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
