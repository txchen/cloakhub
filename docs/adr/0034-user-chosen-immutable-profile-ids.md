# User-chosen immutable profile IDs

CloakHub will use a user-chosen immutable Profile ID in profile and CDP URLs instead of opaque UUIDs. Profile IDs must be unique and match `^[a-z][a-z0-9_]*$`; display names remain separate and can change without breaking automation URLs.
