# LambVNC — Manual Browser Testing Protocol

This document covers the browser-side functionality that the automated test suite
(`node --test test.js`) cannot reach: visual change detection, alert lifecycle,
viewport virtualization, VNC stream integrity, and the tunnel reconnection UI.

Each test specifies the exact setup, precise steps, and an unambiguous pass/fail
criterion observable without DevTools unless DevTools is explicitly required.

**Prerequisite for all tests:** the server is running, at least one TightVNC sender
is connected and active, and you are logged in to the dashboard. Tests that require
specific conditions note them under **Setup**.

**Browser under test:** Chromium-based browser (Chrome, Edge) unless a test
specifies Firefox. Run Firefox variants of any test marked [CROSS-BROWSER].

---

## 1. Visual Change Detection

These tests validate `detection.js` — the 64×64 downscale, grayscale comparison,
and three-tier threshold logic.

---

### T-DET-01 — High tier fires on any detectable change

**Setup:** One connected sender. Set that cell's alert tier to **High** via the
tier dropdown in the sidebar.

**Steps:**
1. Wait for the cell to show a live VNC frame (no spinner).
2. On the sender machine, move the mouse slowly across the screen.

**Pass:** The cell border snaps to **red** within one frame cycle of the mouse
movement. Movement of any visible portion of the cursor triggers the alert.

**Fail:** No border appears despite clear mouse movement. Indicates the
`cell:frame-updated` event is not firing or `detection.js` is not receiving it.

---

### T-DET-02 — Low tier ignores cursor movement, fires on major change

**Setup:** Same cell, tier set to **Low** (area threshold: 15%, distance: 30).

**Steps:**
1. Move the mouse slowly across the sender screen. Observe the cell for 10 seconds.
2. Open a large application window (e.g., File Explorer fullscreen) on the sender.

**Pass — Step 1:** No alert fires during cursor movement alone.
**Pass — Step 2:** Red/blue border fires when the large window appears.

**Fail — Step 1:** Alert fires on cursor movement at Low tier. Indicates either
the area threshold is not being applied or tier params are wired incorrectly.

**Fail — Step 2:** No alert fires on a fullscreen window open. Indicates the
distance or area threshold is too high, or grayscale conversion is broken.

---

### T-DET-03 — Tier: None suppresses all alerts

**Setup:** Cell tier set to **None**.

**Steps:**
1. On the sender, open and close multiple applications, move windows, type rapidly.
2. Observe the cell for 30 seconds of active sender activity.

**Pass:** No alert border appears at any point.

**Fail:** Any border appears. `detection.js` tier `none` uses `{ area: 100, distance: 255 }` —
a 100% area threshold that should never trigger under normal activity.

---

### T-DET-04 — Per-cell tier isolation

**Setup:** Two connected senders. Cell A set to **High**, Cell B set to **None**.

**Steps:**
1. Move the mouse on Sender A's machine.
2. Open a fullscreen window on Sender B's machine.

**Pass:** Cell A border fires on mouse movement. Cell B shows no border despite
significant screen change on its sender.

**Fail — Cell B fires:** Tier state is shared across cells rather than per-cell.
Indicates the `contexts` Map in `detection.js` is not keyed by `cellId`, or
`alert:set-tier` with `cellId: 'all'` was accidentally triggered.

---

### T-DET-05 — Tier change takes effect immediately, mid-session [DevTools]

**Setup:** One connected sender. Open DevTools Console.

**Steps:**
1. Set the cell tier to **None** via the sidebar dropdown.
2. In DevTools Console, dispatch:
   ```javascript
   window.dispatchEvent(new CustomEvent('alert:set-tier',
     { detail: { cellId: '<your-hostId>', tier: 'high' } }));
   ```
3. Move the mouse on the sender.

**Pass:** Alert fires immediately after the dispatched event, without any
page reload or reconnection.

**Fail:** No alert fires after tier change. The `contexts` Map entry is not
being updated by the `alert:set-tier` listener in `detection.js`.

---

## 2. Alert Lifecycle

These tests validate `alerts.js` — border snap, fade timer, retrigger, mute,
and suppression during tunnel state changes.

---

### T-ALT-01 — Correct color per tier

**Setup:** Three connected senders. Set Cell A to High, Cell B to Medium,
Cell C to Low.

**Steps:**
1. Trigger activity on each sender (mouse movement sufficient for High,
   window open for Medium and Low).

**Pass:** Cell A border is **red** (`#f44336`), Cell B is **orange** (`#ff9800`),
Cell C is **blue** (`#2196f3`). Colors match the CSS variables in `style.css`.

