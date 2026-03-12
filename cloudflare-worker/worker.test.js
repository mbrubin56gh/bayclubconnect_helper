// Unit and integration tests for worker.js.
//
// Run:  cd cloudflare-worker && npm test
//
// KV and D1 are replaced with lightweight in-memory mocks. External fetch
// calls (Bay Club auth, booking APIs, Resend) are stubbed with vi.stubGlobal.
// The Cloudflare runtime's default export is not exercised directly — tests
// call handleRequest and runCronTick via the named test exports.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import workerDefault, {
    tokenKvKey,
    isPlainObject,
    isValidBookingPayload,
    escHtml,
    checkSecret,
    checkSecretFlexible,
    handleRequest,
    runCronTick,
} from './worker.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

// Builds an in-memory KV store with a simple get/put interface.
// Exposes the underlying Map as `._store` for post-call assertions.
function makeMockKv(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        _store: store,
        get: vi.fn(key => Promise.resolve(store.get(key) ?? null)),
        put: vi.fn((key, value) => { store.set(key, value); return Promise.resolve(); }),
    };
}

// Builds a minimal D1 mock.  `prepare().bind().run()` resolves successfully;
// `prepare().bind().all()` resolves with `{ results: rows }` where rows
// can be overridden per-test.
function makeMockD1(rows = []) {
    const run = vi.fn(() => Promise.resolve());
    const all = vi.fn(() => Promise.resolve({ results: rows }));
    const bind = vi.fn(() => ({ run, all }));
    const prepare = vi.fn(() => ({ bind }));
    return { prepare, _run: run, _all: all };
}

// Builds the env object passed to handler functions.
function makeEnv(overrides = {}) {
    return {
        BC_BOOKINGS: overrides.kv || makeMockKv(),
        DB: overrides.db || makeMockD1(),
        WORKER_SECRET: overrides.secret ?? 'test-secret',
        RESEND_API_KEY: overrides.resendKey ?? null,
        ADMIN_EMAIL: overrides.adminEmail ?? null,
    };
}

// Builds a Request targeting the worker with the test secret pre-set.
function makeRequest(method, path, opts = {}) {
    const url = `https://worker.test${path}`;
    const headers = {};
    if (!opts.noAuth) {
        headers['X-Worker-Secret'] = 'test-secret';
    }
    if (opts.userId) {
        headers['X-User-Id'] = opts.userId;
    }
    Object.assign(headers, opts.headers || {});
    const init = { method, headers };
    if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
    }
    return new Request(url, init);
}

