import RFB from '/client/vendor/novnc/core/rfb.js';

const grid = document.getElementById('grid');
const rfbs = new Map(); // hostId -> RFB instance
const hostStates = new Map(); // hostId -> tunnel status
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

// Connect to the control channel
const controlWs = new WebSocket(`${protocol}//${window.location.host}/control`);
controlWs.onmessage = (event) => {
    const { type, detail } = JSON.parse(event.data);
    if (type === 'tunnel:status-changed') {
        hostStates.set(detail.cellId, detail.status);
        window.dispatchEvent(new CustomEvent('tunnel:status-changed', { detail }));
        updateCellStatus(detail.cellId, detail.status);

        // Reconnect lazily when tunnel becomes available.
        if (detail.status === 'connected' && !rfbs.has(detail.cellId)) {
            connectHost(detail.cellId);
        }

        // Drop stale sessions when tunnel is down.
        if ((detail.status === 'reconnecting' || detail.status === 'disconnected') && rfbs.has(detail.cellId)) {
            rfbs.get(detail.cellId).disconnect();
            rfbs.delete(detail.cellId);
        }
    }
};

/**
 * Creates a new cell in the grid
 */
function createCell(hostId, label) {
    let cell = document.getElementById(`cell-${hostId}`);
    if (cell) return cell;

    cell = document.createElement('div');
    cell.id = `cell-${hostId}`;
    cell.className = 'cell';
    cell.innerHTML = `
        <div class="cell-header"><span class="cell-label">${label}</span></div>
        <div class="cell-status"><div class="spinner"></div><span class="status-text">Connecting...</span></div>
    `;
    grid.appendChild(cell);
    return cell;
}

/**
 * Updates cell UI status
 */
function updateCellStatus(hostId, status) {
    const cell = document.getElementById(`cell-${hostId}`);
    if (!cell) return;
    const statusText = cell.querySelector('.status-text');
    cell.classList.remove('connected', 'reconnecting', 'disconnected');
    cell.classList.add(status);
    if (status === 'reconnecting') statusText.textContent = 'Reconnecting...';
    if (status === 'disconnected') statusText.textContent = 'Disconnected';
}

/**
 * Connects to VNC
 */
function connectHost(hostId) {
    if (rfbs.has(hostId)) return;
    const cell = document.getElementById(`cell-${hostId}`);
    if (!cell) return;
    const rfb = new RFB(cell, `${protocol}//${window.location.host}/ws/${hostId}`, {
        wsProtocols: ['binary']
    });

    // SPEC: Negotiate tightPNG (via qualityLevel)
    rfb.qualityLevel = 6;
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.background = '#000';

    rfb.addEventListener('connect', () => {
        updateCellStatus(hostId, 'connected');
        window.dispatchEvent(new CustomEvent('cell:connected', { detail: { cellId: hostId, canvas: rfb.canvas } }));
        observer.observe(cell);
    });

    rfb.addEventListener('disconnect', () => {
        rfbs.delete(hostId);
        window.dispatchEvent(new CustomEvent('cell:disconnected', { detail: { cellId: hostId } }));
    });

    rfb.addEventListener('fbucomplete', () => {
        window.dispatchEvent(new CustomEvent('cell:frame-updated', { detail: { cellId: hostId } }));
    });

    rfbs.set(hostId, rfb);
}

/**
 * Sets grid column count based on total cell count.
 */
function updateGridLayout(hostCount) {
    const cols = hostCount <= 1 ? 1
               : hostCount <= 4 ? 2
               : hostCount <= 9 ? 3
               : 4;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// Click-to-focus: expand a cell to fill the grid row
grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;

    const isExpanded = cell.classList.contains('expanded');

    // Collapse any currently expanded cell
    document.querySelectorAll('.cell.expanded')
        .forEach(c => c.classList.remove('expanded'));

    if (!isExpanded) {
        cell.classList.add('expanded');
        // Ensure the VNC canvas scales to fill the enlarged container
        const hostId = cell.id.replace('cell-', '');
        const rfb = rfbs.get(hostId);
        if (rfb) rfb.scaleViewport = true;
    }
});

// Viewport Virtualization
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const hostId = entry.target.id.replace('cell-', '');
        const rfb = rfbs.get(hostId);
        if (!rfb) return;

        const canvas = entry.target.querySelector('canvas');

        // SPEC: pause rendering and release canvas context when off-screen
        if (entry.isIntersecting) {
            rfb.scaleViewport = true;
            // Restore canvas size if it was minimized
            if (canvas && canvas._originalWidth) {
                canvas.width = canvas._originalWidth;
                canvas.height = canvas._originalHeight;
            }
        } else {
            // Skip canvas-zeroing for expanded cells — they are intentionally
            // large and should not be treated as off-screen during layout transitions.
            if (entry.target.classList.contains('expanded')) return;
            rfb.scaleViewport = false;
            // Release context by minimizing canvas footprint
            if (canvas && canvas.width > 0) {
                canvas._originalWidth = canvas.width;
                canvas._originalHeight = canvas.height;
                canvas.width = 0;
                canvas.height = 0;
            }
        }
    });
}, { threshold: 0.1 });

// Initial Load & Profile listener
async function initGrid() {
    const res = await fetch('/api/hosts');
    const data = await res.json();
    for (const id in data.hosts) {
        createCell(id, data.hosts[id].label);
        updateCellStatus(id, data.hosts[id].tunnelState);
        hostStates.set(id, data.hosts[id].tunnelState);
        if (data.hosts[id].tunnelState === 'connected') {
            connectHost(id);
        }
        // SPEC §7.1: Initialize detection tier from saved host profile
        if (data.hosts[id].alertTier) {
            window.dispatchEvent(new CustomEvent('alert:set-tier', {
                detail: { cellId: id, tier: data.hosts[id].alertTier }
            }));
        }
    }
    updateGridLayout(Object.keys(data.hosts).length);
}

window.addEventListener('profile:loaded', (event) => {
    const { profile } = event.detail;
    grid.innerHTML = '';
    rfbs.forEach(rfb => rfb.disconnect());
    rfbs.clear();

    fetch('/api/hosts').then(r => r.json()).then(data => {
        profile.hostIds.forEach(id => {
            if (data.hosts[id]) {
                createCell(id, data.hosts[id].label);
                updateCellStatus(id, data.hosts[id].tunnelState);
                hostStates.set(id, data.hosts[id].tunnelState);
                if (data.hosts[id].tunnelState === 'connected') {
                    connectHost(id);
                }
                // SPEC §7.1: Initialize detection tier from saved host profile
                if (data.hosts[id].alertTier) {
                    window.dispatchEvent(new CustomEvent('alert:set-tier', {
                        detail: { cellId: id, tier: data.hosts[id].alertTier }
                    }));
                }
            }
        });
        updateGridLayout(profile.hostIds.filter(id => data.hosts[id]).length);
    });
});

initGrid();
