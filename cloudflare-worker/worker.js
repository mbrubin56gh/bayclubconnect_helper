// Cloudflare Worker for BayClub scheduled court booking execution.
//
// KV keys (all stored in BC_BOOKINGS namespace):
//   refresh_token       — current valid refresh token (rotates on every use)
//   scheduled_bookings  — JSON array of booking records
//   last_token_refresh  — ISO timestamp of last successful token refresh
//
// Secrets (set via `wrangler secret put`):
//   WORKER_SECRET  — required on all write endpoints (X-Worker-Secret header)
//
// HTTP endpoints:
//   GET  /status          — health check, no auth required
//   GET  /bookings        — list all bookings (requires secret)
//   POST /bookings        — add a booking (requires secret)
//   DELETE /bookings/{id} — cancel a booking (requires secret)
//
// Cron: fires every minute, executes any booking whose fireAtMs has passed.

const AUTH_URL = 'https://authentication2-api.bayclubs.io/connect/token';
const BOOKING_API_BASE = 'https://connect-api.bayclubs.io/court-booking/api/1.0';
const SUBSCRIPTION_KEY = 'bac44a2d04b04413b6aea6d4e3aad294';

const KV_REFRESH_TOKEN = 'refresh_token';
const KV_BOOKINGS = 'scheduled_bookings';
const KV_LAST_REFRESH = 'last_token_refresh';

const STATUS_PENDING = 'pending';
const STATUS_FIRING = 'firing';
const STATUS_SUCCEEDED = 'succeeded';
const STATUS_FAILED = 'failed';
const STATUS_CANCELLED = 'cancelled';

// CORS headers allowing the extension (running on bayclubconnect.com) to call
// this Worker from its fetch() calls in the page context.
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://bayclubconnect.com',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
};

export default {
    async fetch(request, env) {
        // Handle CORS preflight.
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        const response = await handleRequest(request, env);
        // Attach CORS headers to every response.
        const corsed = new Response(response.body, response);
        Object.entries(CORS_HEADERS).forEach(([k, v]) => corsed.headers.set(k, v));
        return corsed;
    },

    async scheduled(_event, env, ctx) {
        ctx.waitUntil(runCronTick(env));
    },
};

// --- Auth ---

function buildApiHeaders(accessToken, sessionId) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
        'X-SessionId': sessionId || crypto.randomUUID(),
        'Content-Type': 'application/json',
    };
}

// Refreshes the access token using the stored refresh token. Rotates the
// refresh token in KV immediately — Bay Club refresh tokens are single-use.
// Returns the new access token.
async function refreshAccessToken(env) {
    const currentRefreshToken = await env.BC_BOOKINGS.get(KV_REFRESH_TOKEN);
    if (!currentRefreshToken) {
        throw new Error('No refresh token stored in KV.');
    }

    const body = new URLSearchParams({
        client_id: 'connect20',
        client_secret: 'connectSecret',
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
    });

    const response = await fetch(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Token refresh failed: HTTP ${response.status} ${text}`);
    }

    const data = await response.json();
    const { access_token: accessToken, refresh_token: newRefreshToken } = data;

    if (!accessToken || !newRefreshToken) {
        throw new Error('Token refresh response is missing access_token or refresh_token.');
    }

    // Rotate immediately — the old token is now invalid.
    await env.BC_BOOKINGS.put(KV_REFRESH_TOKEN, newRefreshToken);
    await env.BC_BOOKINGS.put(KV_LAST_REFRESH, new Date().toISOString());

    return accessToken;
}

// --- KV helpers ---

async function loadBookings(env) {
    const raw = await env.BC_BOOKINGS.get(KV_BOOKINGS);
    if (!raw) return [];
    try {
        return JSON.parse(raw);
    } catch (_e) {
        return [];
    }
}

async function saveBookings(env, bookings) {
    await env.BC_BOOKINGS.put(KV_BOOKINGS, JSON.stringify(bookings));
}

// --- Booking execution ---

// Fires a single booking: refreshes the token, POSTs courtbookings, then PUTs
// confirm. Throws on any failure so the cron tick can mark the booking failed.
async function fireBooking(booking, env) {
    const accessToken = await refreshAccessToken(env);
    const headers = buildApiHeaders(accessToken, crypto.randomUUID());

    // Step 1: POST courtbookings.
    const bookingResponse = await fetch(`${BOOKING_API_BASE}/courtbookings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(booking.bookingBody),
    });
    if (!bookingResponse.ok) {
        const text = await bookingResponse.text().catch(() => '');
        throw new Error(`Booking POST failed: HTTP ${bookingResponse.status} ${text}`);
    }
    const bookingResult = await bookingResponse.json();
    const courtBookingId = bookingResult.courtBookingId;
    if (!courtBookingId) {
        throw new Error('Booking POST did not return a courtBookingId.');
    }

    // Step 2: PUT confirm with partner invitations.
    const confirmResponse = await fetch(`${BOOKING_API_BASE}/courtbookings/${courtBookingId}/confirm`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(booking.confirmBody),
    });
    if (!confirmResponse.ok) {
        const text = await confirmResponse.text().catch(() => '');
        throw new Error(`Confirm PUT failed: HTTP ${confirmResponse.status} ${text}`);
    }
}

