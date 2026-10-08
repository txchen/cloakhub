# Client setup

The operator first creates a profile in CloakHub and signs into any required websites
through the viewer. For protected CDP access, open the profile's **···** menu in the
management page and select **Manage CDP token**, then click **Protect with token**.
Use **Copy CDP URL** to retrieve the generated token; the UI does not accept a
custom token. The client needs the reachable hub origin, exact profile ID, and
that token if protection is enabled. Admin access and the CloakBrowser license
stay on the server/operator side.

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
      "token": "REPLACE_WITH_PROFILE_CDP_TOKEN"
    },
    "personal": {
      "url": "http://192.168.1.50:7788",
      "profile": "personal",
      "tokenEnv": "PERSONAL_CLOAKHUB_CDP_TOKEN"
    }
  }
}
```

Replace the example values with operator-provided values. With an inline `token`,
`client.json` contains a secret: on Unix, restrict `~/.config/cloakhub` to mode
`700` and `client.json` to mode `600`; do not commit or paste it into a prompt.
The agent should let the script read it without loading it into conversational
context. `tokenFile` remains supported (a path relative to `client.json`, absolute,
or starting with `~/`); `tokenEnv` names a variable inherited by the agent process.
Setting it in an unrelated terminal will not affect an already-running desktop agent.

For a protected profile, choose exactly one of `token`, `tokenFile`, or `tokenEnv`.
For a profile without a CDP token, omit all three fields (or use `"auth": "none"`
to make the intent explicit). This sends no CDP credential; admin auth does not
protect an un-tokened profile's CDP endpoints. If a source is configured but its
token is missing, the client fails before connecting rather than falling back to
anonymous access. An open target cannot connect to a profile whose server-side
CDP token is configured.

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
- `connectOverCDP` timeout after `<ws connected>`: authentication and the WebSocket
  upgrade succeeded. Playwright waits for every existing tab to answer its first CDP
  commands. A tab whose host drops TCP packets, such as a stopped dev server on the
  Docker host's LAN or Tailscale IP, may not answer until Chrome's connection timeout
  (about 2.5 minutes). Rerun with
  `DEBUG=pw:protocol` and find the `sessionId` whose `Page.enable` never gets a reply.
  Its `Target.attachedToTarget` line gives the URL. Ask the operator to close that tab,
  or close it yourself after the browser is warm. Do not increase the timeout. Close task
  tabs that point at temporary hosts.
- 503: do not retry just on status. When the server reports `CAPACITY_UNAVAILABLE`
  with `retryable: true`, use bounded backoff (at most three retries). Display or
  startup configuration errors require operator repair. A WebSocket error may hide
  the structured response; the operator can inspect the UI/API error instead.

Changing or revoking a token affects new connections; it is not a promise that an
already-connected client has been disconnected. Admin stop/restart affects all clients.
