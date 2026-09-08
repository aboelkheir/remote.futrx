# Previews and browser features

There are two browser systems:

| System | Purpose | Browser process |
| --- | --- | --- |
| App preview | Show a web app already running in the project | The user's normal browser loads the project app in an iframe |
| Agent Browser | Share a signed-in, headed browser between user and agent | One host Chromium; one isolated BrowserContext per active project |

## App discovery and preview URLs

```mermaid
flowchart LR
    App["Project process listens on TCP port"] --> Scan["Backend scans with ss"]
    Scan --> Filter["Exclude loopback-only listeners and deduplicate ports"]
    Filter --> Picker["Browser drawer app picker"]
    Picker --> URL["https://slug--port.dev.host"]
    URL --> Caddy["Caddy authenticates request"]
    Caddy --> DNS["slug.lxd:port"]
    DNS --> App
```

The UI prefers a preview URL recently mentioned in chat when it matches the current project and a discovered port. Otherwise it selects a discovered listener.

Preview host rules:

- Port must be between 1024 and 65535.
- On-demand TLS asks the backend to confirm the slug is a real project before certificate issuance.
- The authenticated user must be an admin or project member, or the request must carry a valid public share link for that exact slug and port.
- Platform cookies are stripped before the request enters project code.

## Public share links

A preview can be shown to someone who has no platform account. A project member creates a share link for one port; the link authorizes that port and nothing else.

```mermaid
sequenceDiagram
    actor Client as Outside viewer
    participant Caddy
    participant Verify as /auth/verify
    participant Store as projectshares store
    participant App as Project app

    Client->>Caddy: GET https://slug--port.dev.host/?share=TOKEN
    Caddy->>Verify: forward_auth with X-Forwarded-Host and X-Forwarded-Uri
    Verify->>Store: match SHA-256 of TOKEN for this slug and port
    Store-->>Verify: live, unexpired, unrevoked link
    Verify-->>Client: 302 to the same URL without the token, Set-Cookie remote_share
    Client->>Caddy: GET https://slug--port.dev.host/
    Caddy->>Verify: forward_auth with the remote_share cookie
    Verify->>Store: is that link still live?
    Verify-->>Caddy: 200
    Caddy->>App: proxy with remote_share stripped
```

Properties that make this safe to hand out:

- **One port, one project.** The token is bound to the project slug and the port. It is refused on any other host, on `*.code.<host>`, on port 6080 (Agent Browser noVNC), and on the main application.
- **Nothing replayable is stored.** `DATA_DIR/projectshares/<projectId>.json` holds only a SHA-256 digest of each token, plus port, label, creator, timestamps, and a revocation stamp.
- **Time-boxed.** Default lifetime 24 hours; the UI offers 1 hour, 24 hours, and 7 days; the service refuses anything under 1 hour or over 30 days.
- **Revocable immediately.** Every request re-reads the link from the store, so revoking one stops the next request, cookie or not.
- **Host-scoped cookie.** `remote_share` is set without a `Domain`, so the browser sends it only to that one `<slug>--<port>.dev.<host>` origin. Its value is `{slug, port, shareId, exp}` signed with the same HMAC key as platform sessions, under a separate domain-separation tag so a share pass can never verify as a session.
- **Token leaves the URL immediately.** The first response is a redirect to the same URL minus `?share=`, so the token stays out of browser history, `Referer`, and the project's own logs. The redirect is also what makes `Set-Cookie` reach the browser: Caddy's `forward_auth` discards the auth response on 2xx and relays only non-2xx responses.
- **Stripped at the container boundary.** `remote_share` is in the Caddyfile `header_up` cookie-strip list, so code running inside the container never sees it.

