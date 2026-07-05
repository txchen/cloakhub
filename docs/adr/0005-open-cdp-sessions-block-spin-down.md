# Open CDP sessions block spin-down

CloakHub will not spin down a Browser Instance while it has an open CDP Session, even if no CDP messages are currently flowing. Long-lived or leaked CDP sessions must be visible in the UI with session duration so operators can diagnose why an instance remains running.
