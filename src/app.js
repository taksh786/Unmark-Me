import {
    WatermarkEngine,
    detectWatermarkConfig,
    calculateWatermarkPosition
} from './core/watermarkEngine.js';
import { WatermarkWorkerClient, canUseWatermarkWorker } from './core/workerClient.js';
import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo,
    resolveProcessedStatusPresentation
} from './core/watermarkDisplay.js';
import { canvasToBlob } from './core/canvasBlob.js';
import {
    loadImage,
    setStatusMessage,
    showLoading,
    hideLoading
} from './utils.js';
import {
    consumeDebugFileHandoff,
    getDebugFileKind,
    saveDebugFileHandoff
} from './shared/debugFileHandoff.js';
import { mountAccountMenu } from './shared/accountMenu.js';
import { createImageCompare } from './shared/imageCompare.js';
import { mountThemeSwitch } from './shared/themeSwitch.js';

const TEXT = {
    loading: 'Loading resources…',
    size: 'Size',
    watermark: 'Detected watermark',
    position: 'Position',
    status: 'Status',
    removed: 'Watermark removed',
    skipped: 'No removable watermark found. The original was kept.',
    visibleResidual: 'Processed. Faint traces may still be visible.',
    possibleContentDamage: 'Best result generated. Please check the watermark area.',
    mixedQualityWarning: 'Best result generated. There may be faint traces or slight distortion.',
    unsupported: 'Your browser does not support copying images.',
    copied: 'Copied!',
    copyFailed: 'Copy failed',
    unsupportedFile: 'Please choose a JPG, PNG or WebP image, or an MP4, WebM or MOV video.',
    fileTooLarge: 'Images larger than 20MB are not supported. Videos open in the video workflow.',
    skippedLargeImages: 'Skipped images larger than 20MB.',
    handoffVideo: 'Opening the video workflow…',
    progress: 'Progress',
    pending: 'Waiting',
    loadingImage: 'Reading image…',
    processing: 'Processing…',
    processFailed: 'Processing failed'
};

let enginePromise = null;
let workerClient = null;
let currentItem = null;
let imageQueue = [];
let processedCount = 0;
let activeBatchId = 0;

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const originalImage = document.getElementById('originalImage');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const batchResetBtn = document.getElementById('batchResetBtn');
const processedOverlay = document.getElementById('processedOverlay');
const sliderHandle = document.getElementById('sliderHandle');
const comparisonContainer = document.getElementById('comparisonContainer');
let imageCompare = null;

async function getEngine() {
    if (!enginePromise) {
        enginePromise = WatermarkEngine.create().catch((error) => {
            enginePromise = null;
            throw error;
        });
    }
    return enginePromise;
}

function getEstimatedWatermarkInfo(item) {
    if (!item?.originalImg) return null;
    const { width, height } = item.originalImg;
    const config = detectWatermarkConfig(width, height);
    const position = calculateWatermarkPosition(width, height, config);
    return {
        size: config.logoSize,
        position,
        config
    };
}

function disableWorkerClient(reason) {
    if (!workerClient) return;
    console.warn('disable worker path, fallback to main thread:', reason);
    workerClient.dispose();
    workerClient = null;
}

function cleanupCurrentItem() {
    if (!currentItem) return;
    if (currentItem.originalUrl) URL.revokeObjectURL(currentItem.originalUrl);
    if (currentItem.processedUrl) URL.revokeObjectURL(currentItem.processedUrl);
    currentItem = null;
}

function cleanupBatchItems() {
    activeBatchId++;
    imageQueue.forEach((item) => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
    });
    imageQueue = [];
    processedCount = 0;
}

async function init() {
    try {
        showLoading(TEXT.loading);

        if (canUseWatermarkWorker()) {
            try {
                workerClient = new WatermarkWorkerClient({
                    workerUrl: './workers/watermark-worker.js'
                });
            } catch (workerError) {
                console.warn('worker unavailable, fallback to main thread:', workerError);
                workerClient = null;
            }
        }

        if (!workerClient) {
            getEngine().catch((error) => {
                console.warn('main thread engine warmup failed:', error);
            });
        }

        hideLoading();
        setupEventListeners();
        setupImageCompare();
        await consumePendingImageHandoff();
    } catch (error) {
        hideLoading();
        console.error('initialize error:', error);
    }
}

