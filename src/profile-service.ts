import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserProfile, CreateProfileInput, UpdateProfileInput } from "./profile";
import { ProfileValidationError, normalizeCreateProfileInput, normalizeUpdateProfileInput } from "./profile";
import type { ProfileRepository } from "./profile-repository";

export interface ProfileFileStore {
  createProfileData(profileId: string): Promise<void>;
  removeProfileData(profileId: string): Promise<void>;
}

export interface ProfileService {
  createProfile(input: unknown): Promise<BrowserProfile>;
  deleteStoppedProfile(profileId: string): Promise<void>;
  getProfile(profileId: string): BrowserProfile | undefined;
  listProfiles(): BrowserProfile[];
  updateProfile(profileId: string, input: unknown): BrowserProfile;
}

export interface ProfileServiceOptions {
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

  return {
    async createProfile(input: unknown): Promise<BrowserProfile> {
      const normalized = normalizeCreateProfileInput(input);
      ensureUnique(options.repository, normalized.profile_id);

      await fileStore.createProfileData(normalized.profile_id);

      return options.repository.create(normalized);
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

    listProfiles(): BrowserProfile[] {
      return options.repository.list();
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
