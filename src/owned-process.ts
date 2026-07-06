import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLOAKHUB_OWNED_PROCESS_DATA_ROOT_ENV = "CLOAKHUB_DATA_ROOT";
export const CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV = "CLOAKHUB_PROFILE_ID";

export interface OwnedProcessResourceUsage {
  owned_process_count: number;
  rss_bytes: number | null;
}

export type OwnedProcessKind = "browser" | "display";

export interface OwnedProcessRegistry {
  cleanupOwnedProcesses(profileIds?: string[], options?: { kinds?: OwnedProcessKind[] }): Promise<string[]>;
  env(profileId: string, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  ownedProfileIds(options?: { kinds?: OwnedProcessKind[] }): Promise<string[]>;
  removeRuntimeProfile(profileId: string): Promise<void>;
  runtimeProfilePath(profileId: string): string;
  writeJson(profileId: string, fileName: string, value: unknown): Promise<void>;
  writePid(profileId: string, kind: OwnedProcessKind, pid: number): Promise<void>;
}

export interface OwnedProcessRegistryOptions {
  dataRoot: string;
  stopGraceMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

type OwnedSubprocess = Pick<Bun.NullSubprocess, "exitCode" | "exited" | "pid">;

interface OwnedProcessSnapshot {
  pid: number;
  process_group_id: number;
  rss_bytes: number | null;
}

const OWNED_PROCESS_PID_FILES: Record<OwnedProcessKind, string> = {
  browser: "browser.pid",
  display: "display.pid"
};

const DEFAULT_STOP_GRACE_MS = 1500;

export function createOwnedProcessRegistry(options: OwnedProcessRegistryOptions): OwnedProcessRegistry {
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const wait = options.wait ?? Bun.sleep;

  async function cleanupOwnedProcesses(
    profileIds?: string[],
    cleanupOptions: { kinds?: OwnedProcessKind[] } = {}
  ): Promise<string[]> {
    const targetProfileIds = profileIds ?? (await ownedProfileIds(cleanupOptions));
    const cleanedProfileIds: string[] = [];

    await Promise.all(
      targetProfileIds.map(async (profileId) => {
        const pids = await ownedProcessPids(options.dataRoot, profileId, cleanupOptions.kinds);
        if (pids.length > 0) {
          for (const pid of pids) {
            signalProcessGroup(pid, "SIGTERM");
          }

          await wait(stopGraceMs);
          for (const pid of await ownedProcessPids(options.dataRoot, profileId, cleanupOptions.kinds)) {
            signalProcessGroup(pid, "SIGKILL");
          }
        }

        if (!cleanupOptions.kinds) {
          await removeRuntimeProfile(profileId);
        }
        cleanedProfileIds.push(profileId);
      })
    );

    return cleanedProfileIds.sort();
  }

  function env(profileId: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return ownedProcessEnv(options.dataRoot, profileId, baseEnv);
  }

  async function ownedProfileIds(profileOptions: { kinds?: OwnedProcessKind[] } = {}): Promise<string[]> {
    const profileIds = new Set<string>();

    for (const profileId of await profileIdsFromRuntimeRoot(options.dataRoot, profileOptions.kinds)) {
      profileIds.add(profileId);
    }

    for (const profileId of await profileIdsFromProcMarkers(options.dataRoot)) {
      profileIds.add(profileId);
    }

    return [...profileIds].sort();
  }

  async function removeRuntimeProfile(profileId: string): Promise<void> {
    await rm(runtimeProfilePath(options.dataRoot, profileId), { force: true, recursive: true });
  }

  function profileRuntimePath(profileId: string): string {
    return runtimeProfilePath(options.dataRoot, profileId);
  }

  async function writeJson(profileId: string, fileName: string, value: unknown): Promise<void> {
    const runtimePath = runtimeProfilePath(options.dataRoot, profileId);
    await mkdir(runtimePath, { recursive: true });
    await writeFile(join(runtimePath, fileName), JSON.stringify(value, null, 2));
  }

  async function writePid(profileId: string, kind: OwnedProcessKind, pid: number): Promise<void> {
    const runtimePath = runtimeProfilePath(options.dataRoot, profileId);
    await mkdir(runtimePath, { recursive: true });
    await writeFile(join(runtimePath, OWNED_PROCESS_PID_FILES[kind]), `${pid}\n`);
  }

  return {
    cleanupOwnedProcesses,
    env,
    ownedProfileIds,
    removeRuntimeProfile,
    runtimeProfilePath: profileRuntimePath,
    writeJson,
    writePid
  };
}

export class OwnedSubprocessHandle {
  constructor(private readonly subprocess: OwnedSubprocess) {}

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

export function ownedProcessEnv(
  dataRoot: string,
  profileId: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [CLOAKHUB_OWNED_PROCESS_DATA_ROOT_ENV]: dataRoot,
    [CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV]: profileId
  };
}

export function hasOwnedProcessEnvMarker(environ: string, dataRoot: string, profileId: string): boolean {
  const values = environ.split("\0");
  return (
    values.includes(`${CLOAKHUB_OWNED_PROCESS_DATA_ROOT_ENV}=${dataRoot}`) &&
    values.includes(`${CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV}=${profileId}`)
  );
}

export async function ownedProcessResourceUsageByProfile(
  dataRoot: string,
  profileIds: string[]
): Promise<Map<string, OwnedProcessResourceUsage>> {
  const usageByProfileId = new Map(profileIds.map((profileId) => [profileId, emptyResourceUsage()]));
  if (profileIds.length === 0) {
    return usageByProfileId;
  }

  const rootSnapshots = (
    await Promise.all(
      profileIds.map(async (profileId) => {
        const rootPids = await candidatePidFileValues(dataRoot, profileId);
        const snapshots = await Promise.all(
          rootPids.map((pid) => ownedProcessRootSnapshot(pid, dataRoot, profileId))
        );
        return snapshots
          .filter((snapshot): snapshot is OwnedProcessSnapshot => snapshot !== null)
          .map((snapshot) => ({ profileId, snapshot }));
      })
    )
  ).flat();
  const profileIdByProcessGroupId = new Map(
    rootSnapshots.map(({ profileId, snapshot }) => [snapshot.process_group_id, profileId])
  );
  const processSnapshots = await processSnapshotsForGroups(new Set(profileIdByProcessGroupId.keys()));
  const snapshotsByProfileId = new Map<string, Map<number, OwnedProcessSnapshot>>();
  for (const snapshot of processSnapshots) {
    const profileId = profileIdByProcessGroupId.get(snapshot.process_group_id);
    if (!profileId) {
      continue;
    }

    const profileSnapshots = snapshotsByProfileId.get(profileId) ?? new Map<number, OwnedProcessSnapshot>();
    profileSnapshots.set(snapshot.pid, snapshot);
    snapshotsByProfileId.set(profileId, profileSnapshots);
  }

  for (const [profileId, snapshots] of snapshotsByProfileId) {
    usageByProfileId.set(profileId, resourceUsageFromSnapshots([...snapshots.values()]));
  }

  return usageByProfileId;
}

async function profileIdsFromRuntimeRoot(
  dataRoot: string,
  kinds: OwnedProcessKind[] | undefined
): Promise<string[]> {
  try {
    const entries = await readdir(runtimeRootPath(dataRoot), { withFileTypes: true });
    const profileIds = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const pids = await candidatePidFileValues(dataRoot, entry.name, kinds);
          return pids.length > 0 ? entry.name : undefined;
        })
    );