Endpoints (project membership required; admins reach every project):

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/projects/{id}/shares` | Creates a link from `{port, ttlHours?, label?}` and returns the full URL **once** |
| `GET` | `/api/projects/{id}/shares` | Lists live links as metadata — never a token or digest |
| `DELETE` | `/api/projects/{id}/shares/{shareId}` | Revokes one link |

Operators create and revoke links under **Project settings → Sharing → Public preview links**, which lists each discovered port with a lifetime selector and a Share action.

Changing the cookie-strip list means the Caddyfile template changed, so an existing box needs `sudo bash infra/install.sh` (step `03-caddy.sh`) or `infra/update.sh` before share cookies stop reaching containers.

## Preview inspection

Inspect mode wraps the selected app with `/__remote_inspector` on the same preview origin. Same-origin access lets the wrapper inspect the inner app iframe.

```mermaid
sequenceDiagram
    actor User
    participant UI as Main chat UI
    participant Wrapper as Inspector wrapper
    participant App as Project app iframe

    User->>UI: Enable inspect mode
    UI->>Wrapper: Load wrapper with app URL
    Wrapper->>App: Load app on the same preview origin
    Wrapper-->>UI: remote-inspector:ready
    UI->>Wrapper: Enable selection
    User->>App: Hover and click element
    Wrapper->>Wrapper: Collect selector, text, HTML, box, styles, parents
    Wrapper-->>UI: element-selected payload
    UI->>UI: Insert Browser element block into composer
```

The payload is bounded and includes enough layout and accessibility context for an agent to identify the selected element. Selecting an element exits inspect mode.

## Agent Browser architecture

```mermaid
flowchart TB
    User["User"] -->|"same-origin WebSocket"| Backend["Authenticated backend view proxy"]
    AgentA["Agent in project A"] -->|"scoped HTTP MCP token"| Broker["Host browser broker"]
    AgentB["Agent in project B"] -->|"different scoped token"| Broker
    Backend -->|"server-side scoped token"| Broker
    Broker --> ContextA["Project A BrowserContext"]
    Broker --> ContextB["Project B BrowserContext"]
    ContextA --> Chrome["One sandboxed headed Chromium"]
    ContextB --> Chrome
    Chrome --> Xvfb["One Xvfb display"]
    ContextA --> StateA["Encrypted A storage state"]
    ContextB --> StateB["Encrypted B storage state"]
```

The user can sign in visually while the agent controls the same project tabs.
BrowserContexts isolate cookies, local storage, IndexedDB, cache, permissions,
and pages between projects while sharing Chromium's fixed process overhead.
The broker starts the Chrome executable directly inside its systemd cgroup and
then attaches Playwright over an ephemeral `127.0.0.1` CDP port. The visited
page never renders into Remote's canvas—the canvas only displays CDP
screencast frames—and Chromium is not started with Playwright's automation
launch arguments. Raw CDP remains inaccessible to project containers.
Storage state is encrypted on the host and restored when a context starts, so
site logins survive context, container, and backend replacement. Existing
legacy Chrome profiles are retained for rollback but are not imported into the
new context format; each project signs in once after migration.

## Agent Browser lifecycle

```mermaid
stateDiagram-v2
    [*] --> Stopped
    Stopped --> Starting: open Agent Browser or select browser skill
    Starting --> CoreReady: project context and MCP ready, no human view
    Starting --> Ready: context and screencast view ready
    CoreReady --> Ready: start human view
    Ready --> CoreReady: close drawer, stop view only
    CoreReady --> Stopped: explicit stop or idle reaper
    Ready --> Stopped: explicit stop or idle reaper
    Starting --> Error: provision or start failure
    Error --> Starting: retry