**Fail:** Wrong color on any cell, or border does not appear. Indicates the
`alert-${tier}` class is not being applied or the CSS variables are missing.

---

### T-ALT-02 — Fade out after configured duration

**Setup:** One sender, tier High, `fadeDuration` set to **5 seconds** in
`config.json` for a fast observable test. Restart server after config change.

**Steps:**
1. Trigger an alert on the cell.
2. Stop all activity on the sender immediately after the border appears.
3. Count seconds.

**Pass:** The red border visibly fades to transparent over approximately 5 seconds
after the last change was detected. The CSS transition is smooth, not a jump.

**Fail — No fade:** The `fading` class is never added, or `--fade-duration` CSS
variable is not being set. Check that `config.fadeDuration * 1000` is the value
passed to `setTimeout` in `alerts.js`.

**Fail — Instant disappear:** The `--fade-duration` property is `0ms` or `NaN`.
Indicates `globalFadeDuration` was not populated from the API, or
`data.fadeDuration` is not being returned by `GET /api/hosts`.

---

### T-ALT-03 — Retrigger resets timer and snaps opacity

**Setup:** One sender, tier High, `fadeDuration: 5` in config. Trigger an alert
and wait until the border begins fading.

**Steps:**
1. While the border is visibly fading (partially transparent), cause a new screen
   change on the sender.

**Pass:** The border instantly snaps back to full opacity and the fade timer resets.
The fade restarts from full opacity, not from where it was.

**Fail:** Border continues fading through the retrigger. Indicates the existing
timer is not being cleared before setting a new one, or the `fading` class is
not being removed before re-adding the `alert-${tier}` class.

---

### T-ALT-04 — fadeEnabled: false holds border at full opacity indefinitely

**Setup:** One sender. In the sidebar, edit the host and set **Fade Enabled** to
unchecked (false). Trigger an alert.

**Steps:**
1. Trigger an alert on the cell.
2. Stop all sender activity and wait 60 seconds.

**Pass:** The red border remains at full opacity for the entire 60 seconds.
No fade transition occurs.

**Fail:** Border fades. The `config.fadeEnabled` flag from `hostConfigs` in
`alerts.js` is not being checked, or `fetchConfigs()` is not populating the
`hostConfigs` Map for this host.

---

### T-ALT-05 — Per-cell mute suppresses alerts for that cell only

**Setup:** Two connected senders, both High tier.

**Steps:**
1. In DevTools Console, dispatch:
   ```javascript
   window.dispatchEvent(new CustomEvent('alert:mute',
     { detail: { cellId: '<hostId-of-cell-A>' } }));
   ```
2. Cause screen changes on both senders simultaneously.

**Pass:** Cell A shows no border. Cell B shows its red border normally.

**Fail — Cell A fires:** The `mutedCells` Set in `alerts.js` is not being checked.

**Fail — Cell B suppressed too:** `alert:mute` with a specific `cellId` is
accidentally setting `globalMute`.

---

### T-ALT-06 — Global mute toggle via Mute All button

**Setup:** Two or more connected senders, all High tier.

**Steps:**
1. Click **Mute All** in the header.
2. Cause screen changes on all senders simultaneously.
3. Click **Unmute All**.
4. Cause screen changes on all senders again.

**Pass — Step 2:** No borders appear on any cell.
**Pass — Step 3:** Button label toggles to "Unmute All" then back to "Mute All".
**Pass — Step 4:** Borders fire normally on all cells after unmuting.

**Fail — Alerts fire while muted:** `globalMute` flag is not being checked in
the `cell:change-detected` handler.

**Fail — Alerts don't fire after unmuting:** `globalMute` is not being toggled
back to `false`, or the button handler is calling something other than a toggle.

---

### T-ALT-07 — Alert clears on cell disconnect

**Setup:** One connected sender with an active (non-fading) red border on screen.

**Steps:**
1. Manually disconnect the sender (stop TightVNC or kill the SSH tunnel).
2. Observe the cell immediately after disconnect.

**Pass:** The red border disappears immediately when the disconnect is registered.
The cell enters its disconnected visual state (dimmed, grayscale per `style.css`).

**Fail:** Border persists after disconnect. The `cell:disconnected` listener in
`alerts.js` is not clearing the alert class, or `grid.js` is not dispatching
the `cell:disconnected` event when the RFB connection closes.

---

## 3. Tunnel Reconnection UI

These tests validate the visual state machine driven by `tunnel:status-changed`
events received over the `/control` WebSocket channel.

---

### T-TUN-01 — Reconnecting state: dimmed cell, spinner, alerts suppressed

**Setup:** One connected sender showing a live frame and an active red border.

