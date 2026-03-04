// SPEC §9.3: Alert lifecycle — snap, timer, fade, retrigger, mute
// Listens: cell:change-detected, cell:disconnected, tunnel:status-changed, alert:mute, profile:loaded

const activeAlerts = new Map(); // hostId -> { timer, tier }
let globalMute = false;
const mutedCells = new Set();
const hostConfigs = new Map(); // hostId -> { fadeEnabled }
const suppressedCells = new Set(); // cells in reconnecting/disconnected state
let globalFadeDuration = 15000;

/**
 * Fetch host configs and fadeDuration from the hosts API
 */
async function fetchConfigs() {
    const res = await fetch('/api/hosts');
    const data = await res.json();

    if (data.fadeDuration) globalFadeDuration = data.fadeDuration;

    for (const id in data.hosts) {
        hostConfigs.set(id, {
            fadeEnabled: data.hosts[id].fadeEnabled
        });
    }
}

// SPEC §9.3: On threshold breach, snap border to full opacity in tier color
window.addEventListener('cell:change-detected', (event) => {
    const { cellId, tier } = event.detail;
    if (globalMute || mutedCells.has(cellId) || suppressedCells.has(cellId)) return;

    const config = hostConfigs.get(cellId) || { fadeEnabled: true };
    const cell = document.getElementById(`cell-${cellId}`);
    if (!cell) return;

    // Clear existing alert state
    cell.classList.remove('fading', 'alert-low', 'alert-medium', 'alert-high');
    const existing = activeAlerts.get(cellId);
    if (existing) clearTimeout(existing.timer);

    // 1. Snap to full opacity
    cell.classList.add(`alert-${tier}`);

    // 2. Timer + fade
    if (config.fadeEnabled) {
        cell.style.setProperty('--fade-duration', `${globalFadeDuration}ms`);
        const timer = setTimeout(() => {
            cell.classList.add('fading');
            activeAlerts.delete(cellId);
        }, globalFadeDuration);
        activeAlerts.set(cellId, { timer, tier });
    }
});

// SPEC §7.1: Suppress alerts for cells in reconnecting/disconnected state
window.addEventListener('tunnel:status-changed', (event) => {
    const { cellId, status } = event.detail;
    if (status === 'connected') {
        suppressedCells.delete(cellId);
    } else {
        suppressedCells.add(cellId);
        // Clear any active alert on this cell
        const existing = activeAlerts.get(cellId);
        if (existing) {
            clearTimeout(existing.timer);
            activeAlerts.delete(cellId);
        }
        const cell = document.getElementById(`cell-${cellId}`);
        if (cell) {
            cell.classList.remove('fading', 'alert-low', 'alert-medium', 'alert-high');
        }
    }
});

// SPEC §7.1: Clean up alert timers on cell disconnect
window.addEventListener('cell:disconnected', (event) => {
    const { cellId } = event.detail;
    const existing = activeAlerts.get(cellId);
    if (existing) {
        clearTimeout(existing.timer);
        activeAlerts.delete(cellId);
    }
    const cell = document.getElementById(`cell-${cellId}`);
    if (cell) {
        cell.classList.remove('fading', 'alert-low', 'alert-medium', 'alert-high');
    }
});

// SPEC: Mute toggle
window.addEventListener('alert:mute', (event) => {
    const { cellId } = event.detail;
    if (cellId === 'all') {
        globalMute = !globalMute;
    } else {
        mutedCells.has(cellId) ? mutedCells.delete(cellId) : mutedCells.add(cellId);
    }
});

// SPEC: Refresh host configs when profile changes
window.addEventListener('profile:loaded', () => {
    fetchConfigs();
});

fetchConfigs();
