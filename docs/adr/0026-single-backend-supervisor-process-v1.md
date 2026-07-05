# Single backend supervisor process for v1

CloakHub v1 will run as a single backend supervisor process for a Data Root. Browser Instance supervision, port/display allocation, sleep timers, and Runtime State are owned by that process; multiple active CloakHub replicas sharing the same Data Root are out of scope.
