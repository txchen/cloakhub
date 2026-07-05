# Monotonic idle timers and wall-clock history

CloakHub will use monotonic time for live idle and timeout decisions, while persisting wall-clock timestamps for UI display and Lifecycle History. This prevents system clock changes from causing incorrect spin-down behavior while keeping operator-visible times understandable.