// A booking record that satisfies isValidBookingPayload.
function makeBooking(overrides = {}) {
    return {
        id: 'booking-1',
        fireAtMs: Date.now() + 60_000,
        bookingBody: { clubId: 'club-1', courtId: 'court-1' },
        confirmBody: { invitations: [{ personId: 'person-1' }] },
        notificationEmail: 'user@example.com',
        slotLabel: 'Broadway · Court 1 · 7:00–8:00 AM · Mon Mar 9',
        partnerNames: ['Jane Doe'],
        status: 'pending',
        createdAtMs: Date.now() - 1000,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('tokenKvKey', () => {
    it('returns bare key when userId is falsy', () => {
        expect(tokenKvKey(null)).toBe('refresh_token');
        expect(tokenKvKey('')).toBe('refresh_token');
        expect(tokenKvKey(undefined)).toBe('refresh_token');
    });

    it('returns per-user key when userId is provided', () => {
        expect(tokenKvKey('user@example.com')).toBe('refresh_token:user@example.com');
    });
});

describe('isPlainObject', () => {
    it('returns true for plain objects', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it('returns false for non-objects', () => {
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject(42)).toBe(false);
        expect(isPlainObject('string')).toBe(false);
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject(undefined)).toBe(false);
    });
});

describe('isValidBookingPayload', () => {
    it('accepts a fully populated booking', () => {
        expect(isValidBookingPayload(makeBooking())).toBe(true);
    });

    it('rejects missing id', () => {
        expect(isValidBookingPayload(makeBooking({ id: '' }))).toBe(false);
        expect(isValidBookingPayload(makeBooking({ id: undefined }))).toBe(false);
    });

    it('rejects non-finite fireAtMs', () => {
        expect(isValidBookingPayload(makeBooking({ fireAtMs: NaN }))).toBe(false);
        expect(isValidBookingPayload(makeBooking({ fireAtMs: Infinity }))).toBe(false);
        expect(isValidBookingPayload(makeBooking({ fireAtMs: '12345' }))).toBe(false);
    });

    it('rejects non-object bookingBody or confirmBody', () => {
        expect(isValidBookingPayload(makeBooking({ bookingBody: null }))).toBe(false);
        expect(isValidBookingPayload(makeBooking({ confirmBody: [] }))).toBe(false);
    });

    it('rejects non-objects at the top level', () => {
        expect(isValidBookingPayload(null)).toBe(false);
        expect(isValidBookingPayload('string')).toBe(false);
    });
});

describe('escHtml', () => {
    it('escapes all five HTML special characters', () => {
        expect(escHtml('<script>&"test"</script>')).toBe('&lt;script&gt;&amp;&quot;test&quot;&lt;/script&gt;');
    });

    it('leaves safe strings unchanged', () => {
        expect(escHtml('hello world')).toBe('hello world');
    });

    it('coerces non-strings to strings', () => {
        expect(escHtml(42)).toBe('42');
        expect(escHtml(null)).toBe('null');
    });
});

describe('checkSecret', () => {
    it('returns true when X-Worker-Secret matches env.WORKER_SECRET', () => {
        const req = new Request('https://worker.test/', {
            headers: { 'X-Worker-Secret': 'mysecret' },
        });
        expect(checkSecret(req, { WORKER_SECRET: 'mysecret' })).toBe(true);
    });

    it('returns false when header is missing', () => {
        const req = new Request('https://worker.test/');
        expect(checkSecret(req, { WORKER_SECRET: 'mysecret' })).toBe(false);
    });

    it('returns false when header value is wrong', () => {
        const req = new Request('https://worker.test/', {
            headers: { 'X-Worker-Secret': 'wrong' },
        });
        expect(checkSecret(req, { WORKER_SECRET: 'mysecret' })).toBe(false);
    });
});

describe('checkSecretFlexible', () => {
    it('accepts secret via X-Worker-Secret header', () => {
        const req = new Request('https://worker.test/', {
            headers: { 'X-Worker-Secret': 'mysecret' },
        });
        expect(checkSecretFlexible(req, { WORKER_SECRET: 'mysecret' })).toBe(true);
    });

    it('accepts secret via ?secret= query param', () => {
        const req = new Request('https://worker.test/?secret=mysecret');
        expect(checkSecretFlexible(req, { WORKER_SECRET: 'mysecret' })).toBe(true);
    });

    it('returns false when neither header nor param is present', () => {
        const req = new Request('https://worker.test/');
        expect(checkSecretFlexible(req, { WORKER_SECRET: 'mysecret' })).toBe(false);
    });

    it('returns false when value does not match', () => {
        const req = new Request('https://worker.test/?secret=wrong');
        expect(checkSecretFlexible(req, { WORKER_SECRET: 'mysecret' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// HTTP endpoints (via handleRequest)
// ---------------------------------------------------------------------------

describe('CORS preflight', () => {
    // OPTIONS is handled by the default export's fetch wrapper, not handleRequest.
    it('returns 204 with CORS headers for OPTIONS requests', async () => {
        const req = new Request('https://worker.test/bookings', { method: 'OPTIONS' });
        const res = await workerDefault.fetch(req, makeEnv());
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://bayclubconnect.com');
    });
});

describe('GET /status', () => {
    it('returns aggregate info without booking details when unauthenticated', async () => {
        const booking = makeBooking({ status: 'pending' });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
        });
        const req = new Request('https://worker.test/status', { method: 'GET' });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.pendingBookings).toBe(1);
        expect(body.scheduledBookings).toBeUndefined();
    });

    it('includes full booking list when authenticated', async () => {
        const booking = makeBooking({ status: 'pending' });
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });
        const req = makeRequest('GET', '/status');
        const res = await handleRequest(req, makeEnv({ kv }));
        const body = await res.json();
        expect(body.scheduledBookings).toHaveLength(1);
        expect(body.scheduledBookings[0].id).toBe('booking-1');
    });

    it('reports nextFireAt for the earliest pending booking', async () => {
        const soon = Date.now() + 5_000;
        const later = Date.now() + 60_000;
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([
                makeBooking({ id: 'b1', fireAtMs: later, status: 'pending' }),
                makeBooking({ id: 'b2', fireAtMs: soon, status: 'pending' }),
            ]),
        });
        const req = new Request('https://worker.test/status');
        const res = await handleRequest(req, makeEnv({ kv }));
        const body = await res.json();
        expect(new Date(body.nextFireAt).getTime()).toBe(soon);
    });
});

describe('Authentication guard', () => {
    it('returns 401 for authenticated endpoints when secret is missing', async () => {
        const req = new Request('https://worker.test/bookings', { method: 'GET' });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(401);
    });

    it('returns 401 when secret is wrong', async () => {
        const req = new Request('https://worker.test/bookings', {
            method: 'GET',
            headers: { 'X-Worker-Secret': 'wrong' },
        });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(401);
    });
});

describe('GET /bookings', () => {
    it('returns empty array when KV has no bookings', async () => {
        const res = await handleRequest(makeRequest('GET', '/bookings'), makeEnv());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it('returns stored bookings', async () => {
        const booking = makeBooking();
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });
        const res = await handleRequest(makeRequest('GET', '/bookings'), makeEnv({ kv }));
        const body = await res.json();
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe('booking-1');
    });
});

describe('POST /bookings', () => {
    it('adds a new booking to KV', async () => {
        const kv = makeMockKv();
        const booking = makeBooking();
        const req = makeRequest('POST', '/bookings', { body: booking });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const stored = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe('booking-1');
    });

    it('returns ok + duplicate:true when id already exists', async () => {
        const booking = makeBooking();
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });
        const req = makeRequest('POST', '/bookings', { body: booking });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(await res.json()).toEqual({ ok: true, duplicate: true });
        // KV should not have grown.
        expect(JSON.parse(kv._store.get('scheduled_bookings'))).toHaveLength(1);
    });

    it('returns 400 for an invalid booking payload', async () => {
        const req = makeRequest('POST', '/bookings', { body: { id: '', fireAtMs: 'bad' } });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });

    it('returns 400 for non-JSON body', async () => {
        const req = new Request('https://worker.test/bookings', {
            method: 'POST',
            headers: { 'X-Worker-Secret': 'test-secret', 'Content-Type': 'application/json' },
            body: 'not-json',
        });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });
});

