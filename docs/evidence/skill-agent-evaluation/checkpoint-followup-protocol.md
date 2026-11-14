# Checkpoint interface follow-up

The first frozen six-case run exposed two pre-write task failures: ambiguous error
at a missing read().destination.siteOrigin, and importing a saved script as an ES
module even though session variables are injected into script bodies. Preserve all
v3 results. The candidate now names the exact invalid field and demonstrates stdin
script execution plus the read-return identity schema. No state transition is relaxed.

Repeat the full six-case protocol with new seeds 1310–1315. The already-running v3
uses its immutable snapshot; the v4 snapshot is independent. Both use isolated
profiles, and may overlap in wall time; these are reliability tests, not speed A/B.
The scorer accepts either the raw tenant key or its observed 'Account: ' label
representation, both identifying the same synthetic tenant. This correction does
not excuse an absent/wrong identity. Keep all new failures. No edits to either
frozen snapshot during testing.
