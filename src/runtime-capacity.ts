import {
  DEFAULT_MAX_RUNNING_INSTANCES,
  INTERNAL_CDP_PORT_RANGE,
  INTERNAL_DISPLAY_NUMBER_RANGE,
  INTERNAL_VNC_PORT_RANGE
} from "./config";
import type { BrowserProfile } from "./profile";

export interface RuntimeCapacityReservation {
  cdpPort: number;
  display?: string;
  displayNumber?: number;
  vncPort?: number;
}

export interface RuntimeCapacityRunningInstance {
  activeCdpSessionCount: number;
  cdpPort: number;
  displayNumber?: number;
  lastActivityMs?: number;
  lastManualInputObservedMs?: number;
  profile: BrowserProfile;
  vncPort?: number;
}

export interface RuntimeCapacityReservationContext {
  preempt(profile: BrowserProfile): Promise<void>;
  runningInstances(): RuntimeCapacityRunningInstance[];
}

export interface RuntimeCapacityOptions {
  cdpPortStart?: number;
  displayNumberStart?: number;
  maxRunningInstances?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  vncPortStart?: number;
}

export interface RuntimeCapacity {
  release(profileId: string): void;
  reserve(
    profile: BrowserProfile,
    context: RuntimeCapacityReservationContext
  ): Promise<RuntimeCapacityReservation> | RuntimeCapacityReservation;
}

const CAPACITY_MANUAL_INPUT_PROTECTION_MS = 60_000;