describe('DELETE /bookings/:id', () => {
    it('removes the specified booking from KV', async () => {
        const booking = makeBooking({ status: 'pending' });
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });
        const req = makeRequest('DELETE', '/bookings/booking-1');
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(JSON.parse(kv._store.get('scheduled_bookings'))).toHaveLength(0);
    });

    it('returns ok even when the id does not exist', async () => {
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([makeBooking()]) });
        const req = makeRequest('DELETE', '/bookings/nonexistent-id');
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        // Original booking still present.
        expect(JSON.parse(kv._store.get('scheduled_bookings'))).toHaveLength(1);
    });

    it('writes a cancelled history row when a pending booking is deleted', async () => {
        const booking = makeBooking({ status: 'pending' });
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });
        const db = makeMockD1();
        const req = makeRequest('DELETE', '/bookings/booking-1');
        await handleRequest(req, makeEnv({ kv, db }));
        // appendToHistory calls prepare → bind → run.
        expect(db.prepare).toHaveBeenCalled();
        expect(db._run).toHaveBeenCalled();
    });
});

describe('PUT /token', () => {
    it('stores the token under the per-user KV key', async () => {
        const kv = makeMockKv();
        const req = makeRequest('PUT', '/token', {
            body: { refresh_token: 'rt-abc', userId: 'user@example.com' },
        });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(kv._store.get('refresh_token:user@example.com')).toBe('rt-abc');
    });

    it('returns 400 when refresh_token is missing', async () => {
        const req = makeRequest('PUT', '/token', { body: { userId: 'user@example.com' } });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });

    it('returns 400 when userId is missing', async () => {
        const req = makeRequest('PUT', '/token', { body: { refresh_token: 'rt-abc' } });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });
});

