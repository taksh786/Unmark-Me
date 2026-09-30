// Before / after compare for one image and its cleaned version.
//
// Left of the line is the original, right of it the cleaned result. Drag
// slowly and the line stays where you leave it; flick it and it glides to the
// edge you threw it at.
//
// The knob is exactly under the pointer; the two ends of the line follow on an
// under-damped spring, so a hard swing bends the line into a curve that settles
// straight when you stop. The original is clipped along the same curve, so the
// picture's edge bends with the line. Both pictures stay still and pixel-aligned
// the whole time; only the line and the cut move.

const MAX_BEND = 9;
const SPRING_STIFFNESS = 620;
const SPRING_DAMPING = 44;
const GLIDE_REMAINDER_PER_SECOND = 0.0004;
const FLICK_VELOCITY = 0.0025;
const KEY_STEP = 0.1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createImageCompare({
    container,
    beforeImage,
    grip,
    linePath,
    lineSvg,
    beforeTag,
    afterTag
}) {
    let position = 0.5;
    let target = null;
    let width = 0;
    let height = 0;
    let frame = 0;
    let active = false;
    let drag = null;
    const ends = { x: 0.5, velocity: 0 };

    function measure() {
        width = beforeImage.clientWidth;
        height = beforeImage.clientHeight;
        lineSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    function render() {
        const bend = active ? clamp((position - ends.x) * width * 0.5, -MAX_BEND, MAX_BEND) : 0;
        const x = position * width;
        const endX = (x - bend).toFixed(2);
        const controlX = (x + bend).toFixed(2);
        const curve = `${endX} 0 Q ${controlX} ${height / 2} ${endX} ${height}`;

        linePath.setAttribute('d', `M ${curve}`);
        beforeImage.style.clipPath = active
            ? `path("M 0 0 L ${curve} L 0 ${height} Z")`
            : '';
        grip.style.left = `${x}px`;
        beforeTag.style.opacity = String(clamp((position - 0.14) * 4, 0, 1));
        afterTag.style.opacity = String(clamp((0.86 - position) * 4, 0, 1));
        container.setAttribute('aria-valuenow', String(Math.round(position * 100)));
    }

    // One loop drives both motions: the glide toward a target, and the line's
    // ends catching up with the knob. It stops itself once everything is still.
    function loop() {
        if (frame) return;
        if (prefersReducedMotion()) {
            if (target !== null) position = target;
            target = null;
            ends.x = position;
            ends.velocity = 0;
            render();
            return;
        }
        let previous = performance.now();
        const step = (now) => {
            const dt = Math.min(0.033, (now - previous) / 1000);
            previous = now;
            if (target !== null) {
                position += (target - position) * (1 - Math.pow(GLIDE_REMAINDER_PER_SECOND, dt));
                if (Math.abs(target - position) < 0.0005) {
                    position = target;
                    target = null;
                }
            }
            ends.velocity += ((position - ends.x) * SPRING_STIFFNESS - ends.velocity * SPRING_DAMPING) * dt;
            ends.x += ends.velocity * dt;
            const still = target === null &&
                Math.abs(position - ends.x) < 0.0006 &&
                Math.abs(ends.velocity) < 0.002;
            if (still) {
                ends.x = position;
                ends.velocity = 0;
                render();
                frame = 0;
                return;
            }
            render();
            frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
    }

    function glide(to) {
        target = clamp(to, 0, 1);
        loop();
    }

    // Under the pointer the knob is drawn this frame; only the ends are left to the loop.
    function place(to) {
        target = null;
        position = clamp(to, 0, 1);
        render();
        loop();
    }

    function positionAt(clientX) {
        const rect = beforeImage.getBoundingClientRect();
        return rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : position;
    }

    container.addEventListener('pointerdown', (event) => {
        if (!active || event.button !== 0) return;
        try {
            container.setPointerCapture(event.pointerId);
        } catch {
            // A scripted pointer cannot be captured.
        }
        const at = positionAt(event.clientX);
        drag = { id: event.pointerId, velocity: 0, time: performance.now(), last: at };
        container.dataset.held = 'true';
        glide(at);
    });

    container.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const at = positionAt(event.clientX);
        const now = performance.now();
        drag.velocity = (at - drag.last) / Math.max(1, now - drag.time);
        drag.time = now;
        drag.last = at;
        place(at);
    });

    const release = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const { velocity } = drag;
        drag = null;
        delete container.dataset.held;
        // A flick carries the line to the edge it was thrown at.
        if (event.type === 'pointerup' && Math.abs(velocity) > FLICK_VELOCITY) {
            glide(velocity > 0 ? 1 : 0);
        }
    };
    container.addEventListener('pointerup', release);
    container.addEventListener('pointercancel', release);

    container.addEventListener('keydown', (event) => {
        if (!active) return;
        const from = target ?? position;
        const next = {
            ArrowLeft: from - KEY_STEP,
            ArrowDown: from - KEY_STEP,
            ArrowRight: from + KEY_STEP,
            ArrowUp: from + KEY_STEP,
            Home: 0,
            End: 1
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        glide(next);
    });

    new ResizeObserver(() => {
        measure();
        render();
    }).observe(beforeImage);

    return {
        // The cleaned result is ready: reveal it from the right, settling at the middle.
        activate() {
            active = true;
            container.tabIndex = 0;
            measure();
            position = 1;
            ends.x = 1;
            render();
            glide(0.5);
        },
        reset() {
            active = false;
            cancelAnimationFrame(frame);
            frame = 0;
            target = null;
            drag = null;
            position = 0.5;
            ends.x = 0.5;
            ends.velocity = 0;
            container.tabIndex = -1;
            delete container.dataset.held;
            render();
        }
    };
}
