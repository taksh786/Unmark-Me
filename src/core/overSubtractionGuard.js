/**
 * Over-subtraction guard.
 *
 * Removing a watermark with too much alpha gain leaves a darker imprint of the
 * logo. The correlation-based residual scores can reward that mistake when a
 * shadow or hard edge crosses the watermark: the background structure itself
 * correlates with the logo shape, and darkening the logo cancels it out, so the
 * scores keep improving as the gain rises past the true value.
 *
 * Comparing each pixel just inside the logo with background pixels a few
 * pixels away cancels that structure, because a shadow or gradient barely
 * changes over that distance. When the chosen gain is above 1 and the logo
 * comes out darker than its immediate surroundings, re-solve the watermark box
 * from the original pixels at the gain where the logo matches its surroundings.
 *
 * The re-solved box can still show a faint outline along the logo's
 * anti-aliased edge, where the stored alpha map differs slightly from the
 * rendered one. On smooth backgrounds those edge pixels are pulled toward the
 * nearby logo-free pixels; textured neighbourhoods are left untouched.
 */

import { removeWatermark } from './blendModes.js';

const EDGE_INSIDE_MIN_ALPHA = 0.2;
const EDGE_OUTSIDE_MAX_ALPHA = 0.02;
const EDGE_NEIGHBOR_RADIUS = 3;
const EDGE_MIN_NEIGHBORS = 3;
const EDGE_MIN_SAMPLES = 40;

// Median luminance difference (inside minus nearby outside) that counts as a
// visibly darker logo imprint.
const OVER_SUBTRACTION_TRIGGER_LUMA = -3;
// The corrected gain must shrink the imprint by at least this much to be used.
const MIN_CONTRAST_IMPROVEMENT_LUMA = 1.5;
const GAIN_SEARCH_MIN = 0.9;
const GAIN_SEARCH_STEP = 0.025;

const EDGE_POLISH_MIN_ALPHA = 0.004;
const EDGE_POLISH_MAX_ALPHA = 0.35;
const EDGE_POLISH_RADIUS = 4;
const EDGE_POLISH_MIN_NEIGHBORS = 6;
// Luminance standard deviation above which the background counts as textured.
const EDGE_POLISH_MAX_BACKGROUND_STD = 2.5;
// Share of each edge pixel's own deviation that is kept, so grain survives.
const EDGE_POLISH_KEEP = 0.3;

function luminanceAt(data, index) {
    return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
}

function hasDarkPolarity(alphaMap) {
    for (let i = 0; i < alphaMap.length; i++) {
        if (alphaMap[i] < -1e-6) return true;
    }
    return false;
}

function extractRegion(imageData, position) {
    const { x, y, width, height } = position;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const start = ((y + row) * imageData.width + x) * 4;
        data.set(imageData.data.subarray(start, start + width * 4), row * width * 4);
    }
    return { width, height, data };
}

function writeRegion(imageData, region, position) {
    for (let row = 0; row < region.height; row++) {
        const start = ((position.y + row) * imageData.width + position.x) * 4;
        imageData.data.set(region.data.subarray(row * region.width * 4, (row + 1) * region.width * 4), start);
    }
}

/**
 * Median luminance of logo-edge pixels minus nearby background pixels, measured
 * on a region that starts at the watermark's top-left corner. Positive means a
 * lighter logo is still visible, negative means a darker imprint.
 */
export function measureLogoEdgeContrast(region, alphaMap) {
    const { width, height, data } = region;
    if (!alphaMap || alphaMap.length !== width * height) return null;

    const differences = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (alphaMap[y * width + x] < EDGE_INSIDE_MIN_ALPHA) continue;
            let sum = 0;
            let count = 0;
            for (let dy = -EDGE_NEIGHBOR_RADIUS; dy <= EDGE_NEIGHBOR_RADIUS; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -EDGE_NEIGHBOR_RADIUS; dx <= EDGE_NEIGHBOR_RADIUS; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    if (alphaMap[ny * width + nx] > EDGE_OUTSIDE_MAX_ALPHA) continue;
                    sum += luminanceAt(data, (ny * width + nx) * 4);
                    count++;
                }
            }
            if (count >= EDGE_MIN_NEIGHBORS) {
                differences.push(luminanceAt(data, (y * width + x) * 4) - sum / count);
            }
        }
    }
    if (differences.length < EDGE_MIN_SAMPLES) return null;

    differences.sort((a, b) => a - b);
    return {
        samples: differences.length,
        median: differences[Math.floor((differences.length - 1) / 2)]
    };
}

