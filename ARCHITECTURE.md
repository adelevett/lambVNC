# LambVNC — Architecture & Design Rationale

> *One shepherd. Many lambs.*

This document is the authoritative record of every significant architectural decision made in the design of LambVNC — what was chosen, what was rejected, and why. It is intended for contributors seeking to understand the codebase, security auditors evaluating the threat model, and campus IT administrators assessing deployment suitability. It is a living document and should be updated whenever a consequential design decision is made or revised.

---

## 1. What LambVNC Is

LambVNC is a browser-based, many-to-one VNC monitoring dashboard purpose-built for campus LAN environments. It allows a single administrator (the shepherd) to watch up to 12 remote Windows machines (the lambs) simultaneously in a live, auto-scaling grid — with no proprietary agent installation required on monitored machines (beyond a standard VNC server), no proprietary software, and a security model designed explicitly for environments where unauthorized access to screen content carries serious institutional and legal consequences.

The specific combination of capabilities LambVNC delivers does not currently exist in any open-source project:

- **Agentless deployment** via Windows' built-in OpenSSH, requiring zero third-party software on sender machines
- **Browser-based grid UI** built on noVNC, accessible from any modern browser or via RDP into the monitoring station
- **Tiered visual change detection** with configurable per-tier alerting, fade timers, and session-persistent profiles
- **Security-first credential management** with AES-256-GCM encrypted VNC passwords at rest
- **Tamper-evident audit logging** via SQLite WAL, recording who watched whom and when

### 1.1 Market Gap

The remote desktop landscape bifurcates into two categories that LambVNC bridges:

| Platform | Model | Grid UI | Visual Alerts | Agentless¹ | Open Source |
|---|---|---|---|---|---|
| Apache Guacamole | Gateway | No | No | Yes | Yes |
| MeshCentral | RMM | Thumbnail | No | **No** | Yes |
| MightyViewer | Desktop app | Yes | Basic | Yes¹ | **No** |
| SmartCode VNC Manager | Desktop app | Yes | Basic | **No** | **No** |
| **LambVNC** | **Web dashboard** | **Yes** | **3-tier** | **Yes** | **Yes** |

¹ "Agentless" here means no custom proprietary agent — but both MightyViewer and LambVNC require TightVNC Server to be installed on sender machines. The distinction is that TightVNC Server is a standard, open, auditable VNC implementation rather than a vendor-controlled agent with opaque capabilities.

MightyViewer is the closest functional analog and the direct inspiration for LambVNC's grid UI. It was rejected as a solution for three reasons: it is a locally-installed Windows application (not browser-accessible), it carries no meaningful security model (plaintext transport, no auth, no audit log), and it is transitioning to a paid commercial product.

---

## 2. Topology and Data Flow

```
[ Sender Machine 1 ] ──SSH Reverse Tunnel──┐
[ Sender Machine 2 ] ──SSH Reverse Tunnel──┤
         ...                               ├──► [ LambVNC Server ]──WSS──► [ Monitor Browser ]
[ Sender Machine N ] ──SSH Reverse Tunnel──┘
         (TightVNC Server on :5900)              (Node.js + Express)        (noVNC Grid UI)
                                                 (WS↔TCP bridge, localhost)
```

Every component in this chain is either open source or built into the operating system. No proprietary protocol, no cloud dependency, no registration.

### 2.1 Capacity

LambVNC is deliberately capped at **12 simultaneous monitored sessions**. This is not a technical limitation — it is a design constraint that keeps the rendering architecture simple, the SSH tunnel pool manageable, and the UI readable. At 12 sessions:

- Browser canvas context limits (typically 8–20 simultaneous high-performance contexts) become relevant but manageable via viewport virtualization rather than requiring the extreme complexity of monolithic canvas aggregation
- Pixel diffing on downscaled canvases is negligible CPU cost on the main thread — Web Workers and WebAssembly are engineering overkill
- SSH tunnel pool management is trivial
- The grid layout remains visually comprehensible to a human monitor

Implementations requiring 50+ sessions should evaluate Apache Guacamole with a custom plugin layer instead.

---

## 3. Transport Layer

### 3.1 Why SSH Tunneling Over Raw VNC

The VNC protocol (RFB) transmits screen content in plaintext by default. TightVNC's native "encryption" is a weak DES challenge-response limited to 8-character passwords — and tools exist publicly to trivially reverse stored TightVNC passwords from the Windows registry. On a campus LAN, any machine running a packet capture can reconstruct screen content from raw VNC traffic.

SSH tunneling solves this at the transport layer cleanly and without any third-party dependency. Windows 10 and 11 ship with OpenSSH built in. No install, no agent, no elevated privilege beyond enabling the OpenSSH client at startup.

The tunnel topology is a **reverse tunnel** — the sender initiates an outbound connection to the LambVNC server, which opens a corresponding localhost port mapping back to the sender's VNC service. This means:

- Sender machines require **no inbound firewall exceptions**
- The server never needs to reach into the LAN to pull connections
- The attack surface on sender machines is reduced to their outbound SSH connection only

### 3.2 SSH Tunnel Stability

Raw SSH connections over idle TCP will be dropped by intermediate networking hardware managing state tables. Each sender's SSH client must be configured with keepalive directives:

```
ServerAliveInterval 30
ServerAliveCountMax 3
```

This injects cryptographic dummy packets every 30 seconds, maintaining the NAT binding. Without this, tunnels silently die within minutes of idle VNC sessions.

### 3.3 The IPv4/IPv6 Loopback Pitfall

Windows OpenSSH exhibits a documented quirk: `ssh -R 5902:localhost:5901` may bind the reverse tunnel to the IPv6 loopback (`[::1]`) rather than IPv4 (`127.0.0.1`). If TightVNC Server is bound exclusively to IPv4 — which it is by default — the tunnel will silently fail with no visible error.

The mitigation is non-negotiable: always specify `127.0.0.1` explicitly in the tunnel command, never the `localhost` alias.

```bash
# Correct
ssh -R 127.0.0.1:590N:127.0.0.1:5900 lambvnc-server

# Silently broken on Windows
ssh -R localhost:590N:localhost:5900 lambvnc-server
```

### 3.4 WebSocket-to-TCP Bridge (Pure Node.js)

Browsers cannot open raw TCP connections. The LambVNC server runs one WebSocket-to-TCP bridge instance per connected sender, implemented in ~30 lines of Node.js using the `ws` and `net` modules. Each bridge is bound exclusively to `127.0.0.1` — never to the LAN interface — ensuring that raw, unauthenticated VNC byte streams are never exposed to the network. All external access is forced through the authenticated Express frontend layer.

