// Email sign-in with one-time codes.
//
//   POST /api/auth/email/start   { email }        -> emails a 6-digit code
//   POST /api/auth/email/verify  { email, code }  -> signs in, sets the session cookie
//   GET  /api/auth/session                         -> the signed-in user, or null
//   POST /api/auth/logout                          -> ends the session
//
// Handlers take a Web Request and return a Response, so the same code runs as a
// Vercel Function and inside the local dev server.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DatabaseNotConfiguredError, getDb } from './db.js';
import { EmailNotConfiguredError, sendLoginCode } from './email.js';

const CODE_MINUTES_VALID = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_REQUEST_WINDOW_MINUTES = 15;
const CODE_REQUESTS_PER_WINDOW = 5;
const SESSION_DAYS = 30;
const SESSION_COOKIE = 'um_session';
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEV_AUTH_SECRET = 'unmark-me-local-development-secret';

class AuthNotConfiguredError extends Error {}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function authSecret() {
    const secret = process.env.AUTH_SECRET;
    if (secret) return secret;
    if (process.env.VERCEL) throw new AuthNotConfiguredError('AUTH_SECRET is not set');
    return DEV_AUTH_SECRET;
}

export function normalizeEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        throw new HttpError(400, 'Enter a valid email address.');
    }
    return email;
}

export function generateCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(email, code) {
    return createHmac('sha256', authSecret()).update(`${email}:${code}`).digest('hex');
}

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function sameHash(a, b) {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header) {
    const cookies = {};
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const name = part.slice(0, index).trim();
        if (name) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

export function sessionCookie(token, { secure, maxAgeSeconds }) {
    return [
        `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`,
        secure ? 'Secure' : null
    ].filter(Boolean).join('; ');
}

function isSecureRequest(request) {
    return new URL(request.url).protocol === 'https:' ||
        request.headers.get('x-forwarded-proto') === 'https';
}

function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
    });
}

// JSON-only POSTs from our own origin: a cross-site form cannot send JSON
// without a preflight, and the Origin check rejects other sites outright.
async function readJsonBody(request) {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
        throw new HttpError(403, 'Cross-site request refused.');
    }
    if (!String(request.headers.get('content-type') || '').includes('application/json')) {
        throw new HttpError(415, 'Expected a JSON body.');
    }
    try {
        return await request.json();
    } catch {
        throw new HttpError(400, 'Invalid JSON body.');
    }
}

function publicUser(row) {
    return {
        email: row.email,
        name: row.display_name || row.email.split('@')[0],
        plan: row.plan.charAt(0).toUpperCase() + row.plan.slice(1)
    };
}

function withErrors(handler) {
    return async (request) => {
        try {
            return await handler(request);
        } catch (error) {
            if (error instanceof HttpError) return json(error.status, { error: error.message });
            if (
                error instanceof EmailNotConfiguredError ||
                error instanceof DatabaseNotConfiguredError ||
                error instanceof AuthNotConfiguredError
            ) {
                console.error('Email sign-in is not configured:', error.message);
                return json(503, { error: 'Email sign-in is not available right now.' });
            }
            console.error('Auth request failed:', error);
            return json(500, { error: 'Something went wrong. Please try again.' });
        }
    };
}

export const startEmailSignIn = withErrors(async (request) => {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);
    const db = getDb();

    await db.query(`delete from login_codes where expires_at < now() - interval '1 hour'`);
    const { rows: [recent] } = await db.query(
        `select count(*)::int as count from login_codes
         where email = $1 and created_at > now() - make_interval(mins => $2)`,
        [email, CODE_REQUEST_WINDOW_MINUTES]
    );
    if (recent.count >= CODE_REQUESTS_PER_WINDOW) {
        throw new HttpError(429, 'Too many codes requested. Try again in a few minutes.');
    }

    const code = generateCode();
    await db.query(
        `insert into login_codes (email, code_hash, expires_at)
         values ($1, $2, now() + make_interval(mins => $3))`,
        [email, hashCode(email, code), CODE_MINUTES_VALID]
    );
    await sendLoginCode({ email, code, minutesValid: CODE_MINUTES_VALID });

    // Same answer whether or not an account exists, so emails can't be probed.
    return json(200, { ok: true, minutesValid: CODE_MINUTES_VALID });
});

export const verifyEmailSignIn = withErrors(async (request) => {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);
    const code = String(body?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code from the email.');

    const db = getDb();
    const client = await db.connect();
    try {
        await client.query('begin');
        const { rows: [pending] } = await client.query(
            `select id, code_hash, attempts from login_codes
             where email = $1 and expires_at > now()
             order by created_at desc limit 1
             for update`,
            [email]
        );
        if (!pending) {
            await client.query('rollback');
            throw new HttpError(400, 'That code has expired. Request a new one.');
        }
        if (pending.attempts >= CODE_MAX_ATTEMPTS) {
            await client.query('rollback');
            throw new HttpError(429, 'Too many wrong codes. Request a new one.');
        }
        if (!sameHash(pending.code_hash, hashCode(email, code))) {
            await client.query('update login_codes set attempts = attempts + 1 where id = $1', [pending.id]);
            await client.query('commit');
            const left = CODE_MAX_ATTEMPTS - pending.attempts - 1;
            throw new HttpError(400, left > 0
                ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
                : 'Too many wrong codes. Request a new one.');
        }

        await client.query('delete from login_codes where email = $1', [email]);
        const { rows: [user] } = await client.query(
            `insert into users (email, email_verified, auth_provider, auth_subject, last_sign_in_at)
             values ($1, true, 'email', $1, now())
             on conflict (lower(email)) do update
                 set email_verified = true, last_sign_in_at = now()
             returning id, email, display_name, plan`,
            [email]
        );
        const token = randomBytes(32).toString('base64url');
        await client.query(
            `insert into sessions (user_id, token_hash, expires_at)
             values ($1, $2, now() + make_interval(days => $3))`,
            [user.id, hashToken(token), SESSION_DAYS]
        );
        await client.query('delete from sessions where user_id = $1 and expires_at < now()', [user.id]);
        await client.query('commit');

        return json(200, { user: publicUser(user) }, {
            'Set-Cookie': sessionCookie(token, {
                secure: isSecureRequest(request),
                maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60
            })
        });
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
});

export const getSession = withErrors(async (request) => {
    const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
    if (!token) return json(200, { user: null });

    const { rows: [user] } = await getDb().query(
        `update sessions set last_seen_at = now()
         from users
         where sessions.token_hash = $1
           and sessions.expires_at > now()
           and users.id = sessions.user_id
         returning users.email, users.display_name, users.plan`,
        [hashToken(token)]
    );
    return json(200, { user: user ? publicUser(user) : null });
});

export const logout = withErrors(async (request) => {
    await readJsonBody(request);
    const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
    if (token) {
        await getDb().query('delete from sessions where token_hash = $1', [hashToken(token)]);
    }
    return json(200, { ok: true }, {
        'Set-Cookie': sessionCookie('', { secure: isSecureRequest(request), maxAgeSeconds: 0 })
    });
});