    return profileIds.filter((profileId): profileId is string => profileId !== undefined);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

async function profileIdsFromProcMarkers(dataRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }

  const profileIds = await Promise.all(
    entries
      .map((entry) => Number(entry))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .map(async (pid) => {
        const environ = await processEnviron(pid);
        return environ ? ownedProcessProfileIdFromEnv(environ, dataRoot) : undefined;
      })
  );

  return profileIds.filter((profileId): profileId is string => profileId !== undefined);
}

async function ownedProcessPids(
  dataRoot: string,
  profileId: string,
  kinds: OwnedProcessKind[] | undefined
): Promise<number[]> {
  const pids = new Set<number>();
  for (const pid of await candidatePidFileValues(dataRoot, profileId, kinds)) {
    pids.add(pid);
  }

  for (const pid of await ownedProcessPidsFromProc(dataRoot, profileId)) {
    pids.add(pid);
  }

  return [...pids];
}

async function ownedProcessPidsFromProc(dataRoot: string, profileId: string): Promise<number[]> {
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
      .map(async (pid) => {
        const environ = await processEnviron(pid);
        return environ && hasOwnedProcessEnvMarker(environ, dataRoot, profileId) ? pid : undefined;
      })
  );
  return pids.filter((pid): pid is number => pid !== undefined);
}

