# Client setup

The operator first creates a profile in CloakHub, signs into any required websites
through the viewer, and generates a CDP token for that profile. The client needs
the reachable hub origin, exact profile ID, and that profile's token. Admin access
and the CloakBrowser license stay on the server/operator side.

## Install

Copy this entire `cloakhub-browser` directory into the agent's supported skills
directory on the client, including `scripts/`, `references/`, `package.json`, and
`package-lock.json`. Use Node 20+ and run
`npm ci --prefix /absolute/path/to/cloakhub-browser` once.
Only `playwright-core` is installed; no browser download is required. Restart or
reload the agent's skill discovery according to its client.

## Configure targets

Create `~/.config/cloakhub/client.json` on the client:

```json
{
  "version": 1,
  "defaultTarget": "work",
  "targets": {
    "work": {
      "url": "https://browser.example.com",
      "profile": "research",
      "tokenFile": "tokens/work"
    },
    "personal": {
      "url": "http://192.168.1.50:7788",
      "profile": "personal",
      "tokenEnv": "PERSONAL_CLOAKHUB_CDP_TOKEN"
    }
  }
}
```

Replace the example values with operator-provided values. Put only the profile's
CDP token in `~/.config/cloakhub/tokens/work`; on Unix, restrict the token file to
mode `600` and its directory to `700`. The agent should let the script read it,
not load it into conversational context. `tokenEnv` names a variable inherited by
the agent's execution process; setting it in an unrelated terminal will not affect
an already-running desktop agent.

Choose exactly one authentication source per target: `tokenFile`, `tokenEnv`, or
`"auth": "none"` for an intentionally unprotected CDP endpoint. Missing credentials
fail before connecting; there is no anonymous fallback. Admin auth does not protect
an un-tokened profile's CDP endpoints.

Token paths can be absolute, start with `~/`, or be relative to the config file.
URLs must be HTTP(S) origins with no path, query, embedded credentials, or fragment.
CloakHub path-prefix hosting is unsupported. Use HTTPS outside a trusted private
network. Reverse proxies must support WebSocket upgrades and set the public
`X-Forwarded-Host` and `X-Forwarded-Proto`. The default Docker localhost binding
must be exposed through a suitable proxy or changed for private-network access.

`CLOAKHUB_CLIENT_CONFIG` overrides the config file path; no project config is
automatically loaded. To bind one project or agent process to an alias, set
`CLOAKHUB_TARGET=work` in its execution environment, or instruct it to use
`--target work`. An explicit `--target` wins, then `CLOAKHUB_TARGET`, then
`defaultTarget`. Changing the alias selects URL, profile, and credential together.
The helper does not read `CLOAKHUB_AUTH_TOKEN` or the older example's URL/profile
environment variables.

```sh
node /absolute/path/to/cloakhub-browser/scripts/browser.mjs targets
node /absolute/path/to/cloakhub-browser/scripts/browser.mjs check --target work
```

`targets` is local and does not read secrets. `check` wakes the browser if needed,
authenticates over CDP, reports connection metadata, and disconnects. It does not
navigate, create tabs, or test a website's login state. A successful check means
the client is ready for a browser task.

## Troubleshooting

- Missing config/default/alias: obtain the intended URL and profile from the operator;
  configure them once. Do not discover and choose arbitrary server profiles.
- Missing package: install dependencies in this skill's directory, not an unrelated
  project's directory.
- 401: check the selected profile's CDP token. The admin token is a different credential.
- 404: verify the exact profile ID. Connecting does not create a missing profile.
- Connection refused or TLS/upgrade failure: check client reachability, server binding,
  HTTPS certificate, and proxy WebSocket support. Never fall back to a local browser.
- Cold start timeout: connecting allows 60 seconds; an expired timeout does not cancel
  server startup. Inspect server state before repeating. An operator can inspect the UI
  and event log without giving the client administrative credentials.
- 503: do not retry just on status. When the server reports `CAPACITY_UNAVAILABLE`
  with `retryable: true`, use bounded backoff (at most three retries). Display or
  startup configuration errors require operator repair. A WebSocket error may hide
  the structured response; the operator can inspect the UI/API error instead.

Changing or revoking a token affects new connections; it is not a promise that an
already-connected client has been disconnected. Admin stop/restart affects all clients.