function polishSmoothLogoEdges(region, alphaMap) {
    const { width, height, data } = region;
    const output = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = alphaMap[y * width + x];
            if (alpha <= EDGE_POLISH_MIN_ALPHA || alpha > EDGE_POLISH_MAX_ALPHA) continue;

            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            let sumLuma = 0;
            let sumLumaSquared = 0;
            let count = 0;
            for (let dy = -EDGE_POLISH_RADIUS; dy <= EDGE_POLISH_RADIUS; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -EDGE_POLISH_RADIUS; dx <= EDGE_POLISH_RADIUS; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    if (alphaMap[ny * width + nx] > EDGE_OUTSIDE_MAX_ALPHA) continue;
                    const index = (ny * width + nx) * 4;
                    const luma = luminanceAt(data, index);
                    sumR += data[index];
                    sumG += data[index + 1];
                    sumB += data[index + 2];
                    sumLuma += luma;
                    sumLumaSquared += luma * luma;
                    count++;
                }
            }
            if (count < EDGE_POLISH_MIN_NEIGHBORS) continue;
            const meanLuma = sumLuma / count;
            const std = Math.sqrt(Math.max(0, sumLumaSquared / count - meanLuma * meanLuma));
            if (std > EDGE_POLISH_MAX_BACKGROUND_STD) continue;

            const index = (y * width + x) * 4;
            const means = [sumR / count, sumG / count, sumB / count];
            for (let c = 0; c < 3; c++) {
                output[index + c] = Math.round(means[c] + (data[index + c] - means[c]) * EDGE_POLISH_KEEP);
            }
        }
    }
    return { width, height, data: output };
}

/**
 * Returns a corrected copy of `imageData` when the watermark was over-subtracted,
 * or null when the result should be kept as is.
 */
export function correctOverSubtractedWatermark({
    originalImageData,
    imageData,
    alphaMap,
    position,
    alphaGain,
    cloneImageData
}) {
    if (!originalImageData || !imageData || !alphaMap || !position || !cloneImageData) return null;
    if (!(alphaGain > 1)) return null;
    if (hasDarkPolarity(alphaMap)) return null;
    if (alphaMap.length !== position.width * position.height) return null;
    if (
        position.x < 0 || position.y < 0 ||
        position.x + position.width > imageData.width ||
        position.y + position.height > imageData.height
    ) {
        return null;
    }

    const before = measureLogoEdgeContrast(extractRegion(imageData, position), alphaMap);
    if (!before || before.median > OVER_SUBTRACTION_TRIGGER_LUMA) return null;

    const originalRegion = extractRegion(originalImageData, position);
    const regionPosition = { x: 0, y: 0, width: position.width, height: position.height };
    let best = null;
    for (let gain = GAIN_SEARCH_MIN; gain < alphaGain + 1e-9; gain += GAIN_SEARCH_STEP) {
        const candidate = {
            width: originalRegion.width,
            height: originalRegion.height,
            data: new Uint8ClampedArray(originalRegion.data)
        };
        removeWatermark(candidate, alphaMap, regionPosition, { alphaGain: gain });
        const contrast = measureLogoEdgeContrast(candidate, alphaMap);
        if (!contrast) continue;
        if (!best || Math.abs(contrast.median) < Math.abs(best.contrast.median)) {
            best = { gain, region: candidate, contrast };
        }
    }
    if (!best) return null;
    if (Math.abs(best.contrast.median) > Math.abs(before.median) - MIN_CONTRAST_IMPROVEMENT_LUMA) return null;

    const corrected = cloneImageData(imageData);
    writeRegion(corrected, polishSmoothLogoEdges(best.region, alphaMap), position);
    return {
        imageData: corrected,
        alphaGain: Number(best.gain.toFixed(3)),
        edgeContrastBefore: before.median,
        edgeContrastAfter: best.contrast.median
    };
}
