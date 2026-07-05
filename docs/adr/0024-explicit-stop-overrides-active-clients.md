# Explicit stop overrides active clients

CloakHub's explicit stop action is an operator override: it may close active CDP Sessions and VNC viewers, then spin down the Browser Instance. The UI should warn when active clients exist, but the API must provide a way to reclaim resources from leaked or unwanted connections.