describe('GET /prefs', () => {
    it('returns 400 when X-User-Id header is missing', async () => {
        const res = await handleRequest(makeRequest('GET', '/prefs'), makeEnv());
        expect(res.status).toBe(400);
    });

    it('returns empty object when no prefs are stored', async () => {
        const req = makeRequest('GET', '/prefs', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
    });

    it('returns stored prefs for the user', async () => {
        const prefs = { bc_view_mode: 'by-time', bc_indoor_only: 'true' };
        const kv = makeMockKv({ 'prefs:user@example.com': JSON.stringify(prefs) });
        const req = makeRequest('GET', '/prefs', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(await res.json()).toEqual(prefs);
    });
});

describe('PUT /prefs', () => {
    it('stores prefs under the per-user KV key', async () => {
        const kv = makeMockKv();
        const prefs = { bc_view_mode: 'by-club' };
        const req = makeRequest('PUT', '/prefs', { body: { userId: 'user@example.com', prefs } });
        const res = await handleRequest(req, makeEnv({ kv }));
        expect(res.status).toBe(200);
        expect(JSON.parse(kv._store.get('prefs:user@example.com'))).toEqual(prefs);
    });

    it('returns 400 when userId is missing', async () => {
        const req = makeRequest('PUT', '/prefs', { body: { prefs: { bc_view_mode: 'by-club' } } });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });

    it('returns 400 when prefs is not a plain object', async () => {
        const req = makeRequest('PUT', '/prefs', { body: { userId: 'user@example.com', prefs: 'bad' } });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(400);
    });
});

describe('Unknown routes', () => {
    it('returns 404 for an unrecognised path', async () => {
        const res = await handleRequest(makeRequest('GET', '/unknown'), makeEnv());
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Cron tick (runCronTick)
// ---------------------------------------------------------------------------

describe('runCronTick', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does nothing when there are no due bookings', async () => {
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([
                makeBooking({ status: 'pending', fireAtMs: Date.now() + 60_000 }),
            ]),
        });
        const env = makeEnv({ kv });
        await runCronTick(env);
        // KV should not have been written (booking not due yet).
        expect(kv.put).not.toHaveBeenCalled();
    });

    it('fires a due pending booking and marks it succeeded', async () => {
        const booking = makeBooking({ status: 'pending', fireAtMs: Date.now() - 1000 });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:user@example.com': 'rt-initial',
        });

        // Sequence: auth exchange → booking POST → confirm PUT.
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at-xyz', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ courtBookingId: 'cbi-123' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('', { status: 200 })),
        );

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved[0].status).toBe('succeeded');
        // Token should have been rotated to the new refresh token.
        expect(kv._store.get('refresh_token:user@example.com')).toBe('rt-new');
    });

    it('marks a booking failed when the booking POST returns an error and there are no fallbacks', async () => {
        const booking = makeBooking({ status: 'pending', fireAtMs: Date.now() - 1000 });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:user@example.com': 'rt-initial',
        });

        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at-xyz', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('Court already booked', { status: 409 })),
        );

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved[0].status).toBe('failed');
        expect(saved[0].failureReason).toMatch(/409/);
    });

    it('falls back to the next court and succeeds when the primary court POST fails', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            originalCourtName: 'Court 1',
            fallbackCourts: [{ courtId: 'court-2', courtName: 'Court 2' }],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:user@example.com': 'rt-initial',
        });

        // Sequence: auth → primary court POST (409) → fallback court POST (200) → confirm PUT (200).
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at-xyz', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('Court already booked', { status: 409 }))
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ courtBookingId: 'cbi-fallback' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('', { status: 200 })),
        );

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved[0].status).toBe('succeeded');
        expect(saved[0].bookedCourtId).toBe('court-2');
        expect(saved[0].bookedCourtName).toBe('Court 2');
        expect(saved[0].usedFallback).toBe(true);
    });

    it('marks failed when all fallback courts are also unavailable', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            originalCourtName: 'Court 1',
            fallbackCourts: [
                { courtId: 'court-2', courtName: 'Court 2' },
                { courtId: 'court-3', courtName: 'Court 3' },
            ],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:user@example.com': 'rt-initial',
        });

        // Auth succeeds; all three court POSTs fail.
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at-xyz', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValue(new Response('Court already booked', { status: 409 })),
        );

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved[0].status).toBe('failed');
        expect(saved[0].failureReason).toMatch(/409/);
        expect(saved[0].failureReason).toMatch(/2 fallback court/);
    });

    it('notes the fallback substitution in the success email when a fallback court was used', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            originalCourtName: 'Court 1',
            fallbackCourts: [{ courtId: 'court-2', courtName: 'Court 2' }],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:user@example.com': 'rt-initial',
        });

        // Auth → primary 409 → fallback 200 → confirm 200 → Resend POST.
        const sentEmailBodies = [];
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at-xyz', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('Court already booked', { status: 409 }))
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ courtBookingId: 'cbi-fallback' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('', { status: 200 }))
            .mockImplementationOnce(async (url, opts) => {
                sentEmailBodies.push(JSON.parse(opts.body));
                return new Response('{}', { status: 200 });
            }),
        );

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        expect(sentEmailBodies).toHaveLength(1);
        expect(sentEmailBodies[0].html).toMatch(/Court 1 was unavailable/);
        expect(sentEmailBodies[0].html).toMatch(/Court 2 instead/);
    });

    it('marks a booking failed when no refresh token is stored in KV', async () => {
        const booking = makeBooking({ status: 'pending', fireAtMs: Date.now() - 1000 });
        // KV has bookings but no token for the user.
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved[0].status).toBe('failed');
        expect(saved[0].failureReason).toMatch(/No refresh token/);
    });

    it('skips already-firing bookings to prevent double-fire', async () => {
        const booking = makeBooking({ status: 'firing', fireAtMs: Date.now() - 1000 });
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([booking]) });

        vi.stubGlobal('fetch', vi.fn());

        await runCronTick(makeEnv({ kv }));

        // fetch should not have been called because no pending bookings were due.
        expect(fetch).not.toHaveBeenCalled();
    });

    it('prunes terminal bookings older than 7 days', async () => {
        const OLD_MS = Date.now() - 8 * 24 * 60 * 60 * 1000;
        const recent = makeBooking({ id: 'recent', status: 'succeeded', fireAtMs: Date.now() - 1000 });
        const old = makeBooking({ id: 'old', status: 'succeeded', fireAtMs: OLD_MS });
        const kv = makeMockKv({ scheduled_bookings: JSON.stringify([recent, old]) });

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved.map(b => b.id)).toEqual(['recent']);
    });

    it('fires multiple due bookings in a single tick', async () => {
        const b1 = makeBooking({ id: 'b1', status: 'pending', fireAtMs: Date.now() - 2000, notificationEmail: 'a@test.com' });
        const b2 = makeBooking({ id: 'b2', status: 'pending', fireAtMs: Date.now() - 1000, notificationEmail: 'a@test.com' });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([b1, b2]),
            'refresh_token:a@test.com': 'rt-shared',
        });

        // Six fetch calls: auth+post+confirm for b1, then auth+post+confirm for b2.
        // Use mockImplementation (not mockResolvedValue) so each call gets a fresh
        // Response instance — Response bodies are single-use streams.
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
            Promise.resolve(new Response(
                JSON.stringify({ access_token: 'at', refresh_token: 'rt-next', courtBookingId: 'cbi' }),
                { status: 200 },
            )),
        ));

        await runCronTick(makeEnv({ kv }));

        const saved = JSON.parse(kv._store.get('scheduled_bookings'));
        expect(saved.every(b => b.status === 'succeeded')).toBe(true);
    });
});

