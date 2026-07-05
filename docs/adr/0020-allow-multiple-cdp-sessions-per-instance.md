# Allow multiple CDP sessions per instance

CloakHub will allow multiple CDP Sessions to connect to the same Browser Instance, matching CloakBrowser Manager's lack of an artificial single-client guard. CloakHub will track and display each session separately, but it will not coordinate CDP commands or prevent clients from interfering with each other inside the browser.