```javascript
// Illustrative bridge pattern — ws↔TCP, localhost-bound, one per sender.
// Production code must handle binary framing explicitly:
// ws.send(data, { binary: true }) — without this flag, the ws library
// may coerce binary RFB frames to text frames, corrupting the VNC stream.
const wss = new WebSocket.Server({ host: '127.0.0.1', port: wsPort });
wss.on('connection', (ws) => {
  const tcp = net.createConnection(tunnelPort, '127.0.0.1');
  ws.on('message', (data) => tcp.write(data));
  tcp.on('data', (data) => ws.send(data, { binary: true }));
  ws.on('close', () => tcp.destroy());
  tcp.on('close', () => ws.terminate());
});
```

This approach was chosen over the `websockify` Python utility — which was the original specification — specifically to eliminate Python as a runtime dependency. An otherwise pure Node.js server requiring a Python subprocess installation is an unnecessary operational burden. The bridge logic is simple enough that owning it directly is strictly preferable.

### 3.5 Tunnel Discovery and Port Pre-Allocation

A question the topology diagram leaves implicit: how does the server know a tunnel has arrived, and on which port?

LambVNC uses **static pre-allocation** — not dynamic discovery. When a host is added to `profiles.json`, it is assigned a dedicated localhost port (e.g., host `lab-01` → port 5910, `lab-02` → port 5911). The server binds and listens on all pre-allocated ports at startup, regardless of whether the corresponding sender is currently connected. The SSH reverse tunnel command on each sender explicitly targets its pre-assigned port:

```bash
ssh -R 127.0.0.1:5910:127.0.0.1:5900 lambvnc-server
```

When the sender connects, the tunnel populates the pre-bound port. When it disconnects, the port remains bound but idle. The server detects live vs. dead tunnel state via TCP connection events on the bound socket, not by polling.

**Dynamic discovery was considered and rejected.** Watching for new port bindings appearing on localhost requires either OS-level socket enumeration (fragile, platform-specific) or an out-of-band signaling channel (complexity with no benefit at this scale). Static pre-allocation from `profiles.json` means the complete topology is declared once and known at startup. `ports.js` owns the port registry: it reads host profiles at initialization, allocates ports sequentially from a configurable base (default: 5910), and provides a lookup table used by both `tunnels.js` and `proxy.js`.

**Port collision validation:** At startup, `ports.js` must attempt to bind each pre-allocated port before proceeding. If a port is already in use by another process, the server must fail loud with a clear error identifying which port is conflicted — consistent with the §15 "fail loud at startup" principle. Silent port conflicts produce a bridge that never receives VNC traffic, resulting in a cell that appears connected but is permanently dead with no diagnostic signal. The validation is a `net.createServer().listen(port)` probe per allocated port, awaited before any SSH server or Express instance starts — the startup sequence must not proceed until all probes complete.

### 3.7 The LambVNC SSH Server (ssh2)

A critical architectural clarification: the LambVNC server runs an **embedded SSH server** implemented via the `ssh2` Node.js package — it does not rely on the OS-level OpenSSH server (`sshd`) on the monitoring machine. This is a meaningful distinction.

The `ssh2` package implements the full SSH2 protocol in pure Node.js, including support for accepting inbound connections and honoring `-R` reverse port forwarding requests. When sender machines connect with `ssh -R 127.0.0.1:5910:127.0.0.1:5900 lambvnc-server`, they are connecting to this embedded server. `tunnels.js` implements the `ssh2` server, listens on a configurable port (default: 2222), authenticates senders via public key (keys registered in `profiles.json` per host), and binds the requested reverse tunnel ports on localhost.

**Why an embedded server rather than OS sshd:**
- No dependency on the monitoring machine having `sshd` installed and configured
- Full programmatic control over which `-R` port forwarding requests are honored — the server can accept only the exact pre-allocated ports for known hosts and reject all other requests
- Session events (`close`, `error`, `tcp/ip-forward`) are directly observable in Node.js without parsing SSH logs
- Sender authentication keys are managed by LambVNC's own `profiles.json` rather than requiring OS-level `~/.ssh/authorized_keys` management

**Sender authentication:** Each host profile includes a registered public key. The embedded SSH server rejects connections from keys not present in `profiles.json`. This means adding a new monitored machine requires registering its key in the dashboard — an intentional access control gate, not an inconvenience.

---

### 3.8 Why Not WebRTC

WebRTC was evaluated and rejected. While it offers superior latency for continuous media streams, VNC does not transmit video — it transmits the RFB protocol: mathematical drawing primitives, coordinate updates, and compressed pixel rectangles. RFB demands **strict byte ordering and guaranteed delivery**. A single dropped or reordered byte misaligns the entire coordinate system, producing unrecoverable visual corruption.

WebSockets over TCP provide this guarantee natively. WebRTC's reliable Data Channels (SCTP) could theoretically satisfy the requirement, but implementing a full RFB client over SCTP introduces extreme complexity with no tangible performance benefit on a LAN where latency is measured in microseconds. WebSockets are the empirically correct choice for proxying VNC in this topology.

---

## 4. Content Security Policy and CORS

### 4.1 Why CSP Matters for LambVNC

LambVNC's dashboard opens WebSocket connections from the browser to multiple localhost ports — one WS↔TCP bridge per monitored host. If no CSP header is sent at all, browsers impose no `connect-src` restrictions and these connections work freely. The risk is the opposite: if any CSP header is ever introduced — by a reverse proxy sitting in front of LambVNC, by a future middleware addition, or by a well-intentioned security hardening pass — and that header does not explicitly include `connect-src`, the browser falls back to the CSP's `default-src` directive, which is typically `'self'`. The `'self'` check then blocks WebSocket connections to different localhost ports (because `localhost:5910` is a different origin from `localhost:3000`), producing a grid of dead cells with no error visible to the user.

The correct defense is to set `connect-src` explicitly on every response from the start — not because browsers restrict by default, but because explicitly declaring what is permitted makes the system resilient to future changes that would otherwise break it silently:

```
Content-Security-Policy: connect-src 'self' ws://localhost:* wss://localhost:*
```

In TLS mode the `ws://` variant can be tightened to `wss://` only. The wildcard port (`*`) is necessary because bridge ports are dynamically allocated per session — a fixed port list would require updating the CSP header on every host configuration change, which is operationally fragile.

### 4.2 CORS

LambVNC's dashboard is served by the same Express instance that hosts the WebSocket bridges. Because the origin of the dashboard page and the WebSocket endpoints are identical (`localhost:<port>`), cross-origin restrictions do not apply in the standard case. No CORS headers are required.

