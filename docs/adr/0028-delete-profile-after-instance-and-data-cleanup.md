# Delete profile after instance and data cleanup

CloakHub will delete a Browser Profile only after stopping any running Browser Instance and successfully removing the profile's browser user-data directory. If teardown or filesystem cleanup fails, CloakHub keeps the metadata so the profile remains visible and recoverable instead of orphaning hidden data.