function resourceUsageFromSnapshots(snapshots: OwnedProcessSnapshot[]): OwnedProcessResourceUsage {
  const knownRssValues = snapshots
    .map((snapshot) => snapshot.rss_bytes)
    .filter((rss): rss is number => rss !== null);

  return {
    owned_process_count: snapshots.length,
    rss_bytes:
      knownRssValues.length === 0
        ? null
        : knownRssValues.reduce((total, rss) => total + rss, 0)
  };
}

function emptyResourceUsage(): OwnedProcessResourceUsage {
  return { owned_process_count: 0, rss_bytes: null };
}

async function ownedProcessRootSnapshot(
  pid: number,
  dataRoot: string,
  profileId: string
): Promise<OwnedProcessSnapshot | null> {
  const [snapshot, environ] = await Promise.all([processSnapshot(pid), processEnviron(pid)]);
  if (!snapshot || !environ || !hasOwnedProcessEnvMarker(environ, dataRoot, profileId)) {
    return null;
  }

  return snapshot;
}

async function processSnapshotsForGroups(processGroupIds: Set<number>): Promise<OwnedProcessSnapshot[]> {
  if (processGroupIds.size === 0) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }

  const snapshots = await Promise.all(
    entries
      .map((entry) => Number(entry))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .map((pid) => processSnapshot(pid))
  );
  return snapshots.filter(
    (snapshot): snapshot is OwnedProcessSnapshot =>
      snapshot !== null && processGroupIds.has(snapshot.process_group_id)
  );
}

async function candidatePidFileValues(
  dataRoot: string,
  profileId: string,
  kinds: OwnedProcessKind[] = ["browser", "display"]
): Promise<number[]> {
  const runtimePath = join(dataRoot, "runtime", profileId);
  const pidFileValues = await Promise.all(
    kinds.map(async (kind) => {
      try {
        return Number((await readFile(join(runtimePath, OWNED_PROCESS_PID_FILES[kind]), "utf8")).trim());
      } catch (error) {
        if (isMissingPathError(error)) {
          return 0;
        }

        throw error;
      }
    })
  );

  return pidFileValues.filter((pid) => Number.isInteger(pid) && pid > 0);
}

function ownedProcessProfileIdFromEnv(environ: string, dataRoot: string): string | undefined {
  const values = environ.split("\0");
  if (!values.includes(`${CLOAKHUB_OWNED_PROCESS_DATA_ROOT_ENV}=${dataRoot}`)) {
    return undefined;
  }

  const marker = values.find((value) => value.startsWith(`${CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV}=`));
  const profileId = marker?.slice(CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV.length + 1);
  return profileId || undefined;
}

async function processSnapshot(pid: number): Promise<OwnedProcessSnapshot | null> {
  try {
    const [status, stat] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8")
    ]);
    const processGroupId = processGroupIdFromStat(stat);
    if (processGroupId === null) {
      return null;
    }

    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return {
      pid,
      process_group_id: processGroupId,
      rss_bytes: match ? Number(match[1]) * 1024 : null
    };
  } catch {
    return null;
  }
}

async function processEnviron(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/environ`, "utf8");
  } catch {
    return null;
  }
}

function processGroupIdFromStat(stat: string): number | null {
  const statFieldsStart = stat.lastIndexOf(") ");
  if (statFieldsStart === -1) {
    return null;
  }

  const fields = stat.slice(statFieldsStart + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  return Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
}

function runtimeRootPath(dataRoot: string): string {
  return join(dataRoot, "runtime");
}

function runtimeProfilePath(dataRoot: string, profileId: string): string {
  return join(runtimeRootPath(dataRoot), profileId);
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