The one scenario that would require CORS handling — a dashboard served from a different origin than the WebSocket server — is explicitly not a supported deployment model. If someone attempts this configuration, they will receive browser CORS errors; the correct fix is to serve the dashboard and the WebSocket server from the same Express instance, not to loosen CORS policy.

---

## 5. TLS and the Certificate Authority Question

### 5.1 The Self-Signed Certificate Problem

The specification requires encrypted WebSocket transport (WSS). The naive implementation — a self-signed certificate — is cryptographically equivalent to a CA-signed certificate but fails silently in practice. Modern browsers enforce Web PKI strictly for background WebSocket connections. Unlike HTTPS navigations, there is no interstitial "Proceed anyway" page for WSS. The connection is simply rejected with `ERR_CONNECTION_CLOSED` and no user-visible explanation.

The workaround (manually navigating to the WSS port in a browser tab to accept the certificate exception) is operationally fragile and unsuitable for production.

### 5.2 The Localhost Exception

**If the monitoring browser connects to `localhost`**, browsers unconditionally treat the connection as a secure context. TLS is not required at all. This is the W3C Secure Contexts specification, implemented uniformly across Chromium, Firefox, and Safari.

This is the core insight behind LambVNC's primary deployment model: **run the Node.js server and the browser on the same machine, accessed via RDP**. The CA problem evaporates entirely. SSH tunnels still encrypt all sender → server traffic. The monitoring station's screen content (the grid itself) is protected by RDP's own encryption in transit to the administrator's device.

### 5.3 When a CA Is Required

Browser-based access from a device other than the monitoring station (e.g., an Android tablet, a separate workstation) requires TLS with a trusted certificate. The correct solution is an internal Certificate Authority:

1. Generate a root CA keypair on the LambVNC server
2. Deploy the root CA certificate to monitoring devices via Group Policy or MDM
3. Issue server certificates signed by the internal CA
4. Configure Express to use the signed certificate

This is a campus IT operation, not a code problem. The codebase supports both modes — localhost (no TLS) and network (TLS with internal CA) — via a single config flag.

---

## 6. Cryptographic Architecture

### 6.1 Dashboard Authentication

The administrator login is hashed with **bcrypt at cost factor 12**. Bcrypt was chosen over faster algorithms (SHA-256, SHA-512) because its adaptive cost factor makes brute force computationally infeasible without penalizing legitimate single logins. Cost factor 12 imposes ~250ms of intentional latency — imperceptible to a human, catastrophic for automated attacks.

Login verification uses timing-safe string comparison (`crypto.timingSafeEqual`) to prevent side-channel timing attacks, where an attacker infers password correctness from microsecond differences in server response time.

**Rate limiting** is applied to the authentication endpoint via `express-rate-limit`: a maximum of 10 login attempts per 15-minute window per IP address. This is an authentication control, not an infrastructure afterthought — it is implemented in `auth.js` alongside the bcrypt verification, not as a separate middleware concern.

Post-authentication sessions are managed via **JWT tokens** delivered as HTTP-only cookies. HTTP-only prevents JavaScript extraction (XSS mitigation). Tokens carry strict expiration horizons and are validated on every proxied WebSocket upgrade request — not just on page load.

**How JWT validation intercepts WebSocket upgrades:** The WS↔TCP bridges in `proxy.js` are not publicly exposed WebSocket servers — they are created as internal instances bound to `127.0.0.1` and never registered as Express routes. The browser's noVNC clients do not connect to these bridges directly. Instead, all WebSocket upgrade requests from the browser arrive at Express, which handles the HTTP upgrade event. Express validates the JWT from the cookie before deciding whether to proxy the upgrade to the appropriate internal bridge. A request with an invalid or missing token receives a `401` response and the upgrade is refused. No WebSocket connection reaches a bridge without passing through this authenticated proxy layer. This is option (a) from the review — authenticated Express routing, not per-bridge `verifyClient` callbacks — which keeps auth logic centralized in `auth.js` rather than scattered across bridge instances.

**Cookie parsing on the upgrade event:** The Express `upgrade` event receives a raw `http.IncomingMessage`. Standard Express middleware (including `cookie-parser`) does not run on upgrade events. The JWT must be extracted by manually parsing `req.headers.cookie`. `cookie-parser` is not in the dependency list — the agent should write a minimal inline parser:

```javascript
function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}
const token = parseCookies(req.headers.cookie).token;
```

This is ~5 lines, correct, and requires no dependency.

**The `Secure` cookie flag is conditional on deployment mode.** The `Secure` flag instructs browsers to transmit the cookie only over HTTPS. In TLS mode (network browser access with internal CA), `secure: true` must be set. In localhost/RDP mode, it must be omitted — the W3C Secure Contexts specification treats `localhost` as a secure context for JavaScript APIs, but `Secure` cookie transmission on `localhost` over plain HTTP is browser-specific: Chromium sends them, Firefox historically has not. Setting `secure: true` unconditionally in localhost mode will silently break sessions in Firefox. The correct pattern:

```javascript
res.cookie('token', jwt, {
  httpOnly: true,
  secure: config.tls === true,  // only in TLS mode
  sameSite: 'strict'
});
```

**Concurrent administrator sessions:** LambVNC does not enforce single-session exclusivity. JWT tokens are stateless — two valid tokens can coexist, meaning two administrators can be logged in and viewing the grid simultaneously. This is a deliberate choice: forcibly invalidating a previous session on new login would lock out an administrator whose session was interrupted, which is a worse failure mode in a campus monitoring context than two people briefly watching the same grid. The audit log correctly attributes each WebSocket connection to its originating session token, so concurrent sessions are independently traceable. If single-session enforcement is required for a specific deployment, it can be implemented by maintaining a server-side token revocation list in `data/`, but this is not the default.

**JWT secret management:** The JWT signing secret is a 64-byte random value generated at first run via `crypto.randomBytes(64)` and stored in `data/.secret`. It is never placed in `config.json` — configuration files are frequently committed to version control or shared, while `data/` is explicitly gitignored and treated as server-local state. A leaked `config.json` must not compromise all active sessions. `data/.secret` must have filesystem permissions restricted to the server process user.

### 6.2 VNC Password Encryption at Rest

VNC passwords stored in `profiles.json` are encrypted with **AES-256-GCM**. GCM mode was chosen specifically over CBC because it provides **Authenticated Encryption with Associated Data (AEAD)** — it guarantees both confidentiality and integrity. If stored ciphertext is tampered with, decryption fails with a cryptographic error rather than silently returning corrupted data.