**Steps:**
1. Kill the SSH tunnel from the sender side (stop the scheduled task or kill
   the `ssh` process).
2. Observe the cell within the first 5-second reconnect interval.

**Pass:**
- Cell opacity drops to ~0.7 (`.cell.reconnecting` in `style.css`).
- Spinner overlay appears over the VNC canvas.
- The existing red alert border is cleared immediately on disconnect.
- No new alert borders appear while the cell is in `reconnecting` state,
  even if the detection algorithm would otherwise fire.

**Fail — No visual change:** The `/control` WebSocket is not delivering the
`tunnel:status-changed` event to the client, or `grid.js` is not calling
`updateCellStatus`.

**Fail — Alert fires during reconnecting:** `suppressedCells` in `alerts.js`
is not being populated by the `tunnel:status-changed` listener.

---

### T-TUN-02 — Disconnected state after max retries exceeded

**Setup:** Same cell in reconnecting state. Ensure `reconnectRetries: 3` and
`reconnectInterval: 5` in config (default values). Keep the tunnel down.

**Steps:**
1. Wait 15–20 seconds (3 × 5-second intervals) after the tunnel drops.
2. Observe the cell.

**Pass:**
- Cell opacity drops further to ~0.5 and a grayscale filter is applied
  (`.cell.disconnected` in `style.css`).
- Status text reads "Disconnected".
- No spinner (spinner is for reconnecting, not disconnected).

**Fail — Cell stays in reconnecting:** The server's reconnection FSM is not
transitioning to `disconnected` after 3 retries, or the broadcast is not
reaching the client.

---

### T-TUN-03 — Reconnection restores live state and lifts alert suppression

**Continuation of T-TUN-01 or T-TUN-02.** Restore the SSH tunnel from the sender.

**Steps:**
1. Restart the sender's scheduled SSH task.
2. Observe the cell.

**Pass:**
- Cell returns to full opacity with no spinner or grayscale.
- Status text disappears (`.cell.connected .cell-status { display: none }`).
- Causing a screen change on the sender now fires an alert border normally —
  suppression has been lifted.

**Fail — Cell stuck in reconnecting/disconnected:** The `tunnel:status-changed`
event with `status: 'connected'` is not being dispatched, or `suppressedCells`
is not being cleared on reconnect.

---

## 4. Viewport Virtualization

These tests validate the `IntersectionObserver` logic in `grid.js`. They require
either a viewport small enough to force scrolling, or enough hosts configured
that the grid extends below the fold.

**Note:** With a standard 1080p monitor and the default 4×3 grid layout, all 12
cells fit on screen simultaneously and these tests will not trigger naturally.
Use a reduced browser window (approximately 800×600) or configure at least 9
hosts to create a scrollable grid.

---

### T-VRT-01 — Canvas context released when cell scrolls out of view [DevTools]

**Setup:** At least 9 hosts configured. Resize the browser window so the bottom
row of cells is off-screen. Open DevTools Console.

**Steps:**
1. Scroll the grid so a cell that was previously visible is now fully off-screen.
2. In DevTools Console, query the canvas of the off-screen cell:
   ```javascript
   document.querySelector('#cell-<hostId> canvas').width
   ```

**Pass:** The canvas `width` returns `0`. The `IntersectionObserver` callback
has run and set `canvas.width = 0` to release the context.

**Fail:** Canvas width is non-zero. The `IntersectionObserver` is not firing,
or the threshold of `0.1` is not being crossed for that cell.

---

### T-VRT-02 — Rendering resumes and canvas restores on scroll back into view

**Continuation of T-VRT-01.**

**Steps:**
1. Scroll the off-screen cell back into view.
2. Wait 2–3 seconds.
3. In DevTools Console:
   ```javascript
   document.querySelector('#cell-<hostId> canvas').width
   ```

**Pass:** Canvas width is restored to its original value (e.g. `300` or
whatever the cell renders at). The VNC frame is rendering again — the canvas
shows a live image, not a black rectangle.

**Fail — Canvas remains 0:** `canvas._originalWidth` was not stored before
zeroing, or the restore branch of the `IntersectionObserver` callback is
not executing.

**Fail — Black canvas:** Width restored but frame is not rendering. The RFB
instance's `scaleViewport` was not re-enabled, or the underlying WebSocket
connection was dropped rather than maintained dormant.

---

### T-VRT-03 — WebSocket connection survives off-screen period

**Setup:** Same as T-VRT-01. Open DevTools Network tab, filter to WS.

**Steps:**
1. Observe the active WebSocket connection for the cell you will scroll off-screen.
2. Scroll that cell off-screen and wait 10 seconds.
3. Scroll it back into view.

