import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type {
  BrowserDisplayRuntime,
  BrowserDisplayRuntimeCommand,
  BrowserProcessHandle
} from "./browser-runtime";
import { MissingDisplayRuntimeError } from "./browser-runtime";
import { ownedProcessEnv } from "./owned-process";

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
  spawn?: typeof Bun.spawn;
  stopGraceMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
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
  const spawn = options.spawn ?? Bun.spawn;
  const stopGraceMs = options.stopGraceMs ?? 1500;
  const wait = options.wait ?? Bun.sleep;

  return {
    async cleanupOwnedProcesses(profileIds: string[]): Promise<void> {
      await Promise.all(
        profileIds.map(async (profileId) => {
          const pids = await ownedDisplayPids(options.dataRoot, profileId);
          if (pids.length === 0) {
            return;
          }

          for (const pid of pids) {
            signalProcessGroup(pid, "SIGTERM");
          }

          await wait(stopGraceMs);
          for (const pid of await ownedDisplayPids(options.dataRoot, profileId)) {
            signalProcessGroup(pid, "SIGKILL");
          }
        })
      );
    },

    async start(command: BrowserDisplayRuntimeCommand): Promise<BrowserProcessHandle> {
      if (!options.xvncBin) {
        throw new MissingDisplayRuntimeError();
      }

      await cleanupOwnedDisplayProcesses(options.dataRoot, command.profileId, wait, stopGraceMs);
      await mkdir(runtimeProfilePath(options.dataRoot, command.profileId), { recursive: true });
      const subprocess = spawn(displayCommand(options.xvncBin, command), {
        detached: true,
        env: ownedProcessEnv(options.dataRoot, command.profileId),
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore"
      }) as DisplaySubprocess;
      subprocess.unref();

      try {
        await writeFile(join(runtimeProfilePath(options.dataRoot, command.profileId), "display.pid"), `${subprocess.pid}\n`);
      } catch (error) {
        signalProcessGroup(subprocess.pid, "SIGKILL");
        throw error;
      }

      void subprocess.exited.catch(() => undefined);
      return new KasmVncProcessHandle(subprocess);
    }
  };
}

async function cleanupOwnedDisplayProcesses(
  dataRoot: string,
  profileId: string,
  wait: (milliseconds: number) => Promise<void>,
  stopGraceMs: number
): Promise<void> {
  const pids = await ownedDisplayPids(dataRoot, profileId);
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    signalProcessGroup(pid, "SIGTERM");
  }

  await wait(stopGraceMs);
  for (const pid of await ownedDisplayPids(dataRoot, profileId)) {
    signalProcessGroup(pid, "SIGKILL");
  }
}

async function ownedDisplayPids(dataRoot: string, profileId: string): Promise<number[]> {
  const pids = new Set<number>();
  const pidFileValue = await readOwnedPid(dataRoot, profileId);
  if (pidFileValue !== undefined) {
    pids.add(pidFileValue);
  }

  for (const pid of await ownedDisplayPidsFromProc(dataRoot, profileId)) {
    pids.add(pid);
  }

  return [...pids];
}

async function ownedDisplayPidsFromProc(dataRoot: string, profileId: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }

  const pids = await Promise.all(
    entries
      .map((entry) => Number(entry))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .map(async (pid) => ((await isOwnedDisplayProcess(pid, dataRoot, profileId)) ? pid : undefined))
  );
  return pids.filter((pid): pid is number => pid !== undefined);
}

async function isOwnedDisplayProcess(pid: number, dataRoot: string, profileId: string): Promise<boolean> {
  try {
    const [cmdline, environ] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/environ`, "utf8")
    ]);
    return (
      (cmdline.includes("Xvnc") || cmdline.includes("Xkasmvnc")) &&
      environ.split("\0").includes(`CLOAKHUB_DATA_ROOT=${dataRoot}`) &&
      environ.split("\0").includes(`CLOAKHUB_PROFILE_ID=${profileId}`)
    );
  } catch {
    return false;
  }
}

class KasmVncProcessHandle implements BrowserProcessHandle {
  constructor(private readonly subprocess: DisplaySubprocess) {}

  async close(): Promise<void> {
    signalProcessGroup(this.subprocess.pid, "SIGTERM");
  }

  async exited(): Promise<void> {
    await this.subprocess.exited;
  }

  async hasExited(): Promise<boolean> {
    return this.subprocess.exitCode !== null;
  }

  async kill(): Promise<void> {
    signalProcessGroup(this.subprocess.pid, "SIGKILL");
  }
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

async function readOwnedPid(dataRoot: string, profileId: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(join(runtimeProfilePath(dataRoot, profileId), "display.pid"), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
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

function runtimeProfilePath(dataRoot: string, profileId: string): string {
  return join(dataRoot, "runtime", profileId);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The Owned Process may already have exited between discovery and cleanup.
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
