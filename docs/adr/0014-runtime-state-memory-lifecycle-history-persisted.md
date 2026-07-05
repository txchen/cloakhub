# Runtime state in memory, lifecycle history persisted

CloakHub will keep Runtime State in memory and reconstruct it on process startup by cleaning up owned orphan processes and marking Browser Instances stopped. SQLite will persist Browser Profiles, Sleep Policies, and Lifecycle History, but not active websocket counts, process handles, allocated displays, ports, launch locks, or timers.