**Pass:** The WebSocket connection in the Network tab **never closes** during
the off-screen period. The connection status remains open throughout. On return,
no new WebSocket connection is initiated — the existing one is reused.

**Fail — Connection closes:** The `rfb.disconnect()` call is being made on
scroll-out rather than just canvas resizing. This is incorrect — the spec
requires the WebSocket to remain dormant, not disconnected.

---

## 5. Profile Management

These tests validate `profiles-ui.js` — host CRUD via the modal, profile
save/load, and the event bus interactions triggered by profile changes.

---

### T-PRF-01 — Host added via modal appears in grid and sidebar

**Steps:**
1. Click **Add Host** in the sidebar.
2. Fill in a label, IP, VNC port, password, SSH public key. Set tier to Medium.
3. Click **Save**.

**Pass:**
- A new cell appears in the grid immediately, showing a connecting spinner.
- The host appears in the sidebar host list with its label.
- The tier dropdown for the new host shows **Medium**.

**Fail — Cell missing:** `grid.js` does not re-fetch `/api/hosts` after the
modal saves, or the `loadData()` call in `profiles-ui.js` is not triggering
`initGrid()` behaviour.

**Fail — Tier wrong:** The `alertTier` field is not being saved by `POST /api/hosts`,
or `profiles-ui.js` is not reading it back correctly on `loadData()`.

---

### T-PRF-02 — Alert tier change via dropdown fires event bus and persists

**Steps:**
1. Change the tier dropdown for a host from **Medium** to **High** in the sidebar.
2. Cause a minor screen change on that sender (cursor movement).
3. Reload the dashboard page.
4. Confirm the dropdown still shows **High** after reload.

**Pass — Step 2:** Alert fires on cursor movement (High tier threshold is met by
cursor movement; Medium is not).
**Pass — Step 4:** Dropdown shows High after reload — tier persisted to server.

**Fail — Step 2 no alert:** `alert:set-tier` was dispatched but `detection.js`
did not receive it, or the `contexts` Map entry was not updated.

**Fail — Step 4 reverts to Medium:** `PUT /api/hosts/:hostId` with just `alertTier`
is overwriting other host fields with `undefined`, or the response from
`GET /api/hosts` is returning stale data.

---

### T-PRF-03 — Monitoring profile save, load, and grid reconfiguration

**Setup:** Two hosts configured: Host A and Host B, both connected.

**Steps:**
1. Create a new profile named "Test Profile" via the **New** button.
2. In the host list, check only Host A for this profile.
3. Click **Save**.
4. Select a different profile (or blank) from the dropdown.
5. Re-select "Test Profile".

**Pass:**
- On step 5, the grid clears and rebuilds showing **only Host A**.
- Host B's cell is absent.
- A `profile:loaded` CustomEvent fires (verifiable in DevTools Console:
  `window.addEventListener('profile:loaded', e => console.log(e.detail))`).
- `alerts.js` calls `fetchConfigs()` in response to `profile:loaded`,
  refreshing host-level fade settings.

**Fail — Both cells shown:** `profile:loaded` listener in `grid.js` is using the
full host list rather than filtering by `profile.hostIds`.

**Fail — Grid not cleared:** `grid.innerHTML = ''` and `rfbs.forEach(rfb =>
rfb.disconnect())` are not executing before rebuilding.

---

### T-PRF-04 — Deleting a host removes it from all profiles and the grid

**Steps:**
1. With "Test Profile" active showing Host A, click the **×** delete button
   next to Host A in the sidebar.
2. Confirm the deletion dialog.

**Pass:**
- Host A's cell disappears from the grid.
- Host A no longer appears in the sidebar host list.
- Re-selecting "Test Profile" from the dropdown shows an empty grid (the
  profile's `hostIds` array retained a reference to a now-deleted host;
  `grid.js` should silently skip missing hosts rather than error).

**Fail — Error on profile reload:** `data.hosts[id]` access is not guarded
in `grid.js`'s `profile:loaded` handler. The code reads:
`if (data.hosts[id]) { ... }` — this guard must be present.

---

## 6. VNC Stream Integrity

These tests confirm that the WS↔TCP bridge is passing the RFB protocol stream
correctly and that the `binary: true` flag in `proxy.js` is in effect.

---

### T-VNC-01 — Live VNC frame renders without corruption

**Setup:** One TightVNC sender connected via SSH reverse tunnel.

**Steps:**
1. Observe the cell for 30 seconds of normal sender activity (mouse movement,
   opening windows).

**Pass:** The cell shows a consistent, accurate rendering of the sender's screen.
No pixel blocks are scrambled, no colour channels are inverted, no visual
tearing or partial frames are visible.

