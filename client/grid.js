import RFB from '/client/vendor/novnc/core/rfb.js';

const grid = document.getElementById('grid');
const rfbs = new Map(); // hostId -> RFB instance
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

// Connect to the control channel
const controlWs = new WebSocket(`${protocol}//${window.location.host}/control`);
controlWs.onmessage = (event) => {
    const { type, detail } = JSON.parse(event.data);
    if (type === 'tunnel:status-changed') {
        window.dispatchEvent(new CustomEvent('tunnel:status-changed', { detail }));
        updateCellStatus(detail.cellId, detail.status);
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
    const cell = document.getElementById(`cell-${hostId}`);
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
        window.dispatchEvent(new CustomEvent('cell:disconnected', { detail: { cellId: hostId } }));
    });

    rfb.addEventListener('fbucomplete', () => {
        window.dispatchEvent(new CustomEvent('cell:frame-updated', { detail: { cellId: hostId } }));
    });

    rfbs.set(hostId, rfb);
}

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
        connectHost(id);
        // SPEC §7.1: Initialize detection tier from saved host profile
        if (data.hosts[id].alertTier) {
            window.dispatchEvent(new CustomEvent('alert:set-tier', {
                detail: { cellId: id, tier: data.hosts[id].alertTier }
            }));
        }
    }
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
                connectHost(id);
                // SPEC §7.1: Initialize detection tier from saved host profile
                if (data.hosts[id].alertTier) {
                    window.dispatchEvent(new CustomEvent('alert:set-tier', {
                        detail: { cellId: id, tier: data.hosts[id].alertTier }
                    }));
                }
            }
        });
    });
});

initGrid();
