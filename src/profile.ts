export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export type InstanceStatus = "stopped";

export interface BrowserProfile {
  created_at: string;
  display_name: string;
  instance_status: InstanceStatus;
  last_delete_error: string | null;
  notes: string;
  profile_id: string;
  updated_at: string;
}

export interface CreateProfileInput {
  display_name?: string;
  notes?: string;
  profile_id: string;
}

export interface UpdateProfileInput {
  display_name?: string;
  notes?: string;
  profile_id?: string;
}

export type ProfileIdValidationResult =
  | { ok: true; profile_id: string }
  | { error: string; ok: false };

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

export function validateProfileId(value: unknown): ProfileIdValidationResult {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    return {
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    };
  }

  return { ok: true, profile_id: value };
}

export function normalizeCreateProfileInput(input: unknown): CreateProfileInput {
  if (!isRecord(input)) {
    throw new ProfileValidationError("Request body must be a JSON object");
  }

  const profileId = validateProfileId(input.profile_id);
  if (!profileId.ok) {
    throw new ProfileValidationError(profileId.error);
  }

  return {
    display_name: optionalString(input.display_name, "display_name") ?? profileId.profile_id,
    notes: optionalString(input.notes, "notes") ?? "",
    profile_id: profileId.profile_id
  };
}

export function normalizeUpdateProfileInput(profileId: string, input: unknown): UpdateProfileInput {
  if (!isRecord(input)) {
    throw new ProfileValidationError("Request body must be a JSON object");
  }

  if (input.profile_id !== undefined && input.profile_id !== profileId) {
    throw new ProfileValidationError("Profile ID is immutable");
  }

  return {
    display_name: optionalString(input.display_name, "display_name"),
    notes: optionalString(input.notes, "notes"),
    profile_id: input.profile_id === undefined ? undefined : profileId
  };
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ProfileValidationError(`${fieldName} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
