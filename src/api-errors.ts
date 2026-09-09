import {
  BrowserProfileNotFoundError,
  CapacityUnavailableError,
  MissingDisplayRuntimeError
} from "./browser-runtime";
import { ProfileValidationError, redactProfileSecrets } from "./profile";
import { apiErrorResponse } from "./http";

export function runtimeErrorResponse(
  error: unknown,
  fallbackCode: string,
  fallbackStatus: number,
  secrets: string[] = []
): Response {
  const message = redactProfileSecrets(
    error instanceof Error ? error.message : String(error), secrets
  );
  if (error instanceof BrowserProfileNotFoundError) {
    return apiErrorResponse(message, 404, "PROFILE_NOT_FOUND");
  }
  if (error instanceof CapacityUnavailableError) {
    return apiErrorResponse(message, 503, "CAPACITY_UNAVAILABLE", true);
  }
  if (error instanceof ProfileValidationError) {
    return apiErrorResponse(message, 400, "BAD_REQUEST");
  }
  if (error instanceof MissingDisplayRuntimeError) {
    return apiErrorResponse(message, 503, "DISPLAY_UNAVAILABLE");
  }
  return apiErrorResponse(message, fallbackStatus, fallbackCode);
}
