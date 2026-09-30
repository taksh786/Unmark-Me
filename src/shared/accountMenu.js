// Log in button, sign-in sheet and profile menu, shared by every page.
//
// Email sign-in uses a one-time code: the server emails a 6-digit code, the
// user types it here, and the server sets an HttpOnly session cookie (see
// src/server/auth.js). Google sign-in is not connected yet.
//
// Unmark Me keeps no history: the profile shows who you are and your plan,
// nothing about the files you process.

const GOOGLE_COMING_SOON = 'Google sign-in is coming soon. Use your email for now.';
const UNAVAILABLE = 'Sign-in is not available right now. Unmark Me works without an account in the meantime.';

async function callAuth(path, body) {
    let response;
    try {
        response = await fetch(`/api/auth/${path}`, body === undefined
            ? { credentials: 'same-origin', cache: 'no-store' }
            : {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
    } catch {
        return { ok: false, error: UNAVAILABLE };
    }
    const data = await response.json().catch(() => null);
    if (!data) return { ok: false, error: UNAVAILABLE };
    return response.ok ? { ok: true, ...data } : { ok: false, error: data.error || UNAVAILABLE };
}

function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

const PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.3-3.2 4-4.8 7-4.8s5.7 1.6 7 4.8"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 017 0v3"/></svg>';
const MAIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/></svg>';
const GOOGLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 01-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.2v2.8A11 11 0 0012 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 010-4.2V7.1H2.2a11 11 0 000 9.8l3.6-2.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 002.2 7.1l3.6 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const PRIVACY_NOTE = 'No history is kept. Your images and videos are processed on this device and never stored.';

function buildSignInSheet() {
    const dialog = document.createElement('dialog');
    dialog.className = 'auth-sheet';
    dialog.setAttribute('aria-labelledby', 'authTitle');
    // Content sits in an inner box so a click on the dialog itself means the backdrop.
    dialog.innerHTML = `<div class="auth-body">
        <button type="button" class="auth-close" aria-label="Close">${CLOSE_ICON}</button>
        <span class="auth-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3.5l-1.7 5.3-5.3 1.7 5.3 1.7 1.7 5.3 1.7-5.3 5.3-1.7-5.3-1.7z"/></svg>
        </span>
        <h2 id="authTitle" class="auth-title">Log in to Unmark Me</h2>
        <p class="auth-lede">Keep your plan with you on every device.</p>
        <div class="auth-step"></div>
        <p class="auth-status" role="status" aria-live="polite"></p>
        <p class="auth-privacy">${LOCK_ICON}<span>We only use your name and email to sign you in. ${PRIVACY_NOTE}</span></p>
    </div>`;
    return dialog;
}

const CHOOSE_STEP = `
    <div class="auth-options">
        <button type="button" class="auth-option" data-provider="google">${GOOGLE_ICON}<span>Continue with Google</span></button>
        <button type="button" class="auth-option" data-provider="email">${MAIL_ICON}<span>Continue with email</span></button>
    </div>`;

const EMAIL_STEP = `
    <form class="auth-form" novalidate>
        <label class="auth-label" for="authEmail">Email</label>
        <input id="authEmail" class="auth-input" type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
        <button type="submit" class="auth-submit">Send code</button>
        <button type="button" class="auth-link" data-action="back">Back</button>
    </form>`;

function codeStep(email) {
    return `
    <form class="auth-form" novalidate>
        <p class="auth-sent">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>.</p>
        <label class="auth-label" for="authCode">Code</label>
        <input id="authCode" class="auth-input auth-code" type="text" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" required>
        <button type="submit" class="auth-submit">Log in</button>
        <div class="auth-links">
            <button type="button" class="auth-link" data-action="resend">Send a new code</button>
            <button type="button" class="auth-link" data-action="change-email">Use a different email</button>
        </div>
    </form>`;
}

function buildProfilePopover() {
    const panel = document.createElement('div');
    panel.className = 'profile-popover';
    panel.id = 'profilePopover';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Your profile');
    return panel;
}

function renderProfile(panel, account) {
    panel.innerHTML = `
        <div class="profile-head">
            <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials(account.name))}</span>
            <div class="profile-id">
                <p class="profile-name">${escapeHtml(account.name)}</p>
                <p class="profile-email">${escapeHtml(account.email)}</p>
            </div>
        </div>
        <div class="profile-plan">
            <span class="profile-plan-label">Plan</span>
            <span class="profile-plan-badge">${escapeHtml(account.plan)}</span>
            <a class="profile-plan-link" href="./pricing.html">${account.plan === 'Free' ? 'Upgrade' : 'Change'}</a>
        </div>
        <div class="profile-actions">
            <a class="profile-action" href="./pricing.html">Manage plan</a>
            <button type="button" class="profile-action profile-logout">Log out</button>
        </div>
        <p class="profile-privacy">${LOCK_ICON}<span>${PRIVACY_NOTE}</span></p>
    `;
}

export function mountAccountMenu(button) {
    if (!button) return;

    const label = button.querySelector('.account-label');
    const sheet = buildSignInSheet();
    const popover = buildProfilePopover();
    const title = sheet.querySelector('.auth-title');
    const lede = sheet.querySelector('.auth-lede');
    const step = sheet.querySelector('.auth-step');
    const status = sheet.querySelector('.auth-status');
    document.body.append(sheet, popover);

    let account = null;
    let pendingEmail = '';

    function renderButton() {
        button.classList.toggle('is-signed-in', Boolean(account));
        if (account) {
            button.innerHTML = `<span class="account-initials" aria-hidden="true">${escapeHtml(initials(account.name))}</span>`;
            button.setAttribute('aria-label', `Profile: ${account.name}`);
            // The browser toggles the menu from its invoker, so a second click closes it.
            button.setAttribute('popovertarget', popover.id);
        } else {
            button.innerHTML = `${PERSON_ICON}<span class="account-label">${label?.textContent || 'Log in'}</span>`;
            button.setAttribute('aria-label', 'Log in');
            button.removeAttribute('popovertarget');
        }
        button.setAttribute('aria-haspopup', 'dialog');
    }

    function setStatus(message = '') {
        status.textContent = message;
    }

    // Disables the form while a request is in flight and shows progress on its button.
    async function busy(form, pendingLabel, task) {
        const submit = form.querySelector('.auth-submit');
        const idleLabel = submit.textContent;
        for (const control of form.elements) control.disabled = true;
        submit.textContent = pendingLabel;
        try {
            return await task();
        } finally {
            for (const control of form.elements) control.disabled = false;
            submit.textContent = idleLabel;
        }
    }

    function showChooseStep() {
        title.textContent = 'Log in to Unmark Me';
        lede.textContent = 'Keep your plan with you on every device.';
        step.innerHTML = CHOOSE_STEP;
        step.querySelector('[data-provider="google"]').addEventListener('click', () => setStatus(GOOGLE_COMING_SOON));
        step.querySelector('[data-provider="email"]').addEventListener('click', () => showEmailStep());
    }

    function showEmailStep() {
        title.textContent = 'Log in with email';
        lede.textContent = "We'll email you a code. No password needed.";
        step.innerHTML = EMAIL_STEP;
        setStatus('');
        const form = step.querySelector('form');
        const input = form.elements.email;
        input.value = pendingEmail;
        input.focus();
        form.querySelector('[data-action="back"]').addEventListener('click', () => {
            setStatus('');
            showChooseStep();
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const email = input.value.trim();
            if (!input.checkValidity() || !email) {
                setStatus('Enter a valid email address.');
                input.focus();
                return;
            }
            const result = await busy(form, 'Sending…', () => callAuth('email/start', { email }));
            if (!result.ok) {
                setStatus(result.error);
                input.focus();
                return;
            }
            pendingEmail = email;
            showCodeStep();
        });
    }

    function showCodeStep() {
        title.textContent = 'Check your email';
        lede.textContent = 'Enter the code to finish logging in.';
        step.innerHTML = codeStep(pendingEmail);
        setStatus('');
        const form = step.querySelector('form');
        const input = form.elements.code;
        input.focus();
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 6);
        });
        form.querySelector('[data-action="change-email"]').addEventListener('click', () => showEmailStep());
        form.querySelector('[data-action="resend"]').addEventListener('click', async () => {
            const result = await busy(form, 'Sending…', () => callAuth('email/start', { email: pendingEmail }));
            setStatus(result.ok ? 'A new code is on its way.' : result.error);
            input.value = '';
            input.focus();
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (input.value.length !== 6) {
                setStatus('Enter the 6-digit code from the email.');
                input.focus();
                return;
            }
            const result = await busy(form, 'Checking…', () => callAuth('email/verify', { email: pendingEmail, code: input.value }));
            if (!result.ok) {
                setStatus(result.error);
                input.select();
                return;
            }
            account = result.user;
            pendingEmail = '';
            sheet.close();
            renderButton();
            button.focus();
        });
    }

    // Anchor the profile menu to the button so it grows out of it.
    function placePopover() {
        const rect = button.getBoundingClientRect();
        popover.style.top = `${Math.round(rect.bottom + 10)}px`;
        popover.style.right = `${Math.max(12, Math.round(window.innerWidth - rect.right))}px`;
    }

    popover.addEventListener('beforetoggle', (event) => {
        if (event.newState !== 'open' || !account) return;
        renderProfile(popover, account);
        popover.querySelector('.profile-logout').addEventListener('click', async () => {
            await callAuth('logout', {});
            account = null;
            popover.hidePopover();
            renderButton();
            button.focus();
        });
        placePopover();
    });

    button.addEventListener('click', () => {
        if (account) return;
        setStatus('');
        showChooseStep();
        sheet.showModal();
    });

    sheet.querySelector('.auth-close').addEventListener('click', () => sheet.close());
    // Clicking the dimmed backdrop closes the sheet.
    sheet.addEventListener('click', (event) => {
        if (event.target === sheet) sheet.close();
    });

    window.addEventListener('resize', () => {
        if (popover.matches?.(':popover-open')) placePopover();
    });

    renderButton();
    callAuth('session').then((result) => {
        if (result.ok && result.user) {
            account = result.user;
            renderButton();
        }
    });
}
