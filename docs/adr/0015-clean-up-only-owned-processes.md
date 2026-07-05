# Clean up only owned processes

CloakHub startup cleanup will target only Owned Processes identified by pidfiles, profile-specific paths, per-instance process groups, or launch markers under the Data Root. Each Browser Instance should run its child processes in an identifiable process group for cleanup and Resource Usage attribution. CloakHub will not use broad process-name killing such as `pkill chrome` or `pkill Xvnc`, because it must be safe to test and run on non-Docker Linux hosts.
