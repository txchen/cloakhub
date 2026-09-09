import { chromium } from "@playwright/test";

const hub = process.env.CLOAKHUB_URL;
const profileId = process.env.CLOAKHUB_PROFILE_ID;
if (!hub || !profileId) {
  throw new Error("Set CLOAKHUB_URL and CLOAKHUB_PROFILE_ID before running this example");
}
const adminToken = process.env.CLOAKHUB_AUTH_TOKEN;
const adminHeaders = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};

async function request(url, method = "GET") {
  const response = await fetch(url, {
    method, headers: adminHeaders, signal: AbortSignal.timeout(60_000)
  });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw new Error(`${body.code}: ${body.message} (retryable=${body.retryable})`);
  }
  return body;
}

const profiles = await request(new URL("/api/profiles?view=summary", hub));
const profile = profiles.find((entry) => entry.profile_id === profileId);
if (!profile) throw new Error("Requested profile was not found");
const path = new URL(`/api/profiles/${encodeURIComponent(profileId)}`, hub).href;
const tokenState = profile.connection.auth === "cdp_token"
  ? await request(profile.connection.cdp_token_url)
  : undefined;
const cdpHeaders = tokenState?.cdp_token
  ? { Authorization: `Bearer ${tokenState.cdp_token}` }
  : {};

let browser;
let page;
let started = false;
try {
  const state = await request(`${path}/start`, "POST");
  started = true;
  browser = await chromium.connectOverCDP(state.connection.cdp_url, {
    headers: cdpHeaders, timeout: 60_000
  });
  page = await browser.contexts()[0].newPage();
  await page.goto("data:text/html,<title>CloakHub agent connected</title>");
  console.log(await page.title());
} finally {
  try {
    try { if (page) await page.close(); }
    finally { if (browser) await browser.close(); }
  } finally {
    // Explicit stop affects all clients. Enable only for a task-dedicated profile.
    if (started && process.env.CLOAKHUB_STOP_AFTER === "true") {
      const state = await request(`${path}/stop`, "POST");
      console.log(`Profile ${state.instance_status}`);
    }
  }
}