**Critical implementation constraints:**

**IV uniqueness is absolute.** GCM's security model mathematically collapses if an Initialization Vector (IV) is ever reused with the same key. A single IV reuse allows an attacker to derive the authentication key and decrypt all data. Every encryption operation generates a fresh 12-byte IV via `crypto.randomBytes(12)`. The IV is stored alongside its ciphertext in the profile.

**Binary output must be base64-encoded before serialization.** This is the most common AES-GCM implementation failure in Node.js. The `cipher.getAuthTag()` method returns a raw binary Buffer. Concatenating it with standard JavaScript string operations implicitly calls `.toString()`, which defaults to UTF-8 encoding. Arbitrary cryptographic binary data will contain byte sequences that are not valid UTF-8. Node.js replaces these with the Unicode replacement character (U+FFFD), irrecoverably corrupting the authentication tag. The encrypted password becomes permanently unrecoverable.

The correct pattern:

```javascript
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
let encrypted = cipher.update(password, 'utf8', 'base64');
encrypted += cipher.final('base64');
const tag = cipher.getAuthTag(); // raw Buffer

// Store all three as base64 strings — never raw binary
profile.iv = iv.toString('base64');
profile.encrypted = encrypted;
profile.tag = tag.toString('base64');
```

### 6.3 Encryption Key Management

The AES-256-GCM key is a 32-byte random value generated at first run via `crypto.randomBytes(32)` and stored in `data/.key`. Like the JWT secret, it lives in `data/` — not `config.json` — and must have restricted filesystem permissions.

Two alternative approaches were considered and rejected:

**Deriving the key from the admin password (PBKDF2/scrypt):** Cryptographically sound, but creates a painful operational coupling — rotating the admin password requires decrypting and re-encrypting every stored VNC password. In a campus environment where password rotation may be policy-mandated, this is an unacceptable operational burden.

**Storing the key in `config.json`:** Conflates configuration (shareable, often version-controlled) with secrets (server-local, never shared). A single accidental `git push` of `config.json` compromises every stored VNC credential permanently.

The standalone `data/.key` approach is the correct middle ground: the key is independent of the admin password (no rotation coupling), stored separately from configuration (no accidental exposure), and its location and sensitivity are explicit and documentable.

**Consequence of key loss:** If `data/.key` is deleted or corrupted, all stored VNC passwords become permanently unrecoverable. Backup of `data/.key` alongside `data/profiles.json` is a first-run administrative responsibility and must be documented in the README.

**First-run operationalization:** When `index.js` detects that `data/.key` does not exist and generates it for the first time, it must emit a conspicuous startup log warning — not a comment in the README that administrators may never read:

```
⚠  LambVNC: Encryption key generated at data/.key
   This file is NOT backed up automatically.
   Loss of data/.key makes all stored VNC passwords permanently unrecoverable.
   Back up data/.key to a secure location now.
```

This warning fires once, on first run only. It is the correct lightweight mechanism — no CLI prompts, no wizard, just an unmissable log line at the moment the risk is created.

---

## 7. Project Structure

```
lambvnc/
│
├── server/
│   ├── index.js          ← entry point, Express bootstrap, route wiring
│   ├── auth.js           ← bcrypt login, JWT issuance, rate limiting
│   ├── tunnels.js        ← SSH tunnel lifecycle: connect, keepalive, reconnect FSM
│   ├── ports.js          ← port allocation registry, tunnel↔port mapping
│   ├── proxy.js          ← WS↔TCP bridge instances, localhost-bound
│   ├── profiles.js       ← read/write profiles.json with atomic backup
│   ├── crypto.js         ← AES-256-GCM encrypt/decrypt, IV management
│   ├── audit.js          ← SQLite WAL append and query
│   └── health.js         ← /health endpoint: tunnel status, active sessions, bridge ports
│
├── client/
│   ├── index.html        ← shell, grid layout
│   ├── grid.js           ← noVNC RFB instantiation, cell lifecycle
│   ├── detection.js      ← downscaled pixel diffing, 3-tier logic
│   ├── alerts.js         ← fade/snap/timer lifecycle, CSS transitions
│   ├── profiles-ui.js    ← save/load monitoring profiles, bulk controls
│   └── style.css         ← grid layout, cell states, alert tier colors
│
├── data/                 ← gitignored, server-local state
│   ├── .key              ← AES-256 encryption key (generated at first run)
│   ├── .secret           ← JWT signing secret (generated at first run)
│   ├── host.key          ← ssh2 server Ed25519 host key (generated at first run)
│   ├── admin.hash        ← bcrypt hash of admin password (set at first run)
│   ├── profiles.json     ← encrypted host and monitoring profiles
│   ├── profiles.json.bak ← previous profiles snapshot (written before every save)
│   └── audit.db          ← SQLite WAL audit log
│
├── config.json           ← server port, fade duration, session timeout
└── README.md
```

`tunnels.js` and `ports.js` are intentionally split. SSH tunnel lifecycle management — connecting, tracking keepalive state, handling `close` events, executing the reconnection state machine — has a natural complexity floor that will approach or exceed a naive line budget on its own. Port allocation (assigning and releasing localhost ports for each tunnel↔bridge pair) is a distinct, testable concern. Keeping them separate preserves the single-responsibility principle without artificially compressing complex logic.

**On the 150-line guideline:** The ~150 line cap per file is a guideline, not an enforced rule. The principle it encodes is single responsibility — one file, one concern. A file that exceeds 150 lines because its domain is genuinely complex (a reconnection FSM, a crypto module with multiple operations) is acceptable. A file that exceeds 150 lines because it is doing two things is not. `tunnels.js` is explicitly exempt from forced splitting for line count compliance: artificially amputating an FSM across files to satisfy a number makes the logic harder to follow, not easier. If `tunnels.js` reaches 180–200 lines with a clean, coherent reconnection state machine, that is correct. If it reaches 180 lines because tunnel management and port allocation have merged back together, that is a violation of the principle the guideline exists to protect.

### 7.1 Client Event Bus Contract

Client modules communicate via custom DOM events dispatched on a shared `window` event bus. No module calls another module's functions directly. Events are dispatched as `CustomEvent` instances — the payload in the table below maps to the `event.detail` property. Listeners must destructure from `event.detail`, not the event object directly:

```javascript
// Emitting
window.dispatchEvent(new CustomEvent('cell:change-detected', {
  detail: { cellId: 'lab-01', tier: 'high', pctChanged: 12.4 }
}));

// Listening
window.addEventListener('cell:change-detected', (event) => {
  const { cellId, tier, pctChanged } = event.detail; // ← always event.detail
});
```

