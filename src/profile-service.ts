import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { BrowserProfile, CreateProfileInput, UpdateProfileInput } from "./profile";
import { ProfileValidationError, normalizeCreateProfileInput, normalizeUpdateProfileInput } from "./profile";
import type { ProfileRepository } from "./profile-repository";

export interface ProfileFileStore {
  createProfileData(profileId: string): Promise<void>;
  removeProfileData(profileId: string): Promise<void>;
}

export interface ProfileService {
  createCdpToken(profileId: string): CdpTokenState;
  createProfile(input: unknown): Promise<BrowserProfile>;
  cdpTokensForRedaction(): string[];
  deleteStoppedProfile(profileId: string): Promise<void>;
  getProfile(profileId: string): BrowserProfile | undefined;
  getCdpToken(profileId: string): CdpTokenState;
  listProfiles(): BrowserProfile[];
  regenerateCdpToken(profileId: string): CdpTokenState;
  revokeCdpToken(profileId: string): void;
  updateProfile(profileId: string, input: unknown): BrowserProfile;
}

export interface CdpTokenState {
  cdp_token: string | null;
  cdp_token_configured: boolean;
  profile_id: string;
}

export interface ProfileServiceOptions {
  cdpTokenGenerator?: () => string;
  dataRoot: string;
  fileStore?: Partial<ProfileFileStore>;
  repository: ProfileRepository;
}

export class DuplicateProfileError extends Error {
  constructor(profileId: string) {
    super(`Browser Profile "${profileId}" already exists`);
    this.name = "DuplicateProfileError";
  }
}

export class ProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Browser Profile "${profileId}" was not found`);
    this.name = "ProfileNotFoundError";
  }
}

export class DeleteProfileDataError extends Error {
  constructor(profileId: string, cause: unknown) {
    super(`Failed to delete Browser Profile data for "${profileId}": ${errorMessage(cause)}`);
    this.name = "DeleteProfileDataError";
  }
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const fileStore = createFileStore(options);
  const generateCdpToken = options.cdpTokenGenerator ?? defaultCdpTokenGenerator;

  return {
    createCdpToken(profileId: string): CdpTokenState {
      const profile = requireProfile(options.repository, profileId);
      if (profile.cdp_token) {
        return cdpTokenState(profile);
      }

      return cdpTokenState(options.repository.setCdpToken(profileId, generateCdpToken())!);
    },

    async createProfile(input: unknown): Promise<BrowserProfile> {
      const normalized = normalizeCreateProfileInput(input);
      ensureUnique(options.repository, normalized.profile_id);

      await fileStore.createProfileData(normalized.profile_id);

      return options.repository.create(normalized);
    },

    cdpTokensForRedaction(): string[] {
      return options.repository
        .list()
        .map((profile) => profile.cdp_token)
        .filter((token): token is string => Boolean(token));
    },

    deleteStoppedProfile: async (profileId: string): Promise<void> => {
      const profile = requireProfile(options.repository, profileId);

      try {
        await fileStore.removeProfileData(profile.profile_id);
      } catch (error) {
        options.repository.recordDeleteError(profile.profile_id, errorMessage(error));
        throw new DeleteProfileDataError(profile.profile_id, error);
      }

      options.repository.delete(profile.profile_id);
    },

    getProfile(profileId: string): BrowserProfile | undefined {
      return options.repository.get(profileId);
    },

    getCdpToken(profileId: string): CdpTokenState {
      return cdpTokenState(requireProfile(options.repository, profileId));
    },

    listProfiles(): BrowserProfile[] {
      return options.repository.list();
    },

    regenerateCdpToken(profileId: string): CdpTokenState {
      requireProfile(options.repository, profileId);
      return cdpTokenState(options.repository.setCdpToken(profileId, generateCdpToken())!);
    },

    revokeCdpToken(profileId: string): void {
      requireProfile(options.repository, profileId);
      options.repository.setCdpToken(profileId, null);
    },

    updateProfile(profileId: string, input: unknown): BrowserProfile {
      const normalized = normalizeUpdateProfileInput(profileId, input);
      const updated = options.repository.update(profileId, normalized);
      if (!updated) {
        throw new ProfileNotFoundError(profileId);
      }

      return updated;
    }
  };
}

export { ProfileValidationError };

function createFileStore(options: ProfileServiceOptions): ProfileFileStore {
  const defaultStore = {
    createProfileData: async (profileId: string): Promise<void> => {
      await mkdir(profileDataPath(options.dataRoot, profileId), { recursive: true });
    },
    removeProfileData: async (profileId: string): Promise<void> => {
      await rm(profileDataPath(options.dataRoot, profileId), { force: true, recursive: true });
    }
  };

  return {
    createProfileData: options.fileStore?.createProfileData ?? defaultStore.createProfileData,
    removeProfileData: options.fileStore?.removeProfileData ?? defaultStore.removeProfileData
  };
}

function ensureUnique(repository: ProfileRepository, profileId: string): void {
  if (repository.get(profileId)) {
    throw new DuplicateProfileError(profileId);
  }
}

function requireProfile(repository: ProfileRepository, profileId: string): BrowserProfile {
  const profile = repository.get(profileId);
  if (!profile) {
    throw new ProfileNotFoundError(profileId);
  }

  return profile;
}

function profileDataPath(dataRoot: string, profileId: string): string {
  return join(dataRoot, "profiles", profileId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cdpTokenState(profile: BrowserProfile): CdpTokenState {
  return {
    cdp_token: profile.cdp_token,
    cdp_token_configured: Boolean(profile.cdp_token),
    profile_id: profile.profile_id
  };
}

function defaultCdpTokenGenerator(): string {
  return `cdp_${randomBytes(24).toString("base64url")}`;
}
