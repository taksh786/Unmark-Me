import test from 'node:test';
import assert from 'node:assert/strict';

import {
    generateCode,
    hashCode,
    normalizeEmail,
    parseCookies,
    sessionCookie,
    startEmailSignIn
} from '../../src/server/auth.js';

function jsonRequest(body, headers = {}) {
    return new Request('http://localhost:4173/api/auth/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
}

test('emails are trimmed and lowercased, and malformed ones are rejected', () => {
    assert.equal(normalizeEmail('  Alex@Example.COM '), 'alex@example.com');
    for (const bad of ['', 'alex', 'alex@', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`, null]) {
        assert.throws(() => normalizeEmail(bad), /valid email/);
    }
});

test('codes are six digits, including leading zeros', () => {
    for (let i = 0; i < 200; i++) {
        assert.match(generateCode(), /^\d{6}$/);
    }
});

test('code hashes depend on both the email and the code', () => {
    const base = hashCode('alex@example.com', '123456');
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(hashCode('alex@example.com', '123456'), base);
    assert.notEqual(hashCode('alex@example.com', '123457'), base);
    assert.notEqual(hashCode('sam@example.com', '123456'), base);
});

test('cookies are parsed from the request header', () => {
    assert.deepEqual(parseCookies('a=1; um_session=abc%2Fdef; theme=dark'), {
        a: '1',
        um_session: 'abc/def',
        theme: 'dark'
    });
    assert.deepEqual(parseCookies(''), {});
    assert.deepEqual(parseCookies(null), {});
});

test('the session cookie is HttpOnly, same-site and only Secure over https', () => {
    const cookie = sessionCookie('token-value', { secure: true, maxAgeSeconds: 60 });
    assert.match(cookie, /^um_session=token-value; /);
    for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=60', 'Secure']) {
        assert.ok(cookie.includes(flag), `missing ${flag}`);
    }
    assert.ok(!sessionCookie('t', { secure: false, maxAgeSeconds: 60 }).includes('Secure'));
    assert.match(sessionCookie('', { secure: false, maxAgeSeconds: 0 }), /^um_session=; .*Max-Age=0/);
});

test('sign-in requests from other sites are refused', async () => {
    const response = await startEmailSignIn(jsonRequest({ email: 'alex@example.com' }, { Origin: 'https://evil.example' }));
    assert.equal(response.status, 403);
});

test('sign-in requests must be JSON', async () => {
    const response = await startEmailSignIn(new Request('http://localhost:4173/api/auth/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=alex@example.com'
    }));
    assert.equal(response.status, 415);
});

test('an invalid email is reported before touching the database', async () => {
    const response = await startEmailSignIn(jsonRequest({ email: 'not-an-email' }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Enter a valid email address.' });
});

test('a deployment without a database reports sign-in as unavailable', async () => {
    const saved = { url: process.env.DATABASE_URL, vercel: process.env.VERCEL };
    delete process.env.DATABASE_URL;
    process.env.VERCEL = '1';
    const originalError = console.error;
    console.error = () => {};
    try {
        const response = await startEmailSignIn(jsonRequest({ email: 'alex@example.com' }));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'Email sign-in is not available right now.' });
    } finally {
        console.error = originalError;
        if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
        if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
    }
});
