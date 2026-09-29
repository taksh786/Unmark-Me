import {
    DEFAULT_ADAPTIVE_ALPHA,
    DEFAULT_ALPHA_GAIN,
    DEFAULT_DENOISE_BACKEND,
    DEFAULT_EDGE_DENOISE_STRENGTH,
    DEFAULT_HIGH_QUALITY_CLEANUP,
    DEFAULT_RESIDUAL_CLEANUP_STRENGTH,
    DEFAULT_SAMPLE_COUNT,
    DEFAULT_VIDEO_BITRATE,
    VIDEO_DENOISE_BACKENDS,
    detectGeminiVideoWatermark,
    inspectGeminiVideoFile,
    removeGeminiVideoWatermark
} from './video/videoExport.js';
import { isReferenceGeminiVideoSize } from './video/videoWatermarkCatalog.js';
import {
    getAutomaticVideoPresetConfig,
    getRelocatedReviewPresetConfig
} from './video/videoPresetPolicy.js';
import { resolveAllenkFdncnnRuntimeProfile } from './video/videoDenoiseRuntimePolicy.js';
import {
    applyVideoAdaptiveAlphaDebugOverride,
    applyVideoBitrateDebugOverride
} from './video/videoDebugControlOverrides.js';
import {
    createBatchQueue,
    enqueueBatchFiles,
    processBatchQueue,
    startBatchSelection
} from './video/videoBatchQueue.js';
import {
    consumeDebugFileHandoff,
    getDebugFileKind,
    pickDebugUploadFile,
    saveDebugFileHandoff
} from './shared/debugFileHandoff.js';
import { createAllenkFdncnnOnnxRuntime } from './core/allenkFdncnnOnnxRuntime.js';
import { mountAccountMenu } from './shared/accountMenu.js';
import { mountThemeSwitch } from './shared/themeSwitch.js';

const $ = (id) => document.getElementById(id);
const ALLENK_FDNCNN_WASM_PATHS = Object.freeze({
    mjs: './onnxruntime/ort-wasm-simd-threaded.js',
    wasm: './onnxruntime/ort-wasm-simd-threaded.wasm'
});
const ALLENK_FDNCNN_WEBGPU_WASM_PATHS = Object.freeze({
    mjs: './onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: './onnxruntime/ort-wasm-simd-threaded.asyncify.wasm'
});

const state = {
    file: null,
    originalUrl: null,
    processedUrl: null,
    metadata: null,
    detection: null,
    running: false,
    controller: null,
    jobId: 0,
    syncingPlayback: false
};

const allenkFdncnnRuntimePromises = new Map();

const els = {
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    batchQueue: $('batchQueue'),
    comparePlayer: $('comparePlayer'),
    afterBadge: $('afterBadge'),
    playPauseBtn: $('playPauseBtn'),
    scrubber: $('scrubber'),
    timeLabel: $('timeLabel'),
    originalVideo: $('originalVideo'),
    processedVideo: $('processedVideo'),
    originalEmpty: $('originalEmpty'),
    processedEmpty: $('processedEmpty'),
    metadata: $('metadata'),
    detection: $('detection'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    status: $('status'),
    alphaGain: $('alphaGain'),
    alphaGainValue: $('alphaGainValue'),
    adaptiveAlpha: $('adaptiveAlpha'),
    highQualityCleanup: $('highQualityCleanup'),
    denoiseBackend: $('denoiseBackend'),
    edgeDenoiseStrength: $('edgeDenoiseStrength'),
    edgeDenoiseStrengthValue: $('edgeDenoiseStrengthValue'),
    residualCleanup: $('residualCleanup'),
    residualCleanupValue: $('residualCleanupValue'),
    videoBitrateMbps: $('videoBitrateMbps'),
    sampleCount: $('sampleCount'),
    allowLowConfidence: $('allowLowConfidence'),
    autoPresetSummary: $('autoPresetSummary'),
    processBtn: $('processBtn'),
    detectBtn: $('detectBtn'),
    downloadBtn: $('downloadBtn'),
    resetBtn: $('resetBtn'),
    cancelBtn: $('cancelBtn'),
    relocatedReviewPresetBtn: $('relocatedReviewPresetBtn')
};

function setStatus(message, tone = 'info') {
    els.status.textContent = message || '';
    els.status.dataset.tone = tone;
}

function isLikelyJavascriptMime(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    return mime === 'application/javascript'
        || mime === 'text/javascript'
        || mime === 'application/ecmascript'
        || mime === 'text/ecmascript'
        || mime.endsWith('+javascript');
}

async function preflightWebGpuRuntimeAssets(paths, signal) {
    try {
        const response = await fetch(paths.mjs, { cache: 'no-store', signal });
        if (!response.ok) {
            return {
                ok: false,
                reason: `WebGPU runtime module unavailable: ${response.status}`
            };
        }
        const contentType = response.headers.get('content-type') || '';
        if (!isLikelyJavascriptMime(contentType)) {
            return {
                ok: false,
                reason: `WebGPU runtime module is served as ${contentType || 'unknown MIME'}`
            };
        }
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: error?.message || String(error)
        };
    }
}