// --- Cron tick ---

// Runs every minute. Finds all pending bookings whose fireAtMs has passed,
// marks them firing (to prevent double-fire on concurrent ticks), then
// attempts to fire each one and updates its status.
async function runCronTick(env) {
    const now = Date.now();
    const bookings = await loadBookings(env);

    const due = bookings.filter(b => b.status === STATUS_PENDING && b.fireAtMs <= now);
    if (due.length === 0) return;

    // Mark all due bookings as firing before any async work so a concurrent
    // cron tick (Cloudflare may overlap) cannot pick them up again.
    for (const booking of due) {
        booking.status = STATUS_FIRING;
    }
    await saveBookings(env, bookings);

    // Fire each booking and record the result.
    for (const booking of due) {
        try {
            await fireBooking(booking, env);
            booking.status = STATUS_SUCCEEDED;
        } catch (error) {
            booking.status = STATUS_FAILED;
            booking.failureReason = error.message || String(error);
        }
    }

    await saveBookings(env, bookings);

    // TODO Phase 4: send email notification via Resend for each completed booking.
}

// --- HTTP request handler ---

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function checkSecret(request, env) {
    const secret = request.headers.get('X-Worker-Secret');
    return secret && secret === env.WORKER_SECRET;
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check — publicly readable, no secret required.
    if (method === 'GET' && path === '/status') {
        const bookings = await loadBookings(env);
        const lastRefresh = await env.BC_BOOKINGS.get(KV_LAST_REFRESH);
        const pending = bookings.filter(b => b.status === STATUS_PENDING);
        const nextFireAt = pending.length > 0
            ? new Date(Math.min(...pending.map(b => b.fireAtMs))).toISOString()
            : null;
        return jsonResponse({
            lastTokenRefresh: lastRefresh,
            pendingBookings: pending.length,
            nextFireAt,
            scheduledBookings: bookings,
        });
    }

    // All write/read endpoints require the shared secret.
    if (!checkSecret(request, env)) {
        return new Response('Unauthorized', { status: 401 });
    }

    if (method === 'GET' && path === '/bookings') {
        const bookings = await loadBookings(env);
        return jsonResponse(bookings);
    }

    if (method === 'POST' && path === '/bookings') {
        const booking = await request.json();
        const bookings = await loadBookings(env);
        bookings.push(booking);
        await saveBookings(env, bookings);
        return jsonResponse({ ok: true });
    }

    if (method === 'DELETE' && path.startsWith('/bookings/')) {
        const id = path.slice('/bookings/'.length);
        const bookings = await loadBookings(env);
        const updated = bookings.map(b =>
            b.id === id ? Object.assign({}, b, { status: STATUS_CANCELLED }) : b
        );
        await saveBookings(env, updated);
        return jsonResponse({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
}
