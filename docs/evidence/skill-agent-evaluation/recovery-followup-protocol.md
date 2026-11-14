# Recovery follow-up protocol

Declared after the original 18-trial matrix, before this follow-up. Keep original
results unchanged, including candidate recovery failure at seed 810.

Only the recovery entrypoint and reference are revised: before further writes,
read the recovery reference and validate a complete structured reconciliation
result, exact keys/fields, uniqueness and original-request finality. No helper
runtime changes. The follow-up freezes its own candidate snapshot and hashes.

Run three current-only recovery trials, fresh seeds 910–912, with the same model,
fixture, isolated release Hub, 300-second deadline, seventh-write fault and exact
server scoring. Preserve failures. These are diagnostic post-fix regressions,
not new paired A/B evidence or a statistical claim of reliability. Do not pool
these trials with the original matrix or use them for a speed comparison.
