# CDP access only through the CloakHub proxy

CloakHub will not expose Chrome's internal CDP ports directly to clients; CDP Clients must connect through CloakHub proxy endpoints. This lets CloakHub observe CDP connections and messages, enforce spin-down and capacity rules, and perform Transparent Recovery for stopped Browser Instances.
