# Graceful spin-down with hard-kill fallback

CloakHub will spin down Browser Instances gracefully first so browser profile data can flush, then hard-kill remaining Owned Processes after a short grace period. This balances Browser Persistence with the resource-reclamation goal.
