import { constants } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
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
import {
  DEFAULT_VIEWER_STREAM_SETTINGS,
  voxlStreamFlags,
  type ViewerStreamSettings
} from "./viewer-settings";

export interface DisplayRuntimeBins {
  voxl?: string;
  warning: string | null;
  xvfb?: string;
}

export interface DisplayRuntimeDiscoveryOptions {
  pathEnv?: string;
  voxlBin?: string;
  xvfbBin?: string;
}

export interface VoxlDisplayRuntimeOptions {
  dataRoot: string;
  ownedProcesses?: OwnedProcessRegistry;
  spawn?: typeof Bun.spawn;
  /** Read each time voxl starts, so a restart picks up changed settings. */
  streamSettings?: () => ViewerStreamSettings;
  voxlBin?: string;
  /** Waits for Xvfb to accept connections; replaceable in tests. */
  waitForDisplay?: (displayNumber: number, xvfb: DisplaySubprocess) => Promise<void>;
  /** Where X servers keep `.X<n>-lock` and `.X11-unix/`; `/tmp` except in tests. */
  xRoot?: string;
  xvfbBin?: string;
}

export interface VoxlDisplayRuntime extends BrowserDisplayRuntime {
  /** Restarts every running stream encoder with the current settings. */
  restartStreams(): Promise<void>;
}

type DisplaySubprocess = Pick<
  Bun.NullSubprocess,
  "exitCode" | "exited" | "kill" | "pid" | "unref"
>;

interface LiveDisplay {
  command: BrowserDisplayRuntimeCommand;
  stopping: boolean;
  streamer?: DisplaySubprocess;
  xvfb: DisplaySubprocess;
}

const DISPLAY_RUNTIME_MISSING_WARNING =
  "Missing Xvfb or voxl display runtime. Headed Browser Instances will fail until both are installed.";
const STREAMER_RESPAWN_DELAY_MS = 1000;

export async function resolveDisplayRuntimeBins(
  options: DisplayRuntimeDiscoveryOptions = {}
): Promise<DisplayRuntimeBins> {
  const pathEnv = options.pathEnv ?? process.env.PATH;
  const xvfb = await firstExecutable([
    options.xvfbBin ?? process.env.CLOAKHUB_XVFB_BIN,
    "/usr/bin/Xvfb",
    ...pathCandidates(pathEnv, "Xvfb")
  ]);
  const voxl = await firstExecutable([
    options.voxlBin ?? process.env.CLOAKHUB_VOXL_BIN,
    "/usr/local/bin/voxl",
    ...pathCandidates(pathEnv, "voxl")
  ]);
  return {
    voxl,
    warning: xvfb && voxl ? null : DISPLAY_RUNTIME_MISSING_WARNING,
    xvfb
  };
}

/**
 * One private Xvfb X server per headed Browser Instance, streamed by its own voxl
 * process. They are separate Owned Processes so the encoder can restart (new
 * settings, crash) without taking the browser's display down with it.
 */
export function createVoxlDisplayRuntime(
  options: VoxlDisplayRuntimeOptions
): VoxlDisplayRuntime {
  const ownedProcesses =
    options.ownedProcesses ??
    createOwnedProcessRegistry({ dataRoot: options.dataRoot });
  const spawn = options.spawn ?? Bun.spawn;
  const settings = options.streamSettings ?? (() => DEFAULT_VIEWER_STREAM_SETTINGS);
  const xRoot = options.xRoot ?? "/tmp";
  const waitForDisplay =
    options.waitForDisplay ?? ((n: number, xvfb: DisplaySubprocess) => waitForXSocket(xRoot, n, xvfb));
  const live = new Map<string, LiveDisplay>();
  /** Encoders stopped on purpose by restartStreams. */
  const restartRequested = new WeakSet<DisplaySubprocess>();

  function env(profileId: string, extra: Record<string, string> = {}) {
    return { ...ownedProcesses.env(profileId), ...extra };
  }

  async function startStreamer(display: LiveDisplay): Promise<void> {
    const { command } = display;
    const subprocess = spawn(
      streamerCommand(options.voxlBin!, command, settings()),
      {
        detached: true,
        env: env(command.profileId, {
          DISPLAY: `:${command.displayNumber}`,
          RUST_LOG: process.env.CLOAKHUB_VOXL_LOG ?? "warn"
        }),
        stderr: "inherit",
        stdin: "ignore",
        stdout: "ignore"
      }
    ) as DisplaySubprocess;
    subprocess.unref();
    display.streamer = subprocess;
    await ownedProcesses.writePid(command.profileId, "streamer", subprocess.pid);
    void subprocess.exited
      .catch(() => undefined)
      .then(() => {
        // Respawn an encoder that went away while its display still runs: at once
        // after restartStreams, after a pause if it crashed.
        const current = () =>
          !display.stopping && display.streamer === subprocess && display.xvfb.exitCode === null;
        if (!current()) return;
        const delay = restartRequested.has(subprocess) ? 0 : STREAMER_RESPAWN_DELAY_MS;
        setTimeout(() => {
          if (!current()) return;
          void startStreamer(display).catch((error) =>
            console.warn(`voxl restart failed for ${command.profileId}: ${error}`)
          );
        }, delay);
      });
  }

  return {
    async start(
      command: BrowserDisplayRuntimeCommand
    ): Promise<BrowserProcessHandle> {
      if (!options.xvfbBin || !options.voxlBin) {
        throw new MissingDisplayRuntimeError();
      }

      await ownedProcesses.cleanupOwnedProcesses([command.profileId], {
        kinds: ["display", "streamer"]
      });
      await clearStaleDisplay(xRoot, command.displayNumber);
      const xvfb = spawn(xvfbCommand(options.xvfbBin, command), {
        detached: true,
        env: env(command.profileId),
        stderr: "inherit",
        stdin: "ignore",
        stdout: "ignore"
      }) as DisplaySubprocess;
      xvfb.unref();
      void xvfb.exited.catch(() => undefined);
      const display: LiveDisplay = { command, stopping: false, xvfb };
      const handle = new LiveDisplayHandle(display, () => {
        if (live.get(command.profileId) === display) live.delete(command.profileId);
      });

      try {
        await ownedProcesses.writePid(command.profileId, "display", xvfb.pid);
        await waitForDisplay(command.displayNumber, xvfb);
        await startStreamer(display);
      } catch (error) {
        await handle.kill();
        throw error;
      }

      live.set(command.profileId, display);
      return handle;
    },

    async restartStreams(): Promise<void> {
      for (const display of live.values()) {
        const streamer = display.streamer;
        if (!streamer || display.stopping) continue;
        restartRequested.add(streamer);
        new OwnedSubprocessHandle(streamer).close();
      }
    }
  };
}

