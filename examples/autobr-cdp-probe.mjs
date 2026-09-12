// Run from this repo after bun install. No local browser installation is needed.
// Required: CLOAKHUB_URL, CLOAKHUB_PROFILE_ID
// Optional: CLOAKHUB_CDP_TOKEN, TARGET_URL (defaults to a local test document)
import { chromium } from "@playwright/test";

const hub = process.env.CLOAKHUB_URL;
const profileId = process.env.CLOAKHUB_PROFILE_ID;
if (!hub || !profileId) {
  throw new Error("Set CLOAKHUB_URL and CLOAKHUB_PROFILE_ID");
}
const endpoint = new URL(`/api/profiles/${encodeURIComponent(profileId)}/cdp`, hub);
const token = process.env.CLOAKHUB_CDP_TOKEN;
const target = process.env.TARGET_URL ||
  "data:text/html,<title>autobr CDP probe</title><h1>Connected through CloakHub</h1>";

// Connecting wakes a stopped profile. Use its CDP token, not the admin token.
const browser = await chromium.connectOverCDP(endpoint.href, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  timeout: 60_000,
});
let page;
try {
  // Reuse the persistent context so existing cookies/login state are available.
  const context = browser.contexts()[0];
  if (!context) throw new Error("No persistent browser context was returned");
  page = await context.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.mouse.wheel(0, 300);

  // Raw CDP is also available when a Playwright operation is insufficient.
  const session = await context.newCDPSession(page);
  try {
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
      expression: "({ title: document.title, htmlLength: document.documentElement.outerHTML.length })",
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error("Page inspection failed");
    console.log(JSON.stringify(result.value, null, 2));
  } finally {
    await session.detach();
  }
} finally {
  try {
    if (page && !page.isClosed()) await page.close();
  } finally {
    // For a remote CDP browser, this disconnects; CloakHub owns browser shutdown.
    await browser.close();
  }
}