export function createRuntimeCapacity(options: RuntimeCapacityOptions = {}): RuntimeCapacity {
  const launchReservations = new Map<string, RuntimeCapacityReservation>();
  const maxRunningInstances = options.maxRunningInstances ?? DEFAULT_MAX_RUNNING_INSTANCES;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const now = options.now ?? (() => new Date());
  let capacityReservationQueue = Promise.resolve();
  let nextCdpPort = options.cdpPortStart ?? INTERNAL_CDP_PORT_RANGE.start;
  let nextDisplayNumber = options.displayNumberStart ?? INTERNAL_DISPLAY_NUMBER_RANGE.start;
  let nextVncPort = options.vncPortStart ?? INTERNAL_VNC_PORT_RANGE.start;

  return {
    release(profileId: string): void {
      launchReservations.delete(profileId);
    },

    reserve(
      profile: BrowserProfile,
      context: RuntimeCapacityReservationContext
    ): Promise<RuntimeCapacityReservation> | RuntimeCapacityReservation {
      if (reservedInstanceCount(context.runningInstances()) < maxRunningInstances) {
        return reserveResources(profile, context.runningInstances());
      }

      return reserveWithPreemption(profile, context);
    }
  };

  async function reserveWithPreemption(
    profile: BrowserProfile,
    context: RuntimeCapacityReservationContext
  ): Promise<RuntimeCapacityReservation> {
    const reservationAttempt = capacityReservationQueue.then(async () => {
      if (reservedInstanceCount(context.runningInstances()) >= maxRunningInstances) {
        await ensureCapacityFor(profile.profile_id, context);
      }

      const runningInstances = context.runningInstances();
      if (reservedInstanceCount(runningInstances) >= maxRunningInstances) {
        throw new CapacityUnavailableError();
      }

      return reserveResources(profile, runningInstances);
    });
    capacityReservationQueue = reservationAttempt.then(
      () => undefined,
      () => undefined
    );
    return reservationAttempt;
  }

  async function ensureCapacityFor(
    requestedProfileId: string,
    context: RuntimeCapacityReservationContext
  ): Promise<void> {
    const candidate = capacityPreemptionCandidate(requestedProfileId, context.runningInstances());
    if (!candidate) {
      throw new CapacityUnavailableError();
    }

    await context.preempt(candidate.profile);
  }

  function capacityPreemptionCandidate(
    requestedProfileId: string,
    runningInstances: RuntimeCapacityRunningInstance[]
  ): RuntimeCapacityRunningInstance | undefined {
    return runningInstances
      .filter((running) => running.profile.profile_id !== requestedProfileId)
      .filter((running) => isCapacityPreemptionEligible(running))
      .sort((left, right) => capacityActivityTimestamp(left) - capacityActivityTimestamp(right))[0];
  }

  function isCapacityPreemptionEligible(running: RuntimeCapacityRunningInstance): boolean {
    if (running.activeCdpSessionCount > 0) {
      return false;
    }

    if (running.lastManualInputObservedMs !== undefined) {
      return monotonicNow() - running.lastManualInputObservedMs >= CAPACITY_MANUAL_INPUT_PROTECTION_MS;
    }

    const persistedLastManualInput = timestampMs(running.profile.last_manual_input_at);
    return (
      persistedLastManualInput === undefined ||
      now().getTime() - persistedLastManualInput >= CAPACITY_MANUAL_INPUT_PROTECTION_MS
    );
  }

  function capacityActivityTimestamp(running: RuntimeCapacityRunningInstance): number {
    const observed = Math.max(
      running.lastActivityMs ?? Number.NEGATIVE_INFINITY,
      running.lastManualInputObservedMs ?? Number.NEGATIVE_INFINITY
    );
    if (Number.isFinite(observed)) {
      return observed;
    }

    return Math.max(
      timestampMs(running.profile.last_activity_at) ?? 0,
      timestampMs(running.profile.last_manual_input_at) ?? 0
    );
  }

  function reservedInstanceCount(runningInstances: RuntimeCapacityRunningInstance[]): number {
    return new Set([
      ...runningInstances.map((running) => running.profile.profile_id),
      ...launchReservations.keys()
    ]).size;
  }

  function reserveResources(
    profile: BrowserProfile,
    runningInstances: RuntimeCapacityRunningInstance[]
  ): RuntimeCapacityReservation {
    const cdpPort = nextAvailableNumber(
      INTERNAL_CDP_PORT_RANGE,
      usedCdpPorts(runningInstances),
      nextCdpPort
    );
    nextCdpPort = nextNumberAfter(cdpPort, INTERNAL_CDP_PORT_RANGE);

    const reservation = profile.headless
      ? { cdpPort }
      : headedReservation(profile, cdpPort, runningInstances);
    launchReservations.set(profile.profile_id, reservation);
    return reservation;
  }

  function headedReservation(
    _profile: BrowserProfile,
    cdpPort: number,
    runningInstances: RuntimeCapacityRunningInstance[]
  ): RuntimeCapacityReservation {
    const displayNumber = nextAvailableNumber(
      INTERNAL_DISPLAY_NUMBER_RANGE,
      usedDisplayNumbers(runningInstances),
      nextDisplayNumber
    );
    const vncPort = nextAvailableNumber(INTERNAL_VNC_PORT_RANGE, usedVncPorts(runningInstances), nextVncPort);
    nextDisplayNumber = nextNumberAfter(displayNumber, INTERNAL_DISPLAY_NUMBER_RANGE);
    nextVncPort = nextNumberAfter(vncPort, INTERNAL_VNC_PORT_RANGE);

    return { cdpPort, display: `:${displayNumber}`, displayNumber, vncPort };
  }

  function usedCdpPorts(runningInstances: RuntimeCapacityRunningInstance[]): Set<number> {
    return new Set([
      ...runningInstances.map((running) => running.cdpPort),
      ...Array.from(launchReservations.values()).map((reservation) => reservation.cdpPort)
    ]);
  }

  function usedDisplayNumbers(runningInstances: RuntimeCapacityRunningInstance[]): Set<number> {
    return new Set(
      [
        ...runningInstances.map((running) => running.displayNumber),
        ...Array.from(launchReservations.values()).map((reservation) => reservation.displayNumber)
      ].filter((value): value is number => value !== undefined)
    );
  }

  function usedVncPorts(runningInstances: RuntimeCapacityRunningInstance[]): Set<number> {
    return new Set(
      [
        ...runningInstances.map((running) => running.vncPort),
        ...Array.from(launchReservations.values()).map((reservation) => reservation.vncPort)
      ].filter((value): value is number => value !== undefined)
    );
  }
}

export class CapacityUnavailableError extends Error {
  retryable = true;

  constructor() {
    super("Running Instance capacity is full; retry after another Browser Instance stops");
    this.name = "CapacityUnavailableError";
  }
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function nextAvailableNumber(
  range: { endInclusive: number; start: number },
  used: Set<number>,
  preferred: number
): number {
  let candidate = preferred >= range.start && preferred <= range.endInclusive ? preferred : range.start;
  for (let checked = 0; checked < range.endInclusive - range.start + 1; checked += 1) {
    if (!used.has(candidate)) {
      return candidate;
    }

    candidate = nextNumberAfter(candidate, range);
  }

  throw new CapacityUnavailableError();
}

function nextNumberAfter(value: number, range: { endInclusive: number; start: number }): number {
  return value >= range.endInclusive ? range.start : value + 1;
}
