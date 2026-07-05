import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const CLOAKHUB_OWNED_PROCESS_DATA_ROOT_ENV = "CLOAKHUB_DATA_ROOT";
export const CLOAKHUB_OWNED_PROCESS_PROFILE_ID_ENV = "CLOAKHUB_PROFILE_ID";

export interface OwnedProcessResourceUsage {
  owned_process_count: number;
  rss_bytes: number | null;
}

interface OwnedProcessSnapshot {
  pid: number;
  process_group_id: number;
  rss_bytes: number | null;
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

async function candidatePidFileValues(dataRoot: string, profileId: string): Promise<number[]> {
  const runtimePath = join(dataRoot, "runtime", profileId);
  const pidFileValues = await Promise.all(
    ["browser.pid", "display.pid"].map(async (entry) => {
      try {
        return Number((await readFile(join(runtimePath, entry), "utf8")).trim());
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
