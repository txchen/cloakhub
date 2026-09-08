import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const profile of await (await request.get("/api/profiles")).json())
    await request.delete(`/api/profiles/${profile.profile_id}`);
});
async function seed(page: Page, extra = {}) {
  await page.request.post("/api/profiles", {
    data: { profile_id: "work", display_name: "Work", ...extra }
  });
  await page.goto("/");
  await expect(page.locator("#profile-rows tr")).toHaveCount(1);
}
async function details(page: Page) {
  await page
    .getByRole("button", { name: "Details for Work", exact: true })
    .click();
}

test("creates an identity, persists tags, searches, and reports duplicate IDs", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Your workspace starts here")).toBeVisible();
  await page.getByRole("button", { name: "Create your first profile" }).click();
  await page
    .getByRole("textbox", { name: "Profile ID", exact: true })
    .fill("work");
  await page
    .getByRole("textbox", { name: "Tags", exact: true })
    .fill("Research, Team");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Details for work", exact: true })
  ).toBeVisible();
  await page.reload();
  await page.getByRole("searchbox").fill("research");
  await expect(page.locator("#profile-rows tr")).toHaveCount(1);
  await page.getByRole("searchbox").fill("missing");
  await expect(page.getByText("No matching profiles")).toBeVisible();
  await page.getByRole("button", { name: "New profile" }).click();
  await page
    .getByRole("textbox", { name: "Profile ID", exact: true })
    .fill("work");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  expect(errors).toEqual([]);
});

test("edits without revealing or overwriting a saved proxy, and allows explicit removal", async ({
  page
}) => {
  await seed(page, { proxy: "http://user:secret@proxy.example:8080" });
  await details(page);
  await page
    .getByRole("button", { name: "Edit settings", exact: true })
    .click();
  await expect(page.locator('[name="proxy"]')).toHaveValue("");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Updated notes");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
  let profile = await (await page.request.get("/api/profiles/work")).json();
  expect(profile.proxy).toBe("http://user:secret@proxy.example:8080");
  expect(profile.notes).toBe("Updated notes");
  await page
    .getByRole("button", { name: "Edit settings", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Remove the current proxy" })
    .check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
  profile = await (await page.request.get("/api/profiles/work")).json();
  expect(profile.proxy).toBe("");
});

test("refreshes lifecycle observations and confirms stopping active clients", async ({
  page
}) => {
  await seed(page, { headless: true });
  await page.locator('#profile-rows [data-action="start"]').first().click();
  await expect(page.locator("#profile-rows .badge")).toHaveText("running");
  await page.request.post("/__test/cdp/work");
  await page.getByRole("button", { name: "Refresh profiles" }).click();
  await details(page);
  await page.locator('#profile-detail [data-action="stop"]').click();
  await expect(
    page.getByRole("dialog", { name: "Stop this browser?" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#profile-rows .badge")).toHaveText("running");
  await page.locator('#profile-detail [data-action="stop"]').click();
  await page.getByRole("button", { name: "Stop browser", exact: true }).click();
  await expect(page.locator("#profile-rows .badge")).toHaveText("stopped");
  await expect(page.locator("#profile-rows")).toContainText("No connections");
});

test("token copying warns and falls back when clipboard permissions are blocked", async ({
  page
}) => {
  await seed(page);
  await details(page);
  await page.getByRole("button", { name: "Protect with token" }).click();
  await expect(page.locator("#profile-detail")).toContainText("Protected");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        }
      },
      configurable: true
    });
    document.execCommand = () => {
      (window as any).copied = (
        document.activeElement as HTMLTextAreaElement
      ).value;
      return true;
    };
  });
  await page.getByRole("button", { name: "Copy CDP URL", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Anyone with this URL");
  await page.getByRole("button", { name: "Copy URL", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied))
    .toContain("/api/profiles/work/cdp/json/version?token=");
});

test("saving settings keeps an existing viewer document connected", async ({
  page
}) => {
  let viewerLoads = 0;
  await page.route("**/ui/profiles/work/viewer", async (route) => {
    viewerLoads++;
    await route.fulfill({
      contentType: "text/html",
      body: '<main id="manual-viewer">Live viewer fixture</main><script>parent.postMessage({type:"cloakhub-viewer-connected",profile_id:"work"},location.origin)</script>'
    });
  });
  await seed(page);
  await page.locator('#profile-rows [data-action="open"]').click();
  await expect(page.locator("#viewer-state")).toHaveText("Connected");
  await page.getByRole("button", { name: "← Profiles", exact: true }).click();
  await details(page);
  await page
    .getByRole("button", { name: "Edit settings", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Changed while viewing");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Active viewer", exact: false })
    .click();
  await expect(
    page.frameLocator("#viewer-frame").getByText("Live viewer fixture")
  ).toBeVisible();
  expect(viewerLoads).toBe(1);
});

test("polling adds and removes profiles without reloading the page", async ({
  page
}) => {
  await seed(page);
  await page.evaluate(() => {
    (window as any).sentinel = "same document";
  });
  await page.request.post("/api/profiles", {
    data: { profile_id: "other", display_name: "Other" }
  });
  await expect(page.locator("#profile-rows tr")).toHaveCount(2, {
    timeout: 6000
  });
  await page.request.delete("/api/profiles/other");
  await expect(page.locator("#profile-rows tr")).toHaveCount(1, {
    timeout: 6000
  });
  expect(await page.evaluate(() => (window as any).sentinel)).toBe(
    "same document"
  );
});

test("deletion requires confirmation and removes the profile", async ({
  page
}) => {
  await seed(page);
  await details(page);
  await page.locator('#profile-detail [data-action="delete"]').click();
  await expect(page.getByRole("dialog")).toContainText("permanently removes");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#profile-rows tr")).toHaveCount(1);
  await page.locator('#profile-detail [data-action="delete"]').click();
  await page
    .getByRole("button", { name: "Delete profile", exact: true })
    .last()
    .click();
  await expect(page.getByText("Your workspace starts here")).toBeVisible();
});

test("narrow screens keep the page within the viewport and editor usable", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390
  );
  await page.getByRole("button", { name: "New profile" }).click();
  await page
    .getByRole("textbox", { name: "Profile ID", exact: true })
    .fill("mobile");
  await page.getByRole("tab", { name: "Fingerprint", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Timezone", exact: true })
    .fill("Invalid/Zone");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("valid IANA timezone");
  await page
    .getByRole("textbox", { name: "Timezone", exact: true })
    .fill("America/Los_Angeles");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
});