class LiveDisplayHandle implements BrowserProcessHandle {
  constructor(
    private readonly display: LiveDisplay,
    private readonly onStopped: () => void
  ) {}

  private processes(): DisplaySubprocess[] {
    return [this.display.streamer, this.display.xvfb].filter(
      (process): process is DisplaySubprocess => process !== undefined
    );
  }

  async close(): Promise<void> {
    this.display.stopping = true;
    this.onStopped();
    for (const process of this.processes()) {
      await new OwnedSubprocessHandle(process).close();
    }
  }

  async exited(): Promise<void> {
    await Promise.all(this.processes().map((process) => process.exited));
  }

  async hasExited(): Promise<boolean> {
    return this.processes().every((process) => process.exitCode !== null);
  }

  async kill(): Promise<void> {
    this.display.stopping = true;
    this.onStopped();
    for (const process of this.processes()) {
      await new OwnedSubprocessHandle(process).kill();
    }
  }
}

export function xvfbCommand(
  xvfbBin: string,
  command: BrowserDisplayRuntimeCommand
): string[] {
  return [
    xvfbBin,
    `:${command.displayNumber}`,
    "-screen",
    "0",
    `${command.screenWidth}x${command.screenHeight}x24`,
    "-dpi",
    "96",
    "-nolisten",
    "tcp",
    "-ac",
    // Shared-memory framebuffer: voxl captures it without copying.
    "-shmem",
    "-noreset",
    // CloakBrowser renders with its bundled SwiftShader; the image omits Mesa.
    "-extension",
    "GLX"
  ];
}

export function streamerCommand(
  voxlBin: string,
  command: BrowserDisplayRuntimeCommand,
  settings: ViewerStreamSettings = DEFAULT_VIEWER_STREAM_SETTINGS
): string[] {
  const clipboard = command.clipboardSync !== false ? "true" : "false";
  return [
    voxlBin,
    "--addr=127.0.0.1",
    `--port=${command.vncPort}`,
    "--enable-basic-auth=false",
    "--title=CloakHub Viewer",
    `--enable-clipboard=${clipboard}`,
    "--enable-resize=false",
    "--audio-enabled=false",
    "--microphone-enabled=false",
    "--file-transfers=none",
    ...voxlStreamFlags(settings)
  ];
}

/** Removes a lock and socket left by an X server that no longer runs. */
async function clearStaleDisplay(xRoot: string, displayNumber: number): Promise<void> {
  const lock = join(xRoot, `.X${displayNumber}-lock`);
  try {
    const pid = Number((await readFile(lock, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0 && (await isXServer(pid))) {
      throw new Error(`Display :${displayNumber} is already in use by process ${pid}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Display :")) throw error;
  }
  await rm(lock, { force: true });
  await rm(join(xRoot, ".X11-unix", `X${displayNumber}`), { force: true });
}

async function waitForXSocket(
  xRoot: string,
  displayNumber: number,
  xvfb: DisplaySubprocess
): Promise<void> {
  const socket = join(xRoot, ".X11-unix", `X${displayNumber}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (xvfb.exitCode !== null) {
      throw new Error(`Xvfb :${displayNumber} exited during startup (code ${xvfb.exitCode})`);
    }
    try {
      if ((await stat(socket)).isSocket()) return;
    } catch {
      /* not yet */
    }
    await Bun.sleep(50);
  }
  throw new Error(`Xvfb :${displayNumber} did not start within 10 seconds`);
}

async function isXServer(pid: number): Promise<boolean> {
  try {
    return /^X/.test((await readFile(`/proc/${pid}/comm`, "utf8")).trim());
  } catch {
    return false;
  }
}

function pathCandidates(pathEnv: string | undefined, name: string): string[] {
  if (!pathEnv) {
    return [];
  }

  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((pathEntry) => join(pathEntry, name));
}

async function firstExecutable(
  candidates: (string | undefined)[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate && (await isExecutable(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