async function loadAllenkFdncnnRuntime(runtimeProfile = resolveAllenkFdncnnRuntimeProfile(), signal) {
    signal?.throwIfAborted();
    const profile = runtimeProfile || resolveAllenkFdncnnRuntimeProfile();
    if (!allenkFdncnnRuntimePromises.has(profile.id)) {
        const runtimePromise = (async () => {
            const response = await fetch(profile.modelUrl, { signal });
            if (!response.ok) {
                throw new Error(`Could not load the AI model: ${response.status}`);
            }
            const modelBytes = new Uint8Array(await response.arrayBuffer());
            signal?.throwIfAborted();
            if (navigator.gpu && window.__gwrDisableWebGpuDenoise !== true) {
                try {
                    const preflight = await preflightWebGpuRuntimeAssets(ALLENK_FDNCNN_WEBGPU_WASM_PATHS, signal);
                    signal?.throwIfAborted();
                    if (!preflight.ok) {
                        console.warn('WebGPU AI runtime skipped:', preflight.reason);
                        throw new Error(preflight.reason);
                    }
                    setStatus('Enabling WebGPU AI watermark removal…');
                    const webgpuOrt = await import('onnxruntime-web/webgpu');
                    signal?.throwIfAborted();
                    return await createAllenkFdncnnOnnxRuntime({
                        ort: webgpuOrt,
                        modelBytes,
                        executionProvider: 'webgpu',
                        wasmPaths: ALLENK_FDNCNN_WEBGPU_WASM_PATHS,
                        inputName: 'fdncnn_input',
                        outputName: 'fdncnn_output',
                        inputShape: profile.inputShape,
                        outputShape: profile.outputShape
                    });
                } catch (error) {
                    signal?.throwIfAborted();
                    console.warn('WebGPU AI runtime unavailable, falling back to WASM:', error);
                }
            }
            signal?.throwIfAborted();
            return createAllenkFdncnnOnnxRuntime({
                modelBytes,
                executionProvider: 'wasm',
                wasmPaths: ALLENK_FDNCNN_WASM_PATHS,
                inputName: 'fdncnn_input',
                outputName: 'fdncnn_output',
                inputShape: profile.inputShape,
                outputShape: profile.outputShape
            });
        })();
        allenkFdncnnRuntimePromises.set(profile.id, runtimePromise);
        runtimePromise.catch(() => {
            if (allenkFdncnnRuntimePromises.get(profile.id) === runtimePromise) {
                allenkFdncnnRuntimePromises.delete(profile.id);
            }
        });
    }
    return allenkFdncnnRuntimePromises.get(profile.id);
}

async function resolveExportDenoiseRuntime(denoiseBackend, runtimeProfile = resolveAllenkFdncnnRuntimeProfile(), signal) {
    if (denoiseBackend !== VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) {
        return null;
    }
    setStatus('Loading the AI FDnCNN ONNX model. The first load takes a little longer…');
    return loadAllenkFdncnnRuntime(runtimeProfile, signal);
}

function getAllenkFdncnnTemporalReuseConfig(runtime) {
    if (!runtime || runtime.executionProvider !== 'wasm') {
        return null;
    }
    const hasThreadedWasm = Boolean(crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined');
    return {
        maxFrames: hasThreadedWasm ? 1 : 2,
        threshold: hasThreadedWasm ? 4.5 : 6.5
    };
}

function resolveDetectionAllenkFdncnnSigma(detection) {
    if (Number.isFinite(window.__gwrVideoOverrideAllenkFdncnnSigma)) {
        return Math.max(0, Math.min(150, window.__gwrVideoOverrideAllenkFdncnnSigma));
    }
    if (detection?.watermarkKind === 'veo-text') {
        return detection.template?.cleanup?.runtimeFdncnnSigma ?? 75;
    }
    return 75;
}

function resolveDetectionAllenkFdncnnPadding(detection, runtimeProfile) {
    if (Number.isFinite(window.__gwrVideoOverrideAllenkFdncnnPadding)) {
        return Math.max(0, Math.round(window.__gwrVideoOverrideAllenkFdncnnPadding));
    }
    if (detection?.watermarkKind === 'veo-text' && Number.isFinite(detection.template?.cleanup?.allenkFdncnnPadding)) {
        return detection.template.cleanup.allenkFdncnnPadding;
    }
    return runtimeProfile.padding;
}

function setProgress(progress, label) {
    const pct = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress * 100))) : 0;
    els.progressBar.style.width = `${pct}%`;
    els.progressText.textContent = label || `${pct}%`;
}

function yieldToBrowserFrame() {
    return new Promise((resolve) => {
        const finish = () => setTimeout(resolve, 0);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(finish);
        } else {
            finish();
        }
    });
}

