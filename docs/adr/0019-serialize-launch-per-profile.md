# Serialize launch per profile

CloakHub will serialize launch and Transparent Recovery per Browser Profile. Concurrent wake requests for the same stopped profile must share one launch attempt and observe the same result, rather than starting multiple Browser Instances against the same user-data directory.