describe('partner email notifications', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // Builds a mock fetch that succeeds through the full fire sequence
    // (auth → booking POST → confirm PUT) and then handles any number of
    // Resend email POSTs, returning 200 for all of them.
    // URL-based dispatch is used because the auth call body is URL-encoded,
    // not JSON, so parsing the body to detect it would throw.
    function makeSuccessFetch() {
        return vi.fn().mockImplementation((url) => {
            if (typeof url === 'string' && url.includes('resend.com')) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            if (typeof url === 'string' && url.includes('authentication2-api')) {
                return Promise.resolve(new Response(
                    JSON.stringify({ access_token: 'at', refresh_token: 'rt-new' }),
                    { status: 200 },
                ));
            }
            if (typeof url === 'string' && url.includes('confirm')) {
                return Promise.resolve(new Response('', { status: 200 }));
            }
            return Promise.resolve(new Response(
                JSON.stringify({ courtBookingId: 'cbi-123' }),
                { status: 200 },
            ));
        });
    }

    it('sends a notification email to each partner email on success', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            userName: 'Mark Rubin',
            notificationEmail: 'mark@example.com',
            partnerEmails: ['partner1@example.com', 'partner2@example.com'],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:mark@example.com': 'rt-initial',
        });

        const mockFetch = makeSuccessFetch();
        vi.stubGlobal('fetch', mockFetch);

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        const resendCalls = mockFetch.mock.calls.filter(([url]) =>
            typeof url === 'string' && url.includes('resend.com')
        );
        // Three emails: scheduler + two partners.
        expect(resendCalls.length).toBe(3);

        const partnerCalls = resendCalls.filter(([, opts]) =>
            JSON.parse(opts.body).to !== 'mark@example.com'
        );
        const partnerRecipients = partnerCalls.map(([, opts]) => JSON.parse(opts.body).to);
        expect(partnerRecipients.sort()).toEqual(['partner1@example.com', 'partner2@example.com']);

        const partnerSubjects = partnerCalls.map(([, opts]) => JSON.parse(opts.body).subject);
        partnerSubjects.forEach(s => expect(s).toMatch(/Mark Rubin/));
        partnerSubjects.forEach(s => expect(s).toMatch(/succeeded/));
    });

    it('sends failure emails to partners when booking fails', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            userName: 'Mark Rubin',
            notificationEmail: 'mark@example.com',
            partnerEmails: ['partner@example.com'],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:mark@example.com': 'rt-initial',
        });

        const failMockFetch = vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ access_token: 'at', refresh_token: 'rt-new' }),
                { status: 200 },
            ))
            .mockResolvedValueOnce(new Response('Court unavailable', { status: 409 }))
            .mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', failMockFetch);

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        const resendCalls = failMockFetch.mock.calls.filter(([url]) =>
            typeof url === 'string' && url.includes('resend.com')
        );
        const partnerCall = resendCalls.find(([, opts]) =>
            JSON.parse(opts.body).to === 'partner@example.com'
        );
        expect(partnerCall).toBeDefined();
        expect(JSON.parse(partnerCall[1].body).subject).toMatch(/failed/);
    });

    it('uses notificationEmail as fallback label when userName is absent', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            userName: '',
            notificationEmail: 'mark@example.com',
            partnerEmails: ['partner@example.com'],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:mark@example.com': 'rt-initial',
        });

        const mockFetch = makeSuccessFetch();
        vi.stubGlobal('fetch', mockFetch);

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        const resendCalls = mockFetch.mock.calls.filter(([url]) =>
            typeof url === 'string' && url.includes('resend.com')
        );
        const partnerCall = resendCalls.find(([, opts]) =>
            JSON.parse(opts.body).to === 'partner@example.com'
        );
        expect(JSON.parse(partnerCall[1].body).subject).toMatch(/mark@example\.com/);
    });

    it('skips partner email if no partnerEmails are stored', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            notificationEmail: 'mark@example.com',
            // No partnerEmails field.
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:mark@example.com': 'rt-initial',
        });

        const mockFetch = makeSuccessFetch();
        vi.stubGlobal('fetch', mockFetch);

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        const resendCalls = mockFetch.mock.calls.filter(([url]) =>
            typeof url === 'string' && url.includes('resend.com')
        );
        // Only one email: the scheduler.
        expect(resendCalls.length).toBe(1);
        expect(JSON.parse(resendCalls[0][1].body).to).toBe('mark@example.com');
    });

    it('does not send a duplicate email when a partner email matches the scheduler email', async () => {
        const booking = makeBooking({
            status: 'pending',
            fireAtMs: Date.now() - 1000,
            userName: 'Mark Rubin',
            notificationEmail: 'mark@example.com',
            // One unique partner plus a duplicate of the scheduler's address.
            partnerEmails: ['partner@example.com', 'mark@example.com'],
        });
        const kv = makeMockKv({
            scheduled_bookings: JSON.stringify([booking]),
            'refresh_token:mark@example.com': 'rt-initial',
        });

        const mockFetch = makeSuccessFetch();
        vi.stubGlobal('fetch', mockFetch);

        await runCronTick(makeEnv({ kv, resendKey: 'resend-key' }));

        const resendCalls = mockFetch.mock.calls.filter(([url]) =>
            typeof url === 'string' && url.includes('resend.com')
        );
        // Two emails: scheduler (once) + unique partner.
        expect(resendCalls.length).toBe(2);
        const recipients = resendCalls.map(([, opts]) => JSON.parse(opts.body).to);
        expect(recipients.filter(r => r === 'mark@example.com').length).toBe(1);
    });
});

