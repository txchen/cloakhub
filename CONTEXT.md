# CloakHub

CloakHub manages persistent CloakBrowser profiles and their on-demand browser runtimes on Linux servers, usually inside Docker.

## Language

**CloakHub**:
The server application being designed here: a Linux-focused manager for persistent browser profiles and resource-efficient browser runtimes.
_Avoid_: CloakBrowser Manager, clockbrowser-manager

**CloakBrowser Binary**:
The CloakBrowser executable used to run Browser Instances. CloakHub does not treat stock Chrome or Chromium as compatible substitutes.
_Avoid_: Chrome, Chromium

**Browser Profile**:
A durable browser identity and storage area, including fingerprint settings, launch settings, and the browser user-data directory that must survive process restarts and spin-downs.
_Avoid_: Account, chrome profile

**Profile ID**:
The immutable, user-chosen, URL-safe identifier for a Browser Profile, using lower-case letters, numbers, and underscores.
_Avoid_: UUID, slug, display name

**Sleep Policy**:
The Browser Profile setting that controls when its Browser Instance may spin down, including the default timeout, a profile-specific timeout, or an explicit never-sleep choice.
_Avoid_: Timeout, idle setting

**Browser Instance**:
The live runtime for a Browser Profile: the running browser process plus supporting display, VNC, and automation endpoints.
_Avoid_: Profile, session

**Instance Status**:
The operator-visible lifecycle state of a Browser Instance: stopped, starting, running, stopping, or failed.
_Avoid_: Running flag, profile status

**Runtime State**:
The in-memory supervision state for Browser Instances, including active connections, process handles, allocated ports, display mappings, launch locks, and sleep timers.
_Avoid_: Profile data, persisted state

**Lifecycle History**:
Durable timestamps and reasons describing recent Browser Instance events, such as last start, last stop, last activity, last spin-down reason, last launch failure time, or last launch error.
_Avoid_: Runtime State, logs

**Owned Process**:
A child process that CloakHub can identify as belonging to a Browser Instance through its pidfile, profile-specific paths, process group, or launch marker.
_Avoid_: Chrome process, VNC process

**Resource Usage**:
Approximate CPU and memory consumption attributed to a Browser Instance through its Owned Processes or process group.
_Avoid_: Exact billing, browser metrics

**Browser Persistence**:
The guarantee that cookies, local storage, cache, extension state, session restore data, and other browser user-data survive Browser Instance shutdown and later recovery. It does not preserve JavaScript heap, in-flight requests, unsaved form state, media playback, or other live runtime state.
_Avoid_: Process persistence, always-on browser, runtime snapshot

**Data Root**:
The configured filesystem root where CloakHub stores profile metadata and Browser Profile user-data directories. It defaults for Docker use but must be configurable for non-Docker Linux deployments.
_Avoid_: `/data`, volume

**CDP Client**:
An external automation tool that connects to a Browser Instance through Chrome DevTools Protocol.
_Avoid_: Bot, script, CD request

**CDP Session**:
An active CDP websocket connection from a CDP Client through CloakHub to a Browser Instance, tracked with a start time and duration for operator visibility.
_Avoid_: CDP request, command

**CDP Token**:
An optional per-Browser Profile credential that allows CDP Clients to access that profile's CDP endpoints without using the admin UI token.
_Avoid_: API key, profile password

**Manual Client**:
A human operator connected through the web UI and live browser viewer.
_Avoid_: User, viewer

**Viewer Presence**:
The fact that one or more Manual Clients have an open VNC viewer connection to a Browser Instance. Viewer Presence is operator-visible but is not Instance Activity by itself.
_Avoid_: Active viewer, manual activity

**Manual Input**:
Keyboard, pointer, wheel, clipboard paste, or similar operator actions sent from a Manual Client into a Browser Instance.
_Avoid_: Watching, viewing, presence

**Instance Activity**:
An interaction observed by CloakHub that should keep a Browser Instance alive: active CDP websocket connections, CDP messages through CloakHub, Manual Input through VNC, and explicit lifecycle commands. Passive UI polling, health checks, profile list/status requests, profile edits, and view-only VNC framebuffer updates are not Instance Activity.
_Avoid_: Traffic, request, usage

**Transparent Recovery**:
The behavior where a request for a stopped Browser Instance starts it automatically and waits until the requested CDP or manual endpoint can be served.
_Avoid_: Wake first, manual relaunch

**Idle Browser Instance**:
A Browser Instance with no observed Instance Activity for its configured idle window. Browser-internal page work such as timers, media playback, service workers, downloads, or page WebSockets does not prevent a Browser Instance from becoming idle.
_Avoid_: Inactive tab, sleeping page

**Spin-down**:
The teardown of an Idle Browser Instance to reclaim server resources, including the browser process and per-instance display, VNC, clipboard, and automation support processes.
_Avoid_: Pause, suspend, hide

**Running Instance Limit**:
The configured maximum number of Browser Instances that may be live at the same time. Transparent Recovery must respect this limit.
_Avoid_: Browser limit, profile limit

**Capacity Preemption**:
An early Spin-down of a running Browser Instance with no active CDP Sessions and no recent Manual Input, performed to make room under the Running Instance Limit for another requested Browser Instance.
_Avoid_: Idle timeout, eviction

**Registered Profile**:
A Browser Profile that has been created in CloakHub before any CDP Client can connect to it.
_Avoid_: Dynamic profile, implicit profile