function setupEventListeners() {
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    fileInput.addEventListener('change', handleFileSelect);

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('is-dragging');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.clientX === 0 && e.clientY === 0) {
            uploadArea.classList.remove('is-dragging');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('is-dragging');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    });

    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                files.push(items[i].getAsFile());
            }
        }
        if (files.length > 0) handleFiles(files);
    });

    resetBtn.addEventListener('click', reset);
    batchResetBtn.addEventListener('click', reset);
    window.addEventListener('beforeunload', () => {
        cleanupBatchItems();
        disableWorkerClient('beforeunload');
    });
}

function reset() {
    cleanupCurrentItem();
    cleanupBatchItems();
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'none';
    fileInput.value = '';
    imageList.innerHTML = '';
    updateProgress();
    originalImage.src = '';
    processedImage.src = '';
    originalInfo.innerHTML = '';
    originalInfo.style.display = '';
    processedInfo.innerHTML = '';
    processedInfo.style.display = 'none';
    delete singlePreview.dataset.state;
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    imageCompare?.reset();
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
    setStatusMessage('');
    setView('home');
}

// The page is a single-screen app: the hero shows on the home view and gives
// way to the result views, which size themselves to the viewport.
function setView(view) {
    document.body.dataset.view = view;
}

function handleFileSelect(e) {
    handleFiles(Array.from(e.target.files));
}

async function handleFiles(files) {
    setStatusMessage('');

    const list = Array.from(files || []).filter(Boolean);
    const videoFile = list.find((file) => getDebugFileKind(file) === 'video');
    if (videoFile) {
        await routeVideoFile(videoFile);
        return;
    }

    const imageFiles = list.filter((file) => getDebugFileKind(file) === 'image');
    if (imageFiles.length === 0) {
        setStatusMessage(TEXT.unsupportedFile, 'warn');
        return;
    }

    const validImageFiles = imageFiles.filter((file) => file.size <= 20 * 1024 * 1024);
    if (validImageFiles.length === 0) {
        setStatusMessage(TEXT.fileTooLarge, 'warn');
        return;
    }

    if (validImageFiles.length < imageFiles.length) {
        setStatusMessage(TEXT.skippedLargeImages, 'warn');
    }

    if (validImageFiles.length > 1) {
        processBatch(validImageFiles);
        return;
    }

    const validFile = validImageFiles[0];
    cleanupCurrentItem();
    cleanupBatchItems();
    multiPreview.style.display = 'none';
    imageList.innerHTML = '';
    currentItem = {
        id: Date.now(),
        file: validFile,
        name: validFile.name,
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };

    originalInfo.style.display = '';
    processedInfo.style.display = 'none';
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    imageCompare?.reset();
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
    singlePreview.dataset.state = 'processing';
    singlePreview.style.display = 'grid';
    setView('single');
    processSingle(currentItem);
}

function createDebugImageItem(file, index) {
    return {
        id: `${Date.now()}-${index}`,
        file,
        name: file.name,
        status: 'pending',
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };
}

function processBatch(files) {
    cleanupCurrentItem();
    cleanupBatchItems();

    imageQueue = files.map(createDebugImageItem);
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'flex';
    setView('batch');
    imageList.innerHTML = '';
    updateProgress();
    imageQueue.forEach((item) => createImageCard(item));

    const batchId = activeBatchId;
    processQueue(batchId);
}

async function routeVideoFile(file) {
    try {
        showLoading(TEXT.handoffVideo);
        await saveDebugFileHandoff(file, 'video');
        window.location.assign('./video-preview.html?fileHandoff=1');
    } catch (error) {
        hideLoading();
        console.error(error);
        setStatusMessage(error.message || 'Could not open the video workflow. Open the video page and choose the file again.', 'warn');
    }
}

async function consumePendingImageHandoff() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fileHandoff') !== '1') return;

    try {
        const record = await consumeDebugFileHandoff('image');
        if (!record?.file) return;
        await handleFiles([record.file]);
        window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.warn('image handoff unavailable:', error);
        setStatusMessage(error.message || 'Could not read the stored image. Please choose the file again.', 'warn');
    }
}

function renderSingleImageMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    if (!watermarkInfo) return;

    originalInfo.innerHTML = `
        <p class="meta-status is-processing"><span class="meta-status-icon" aria-hidden="true"></span>${TEXT.processing}</p>
        <p class="meta-row"><span>${TEXT.size}</span><span>${item.originalImg.width} × ${item.originalImg.height}</span></p>
        <p class="meta-row"><span>${TEXT.watermark}</span><span>${watermarkInfo.size} × ${watermarkInfo.size}</span></p>
        <p class="meta-row"><span>${TEXT.position}</span><span>${watermarkInfo.position.x}, ${watermarkInfo.position.y}</span></p>
    `;
}