describe('GET /allowed', () => {
    it('returns 401 when secret is missing', async () => {
        const req = makeRequest('GET', '/allowed', { noAuth: true, userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv());
        expect(res.status).toBe(401);
    });

    it('returns allowed:false when no X-User-Id header is provided', async () => {
        const req = makeRequest('GET', '/allowed');
        const res = await handleRequest(req, makeEnv());
        const data = await res.json();
        expect(data.allowed).toBe(false);
    });

    it('returns allowed:true when no allowed_users key exists in KV (fail open)', async () => {
        const kv = makeMockKv({});
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(true);
    });

    it('returns allowed:true when allowed_users is an empty array', async () => {
        const kv = makeMockKv({ allowed_users: JSON.stringify([]) });
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(true);
    });

    it('returns allowed:true when allowed_users is malformed JSON (fail open)', async () => {
        const kv = makeMockKv({ allowed_users: 'not-json' });
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(true);
    });

    it('returns allowed:true when the email is in the allow-list', async () => {
        const kv = makeMockKv({ allowed_users: JSON.stringify(['user@example.com', 'other@example.com']) });
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(true);
    });

    it('returns allowed:false when the email is not in the allow-list', async () => {
        const kv = makeMockKv({ allowed_users: JSON.stringify(['other@example.com']) });
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(false);
    });

    it('performs case-insensitive email matching', async () => {
        const kv = makeMockKv({ allowed_users: JSON.stringify(['User@Example.COM']) });
        const req = makeRequest('GET', '/allowed', { userId: 'user@example.com' });
        const res = await handleRequest(req, makeEnv({ kv }));
        const data = await res.json();
        expect(data.allowed).toBe(true);
    });
});
