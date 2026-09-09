import type { BrowserProfile } from "./profile";

export interface ProfileConnection {
  cdp_url: string;
  cdp_ws_url: string;
  cdp_discovery_url: string;
  auth: "none" | "cdp_token";
  cdp_token_url: string;
}

// The caller supplies the public origin. Credentials never enter connection metadata.
export function profileConnection(
  profile: Pick<BrowserProfile, "profile_id" | "cdp_token">,
  publicUrl: URL
): ProfileConnection {
  const profileUrl = `${publicUrl.origin}/api/profiles/${encodeURIComponent(profile.profile_id)}`;
  const cdpUrl = `${profileUrl}/cdp`;
  return {
    cdp_url: cdpUrl,
    cdp_ws_url: cdpUrl.replace(/^http/, "ws"),
    cdp_discovery_url: `${cdpUrl}/json/version`,
    auth: profile.cdp_token ? "cdp_token" : "none",
    cdp_token_url: `${profileUrl}/cdp-token`
  };
}