The full contract:

| Event | Emitter | Listener | Payload |
|---|---|---|---|
| `cell:connected` | `grid.js` | `detection.js` | `{ cellId, canvas }` |
| `cell:disconnected` | `grid.js` | `detection.js`, `alerts.js` | `{ cellId }` |
| `cell:frame-updated` | `grid.js` | `detection.js` | `{ cellId }` |
| `cell:change-detected` | `detection.js` | `alerts.js` | `{ cellId, tier, pctChanged }` |
| `tunnel:status-changed` | `grid.js` | `alerts.js` | `{ cellId, status: 'connected'\|'reconnecting'\|'disconnected', attempt (optional, number) }` |
| `alert:mute` | `profiles-ui.js` | `alerts.js` | `{ cellId \| 'all' }` |
| `alert:set-tier` | `profiles-ui.js` | `detection.js`, `alerts.js` | `{ cellId \| 'all', tier }` |
| `profile:loaded` | `profiles-ui.js` | `grid.js`, `detection.js`, `alerts.js` | `{ profile }` |

`tunnel:status-changed` is the client-side reflection of the server's reconnection FSM (see §7.2). The server pushes tunnel state changes over a dedicated control WebSocket channel; `grid.js` receives them and dispatches this event. `alerts.js` listens to suppress or modify alert rendering while a cell is in `reconnecting` or `disconnected` state — a reconnecting cell should not fire change-detection alerts.

This table is the integration contract. Any change to event names, emitters, or payload shape is a breaking change and must be reflected here before the code is modified.

### 7.2 Tunnel Reconnection Strategy

SSH tunnels will drop. This is expected behavior, not an error condition — keepalives mitigate it but do not eliminate it. The reconnection lifecycle is:

