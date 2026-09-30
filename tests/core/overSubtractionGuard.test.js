import test from 'node:test';
import assert from 'node:assert/strict';

import { removeWatermark } from '../../src/core/blendModes.js';
import {
    correctOverSubtractedWatermark,
    measureLogoEdgeContrast
} from '../../src/core/overSubtractionGuard.js';

const LOGO_SIZE = 96;
const POSITION = Object.freeze({ x: 64, y: 64, width: LOGO_SIZE, height: LOGO_SIZE });

// Four-point sparkle, like Gemini's logo: solid core, soft anti-aliased edge.
function createSparkleAlpha(size = LOGO_SIZE, peak = 0.45) {
    const alpha = new Float32Array(size * size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = Math.abs(x - c) / (size * 0.42);
            const dy = Math.abs(y - c) / (size * 0.42);
            const d = Math.sqrt(dx) + Math.sqrt(dy);
            alpha[y * size + x] = peak * Math.max(0, Math.min(1, (1 - d) * 6));
        }
    }
    return alpha;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

// Smooth lilac background with a dark shadow band crossing the top of the logo,
// the case where correlation-based residual scores favour too much gain.
function createShadowedBackground(width = 224, height = 224) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inShadow = y < 64 + 30 - x * 0.08;
            const i = (y * width + x) * 4;
            data[i] = inShadow ? 92 : 196;
            data[i + 1] = inShadow ? 66 : 170;
            data[i + 2] = inShadow ? 112 : 204;
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

function addWatermark(imageData, alphaMap, position) {
    const out = cloneImageData(imageData);
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const a = alphaMap[y * position.width + x];
            const i = ((position.y + y) * out.width + position.x + x) * 4;
            for (let c = 0; c < 3; c++) {
                out.data[i + c] = Math.round(a * 255 + (1 - a) * out.data[i + c]);
            }
        }
    }
    return out;
}

function extractRegion(imageData, position) {
    const data = new Uint8ClampedArray(position.width * position.height * 4);
    for (let row = 0; row < position.height; row++) {
        const start = ((position.y + row) * imageData.width + position.x) * 4;
        data.set(imageData.data.subarray(start, start + position.width * 4), row * position.width * 4);
    }
    return { width: position.width, height: position.height, data };
}

function removeAtGain(imageData, alphaMap, alphaGain) {
    const out = cloneImageData(imageData);
    removeWatermark(out, alphaMap, POSITION, { alphaGain });
    return out;
}

test('logo edge contrast is positive for a visible logo, near zero when removed, negative when over-subtracted', () => {
    const alphaMap = createSparkleAlpha();
    const watermarked = addWatermark(createShadowedBackground(), alphaMap, POSITION);

    const visible = measureLogoEdgeContrast(extractRegion(watermarked, POSITION), alphaMap);
    const removed = measureLogoEdgeContrast(extractRegion(removeAtGain(watermarked, alphaMap, 1), POSITION), alphaMap);
    const overSubtracted = measureLogoEdgeContrast(extractRegion(removeAtGain(watermarked, alphaMap, 1.3), POSITION), alphaMap);

    assert.ok(visible.median > 10, `visible logo median ${visible.median}`);
    assert.ok(Math.abs(removed.median) < 1.5, `removed logo median ${removed.median}`);
    assert.ok(overSubtracted.median < -5, `over-subtracted median ${overSubtracted.median}`);
});

test('an over-subtracted result is re-solved near the true gain and the dark imprint disappears', () => {
    const alphaMap = createSparkleAlpha();
    const original = addWatermark(createShadowedBackground(), alphaMap, POSITION);
    const overSubtracted = removeAtGain(original, alphaMap, 1.3);

    const correction = correctOverSubtractedWatermark({
        originalImageData: original,
        imageData: overSubtracted,
        alphaMap,
        position: POSITION,
        alphaGain: 1.3,
        cloneImageData
    });

    assert.ok(correction, 'expected a correction');
    assert.ok(Math.abs(correction.alphaGain - 1) <= 0.05, `corrected gain ${correction.alphaGain}`);
    assert.ok(correction.edgeContrastBefore < -5);
    assert.ok(Math.abs(correction.edgeContrastAfter) < 1.5);
    const after = measureLogoEdgeContrast(extractRegion(correction.imageData, POSITION), alphaMap);
    assert.ok(Math.abs(after.median) < 1.5, `result median ${after.median}`);
    assert.notEqual(correction.imageData, overSubtracted, 'input pixels must not be modified in place');
});

test('pixels outside the watermark box are left untouched', () => {
    const alphaMap = createSparkleAlpha();
    const original = addWatermark(createShadowedBackground(), alphaMap, POSITION);
    const overSubtracted = removeAtGain(original, alphaMap, 1.3);
    const { imageData } = correctOverSubtractedWatermark({
        originalImageData: original,
        imageData: overSubtracted,
        alphaMap,
        position: POSITION,
        alphaGain: 1.3,
        cloneImageData
    });

    for (let y = 0; y < imageData.height; y++) {
        for (let x = 0; x < imageData.width; x++) {
            const insideBox = x >= POSITION.x && x < POSITION.x + POSITION.width &&
                y >= POSITION.y && y < POSITION.y + POSITION.height;
            if (insideBox) continue;
            const i = (y * imageData.width + x) * 4;
            assert.equal(imageData.data[i], overSubtracted.data[i]);
        }
    }
});

test('results at or below unit gain are never changed', () => {
    const alphaMap = createSparkleAlpha();
    const original = addWatermark(createShadowedBackground(), alphaMap, POSITION);
    for (const alphaGain of [0.6, 1]) {
        assert.equal(correctOverSubtractedWatermark({
            originalImageData: original,
            imageData: removeAtGain(original, alphaMap, alphaGain),
            alphaMap,
            position: POSITION,
            alphaGain,
            cloneImageData
        }), null);
    }
});

test('a correctly removed watermark reported at high gain is kept as is', () => {
    const alphaMap = createSparkleAlpha();
    // The watermark really was 1.3x stronger, so 1.3 is the right gain.
    const strongAlpha = alphaMap.map((a) => a * 1.3);
    const strongOriginal = addWatermark(createShadowedBackground(), strongAlpha, POSITION);

    assert.equal(correctOverSubtractedWatermark({
        originalImageData: strongOriginal,
        imageData: removeAtGain(strongOriginal, alphaMap, 1.3),
        alphaMap,
        position: POSITION,
        alphaGain: 1.3,
        cloneImageData
    }), null);
});

test('dark-polarity watermarks are not handled by the guard', () => {
    const alphaMap = createSparkleAlpha().map((a) => -a);
    const original = createShadowedBackground();
    assert.equal(correctOverSubtractedWatermark({
        originalImageData: original,
        imageData: cloneImageData(original),
        alphaMap,
        position: POSITION,
        alphaGain: 1.3,
        cloneImageData
    }), null);
});
