// ARCHITECTURE.md §9.2: Area threshold is % of changed pixels, Distance is per-pixel magnitude
const tiers = {
    low: { area: 15, distance: 30 },
    medium: { area: 10, distance: 20 },
    high: { area: 5, distance: 10 },
    none: { area: 100, distance: 255 }
};

const contexts = new Map(); // hostId -> { canvas, offscreen, prevData, tier }

/**
 * Grayscale conversion
 */
function toGrayscale(pixels) {
    const grayscale = new Uint8Array(pixels.length / 4);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        grayscale[j] = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    }
    return grayscale;
}

window.addEventListener('cell:connected', (event) => {
    const { cellId, canvas } = event.detail;

    // Create offscreen 64x64 canvas for downscaling
    const offscreen = document.createElement('canvas');
    offscreen.width = 64;
    offscreen.height = 64;
    const ctx = offscreen.getContext('2d', { alpha: false, willReadFrequently: true });

    contexts.set(cellId, {
        canvas,
        offscreen: ctx,
        prevData: null,
        tier: 'medium'
    });
});

window.addEventListener('cell:disconnected', (event) => {
    contexts.delete(event.detail.cellId);
});

window.addEventListener('cell:frame-updated', (event) => {
    const { cellId } = event.detail;
    const ctxData = contexts.get(cellId);
    if (!ctxData) return;

    const { canvas, offscreen, prevData, tier } = ctxData;
    const tierParams = tiers[tier];

    // 1. Downscale
    offscreen.drawImage(canvas, 0, 0, 64, 64);

    // 2. Extract and Grayscale
    const imageData = offscreen.getImageData(0, 0, 64, 64).data;
    const currentData = toGrayscale(imageData);

    if (prevData) {
        // 3. Compare
        let changedPixels = 0;
        const totalPixels = 64 * 64;

        for (let i = 0; i < totalPixels; i++) {
            if (Math.abs(currentData[i] - prevData[i]) > tierParams.distance) {
                changedPixels++;
            }
        }

        const pctChanged = (changedPixels / totalPixels) * 100;

        // 4. Threshold check
        if (pctChanged > tierParams.area) {
            window.dispatchEvent(new CustomEvent('cell:change-detected', {
                detail: { cellId, tier, pctChanged }
            }));
        }
    }

    ctxData.prevData = currentData;
});

window.addEventListener('alert:set-tier', (event) => {
    const { cellId, tier } = event.detail;
    if (cellId === 'all') {
        for (const data of contexts.values()) {
            data.tier = tier;
        }
    } else {
        const data = contexts.get(cellId);
        if (data) data.tier = tier;
    }
});
