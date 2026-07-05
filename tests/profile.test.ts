import { describe, expect, test } from "bun:test";

import { validateProfileId } from "../src/profile";

describe("Browser Profile validation", () => {
  test("accepts v1 Profile IDs", () => {
    expect(validateProfileId("work")).toEqual({ ok: true, profile_id: "work" });
    expect(validateProfileId("work_2026")).toEqual({ ok: true, profile_id: "work_2026" });
  });

  test("rejects invalid Profile IDs", () => {
    expect(validateProfileId("Work")).toEqual({
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    });
    expect(validateProfileId("1work")).toEqual({
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    });
  });
});