1. The embedded ssh2 SSH server fires a session `close` event when the sender's connection drops
2. `tunnels.js` immediately sets the cell state to `reconnecting` and notifies the client via the server's WebSocket channel
3. The client `grid.js` renders the cell in a `reconnecting` visual state (dimmed, spinner overlay)
4. `tunnels.js` waits 5 seconds then waits for the sender to re-establish its reverse tunnel (the sender's startup task will reconnect automatically)
5. On reconnect: cell returns to live state, noVNC RFB reconnects automatically
6. If no reconnection within 3 × 5-second intervals: cell state becomes `disconnected` — requires manual reconnect trigger from the administrator

The 5-second backoff and 3-retry limit are configurable in `config.json`. Silent infinite retry loops are explicitly avoided — a permanently dead cell that appears alive is more dangerous in a monitoring context than a cell that honestly reports its disconnected state.

---

## 8. Frontend Rendering

### 8.1 noVNC and the RFB Object Model

LambVNC's grid is built on **noVNC** — a mature, MIT-licensed JavaScript VNC client that exposes a single `RFB` object per connection. Each RFB instance manages its own WebSocket connection, handles RFB protocol negotiation, decodes incoming pixel data, and renders to an assigned HTML5 Canvas element. At 12 sessions, 12 RFB instances run simultaneously.

### 8.2 Canvas Context Management

Browsers enforce a hard limit on simultaneous active canvas contexts, typically 8–20 depending on the engine and hardware. At 12 sessions this limit is approached. LambVNC uses **viewport virtualization** as a defensive measure: cells scrolled out of the viewport have their canvas dimensions zeroed (`canvas.width = 0; canvas.height = 0`), which releases the GPU framebuffer allocation and reduces context pressure. The underlying WebSocket connection and noVNC RFB instance remain live — the cell resumes rendering immediately on scroll-back by restoring the original canvas dimensions. This preserves connection continuity while minimizing context overhead on constrained displays.

**When does this actually trigger?** The primary grid layout targets fitting all 12 cells simultaneously on a standard 1080p or larger display — 4×3 is the default arrangement. On that layout, viewport virtualization never fires during normal use; all cells are visible at once. It becomes relevant in two scenarios: a monitor running at lower resolution (laptop screen, small tablet) where the grid scrolls, or a monitor who has zoomed into fewer cells and scrolled to see others. Viewport virtualization is therefore defensive infrastructure — it prevents canvas context exhaustion on constrained displays rather than being a routine part of the rendering pipeline on a standard monitoring station.

### 8.3 Encoding

LambVNC negotiates **tightPNG encoding** with TightVNC Server. This shifts decompression work from JavaScript into the browser's native C++ image decoding pipeline — the browser simply blits decoded image data to canvas rather than executing pixel mathematics in the JS engine. At 12 simultaneous streams this is a meaningful CPU saving.

---

## 9. Visual Change Detection

### 9.1 The Algorithm

LambVNC implements client-side change detection without external libraries. On each noVNC frame update event:

1. The full-resolution VNC canvas is downscaled to a **64×64 pixel off-screen canvas** via `drawImage`
2. The pixel data is extracted and converted to grayscale: `(R + G + B) / 3`
3. The grayscale matrix is compared against the previous frame's matrix
4. If the percentage of pixels exceeding a per-tier color distance threshold breaches the area threshold, an alert fires

Downscaling to 64×64 reduces the comparison matrix from ~2 million pixels (1080p) to 4,096 — a 500x reduction in work. Grayscale conversion further reduces processing by 4x. The entire operation runs on the main thread without Web Workers — at 12 sessions the CPU cost is negligible.

Thresholding on both **area** (percentage of changed pixels) and **distance** (magnitude of change per pixel) provides two independent dials that distinguish meaningful activity from cursor movement, compression artifacts, and ambient noise.

### 9.2 The Three Tiers

| Tier | Area Threshold | Distance Threshold | Color | Typical Trigger |
|---|---|---|---|---|
| Low | 15% | 30 | Blue | Window movement, large UI changes |
| Medium | 10% | 20 | Orange | Moderate activity, text entry |
| High | 5% | 10 | Red | Any detectable change |

Tier assignment is per-host and persists in the session profile. A machine set to High alerts on a mouse hovering over a menu. A machine set to Low alerts only on dramatic screen changes.

### 9.3 Alert Lifecycle

- **Trigger:** cell border snaps instantly to full opacity in the tier's color
- **Timer:** a 15-second countdown begins (configurable globally)
- **Fade:** if fading is enabled for that tier, border opacity transitions from 1.0 to 0.0 over the fade duration via CSS transition
- **Retrigger:** if another change is detected while fading, opacity snaps back to 1.0 instantly and the timer resets
- **Mute:** per-cell or global mute suppresses all alert rendering without disconnecting the change detection logic

Fade enable/disable is per-tier, not global — a common configuration is High tier always-on (no fade) while Low and Medium fade out after 15 seconds.

---

## 10. Data Persistence

### 10.1 Host and Monitoring Profiles — JSON

`data/profiles.json` stores host configurations (IP, port, encrypted VNC password, alert tier, fade setting) and named monitoring profiles (saved groupings of hosts with their full alert configuration). Read operations are frequent (on dashboard load and profile switch). Write operations are rare (only when an administrator adds, removes, or modifies a host or profile). JSON is appropriate for this access pattern.

Every write to `profiles.json` first copies the current file to `profiles.json.bak`. A power failure or crash mid-write produces a corrupt `profiles.json` — the backup ensures recovery is always possible. Without this, a single interrupted save destroys all host configurations permanently.

### 10.2 Audit Log — SQLite WAL

`data/audit.db` records every monitoring session event: administrator login, which hosts were connected to, connection timestamps, and disconnection timestamps.

JSON was rejected for the audit log for a specific and serious reason. Appending to a JSON array file requires: read the entire file → parse → push → stringify → overwrite. Under Node.js's asynchronous event loop, concurrent audit events overlap their read/write cycles, producing race conditions that corrupt the JSON structure entirely, rendering the entire historical log unreadable. File locking in Node.js is unreliable by default.

SQLite in **Write-Ahead Logging (WAL) mode** eliminates the JSON corruption problem. WAL provides full ACID compliance — each audit write is an atomic, durable transaction. It is a single local file, as simple to back up as JSON, but with transactional integrity guarantees JSON cannot provide.

**An important implementation tradeoff:** `better-sqlite3` — the Node.js SQLite binding used by LambVNC — is **synchronous**. It blocks the Node.js event loop during writes. This is the correct choice at LambVNC's scale: audit events are infrequent (a handful of writes per monitoring session), write operations are fast (microseconds for a single row append), and the synchronous model is simpler and less error-prone than async alternatives. The synchronous nature of `better-sqlite3` does not introduce the race conditions of JSON file I/O — SQLite's atomic transactions prevent that regardless — but it does mean audit writes occupy the event loop momentarily. At 12 monitored sessions with sparse audit events, this is imperceptible. If LambVNC were ever scaled to hundreds of concurrent sessions with high-frequency logging, this tradeoff would need revisiting. At current scope, synchronous SQLite is the right tool.

---

## 11. Deployment Models

### 11.1 RDP to Monitoring Station (Recommended)

The LambVNC server and browser run on the same dedicated Windows machine. Administrators RDP into this machine to access the grid. No TLS configuration required — localhost connections are unconditionally trusted by all browsers. SSH tunnel encryption protects all sender → server traffic.

### 11.2 Network Browser Access

The LambVNC server runs on a dedicated machine accessible over the LAN. Monitoring devices connect via browser from any platform. Requires TLS with an internal CA (see §5.3). Enables monitoring from any device including tablets.

### 11.3 Sender Setup

Each monitored Windows machine requires:
1. TightVNC Server installed and running as a Windows service on port 5900
2. OpenSSH Client enabled (built into Windows 10/11, Settings → Optional Features)
3. A startup task executing the reverse SSH tunnel command to the LambVNC server

The startup task can be deployed via Group Policy in Active Directory environments, requiring zero manual configuration per machine after initial policy application.

---

## 12. What Was Deliberately Left Out

**Audio.** The RFB protocol carries no audio. Adding audio would require a parallel WebRTC stream per sender — a separate, complex, and largely orthogonal problem. Out of scope.

**Remote control from mobile.** noVNC supports mouse/keyboard passthrough in fullscreen mode on desktop browsers. Touch-to-mouse mapping on Android is functional but awkward — dragging and right-click gestures are unreliable. LambVNC makes no attempt to improve this. The primary use case is monitoring, not control.

**Clipboard sync.** Browser security restrictions make cross-origin clipboard synchronization unreliable and inconsistent across browsers. Not implemented.

**More than 12 sessions.** See Section 2.1. This is a design constraint, not a bug.

---

## 13. Dependency Philosophy

LambVNC uses the minimum viable set of dependencies. Every dependency is a liability — a maintenance burden, a potential vulnerability surface, a future incompatibility. The dependency list reflects this:

**Server:**
- `express` — HTTP server and routing
- `express-rate-limit` — authentication endpoint rate limiting
- `ssh2` — embedded SSH server and tunnel management
- `bcryptjs` — password hashing
- `jsonwebtoken` — session tokens
- `better-sqlite3` — SQLite WAL audit log
- `ws` — WebSocket server and WS↔TCP bridge
- `read` — hidden terminal input for first-run password prompt

**Dev / build:**
- `novnc` — VNC client library (vendored to `client/vendor/` via `scripts/vendor.js`)

**System:**
- `OpenSSH` — built into Windows 10/11, no install required
- `TightVNC Server` — installed on sender machines

No Python runtime. No frontend framework. No build pipeline. No transpilation. The client is vanilla JavaScript that runs directly in any modern browser. A contributor needs to understand JavaScript, not a framework.

---

## 14. Security Threat Model

| Threat | Mitigation |
|---|---|
| Screen content interception on LAN | SSH tunnel encrypts all sender → server traffic |
| Unauthorized dashboard access | bcrypt login + JWT session tokens + rate limiting |
| VNC password extraction from server filesystem | AES-256-GCM encryption at rest |
| JWT/encryption key extraction | Keys in `data/` (gitignored), restricted filesystem permissions |
| Direct WebSocket connection bypassing auth | WS↔TCP bridge bound to 127.0.0.1 only |
| Silent WebSocket blocking by browser CSP | Explicit `connect-src` header set by Express |
| Session hijacking | HTTP-only cookies, conditional `Secure` flag, JWT expiration |
| Audit log tampering or corruption | SQLite WAL ACID compliance, append-only schema |
| Brute force login | bcrypt cost factor 12 + express-rate-limit (10 attempts / 15 min) |
| Timing attacks on login | `crypto.timingSafeEqual` comparison |
| Profile data loss on interrupted write | `profiles.json.bak` written before every save |
| Encryption key loss | Conspicuous first-run log warning, README backup instructions |
| Unauthorized access attribution | Full audit log: who, which machine, when |

**Out of scope:** Physical access to the LambVNC server machine. Compromise of the server OS. Malicious insider with server filesystem access and the encryption key. These threats require physical security and OS-level controls outside LambVNC's remit.

---

## 15. Configuration Schema

`config.json` is loaded at startup by `index.js` and validated immediately before any server initialization proceeds. The principle is: **fail loud at startup, never fail silently at runtime.** If a required field is missing or invalid, the server prints a clear error identifying the field and exits with a non-zero code. Optional fields fall back to the defaults listed below.

The complete schema:

| Field | Type | Required | Default | Valid Range / Notes |
|---|---|---|---|---|
| `serverPort` | integer | no | `3000` | 1024–65535. Port Express listens on for dashboard and WebSocket upgrades |
| `sshPort` | integer | no | `2222` | 1024–65535. Port the embedded ssh2 SSH server listens on for incoming sender tunnels |
| `basePort` | integer | no | `5910` | 1024–65535. First port in the sequential range allocated for WS↔TCP bridges. Must not overlap with `serverPort` or `sshPort` |
| `tls` | boolean | no | `false` | `true` enables HTTPS/WSS mode. Requires `tlsCert` and `tlsKey` |
| `tlsCert` | string | if `tls: true` | — | Absolute path to PEM certificate file |
| `tlsKey` | string | if `tls: true` | — | Absolute path to PEM private key file |
| `sessionTtl` | integer | no | `28800` | Seconds. JWT expiration horizon. Default is 8 hours |
| `fadeDuration` | integer | no | `15` | 1–300. Seconds for alert border fade animation. Applied to all tiers that have fading enabled |
| `reconnectInterval` | integer | no | `5` | 1–60. Seconds between tunnel reconnection attempts |
| `reconnectRetries` | integer | no | `3` | 1–10. Maximum reconnection attempts before a cell is marked `disconnected` |
| `maxHosts` | integer | no | `12` | 1–12. Hard cap on simultaneous monitored sessions. Cannot exceed 12 |
| `rateLimitWindow` | integer | no | `900` | Seconds. Auth rate limit window. Default is 15 minutes |
| `rateLimitMax` | integer | no | `10` | Maximum login attempts per window per IP |
| `auditRetentionDays` | integer | no | `90` | 1–3650. Audit log entries older than this are pruned on startup |

**Validation implementation:** Schema validation is written in vanilla JavaScript — no `zod`, `joi`, or similar library. The agent should write explicit type and range checks for every field:

```javascript
if (typeof config.sshPort !== 'number' || config.sshPort < 1024 || config.sshPort > 65535)
  throw new Error('config.sshPort must be an integer between 1024 and 65535');
```

This is the intended pattern. Explicit per-field validation is more transparent than a schema library for a fixed, small config object, and consistent with the minimalist dependency philosophy.

Example `config.json`:
```json
{
  "serverPort": 3000,
  "sshPort": 2222,
  "basePort": 5910,
  "tls": false,
  "sessionTtl": 28800,
  "fadeDuration": 15,
  "reconnectInterval": 5,
  "reconnectRetries": 3,
  "maxHosts": 12,
  "rateLimitWindow": 900,
  "rateLimitMax": 10,
  "auditRetentionDays": 90
}
```

---

## 16. Health Endpoint

`server/health.js` exposes a `GET /health` endpoint returning a JSON snapshot of server state:

```json
{
  "status": "ok",
  "uptime": 3600,
  "tunnels": [
    { "hostId": "lab-01", "state": "connected", "bridgePort": 5910, "since": 1709500000 },
    { "hostId": "lab-02", "state": "reconnecting", "attempt": 2, "bridgePort": 5911, "since": null }
  ],
  "activeSessions": 1,
  "auditLogSize": 1048
}
```

The `/health` endpoint requires authentication — it exposes internal state that reveals which machines are being monitored and their connection status. An unauthenticated health endpoint would leak the topology of the monitoring setup to anyone on the LAN who discovers the port.

For campus IT monitoring integration (Nagios, Zabbix, Prometheus exporters), this endpoint is the correct integration point. It is intentionally minimal — enough for operational monitoring, not a full management API.

---

## 17. Data Shapes

### 17.1 profiles.json Structure

`profiles.json` has two top-level keys: `hosts` (a map of host configurations keyed by hostId) and `monitoringProfiles` (named groupings that reference host IDs, not embed full host configs). This separation means editing a host's alert tier in one place updates every monitoring profile that includes it.

```json
{
  "hosts": {
    "lab-01": {
      "label": "Lab Machine 01",
      "ip": "192.168.1.101",
      "vncPort": 5900,
      "encryptedPassword": "<base64 ciphertext>",
      "passwordIv": "<base64 IV>",
      "passwordTag": "<base64 auth tag>",
      "sshPublicKey": "ssh-rsa AAAA... user@lab-01",
      "tunnelPort": 5910,
      "alertTier": "medium",
      "fadeEnabled": true
    },
    "lab-02": {
      "label": "Lab Machine 02",
      "ip": "192.168.1.102",
      "vncPort": 5900,
      "encryptedPassword": "<base64 ciphertext>",
      "passwordIv": "<base64 IV>",
      "passwordTag": "<base64 auth tag>",
      "sshPublicKey": "ssh-rsa AAAA... user@lab-02",
      "tunnelPort": 5911,
      "alertTier": "high",
      "fadeEnabled": false
    }
  },
  "monitoringProfiles": {
    "morning-session": {
      "label": "Morning Session",
      "hostIds": ["lab-01", "lab-02"],
      "globalMute": false
    },
    "exam-watch": {
      "label": "Exam Watch",
      "hostIds": ["lab-01", "lab-02"],
      "globalMute": false
    }
  }
}
```

**Field notes:**
- `hostId` keys (e.g., `"lab-01"`) are the canonical identifier used throughout the system — in the event bus, audit log, tunnel registry, and health endpoint
- `sshPublicKey` is a standard OpenSSH authorized_keys format string (`ssh-rsa AAAA...` or `ssh-ed25519 AAAA...`). Ed25519 is preferred for new keys
- `tunnelPort` is assigned by `ports.js` at host creation and must not be changed after a sender has been configured — changing it requires reconfiguring the sender's startup task
- `alertTier` values: `"low"`, `"medium"`, `"high"`, or `"none"` (detection disabled)
- A monitoring profile stores `hostIds` references only — it does not duplicate host config. Alert tiers and fade settings are host-level, not profile-level

### 17.2 Audit Log SQLite Schema

```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT    NOT NULL,          -- SHA-256 of the JWT (never store the token itself)
  ip          TEXT    NOT NULL,
  logged_in   INTEGER NOT NULL,          -- Unix timestamp
  logged_out  INTEGER                    -- NULL until session ends
);

CREATE TABLE connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  host_id     TEXT    NOT NULL,
  connected   INTEGER NOT NULL,          -- Unix timestamp
  disconnected INTEGER                   -- NULL until cell closes
);

CREATE INDEX idx_connections_session ON connections(session_id);
CREATE INDEX idx_connections_host    ON connections(host_id);
```

WAL mode is enabled at startup: `PRAGMA journal_mode=WAL`. Both tables use Unix timestamps (integers) rather than ISO strings — simpler to query ranges, no timezone ambiguity.

`token_hash` stores a SHA-256 digest of the JWT rather than the token itself. This allows session attribution in the audit log without storing a credential that could be replayed if the database were accessed.

---

## 18. Express Route Surface

Complete route table. All routes except `GET /login` (page) and `POST /login` (action) require a valid JWT cookie. WebSocket upgrade paths are handled via the Express `upgrade` event, not standard route handlers.

| Method | Path | Auth | Handler | Description |
|---|---|---|---|---|
| `GET` | `/` | yes | `index.js` | Serve `client/index.html` |
| `GET` | `/client/*` | yes | `index.js` | Serve static client assets (JS, CSS, noVNC vendor) |
| `GET` | `/login` | no | `auth.js` | Serve login page |
| `POST` | `/login` | no | `auth.js` | Validate credentials, issue JWT cookie |
| `POST` | `/logout` | yes | `auth.js` | Clear JWT cookie |
| `GET` | `/api/hosts` | yes | `profiles.js` | List all hosts with status |
| `POST` | `/api/hosts` | yes | `profiles.js` | Add new host |
| `PUT` | `/api/hosts/:hostId` | yes | `profiles.js` | Update host config |
| `DELETE` | `/api/hosts/:hostId` | yes | `profiles.js` | Remove host |
| `GET` | `/api/profiles` | yes | `profiles.js` | List all monitoring profiles |
| `POST` | `/api/profiles` | yes | `profiles.js` | Create monitoring profile |
| `PUT` | `/api/profiles/:profileId` | yes | `profiles.js` | Update monitoring profile |
| `DELETE` | `/api/profiles/:profileId` | yes | `profiles.js` | Delete monitoring profile |
| `GET` | `/health` | yes | `health.js` | Server state snapshot |
| `WS` | `/ws/:hostId` | yes (on upgrade) | `proxy.js` | WebSocket upgrade → WS↔TCP bridge for `hostId` |
| `WS` | `/control` | yes (on upgrade) | `tunnels.js` | Control channel: server pushes `tunnel:status-changed` events to client |

The `/control` WebSocket is a single persistent connection per browser session, used exclusively for server-to-client push of tunnel state changes. It is not used for VNC data.

---

## 19. First-Run Bootstrap

Three things must happen on first run that never happen again. They are handled sequentially in `index.js` before the server starts:

**1. Generate secrets and keys:**
```
data/.key     — 32 random bytes, AES-256 encryption key
data/.secret  — 64 random bytes, JWT signing secret
data/host.key — SSH host key for the embedded ssh2 server (Ed25519)
```
All three emit conspicuous log warnings on generation (see §6.3 pattern). `data/host.key` contains the PEM-encoded Ed25519 private key used by the ssh2 SSH server to identify itself to connecting senders. If this key changes, all senders will get a host key mismatch warning — operationally equivalent to an SSH server reinstall. Back it up alongside `data/.key`.

**2. Set admin password:**
On first run, if no admin password hash exists in `data/admin.hash`, the server prompts interactively using the `read` package (a single-purpose, zero-transitive-dependency library for hidden terminal input):
```
LambVNC first run — set administrator password:
Password: 
Confirm:  
✓ Password set. Starting server...
```
The bcrypt hash is written to `data/admin.hash`. The server does not start until a password is set. There is no default password and no environment variable override — an unprotected default is worse than the friction of a first-run prompt.

**Why `read` rather than raw Node.js TTY:** Node's native `readline` module does not support hidden input. Implementing it correctly requires `process.stdin.setRawMode(true)` with manual character-by-character masking and terminal state restoration on interrupt — approximately 60 lines of error-prone TTY code. `read` is 50 lines itself, has no transitive dependencies, and is the one place in LambVNC where the minimalist dependency philosophy yields to implementation correctness. Writing raw TTY manipulation for a one-time prompt is not a worthwhile trade.

**3. Initialize data files:**
`data/profiles.json` is created with empty `hosts` and `monitoringProfiles` objects if it does not exist. `data/audit.db` is created with the schema from §17.2 if it does not exist. WAL mode is enabled.

---

## 20. noVNC Vendoring

noVNC is declared as an npm devDependency. After `npm install`, a dedicated Node.js script `scripts/vendor.js` copies the noVNC `core/` directory and `vendor/` subdirectory from `node_modules/novnc/` into `client/vendor/novnc/` using `fs.cpSync()`:

```javascript
// scripts/vendor.js — runs via "postinstall" in package.json
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', '@novnc', 'novnc');
const dst = path.join(__dirname, '..', 'client', 'vendor', 'novnc');
fs.cpSync(path.join(src, 'core'),   path.join(dst, 'core'),   { recursive: true });
fs.cpSync(path.join(src, 'vendor'), path.join(dst, 'vendor'), { recursive: true });
console.log('noVNC vendored to client/vendor/novnc/');
```

`package.json` invokes it as:
```json
"scripts": {
  "postinstall": "node scripts/vendor.js"
}
```

**Why a dedicated script rather than a shell command:** `cp -r` is not a native Windows CMD or PowerShell command. A shell command in `postinstall` would fail silently on the target OS. `fs.cpSync()` has been stable since Node 16.7 and works identically on Windows, macOS, and Linux. No additional dependency is needed.

`grid.js` imports from the vendored path:
```javascript
import RFB from '/client/vendor/novnc/core/rfb.js';
```

The vendored copy is committed to the repository so the project has no runtime npm dependency — `npm install` is a development-time operation only. The vendored path is explicit and stable.

---

## 21. Name

**LambVNC.** The shepherd watches the flock. The lambs are inherently vulnerable — they are being observed, their screens are exposed to the monitor. The shepherd's role is protective, not predatory. In a campus context, this framing matters: this is a welfare and security tool, not a surveillance apparatus. The name reflects the covenant of care that should govern its use.

---

*This document should be updated whenever a consequential architectural decision changes. Code that contradicts this document is either a bug or evidence that this document is out of date. Resolve the discrepancy — do not let them diverge silently.*
