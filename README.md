# LambVNC

Browser-based VNC monitoring dashboard for campus LANs. Watch up to 12 remote Windows machines simultaneously in a live, auto-scaling grid.

```
[ Sender 1 ] ──SSH Tunnel──┐
[ Sender 2 ] ──SSH Tunnel──┤
       ...                  ├──► [ LambVNC Server ]──WS──► [ Monitor Browser ]
[ Sender N ] ──SSH Tunnel──┘
    (TightVNC on :5900)          (Node.js + Express)        (noVNC Grid UI)
```

## Features

- **Agentless** — senders need only TightVNC Server + Windows built-in OpenSSH
- **Browser-based grid** — noVNC-powered 4×3 grid, accessible via any modern browser or RDP
- **Visual change detection** — three-tier pixel diffing (low/medium/high) with configurable alerts and fade timers
- **Encrypted at rest** — VNC passwords stored with AES-256-GCM, admin login hashed with bcrypt
- **Tamper-evident audit log** — SQLite WAL recording who watched whom and when
- **Embedded SSH server** — `ssh2`-powered, no OS-level `sshd` required on the monitoring station
- **Zero build pipeline** — vanilla JavaScript client, no framework, no transpilation

---

## Quick Start

### Prerequisites

| Component | Where | Notes |
|---|---|---|
| **Node.js 20+** | Monitoring station | 22 LTS recommended |
| **TightVNC Server** | Each sender machine | Listening on port 5900 |
| **OpenSSH Client** | Each sender machine | Built into Windows 10/11 (Settings → Optional Features) |

### Install

```bash
git clone https://github.com/your-org/lambvnc.git
cd lambvnc
npm install
```

`npm install` automatically vendors the noVNC client library into `client/vendor/novnc/`.

### First Run

```bash
npm start
```

On first run, the server will:

1. **Generate cryptographic keys** — `data/.key` (AES-256), `data/.secret` (JWT), `data/host.key` (SSH Ed25519)
2. **Prompt for an admin password** — hashed with bcrypt and stored in `data/admin.hash`
3. **Create data files** — `data/profiles.json` and `data/audit.db`

> [!IMPORTANT]
> **Back up `data/.key`, `data/.secret`, and `data/host.key` immediately.**
> Loss of `.key` makes all stored VNC passwords permanently unrecoverable.
> Changing `host.key` triggers SSH host key mismatch warnings on every sender.

### Open the Dashboard

Navigate to `http://localhost:3000` and log in with the password you set.

---

## Sender Setup

Each monitored Windows machine needs a one-time configuration:

1. **Install TightVNC Server** — configure to listen on port 5900
2. **Enable OpenSSH Client** — Settings → Apps → Optional Features → OpenSSH Client
3. **Generate an SSH key pair** on the sender:
   ```powershell
   ssh-keygen -t ed25519 -f C:\Users\<user>\.ssh\lambvnc_key -N ""
   ```
4. **Register the sender** in the LambVNC dashboard — paste the public key (`lambvnc_key.pub`) when adding the host
5. **Create a startup task** that runs on boot:
   ```bash
   ssh -i C:\Users\<user>\.ssh\lambvnc_key -N -R 127.0.0.1:<tunnelPort>:127.0.0.1:5900 sender@<lambvnc-server> -p 2222 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new
   ```

> [!WARNING]
> Always use `127.0.0.1` explicitly in the `-R` flag — never `localhost`.
> Windows OpenSSH may bind to IPv6 loopback (`[::1]`) when `localhost` is used, silently breaking the tunnel.

The `<tunnelPort>` is assigned by LambVNC when you add the host (visible in the dashboard or via `GET /api/hosts`). The startup task can be deployed via Group Policy for zero-touch provisioning.

---

## Configuration

Edit `config.json` in the project root. All fields are optional with sensible defaults:

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

| Field | Default | Description |
|---|---|---|
| `serverPort` | `3000` | Dashboard HTTP/WS port (1024–65535) |
| `sshPort` | `2222` | Embedded SSH server port for sender tunnels (1024–65535) |
| `basePort` | `5910` | First port in the sequential bridge range (1024–65535) |
| `tls` | `false` | Enable HTTPS/WSS. Requires `tlsCert` and `tlsKey` |
| `tlsCert` | — | Absolute path to PEM certificate (required if `tls: true`) |
| `tlsKey` | — | Absolute path to PEM private key (required if `tls: true`) |
| `sessionTtl` | `28800` | JWT session lifetime in seconds (8 hours) |
| `fadeDuration` | `15` | Alert border fade duration in seconds (1–300) |
| `reconnectInterval` | `5` | Seconds between tunnel reconnection attempts (1–60) |
| `reconnectRetries` | `3` | Max retries before cell shows "disconnected" (1–10) |
| `maxHosts` | `12` | Maximum monitored sessions (hard cap: 12) |
| `rateLimitWindow` | `900` | Login rate limit window in seconds (15 min) |
| `rateLimitMax` | `10` | Max login attempts per window per IP |
| `auditRetentionDays` | `90` | Audit log entries older than this are pruned on startup |

