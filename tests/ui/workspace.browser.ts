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

test("creates an identity and reports duplicate IDs", async ({
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
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await expect(page.locator("#profile-editor")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Details for work", exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("#profile-rows tr")).toHaveCount(1);
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
  await seed(page, { proxy: "http://user:secret@proxy.example:8080", tags: ["legacy"] });
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
  expect(profile.tags).toEqual(["legacy"]);
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

test("switches viewers from the sidebar and edits the selected profile directly", async ({ page }) => {
  const loads: string[] = [];
  await page.route("**/ui/profiles/*/viewer", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    loads.push(id);
    await route.fulfill({
      contentType: "text/html",
      body: `<main id="manual-viewer">Viewer for ${id}</main><script>parent.postMessage({type:"cloakhub-viewer-connected",profile_id:"${id}"},location.origin)</script>`
    });
  });
  await seed(page);
  await page.request.post("/api/profiles", {
    data: { profile_id: "research", display_name: "Research" }
  });
  await page.getByRole("button", { name: "Refresh profiles" }).click();
  const work = page.getByRole("button", { name: "Switch to Work", exact: true });
  const research = page.getByRole("button", { name: "Switch to Research", exact: true });
  await work.click();
  await expect(page.locator("#viewer-state")).toHaveText("Connected");
  await expect(work).toHaveAttribute("aria-current", "true");
  await research.click();
  await expect(page.frameLocator("#viewer-frame").getByText("Viewer for research")).toBeVisible();
  await expect(research).toHaveAttribute("aria-current", "true");
  await expect(work).not.toHaveAttribute("aria-current");
  await research.click();
  await expect(page.locator("#viewer-name")).toHaveText("Research");
  expect(loads).toEqual(["work", "research"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Profile ID", exact: true })).toHaveValue("research");
  await page.getByRole("textbox", { name: "Profile name", exact: true }).fill("Research team");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#viewer-name")).toHaveText("Research team");
  expect(loads).toEqual(["work", "research"]);
  await work.focus();
  await page.request.post("/api/profiles/work/start");
  await expect(work).toContainText("running", { timeout: 6000 });
  await expect(work).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.frameLocator("#viewer-frame").getByText("Viewer for work")).toBeVisible();
  await expect(work).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await expect(page.locator("#profile-nav [aria-current]")).toHaveCount(0);
});

test("headless sidebar selection opens its controls without starting a browser", async ({ page }) => {
  await seed(page, { headless: true });
  const work = page.getByRole("button", { name: "Switch to Work", exact: true });
  await work.click();
  await expect(page.locator("#viewer-page")).not.toBeVisible();
  await expect(page.locator("#profile-detail")).toBeVisible();
  await expect(page.getByRole("region", { name: "Profile list", exact: true })).not.toBeVisible();
  await expect(page.locator("#profile-detail h2")).toHaveText("Work");
  await expect(page.locator("#profile-detail .badge").first()).toHaveText("stopped");
  await expect(work).toHaveAttribute("aria-current", "true");
  await page.locator('#profile-detail [data-action="start"]').click();
  await expect(work).toContainText("running");
  await page.request.delete("/api/profiles/work");
  await page.getByRole("button", { name: "Refresh profiles" }).click();
  await expect(work).toHaveCount(0);
  await expect(page.getByText("Your workspace starts here")).toBeVisible();
  await expect(page.locator("#page-context")).toHaveText("Browser profiles");
});

test("the profile switcher remains usable beside a viewer on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/ui/profiles/*/viewer", (route) => route.fulfill({
    contentType: "text/html",
    body: '<main id="manual-viewer">Mobile viewer</main>'
  }));
  await seed(page);
  for (let i = 0; i < 6; i++) {
    await page.request.post("/api/profiles", {
      data: { profile_id: `profile_${i}`, display_name: `Profile ${i}` }
    });
  }
  await page.reload();
  await page.getByRole("button", { name: "Switch to Work", exact: true }).click();
  await expect(page.locator("#viewer-page")).toBeVisible();
  await page.getByRole("button", { name: "Switch to Profile 0", exact: true }).click();
  await expect(page.locator("#viewer-name")).toHaveText("Profile 0");
  await expect(page.frameLocator("#viewer-frame").getByText("Mobile viewer")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect((await page.locator("#viewer-frame").boundingBox())!.height).toBeGreaterThan(300);
});

test("sidebar resizing and folding preserve the viewer and remembered width", async ({ page }) => {
  let loads = 0;
  await page.route("**/ui/profiles/work/viewer", async (route) => {
    loads++;
    await route.fulfill({
      contentType: "text/html",
      body: '<main id="manual-viewer">Connected workspace</main><script>parent.postMessage({type:"cloakhub-viewer-connected",profile_id:"work"},location.origin)</script>'
    });
  });
  await seed(page);
  await page.getByRole("button", { name: "Switch to Work", exact: true }).click();
  await expect(page.locator("#viewer-state")).toHaveText("Connected");
  const sidebar = page.locator(".navigation");
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 120, 180, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(400);
  await expect(page.locator("body")).not.toHaveClass(/sidebar-resizing/);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(page.locator("#sidebar-content")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveAttribute("aria-expanded", "false");
  expect((await page.locator("#viewer-frame").boundingBox())!.width).toBeGreaterThan(1300);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(400);
  await expect(page.frameLocator("#viewer-frame").getByText("Connected workspace")).toBeVisible();
  expect(loads).toBe(1);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(400);
  await handle.dblclick();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(280);
});

test("sidebar keyboard resizing respects bounds and remains usable on mobile", async ({ page }) => {
  await seed(page);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const sidebar = page.locator(".navigation");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "296");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "220");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "520");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(420);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(520);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).not.toBeVisible();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.locator("#sidebar-content")).not.toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.getByRole("button", { name: "Switch to Work", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("sidebar controls work when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() { throw new DOMException("Storage blocked", "SecurityError"); }
    });
  });
  await seed(page);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "296");
  await expect(page.locator("#profile-rows tr")).toHaveCount(1);
});

test("event log filters lifecycle history and shows why automatic sleep is blocked", async ({ page }) => {
  await seed(page, { headless: true });
  await page.request.post("/api/profiles/work/start");
  await page.request.post("/__test/cdp/work");
  await page.getByRole("button", { name: "Event log", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Event log", exact: true })).toBeVisible();
  await expect(page.locator("#events-sleep-status")).toContainText("active CDP Session");
  await expect(page.locator("#event-rows")).toContainText("cdp.connected");
  await page.getByLabel("Profile ID", { exact: true }).fill("work");
  await page.getByRole("combobox", { name: "Event type", exact: true }).selectOption("browser.stopped");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.request.post("/api/profiles/work/stop");
  await page.getByRole("button", { name: "Refresh events", exact: true }).click();
  await expect(page.locator("#event-rows")).toContainText("manual stop");
  await expect(page.locator("#event-rows")).not.toContainText("cdp.connected");
  await page.getByLabel("Profile ID", { exact: true }).fill("missing");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.locator("#events-empty")).toBeVisible();
  await page.getByRole("button", { name: "Browser profiles", exact: false }).click();
  await expect(page.locator("#profiles-page")).toBeVisible();
  await expect(page.locator("#events-page")).not.toBeVisible();
});