function getProcessedStatusPresentation(item) {
    const presentation = resolveProcessedStatusPresentation(item);
    return {
        label: TEXT[presentation.messageKey],
        tone: presentation.tone
    };
}

function renderSingleProcessedMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);
    const statusPresentation = getProcessedStatusPresentation(item);

    const isWarning = statusPresentation.tone === 'warning';
    const statusIcon = isWarning
        ? '<path d="M12 7v6m0 4h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
        : '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';

    processedInfo.innerHTML = `
        <p class="meta-status${isWarning ? ' is-warning' : ''}"><span class="meta-status-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${statusIcon}</svg></span>${statusPresentation.label}</p>
        <p class="meta-row"><span>${TEXT.size}</span><span>${item.originalImg.width} × ${item.originalImg.height}</span></p>
        ${showWatermarkInfo ? `<p class="meta-row"><span>${TEXT.watermark}</span><span>${watermarkInfo.size} × ${watermarkInfo.size}</span></p>` : ''}
        ${showWatermarkInfo ? `<p class="meta-row"><span>${TEXT.position}</span><span>${watermarkInfo.position.x}, ${watermarkInfo.position.y}</span></p>` : ''}
    `;
}

async function processSingle(item) {
    try {
        const img = await loadImage(item.file);
        item.originalImg = img;
        item.originalUrl = img.src;

        originalImage.src = img.src;
        renderSingleImageMeta(item);

        const processed = await processImageWithBestPath(item.file, img);
        item.processedMeta = processed.meta;
        item.processedBlob = processed.blob;
        item.processedUrl = URL.createObjectURL(processed.blob);

        processedImage.src = item.processedUrl;
        processedOverlay.style.display = 'block';
        sliderHandle.style.display = 'block';
        originalInfo.style.display = 'none';
        processedInfo.style.display = 'block';
        singlePreview.dataset.state = 'done';
        imageCompare?.activate();

        copyBtn.style.display = 'flex';
        copyBtn.onclick = () => copyImage(item);

        downloadBtn.style.display = 'flex';
        downloadBtn.onclick = () => downloadImage(item);

        renderSingleProcessedMeta(item);
    } catch (error) {
        console.error(error);
        delete singlePreview.dataset.state;
        originalInfo.querySelector('.meta-status')?.remove();
        setStatusMessage(TEXT.processFailed, 'warn');
    }
}

function createImageCard(item) {
    const card = document.createElement('div');
    card.id = `card-${item.id}`;
    card.className = 'batch-card';
    card.innerHTML = `
        <div class="batch-comparison">
            <div class="batch-pane original">
                <span class="batch-pane-label">Original</span>
                <img id="original-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
            <div class="batch-pane processed">
                <span class="batch-pane-label">Cleaned</span>
                <img id="processed-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
        </div>
        <div class="batch-main">
            <h4 class="batch-title"></h4>
            <div class="batch-status" id="status-${item.id}"></div>
        </div>
        <div class="batch-actions">
            <button id="download-${item.id}" class="btn btn-primary btn-compact" style="display: none;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>
                <span>Download</span>
            </button>
            <button id="copy-${item.id}" class="btn btn-secondary btn-compact" style="display: none;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0013.5 4h-7A2.5 2.5 0 004 6.5v7A2.5 2.5 0 006.5 16H8"/></svg>
                <span>Copy</span>
            </button>
        </div>
    `;
    imageList.appendChild(card);

    const title = card.querySelector('.batch-title');
    title.textContent = typeof item.name === 'string' ? item.name : '';
    title.title = title.textContent;
    renderImageCardStatus(item);
}

function renderImageCardStatus(item) {
    const statusEl = document.getElementById(`status-${item.id}`);
    if (!statusEl) return;

    statusEl.classList.remove('text-primary', 'text-warning');
    if (item.status === 'completed') {
        const presentation = getProcessedStatusPresentation(item);
        statusEl.textContent = presentation.label;
        statusEl.classList.add(presentation.tone === 'warning' ? 'text-warning' : 'text-primary');
        return;
    }

    const labels = {
        pending: TEXT.pending,
        loading: TEXT.loadingImage,
        processing: TEXT.processing,
        error: TEXT.processFailed
    };
    statusEl.textContent = labels[item.status] || TEXT.pending;
}