**Fail — Scrambled or corrupted rendering:** The RFB stream is being corrupted.
The most likely cause is `ws.send(data)` in `proxy.js` being called without
`{ binary: true }`, causing the binary frame data to be treated as a UTF-8
string. Check `proxy.js` line sending TCP data to WebSocket.

---

### T-VNC-02 — viewOnly: true — mouse and keyboard input are blocked

**Setup:** One sender connected. The sender should have a visible text editor
or input field open.

**Steps:**
1. Click on the VNC cell in the dashboard.
2. Type several characters.
3. Move the mouse over the VNC canvas.

**Pass:** No text appears in the sender's editor. The sender's cursor does not
move in response to dashboard mouse movement. The dashboard is read-only.

**Fail:** Input reaches the sender. `rfb.viewOnly = true` is not set in
`grid.js`, or noVNC is overriding it.

---

### T-VNC-03 — tightPNG encoding negotiated [DevTools]

**Setup:** Open DevTools Network tab, filter to WS. Connect to one sender.

**Steps:**
1. In DevTools, find the `/ws/<hostId>` WebSocket connection.
2. Observe the frames tab. The first few frames will be the RFB handshake.
3. After the connection is established, observe that frames are arriving
   as binary data (opaque blobs in DevTools, not text).

**Pass:** Frames are binary. The cell renders correctly. This confirms the
bridge is operating in binary mode and noVNC has completed the RFB handshake.

**Note:** Verifying tightPNG specifically requires a packet-level inspection
beyond DevTools. The practical test is that rendering is correct and CPU usage
is low (tightPNG shifts decompression to the browser's native image decoder).
If CPU is spiking on the dashboard machine for a single cell, encoding may
have fallen back to raw pixel data.

---

## 7. Login and Session

These tests cover the browser-side login flow and session expiry handling.
The automated suite tests the HTTP surface; these tests validate the browser
redirect behaviour and UX.

---

### T-SES-01 — Unauthenticated navigation redirects to /login [CROSS-BROWSER]

**Steps:**
1. Clear all cookies for the LambVNC origin.
2. Navigate directly to `http://localhost:3000/`.

**Pass:** Browser redirects to `/login`. The login page renders with a password
input and no JavaScript errors in DevTools Console.

**Fail — Chromium passes, Firefox fails:** This is the `Secure` cookie flag
issue documented in §6.1. Verify that `config.tls` is `false` and the server
is setting `secure: config.tls === true` (i.e., `secure: false` in localhost
mode). If `secure: true` is set unconditionally, Firefox will not transmit the
cookie and every request will appear unauthenticated. [CROSS-BROWSER]

---

### T-SES-02 — Session expiry redirects to /login without console errors

**Setup:** Set `sessionTtl: 10` (10 seconds) in config and restart the server.

**Steps:**
1. Log in normally.
2. Wait 15 seconds without interacting.
3. Click any sidebar button (e.g., **Add Host**).

**Pass:** The page redirects to `/login`. No JavaScript errors appear in
DevTools Console (no unhandled promise rejections from failed API calls).

**Fail — No redirect:** The frontend is not handling 401 responses from API calls
after session expiry. `profiles-ui.js` makes unauthenticated fetch calls without
checking `res.ok`, so a 401 silently fails to render data rather than redirecting.
This is a known gap in the current client code — `fetchConfigs()` in `alerts.js`
and `loadData()` in `profiles-ui.js` do not check response status.

---

## Appendix: Rapid Regression Sequence

Before any deployment, run the following sequence end-to-end. It takes
approximately 10 minutes with one active sender and covers the critical paths
in order of risk.

1. **T-VNC-01** — Confirm live rendering is uncorrupted.
2. **T-DET-01** — Confirm High tier fires.
3. **T-DET-03** — Confirm None tier suppresses.
4. **T-ALT-01** — Confirm correct alert colours.
5. **T-ALT-02** — Confirm fade timer fires at configured duration.
6. **T-ALT-03** — Confirm retrigger resets.
7. **T-TUN-01** — Kill tunnel, confirm reconnecting state and alert suppression.
8. **T-TUN-03** — Restore tunnel, confirm live state and suppression lifted.
9. **T-SES-01** — Clear cookies, confirm redirect to login.
10. **T-PRF-02** — Change tier, confirm event bus fires and persists.

A full pass on this sequence, combined with a clean `node --test test.js` run,
constitutes a deployable build.

---

*This document should be updated when client-side behaviour changes. A test
that can no longer be performed as written is evidence that the code has
diverged from the documented behaviour — resolve the discrepancy, do not
silently retire the test.*