```

Frontend behavior:

- Opening Agent Browser calls the start endpoint, polls every 1.5 seconds, and sends a status heartbeat every 15 seconds.
- Closing the drawer stops only the screencast view; the project context stays available to the agent.
- Explicit Stop saves encrypted storage state and closes the project context. Chromium exits after the final context becomes idle.

Backend behavior:

- Starting the browser first ensures the project container is running, then asks the separately supervised host broker for that project's context. The broker launches Chromium directly on demand and attaches over its private loopback CDP endpoint.
- Installation places Chromium and the broker on the host once; project starts publish only the agent skill and remote MCP configuration.
- A selected `browser` skill injects a per-run, project-scoped MCP URL/token pair into that agent process. Raw CDP is not exposed to containers.
- Active browser-enabled prompts send a keepalive every minute.
- A reaper checks every minute and stops a browser after 20 minutes without pane or agent activity, unless a viewer is connected.

## URL and proxy layout

```mermaid
flowchart TD
    Main["https://host"] --> Backend["Main UI and API"]
    IDELauncher["https://code.host"] --> Launcher["Installable IDE launcher"]
    IDEProject["https://slug.code.host"] --> CodeServer["slug.lxd:8842"]
    Preview["https://slug--port.dev.host"] --> ProjectApp["slug.lxd:port"]
    AgentView["wss://host/api/projects/id/agent-browser/view"] --> ViewProxy["Authenticated backend proxy"]
    ViewProxy --> Broker["bridge-ip:9323/view"]
```

The installer configures host DNS resolution for `.lxd` names through the LXD bridge. Caddy handles public HTTPS and routes to private container addresses.
The browser broker is not exposed through Caddy. Its bridge listener requires
an HMAC-scoped bearer token. Agent/view tokens cannot invoke lifecycle control
routes, which use a distinct backend-only token class. The backend strips the
platform cookie before proxying the human WebSocket. The view route also
requires an exact same-origin WebSocket handshake so a project preview
subdomain cannot drive it with the user's same-site cookie.

## Security boundary

```mermaid
flowchart LR
    Request["Agent or human request"] --> Auth["Membership or scoped bearer check"]
    Auth --> Project["Resolve one project identity"]
    Project --> Context["Only that BrowserContext"]
    Context --> Network["Block private, metadata, and sibling .lxd targets"]
```

BrowserContext isolation is a strong session boundary, not a VM boundary: all
contexts still share one Chromium multi-process instance and kernel account. A browser
engine compromise could cross it. Projects that require a hostile-code security
boundary should continue to use separate browser processes or servers.
Preview and IDE requests have their own edge boundary:

```mermaid
flowchart LR
    Request["Public subdomain request"] --> TLS["On-demand TLS allow check"]
    TLS --> Auth["Platform session and membership check"]
    Auth -->|"preview hosts only"| Share["Share link or share cookie check"]
    Auth --> Strip["Strip platform cookies"]
    Share --> Strip
    Strip --> Container["Untrusted project app or IDE"]
```

Project apps may set and receive their own cookies. Only the platform's session, OAuth-state, return-location, and share cookies are removed.

## Code map

- App scanning: [`backend/internal/integration/containers/listeners/scanner.go`](../../backend/internal/integration/containers/listeners/scanner.go)
- Browser drawer: [`frontend/src/ui/chat/browser/BrowserDrawer.tsx`](../../frontend/src/ui/chat/browser/BrowserDrawer.tsx)
- Inspector handler: [`backend/internal/transport/http/handlers/browser_inspector_handler.go`](../../backend/internal/transport/http/handlers/browser_inspector_handler.go)
- Agent Browser service: [`backend/internal/service/container/browser/service.go`](../../backend/internal/service/container/browser/service.go)
- Shared broker: [`browser-broker/src/server.mjs`](../../browser-broker/src/server.mjs)
- Broker systemd unit: [`infra/templates/remote.futrx-browser.service.tmpl`](../../infra/templates/remote.futrx-browser.service.tmpl)
- Caddy routes: [`infra/templates/Caddyfile.tmpl`](../../infra/templates/Caddyfile.tmpl)
- Share links service: [`backend/internal/service/share/service.go`](../../backend/internal/service/share/service.go)
- Share links store: [`backend/internal/stores/fileprojectshares/store.go`](../../backend/internal/stores/fileprojectshares/store.go)
- Edge share check: [`backend/internal/transport/http/handlers/auth_verify_share.go`](../../backend/internal/transport/http/handlers/auth_verify_share.go)
