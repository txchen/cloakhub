# Plaintext CDP token storage

CloakHub will store per-profile CDP Tokens in plaintext in SQLite. Hashing would reduce credential exposure if the Data Root is copied, but plaintext storage was chosen for operational simplicity and easier token viewing/reuse; operators should treat the Data Root as sensitive.