Invalid configuration causes the server to **exit immediately with a clear error** — it will never start with bad config.

---

## Deployment Models

### Localhost via RDP (Recommended)

Run the server and browser on the same dedicated Windows machine. Administrators access the grid via RDP. No TLS needed — browsers treat `localhost` as a secure context. SSH tunnels encrypt all sender↔server traffic. RDP encrypts the administrator's session.

### Network Browser Access

Serve the dashboard over the LAN for access from any device. Requires TLS with a trusted certificate — typically an internal CA deployed via Group Policy or MDM. Set `tls: true` with `tlsCert` and `tlsKey` in `config.json`.

---

## Change Detection

LambVNC detects visual changes on monitored screens using client-side pixel diffing:

1. Each VNC canvas is downscaled to 64×64 grayscale (500× reduction from 1080p)
2. Pixel-by-pixel comparison against the previous frame
3. If the percentage of changed pixels exceeds a threshold, an alert fires

### Tiers

| Tier | Area | Distance | Color | Typical trigger |
|---|---|---|---|---|
| **High** | 5% | 10 | 🔴 Red | Any detectable change |
| **Medium** | 10% | 20 | 🟠 Orange | Moderate activity |
| **Low** | 15% | 30 | 🔵 Blue | Large UI changes |

Alerts snap the cell border to full opacity, then fade over `fadeDuration` seconds (configurable). Retriggering resets the timer. Per-cell or global mute is available.

---

## API

All endpoints except login require a valid JWT cookie.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `GET` | `/login` | Login page |
| `POST` | `/login` | Authenticate (returns JWT cookie) |
| `POST` | `/logout` | Clear session |
| `GET` | `/api/hosts` | List hosts with tunnel status |
| `POST` | `/api/hosts` | Add host |
| `PUT` | `/api/hosts/:id` | Update host |
| `DELETE` | `/api/hosts/:id` | Remove host |
| `GET` | `/api/profiles` | List monitoring profiles |
| `POST` | `/api/profiles` | Create profile |
| `PUT` | `/api/profiles/:id` | Update profile |
| `DELETE` | `/api/profiles/:id` | Delete profile |
| `GET` | `/health` | Server state (tunnels, sessions, uptime) |
| `WS` | `/ws/:hostId` | VNC WebSocket bridge |
| `WS` | `/control` | Tunnel status push channel |

---

## Project Structure

```
lambvnc/
├── server/
│   ├── index.js        Entry point, Express, route wiring
│   ├── auth.js         bcrypt login, JWT, rate limiting
│   ├── tunnels.js      Embedded SSH server, tunnel lifecycle
│   ├── ports.js        Port allocation registry
│   ├── proxy.js        WS↔TCP bridge (localhost-bound)
│   ├── profiles.js     Read/write profiles.json with backup
│   ├── crypto.js       AES-256-GCM encrypt/decrypt
│   ├── audit.js        SQLite WAL audit log
│   └── health.js       /health endpoint
├── client/
│   ├── index.html      Dashboard shell
│   ├── grid.js         noVNC RFB instances, cell lifecycle
│   ├── detection.js    Pixel diffing, 3-tier logic
│   ├── alerts.js       Alert fade/snap/timer lifecycle
│   ├── profiles-ui.js  Profile management UI
│   └── style.css       Grid layout, alert styles
├── data/               Gitignored server-local state
│   ├── .key            AES-256 encryption key
│   ├── .secret         JWT signing secret
│   ├── host.key        SSH host key (Ed25519)
│   ├── admin.hash      bcrypt admin password hash
│   ├── profiles.json   Host and monitoring profiles
│   └── audit.db        SQLite audit log
└── config.json         Server configuration
```

---

## Security

| Threat | Mitigation |
|---|---|
| Screen content interception | SSH tunnel encrypts all sender→server traffic |
| Unauthorized dashboard access | bcrypt + JWT + rate limiting |
| VNC password extraction | AES-256-GCM encryption at rest |
| Key leakage | Keys in `data/` (gitignored), not in config |
| Direct WS bypass | Bridges bound to `127.0.0.1` only |
| Session hijacking | HTTP-only cookies, JWT expiration |
| Audit tampering | SQLite WAL ACID compliance |
| Brute force | bcrypt cost 12 + 10 attempts / 15 min |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full threat model and design rationale.

---

## Testing

```bash
node --test test.js
```

The test suite covers 13 suites / 51 tests including:
- AES-256-GCM encrypt/decrypt correctness
- Network binding (bridges are localhost-only)
- WebSocket upgrade authentication gating
- bcrypt login + rate limiting
- CSP headers
- Profile backup-on-write
- Audit log schema and concurrency
- Config validation (fail loud)
- Route auth surface
- Host CRUD → health reflection
- Port collision detection
- **SSH sender authentication** (end-to-end key verification)
- Event bus contract

---

## License

MIT