function createDetectionProgressHandler(jobId, { start = 0, span = 1 } = {}) {
    return ({ progress = 0, step = 'detect', sampledFrames = 0, sampleCount = 0 } = {}) => {
        if (jobId !== state.jobId) return;
        const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
        const labelByStep = {
            metadata: 'Reading video',
            sample: sampleCount > 0 ? `Sampling frames ${sampledFrames}/${sampleCount}` : 'Sampling frames',
            score: 'Matching watermark',
            done: 'Detection complete'
        };
        setProgress(start + safeProgress * span, labelByStep[step] || 'Detecting');
        if (step === 'sample') {
            setStatus(sampleCount > 0
                ? `Sampling frames to detect the watermark: ${sampledFrames}/${sampleCount}`
                : 'Sampling frames to detect the watermark…');
        } else if (step === 'score') {
            setStatus('Matching watermark candidates. The page stays responsive…');
        }
    };
}

function formatSeconds(value) {
    if (!Number.isFinite(value)) return 'Unknown';
    return `${value.toFixed(2)}s`;
}

function formatBitrate(value) {
    if (!Number.isFinite(value)) return 'Unknown';
    return `${(value / 1000 / 1000).toFixed(2)} Mbps`;
}

function formatPlaybackTime(value) {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const totalSeconds = Math.floor(value);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateButtons() {
    const hasFile = Boolean(state.file);
    els.detectBtn.disabled = !hasFile || state.running || batch.processing;
    els.processBtn.disabled = !hasFile || state.running || batch.processing;
    const canDownload = Boolean(state.processedUrl) && !state.running;
    els.downloadBtn.setAttribute('aria-disabled', canDownload ? 'false' : 'true');
    els.downloadBtn.tabIndex = canDownload ? 0 : -1;
    els.resetBtn.disabled = state.running || batch.processing;
    els.cancelBtn.disabled = !state.controller || state.controller.signal.aborted;
    els.fileInput.disabled = Boolean(state.controller?.signal.aborted) || (state.running && !batch.processing);
    updatePlaybackControls();
}

function hasPlayableOriginal() {
    return Boolean(state.originalUrl) && Number.isFinite(els.originalVideo.duration);
}

function hasPlayableProcessed() {
    return Boolean(state.processedUrl);
}

function updatePlaybackControls() {
    const canPlay = Boolean(state.originalUrl);
    els.playPauseBtn.disabled = !canPlay;
    els.scrubber.disabled = !canPlay;
    els.playPauseBtn.dataset.playing = els.originalVideo.paused ? 'false' : 'true';
    els.playPauseBtn.setAttribute('aria-label', els.originalVideo.paused ? 'Play' : 'Pause');

    const duration = Number.isFinite(els.originalVideo.duration) ? els.originalVideo.duration : 0;
    const currentTime = Number.isFinite(els.originalVideo.currentTime) ? els.originalVideo.currentTime : 0;
    if (duration > 0 && !els.scrubber.matches(':active')) {
        els.scrubber.value = String(Math.round((currentTime / duration) * 1000));
    }
    els.timeLabel.textContent = duration > 0
        ? `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`
        : formatPlaybackTime(currentTime);
}

function updateCompareMode() {
    const hasAfter = hasPlayableProcessed();
    els.afterBadge.hidden = !hasAfter;
    els.processedEmpty.hidden = hasAfter;
}

function syncProcessedToOriginal({ force = false } = {}) {
    if (!hasPlayableProcessed() || state.syncingPlayback) return;
    const targetTime = Number(els.originalVideo.currentTime) || 0;
    if (!force && Math.abs((Number(els.processedVideo.currentTime) || 0) - targetTime) < 0.08) return;

    state.syncingPlayback = true;
    try {
        els.processedVideo.currentTime = targetTime;
    } catch (error) {
        console.warn('sync processed video failed:', error);
    } finally {
        state.syncingPlayback = false;
    }
}

async function playComparison() {
    if (!state.originalUrl) return;
    syncProcessedToOriginal({ force: true });
    try {
        await els.originalVideo.play();
        if (hasPlayableProcessed()) {
            await els.processedVideo.play().catch((error) => {
                console.warn('processed video play failed:', error);
            });
        }
    } catch (error) {
        console.warn('original video play failed:', error);
        setStatus('The browser blocked playback. Please press Play again.', 'warn');
    } finally {
        updatePlaybackControls();
    }
}

function pauseComparison() {
    els.originalVideo.pause();
    els.processedVideo.pause();
    updatePlaybackControls();
}

function togglePlayback() {
    if (els.originalVideo.paused) {
        playComparison();
    } else {
        pauseComparison();
    }
}

function seekComparison(value) {
    const duration = Number(els.originalVideo.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const currentTime = (Number(value) / 1000) * duration;
    els.originalVideo.currentTime = currentTime;
    syncProcessedToOriginal({ force: true });
    updatePlaybackControls();
}

function renderAutoPresetSummary(preset = null) {
    if (!els.autoPresetSummary) return;
    if (!preset) {
        els.autoPresetSummary.innerHTML = `
            <strong>AI cleanup</strong>
            <span>The watermark is detected automatically when you choose a video, and a local AI model cleans it up on export.</span>
        `;
        return;
    }

    els.autoPresetSummary.innerHTML = `
        <strong>${preset.label}</strong>
        <span>${preset.description}</span>
    `;
}

function renderMetadata(metadata) {
    if (!metadata) {
        els.metadata.innerHTML = '<p class="muted">Waiting for a video</p>';
        return;
    }
    const reference = isReferenceGeminiVideoSize(metadata.width, metadata.height);
    els.metadata.innerHTML = `
        <dl>
            <div><dt>Size</dt><dd>${metadata.width} x ${metadata.height}</dd></div>
            <div><dt>Duration</dt><dd>${formatSeconds(metadata.duration)}</dd></div>
            <div><dt>Frame rate</dt><dd>${metadata.frameRate.toFixed(2)} fps</dd></div>
            <div><dt>Video bitrate</dt><dd>${formatBitrate(metadata.averageBitrate)}</dd></div>
            <div><dt>Watermark spec</dt><dd>${reference ? '1920x1080 confirmed' : 'Inferred (experimental)'}</dd></div>
        </dl>
    `;
}

function renderDetection(detection) {
    if (!detection) {
        els.detection.innerHTML = '<p class="muted">Detect first, or export directly</p>';
        return;
    }

    const best = detection.summary?.best || {};
    const bestLabel = detection.watermarkKind === 'veo-text'
        ? (best.templateId || detection.template?.id || 'Veo text')
        : (best.label || best.candidateId || detection.candidate?.label || 'unknown');
    const bestScore = Number.isFinite(best.meanConfidence)
        ? best.meanConfidence
        : Number.isFinite(best.meanNcc)
            ? best.meanNcc
            : null;
    els.detection.innerHTML = `
        <dl>
            <div><dt>Candidate</dt><dd>${bestLabel}</dd></div>
            <div><dt>Position</dt><dd>${detection.position.x}, ${detection.position.y}</dd></div>
            <div><dt>Size</dt><dd>${detection.position.width} x ${detection.position.height}</dd></div>
            <div><dt>Mean score</dt><dd>${Number.isFinite(bestScore) ? bestScore.toFixed(3) : '-'}</dd></div>
            <div><dt>Votes</dt><dd>${best.votes || 0}/${detection.summary?.frameCount || 0}</dd></div>
            <div><dt>Status</dt><dd>${detection.isConfident ? 'Ready to export' : 'Low confidence'}</dd></div>
        </dl>
    `;
}

function cleanupUrls() {
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.processedUrl) URL.revokeObjectURL(state.processedUrl);
    state.originalUrl = null;
    state.processedUrl = null;
}

async function setFile(file) {
    const fileKind = getDebugFileKind(file);
    if (fileKind === 'image') {
        await routeImageFile(file);
        return;
    }
    if (fileKind !== 'video') {
        setStatus('Please choose an image or video. Videos are processed here; images go back to the image page.', 'warn');
        return;
    }

    cleanupUrls();
    state.file = file;
    state.metadata = null;
    state.detection = null;
    state.processedUrl = null;
    state.jobId++;

    state.originalUrl = URL.createObjectURL(file);
    els.originalVideo.src = state.originalUrl;
    els.originalVideo.currentTime = 0;
    els.processedVideo.removeAttribute('src');
    els.processedVideo.load();
    els.downloadBtn.removeAttribute('href');
    els.downloadBtn.removeAttribute('download');
    els.originalEmpty.hidden = true;
    updateCompareMode();
    renderMetadata(null);
    renderDetection(null);
    setProgress(0, 'Ready');
    setStatus('Reading video metadata…');
    updateButtons();

    try {
        const metadata = await inspectGeminiVideoFile(file);
        state.metadata = metadata;
        renderMetadata(metadata);
        applyAutomaticPreset(null, metadata, { silent: true });
        setStatus('Video loaded. Click Export to remove the watermark with AI.');
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Could not read the video', 'error');
    } finally {
        updateButtons();
    }
}

async function routeImageFile(file) {
    try {
        setStatus('Opening the image page…');
        await saveDebugFileHandoff(file, 'image');
        window.location.assign('./dev-preview.html?fileHandoff=1');
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Could not open the image page. Open it and choose the file again.', 'warn');
    }
}

function getDebugAlphaOptions() {
    return {
        alphaProfile: typeof window.__gwrVideoAlphaProfile === 'string'
            ? window.__gwrVideoAlphaProfile
            : undefined,
        alphaLowScale: Number.isFinite(window.__gwrVideoAlphaLowScale)
            ? window.__gwrVideoAlphaLowScale
            : undefined,
        alphaBodyScale: Number.isFinite(window.__gwrVideoAlphaBodyScale)
            ? window.__gwrVideoAlphaBodyScale
            : undefined,
        alphaEdgeBoost: Number.isFinite(window.__gwrVideoAlphaEdgeBoost)
            ? window.__gwrVideoAlphaEdgeBoost
            : undefined,
        alphaLocalRegion: typeof window.__gwrVideoAlphaLocalRegion === 'string'
            ? window.__gwrVideoAlphaLocalRegion
            : undefined,
        alphaLocalLowScale: Number.isFinite(window.__gwrVideoAlphaLocalLowScale)
            ? window.__gwrVideoAlphaLocalLowScale
            : undefined,
        alphaLocalBodyScale: Number.isFinite(window.__gwrVideoAlphaLocalBodyScale)
            ? window.__gwrVideoAlphaLocalBodyScale
            : undefined
    };
}

async function runDetection() {
    if (!state.file || state.running) return;
    const controller = new AbortController();
    state.controller = controller;
    const jobId = ++state.jobId;
    state.running = true;
    updateButtons();
    setProgress(0.05, 'Detecting');
    setStatus('Sampling frames to detect the bottom-right watermark…');

    try {
        await yieldToBrowserFrame();
        const result = await detectGeminiVideoWatermark(state.file, {
            signal: controller.signal,
            ...getDebugAlphaOptions(),
            sampleCount: Number(els.sampleCount.value) || DEFAULT_SAMPLE_COUNT,
            onProgress: createDetectionProgressHandler(jobId, { start: 0.05, span: 0.9 }),
            yieldToMainThread: yieldToBrowserFrame
        });
        controller.signal.throwIfAborted();
        if (jobId !== state.jobId) return;
        state.metadata = result.metadata;
        state.detection = result.detection;
        renderMetadata(result.metadata);
        renderDetection(result.detection);
        setProgress(1, result.detection.isConfident ? 'Detection complete' : 'Low confidence');
        const preset = applyAutomaticPreset(result.detection, result.metadata, { silent: true });
        if (preset.id === 'relocated-review') {
            setStatus('Detection complete. AI removal will be used on export.', result.detection.isConfident ? 'success' : 'warn');
        } else {
            setStatus(result.detection.isConfident ? 'Detection complete. AI removal will be used on export.' : 'Detection confidence is low, but you can still try the AI export.', result.detection.isConfident ? 'success' : 'warn');
        }
    } catch (error) {
        if (!controller.signal.aborted) {
            console.error(error);
            setStatus(error.message || 'Detection failed', 'error');
            setProgress(0, 'Detection failed');
        }
    } finally {
        state.running = false;
        state.controller = null;
        if (controller.signal.aborted) finishCancellation();
        updateButtons();
    }
}

async function runExport(signal) {
    if (!state.file || state.running) return;
    const controller = signal ? null : new AbortController();
    if (controller) state.controller = controller;
    signal ??= controller.signal;
    const jobId = ++state.jobId;
    state.running = true;
    updateButtons();
    setProgress(0, 'Starting');
    setStatus('Processing frame by frame on your device. Keep this page open.');

    try {
        signal.throwIfAborted();
        let detectionPayload = state.detection ? { metadata: state.metadata, detection: state.detection } : null;
        if (!detectionPayload) {
            setProgress(0.04, 'Detecting');
            setStatus('Detecting watermark candidates…');
            await yieldToBrowserFrame();
            const detected = await detectGeminiVideoWatermark(state.file, {
                signal,
                ...getDebugAlphaOptions(),
                sampleCount: Number(els.sampleCount.value) || DEFAULT_SAMPLE_COUNT,
                onProgress: createDetectionProgressHandler(jobId, { start: 0.04, span: 0.08 }),
                yieldToMainThread: yieldToBrowserFrame
            });
            if (jobId !== state.jobId) return;
            state.metadata = detected.metadata;
            state.detection = detected.detection;
            renderMetadata(detected.metadata);
            renderDetection(detected.detection);
            detectionPayload = { metadata: detected.metadata, detection: detected.detection };
            applyAutomaticPreset(detected.detection, detected.metadata, { silent: true });
        } else {
            applyAutomaticPreset(detectionPayload.detection, detectionPayload.metadata, { silent: true });
        }
        applyDebugControlOverrides();
        const denoiseBackend = els.denoiseBackend.value || DEFAULT_DENOISE_BACKEND;
        const allenkFdncnnRuntimeProfile = resolveAllenkFdncnnRuntimeProfile(detectionPayload?.detection?.position);
        const allenkFdncnnSigma = resolveDetectionAllenkFdncnnSigma(detectionPayload?.detection);
        const allenkFdncnnPadding = resolveDetectionAllenkFdncnnPadding(
            detectionPayload?.detection,
            allenkFdncnnRuntimeProfile
        );
        const allenkFdncnnRuntime = await resolveExportDenoiseRuntime(denoiseBackend, allenkFdncnnRuntimeProfile, signal);
        signal.throwIfAborted();
        const allenkFdncnnTemporalReuse = getAllenkFdncnnTemporalReuseConfig(allenkFdncnnRuntime);
        const debugAlphaOptions = getDebugAlphaOptions();
        if (jobId !== state.jobId) return;

        const result = await removeGeminiVideoWatermark(state.file, {
            signal,
            alphaGain: Number(els.alphaGain.value) || DEFAULT_ALPHA_GAIN,
            adaptiveAlpha: els.adaptiveAlpha.checked,
            highQualityCleanup: els.highQualityCleanup.checked,
            denoiseBackend,
            edgeDenoiseStrength: Number(els.edgeDenoiseStrength.value) || 0,
            residualCleanupStrength: Number(els.residualCleanup.value) || 0,
            videoBitrate: Number(els.videoBitrateMbps.value) > 0
                ? Number(els.videoBitrateMbps.value) * 1000 * 1000
                : DEFAULT_VIDEO_BITRATE,
            ...debugAlphaOptions,
            sampleCount: Number(els.sampleCount.value) || DEFAULT_SAMPLE_COUNT,
            detection: detectionPayload,
            allowLowConfidence: els.allowLowConfidence.checked,
            allenkFdncnnRuntime,
            allenkFdncnnSigma,
            allenkFdncnnPadding,
            allenkFdncnnTemporalReuse,
            yieldToMainThread: yieldToBrowserFrame,
            onProgress: ({ phase, progress, processedFrames, frameEstimate, metadata, detection, aiDenoiseFrames, aiReuseFrames }) => {
                signal.throwIfAborted();
                if (jobId !== state.jobId) return;
                const cliProgress = phase === 'detect'
                    ? progress * 0.12
                    : 0.12 + progress * 0.88;
                window.__gwrVideoCliProgress = {
                    phase,
                    progress: cliProgress,
                    processedFrames,
                    frameEstimate,
                    aiDenoiseFrames,
                    aiReuseFrames
                };
                if (metadata) {
                    state.metadata = metadata;
                    renderMetadata(metadata);
                }
                if (detection) {
                    state.detection = detection;
                    renderDetection(detection);
                }
                if (phase === 'detect') {
                    setProgress(progress * 0.12, progress >= 1 ? 'Detection complete' : 'Detecting');
                } else if (phase === 'export') {
                    const exportProgress = 0.12 + progress * 0.88;
                    const frames = Number.isFinite(processedFrames) ? `${processedFrames} frames` : 'processing';
                    const aiNote = '';
                    setProgress(exportProgress, `Exporting ${frames}`);
                    setStatus(`Exporting video: ${frames} processed${aiNote}.`);
                }
            }
        });
        signal.throwIfAborted();
        if (jobId !== state.jobId) return;

        if (state.processedUrl) URL.revokeObjectURL(state.processedUrl);
        state.processedUrl = URL.createObjectURL(result.blob);
        els.processedVideo.src = state.processedUrl;
        els.processedVideo.load();
        els.processedEmpty.hidden = true;
        updateCompareMode();
        syncProcessedToOriginal({ force: true });
        els.downloadBtn.href = state.processedUrl;
        els.downloadBtn.download = `${state.file.name.replace(/\.[^.]+$/, '')}_unmarked.mp4`;
        setProgress(1, 'Done');
        const audioNote = result.audioCopied
            ? `Audio kept: ${result.audioCodec || 'unknown'}, ${result.audioPacketCount || 0} packets.`
            : `Audio not kept: ${result.audioSkipReason || 'unknown'}.`;
        const cleanupNote = result.denoiseBackend === VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
            ? 'AI watermark removal complete'
            : 'Watermark removal complete';
        const aiNote = '';
        setStatus(`${cleanupNote}: ${result.processedFrames} frames processed. ${audioNote}`, 'success');
    } catch (error) {
        if (!signal.aborted) {
            console.error(error);
            setStatus(error.message || 'Export failed', 'error');
        }
    } finally {
        state.running = false;
        if (controller) {
            state.controller = null;
            if (signal.aborted) finishCancellation();
        }
        updateButtons();
    }
}

// --- Batch processing (multiple videos, one at a time) ---
// Video decode/encode is CPU/GPU-bound, so sequential processing through the
// existing single-file pipeline is the correct design, not a compromise.
const batch = createBatchQueue();

function batchStatusLabel(status) {
    switch (status) {
        case 'pending': return 'Queued';
        case 'processing': return 'Processing…';
        case 'done': return 'Done ✓';
        case 'error': return 'Failed ✗';
        case 'skipped': return 'Skipped';
        default: return '';
    }
}

function renderBatchQueue() {
    const box = els.batchQueue;
    if (!box) return;
    if (batch.items.length === 0) {
        box.hidden = true;
        box.replaceChildren();
        return;
    }
    box.hidden = false;
    box.replaceChildren(...batch.items.map((item, index) => {
        const row = document.createElement('div');
        row.className = 'batch-item';
        row.dataset.status = item.status;
        const name = document.createElement('span');
        name.className = 'batch-name';
        name.textContent = `${index + 1}. ${item.file.name}`;
        const stateLabel = document.createElement('span');
        stateLabel.className = 'batch-state';
        stateLabel.textContent = batchStatusLabel(item.status);
        row.append(name, stateLabel);
        return row;
    }));
}

function triggerDownload(href, filename) {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

async function exportQueuedVideo(file, signal) {
    await setFile(file);
    signal.throwIfAborted();
    if (getDebugFileKind(file) !== 'video' || !state.file) return { skipped: true };

    await runExport(signal);
    signal.throwIfAborted();
    const href = els.downloadBtn.getAttribute('href');
    if (!state.processedUrl || !href) return { ok: false };

    return {
        ok: true,
        href,
        filename: els.downloadBtn.getAttribute('download') || `${file.name}.mp4`
    };
}

async function runBatch() {
    if (batch.processing) return;
    const controller = new AbortController();
    state.controller = controller;
    const summary = await processBatchQueue(batch, {
        signal: controller.signal,
        processFile: exportQueuedVideo,
        downloadResult: ({ href, filename }) => triggerDownload(href, filename),
        onChange: renderBatchQueue,
        onError: (error) => console.error(error)
    });
    state.controller = null;
    updateButtons();
    if (controller.signal.aborted) {
        finishCancellation();
        return;
    }
    if (!summary) return;

    setStatus(
        `Batch complete: ${summary.done}/${summary.total} succeeded. Results were downloaded automatically.`,
        summary.done ? 'success' : 'warn'
    );
}

function handleIncomingFiles(fileList) {
    if (state.controller?.signal.aborted || (state.running && !batch.processing)) return;
    const list = Array.from(fileList || []).filter(Boolean);
    const videoFiles = list.filter((file) => getDebugFileKind(file) === 'video');

    // Drop a finished queue before anything else, so completed rows never leak
    // into the next selection — batch or single-file.
    startBatchSelection(batch);

    if (videoFiles.length > 1 || (batch.processing && videoFiles.length === 1)) {
        enqueueBatchFiles(batch, videoFiles);
        renderBatchQueue();
        runBatch();
        return;
    }

    // Single video (or an image handoff): keep the original single-file behavior
    // so preset tuning and manual export still work. Rendering the now-empty
    // queue hides any stale batch UI.
    renderBatchQueue();
    if (batch.processing) return;
    const file = pickDebugUploadFile(fileList);
    if (file) setFile(file);
}

function reset() {
    state.jobId++;
    startBatchSelection(batch);
    renderBatchQueue();
    cleanupUrls();
    state.file = null;
    state.metadata = null;
    state.detection = null;
    state.running = false;
    els.fileInput.value = '';
    els.originalVideo.removeAttribute('src');
    els.originalVideo.load();
    els.processedVideo.removeAttribute('src');
    els.processedVideo.load();
    els.downloadBtn.removeAttribute('href');
    els.downloadBtn.removeAttribute('download');
    els.originalEmpty.hidden = false;
    updateCompareMode();
    renderMetadata(null);
    renderDetection(null);
    renderAutoPresetSummary(null);
    setProgress(0, 'Waiting for video');
    setStatus('');
    updateButtons();
}

function cancelProcessing() {
    if (!state.controller || state.controller.signal.aborted) return;
    state.controller.abort();
    setStatus('Stopping and releasing resources…');
    updateButtons();
}

function finishCancellation() {
    reset();
    setStatus('Stopped. The rest of the queue was cancelled; files already downloaded are not affected.');
    setProgress(0, 'Cancelled');
}

function setNumberControl(input, value) {
    if (input.hasAttribute('max') && Number(value) > Number(input.getAttribute('max'))) {
        input.setAttribute('max', String(value));
    }
    input.value = String(value);
    if (input === els.alphaGain) {
        els.alphaGainValue.textContent = Number(input.value).toFixed(2);
    } else if (input === els.residualCleanup) {
        els.residualCleanupValue.textContent = Number(input.value).toFixed(2);
    } else if (input === els.edgeDenoiseStrength) {
        els.edgeDenoiseStrengthValue.textContent = Number(input.value).toFixed(2);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyPresetToControls(preset) {
    if (!preset) return;
    setNumberControl(els.alphaGain, preset.alphaGain ?? DEFAULT_ALPHA_GAIN);
    els.adaptiveAlpha.checked = preset.adaptiveAlpha ?? DEFAULT_ADAPTIVE_ALPHA;
    els.highQualityCleanup.checked = preset.highQualityCleanup ?? DEFAULT_HIGH_QUALITY_CLEANUP;
    els.denoiseBackend.value = Object.values(VIDEO_DENOISE_BACKENDS).includes(preset.denoiseBackend)
        ? preset.denoiseBackend
        : DEFAULT_DENOISE_BACKEND;
    els.denoiseBackend.dispatchEvent(new Event('change', { bubbles: true }));
    setNumberControl(els.edgeDenoiseStrength, preset.edgeDenoiseStrength ?? DEFAULT_EDGE_DENOISE_STRENGTH);
    setNumberControl(els.residualCleanup, preset.residualCleanupStrength ?? DEFAULT_RESIDUAL_CLEANUP_STRENGTH);
    els.sampleCount.value = String(preset.sampleCount ?? DEFAULT_SAMPLE_COUNT);
    els.videoBitrateMbps.value = Number(preset.videoBitrateMbps) > 0
        ? String(preset.videoBitrateMbps)
        : '';
    els.allowLowConfidence.checked = preset.allowLowConfidence === true;
    renderAutoPresetSummary(preset);
}

function applyAutomaticPreset(detection = state.detection, metadata = state.metadata, { silent = false } = {}) {
    const preset = getAutomaticVideoPresetConfig(detection, metadata);
    applyPresetToControls(preset);
    if (!silent) {
        setStatus(`Auto-selected: ${preset.label}.`, preset.allowLowConfidence ? 'warn' : 'success');
    }
    return preset;
}

function applyDebugControlOverrides() {
    applyVideoAdaptiveAlphaDebugOverride({
        windowObject: window,
        adaptiveAlphaInput: els.adaptiveAlpha
    });
    if (typeof window.__gwrVideoOverrideDenoiseBackend === 'string') {
        if (els.denoiseBackend.value !== window.__gwrVideoOverrideDenoiseBackend) {
            els.denoiseBackend.value = window.__gwrVideoOverrideDenoiseBackend;
            els.denoiseBackend.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    if (typeof window.__gwrVideoOverrideAllowLowConfidence === 'boolean') {
        els.allowLowConfidence.checked = window.__gwrVideoOverrideAllowLowConfidence;
    }
    if (Number.isFinite(window.__gwrVideoOverrideEdgeDenoiseStrength)) {
        setNumberControl(
            els.edgeDenoiseStrength,
            Math.max(0, Math.min(3, window.__gwrVideoOverrideEdgeDenoiseStrength))
        );
    }
    if (Number.isFinite(window.__gwrVideoOverrideResidualCleanupStrength)) {
        setNumberControl(
            els.residualCleanup,
            Math.max(0, Math.min(1.8, window.__gwrVideoOverrideResidualCleanupStrength))
        );
    }
    applyVideoBitrateDebugOverride({
        windowObject: window,
        videoBitrateInput: els.videoBitrateMbps,
        setNumberControl
    });
}

function applyRelocatedReviewPreset() {
    const preset = getRelocatedReviewPresetConfig();
    applyPresetToControls(preset);
    setStatus('Applied the relocated-anchor review preset: Canvas footprint polish, 12 Mbps, low confidence allowed. This preset is for manual review, not the default.', 'warn');
}

function setupEvents() {
    els.dropzone.addEventListener('click', () => els.fileInput.click());
    els.dropzone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            els.fileInput.click();
        }
    });
    els.fileInput.addEventListener('change', (event) => {
        handleIncomingFiles(event.target.files);
    });

    for (const eventName of ['dragenter', 'dragover']) {
        els.dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            els.dropzone.dataset.dragging = 'true';
        });
    }
    for (const eventName of ['dragleave', 'drop']) {
        els.dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            els.dropzone.dataset.dragging = 'false';
        });
    }
    els.dropzone.addEventListener('drop', (event) => {
        handleIncomingFiles(event.dataTransfer?.files);
    });

    els.alphaGain.addEventListener('input', () => {
        els.alphaGainValue.textContent = Number(els.alphaGain.value).toFixed(2);
    });
    els.residualCleanup.addEventListener('input', () => {
        els.residualCleanupValue.textContent = Number(els.residualCleanup.value).toFixed(2);
    });
    els.edgeDenoiseStrength.addEventListener('input', () => {
        els.edgeDenoiseStrengthValue.textContent = Number(els.edgeDenoiseStrength.value).toFixed(2);
    });
    els.denoiseBackend.addEventListener('change', () => {
        if (els.denoiseBackend.value !== VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE) return;
        setNumberControl(els.edgeDenoiseStrength, 1.8);
    });
    els.detectBtn.addEventListener('click', runDetection);
    els.processBtn.addEventListener('click', () => runExport());
    els.cancelBtn.addEventListener('click', cancelProcessing);
    els.resetBtn.addEventListener('click', reset);
    els.relocatedReviewPresetBtn.addEventListener('click', applyRelocatedReviewPreset);
    els.downloadBtn.addEventListener('click', (event) => {
        if (!state.processedUrl || state.running) event.preventDefault();
    });
    els.playPauseBtn.addEventListener('click', togglePlayback);
    els.scrubber.addEventListener('input', (event) => {
        seekComparison(event.target.value);
    });
    els.originalVideo.addEventListener('loadedmetadata', () => {
        updatePlaybackControls();
    });
    els.originalVideo.addEventListener('timeupdate', () => {
        if (!els.originalVideo.paused) syncProcessedToOriginal();
        updatePlaybackControls();
    });
    els.originalVideo.addEventListener('pause', () => {
        if (!els.processedVideo.paused) els.processedVideo.pause();
        updatePlaybackControls();
    });
    els.originalVideo.addEventListener('ended', () => {
        pauseComparison();
    });
    els.processedVideo.addEventListener('loadedmetadata', () => {
        syncProcessedToOriginal({ force: true });
        updateCompareMode();
    });
    window.addEventListener('beforeunload', cleanupUrls);
}

async function consumePendingVideoHandoff() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fileHandoff') !== '1') return;

    try {
        const record = await consumeDebugFileHandoff('video');
        if (!record?.file) return;
        await setFile(record.file);
        window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.warn('video handoff unavailable:', error);
        setStatus(error.message || 'Could not read the stored video. Please choose the file again.', 'warn');
    }
}

async function init() {
    applyPresetToControls(getAutomaticVideoPresetConfig());

    if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) {
        setStatus('This browser does not support WebCodecs. Please use a recent Chrome or Edge.', 'error');
    }

    renderMetadata(null);
    renderDetection(null);
    updateCompareMode();
    setProgress(0, 'Waiting for video');
    setupEvents();
    updateButtons();
    await consumePendingVideoHandoff();
}

mountThemeSwitch(document.getElementById('themeSwitch'));
mountAccountMenu(document.getElementById('accountButton'));
init();