function updateProgress() {
    progressText.textContent = `${TEXT.progress}: ${processedCount}/${imageQueue.length}`;
    const progressBar = document.getElementById('batchProgressBar');
    if (progressBar) {
        const pct = imageQueue.length ? (processedCount / imageQueue.length) * 100 : 0;
        progressBar.style.width = `${pct}%`;
    }
}

async function processQueue(batchId) {
    const concurrency = 3;
    for (let i = 0; i < imageQueue.length; i += concurrency) {
        if (batchId !== activeBatchId) return;

        await Promise.all(imageQueue.slice(i, i + concurrency).map(async (item) => {
            if (batchId !== activeBatchId || item.status !== 'pending') return;

            item.status = 'loading';
            renderImageCardStatus(item);

            try {
                const img = await loadImage(item.file);
                if (batchId !== activeBatchId) return;

                item.originalImg = img;
                item.originalUrl = img.src;
                const originalPreview = document.getElementById(`original-${item.id}`);
                const processedPreview = document.getElementById(`processed-${item.id}`);
                if (originalPreview) originalPreview.src = img.src;

                item.status = 'processing';
                renderImageCardStatus(item);

                const processed = await processImageWithBestPath(item.file, img);
                if (batchId !== activeBatchId) return;

                item.processedMeta = processed.meta;
                item.processedBlob = processed.blob;
                item.processedUrl = URL.createObjectURL(processed.blob);
                if (processedPreview) processedPreview.src = item.processedUrl;

                item.status = 'completed';
                processedCount++;
                renderImageCardStatus(item);
                updateProgress();

                const itemCopyBtn = document.getElementById(`copy-${item.id}`);
                if (itemCopyBtn) {
                    itemCopyBtn.style.display = 'inline-flex';
                    itemCopyBtn.onclick = () => copyImage(item, itemCopyBtn);
                }

                const itemDownloadBtn = document.getElementById(`download-${item.id}`);
                if (itemDownloadBtn) {
                    itemDownloadBtn.style.display = 'inline-flex';
                    itemDownloadBtn.onclick = () => downloadImage(item);
                }
            } catch (error) {
                if (batchId !== activeBatchId) return;
                item.status = 'error';
                renderImageCardStatus(item);
                console.error(error);
            }
        }));
    }
}

async function processImageWithBestPath(file, fallbackImage, options = {}) {
    if (workerClient) {
        try {
            return await workerClient.processBlob(file, options);
        } catch (error) {
            console.warn('worker process failed, fallback to main thread:', error);
            disableWorkerClient(error);
        }
    }

    const engine = await getEngine();
    const canvas = await engine.removeWatermarkFromImage(fallbackImage, options);
    const blob = await canvasToBlob(canvas);
    return {
        blob,
        meta: canvas.__watermarkMeta || null
    };
}

async function copyImage(item, targetBtn = copyBtn) {
    if (!navigator.clipboard || !window.ClipboardItem) {
        setStatusMessage(TEXT.unsupported, 'warn');
        return;
    }

    try {
        if (!item.processedBlob) return;
        const data = [new ClipboardItem({ [item.processedBlob.type]: item.processedBlob })];
        await navigator.clipboard.write(data);

        const span = targetBtn.querySelector('span');
        const svg = targetBtn.querySelector('svg');
        const originalLabel = span.textContent;
        const originalSvgPath = svg.innerHTML;

        span.textContent = TEXT.copied;
        svg.innerHTML = '<path d="M5 13l4 4L19 7"></path>';

        setTimeout(() => {
            span.textContent = originalLabel;
            svg.innerHTML = originalSvgPath;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy image: ', err);
        setStatusMessage(TEXT.copyFailed, 'warn');
    }
}

function downloadImage(item) {
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = `unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
}

function setupImageCompare() {
    imageCompare = createImageCompare({
        container: comparisonContainer,
        beforeImage: originalImage,
        afterLayer: processedOverlay,
        grip: sliderHandle,
        lineSvg: comparisonContainer.querySelector('.cmp-line'),
        linePath: comparisonContainer.querySelector('.cmp-line path'),
        beforeTag: comparisonContainer.querySelector('.cmp-tag-before'),
        afterTag: comparisonContainer.querySelector('.cmp-tag-after')
    });
}

mountThemeSwitch(document.getElementById('themeSwitch'));
mountAccountMenu(document.getElementById('accountButton'));
init();
