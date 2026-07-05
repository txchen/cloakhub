# Optional per-profile CDP tokens

CloakHub will support optional per-profile CDP Tokens for that Browser Profile's CDP endpoints. CDP Tokens are disabled by default; v1 supports one active token per Browser Profile with regenerate and revoke actions. `CLOAKHUB_AUTH_TOKEN` does not grant CDP access, and CDP Tokens do not grant UI or admin API access. If a Browser Profile has no CDP Token, its CDP endpoint is open to anyone who can reach CloakHub; the UI must make that visible.
