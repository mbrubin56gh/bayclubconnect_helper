// Cloudflare Worker for BayClub scheduled court booking execution.
//
// KV keys (all stored in BC_BOOKINGS namespace):
//   refresh_token:{email} — current valid refresh token for that user (rotates on every use)
//   scheduled_bookings    — JSON array of booking records
//   last_token_refresh    — ISO timestamp of the most recent token rotation (any user)
//
// D1 database (BC_BOOKINGS_HISTORY binding, bayclubconnect-history):
//   booking_history — permanent record of all completed/cancelled bookings
//
// Secrets (set via `wrangler secret put`):
//   WORKER_SECRET  — required on all write endpoints (X-Worker-Secret header)
//
// HTTP endpoints:
//   GET  /status            — health check, no auth required
//   GET  /bookings          — list all bookings (requires secret)
//   POST /bookings          — add a booking (requires secret)
//   DELETE /bookings/{id}   — cancel a booking (requires secret)
//   GET  /history           — booking history from D1 (requires secret; header or ?secret=)
//   GET  /dashboard         — HTML monitoring dashboard (requires secret; header or ?secret=)
//
// Cron: fires every minute, executes any booking whose fireAtMs has passed.

const AUTH_URL = 'https://authentication2-api.bayclubs.io/connect/token';
const BOOKING_API_BASE = 'https://connect-api.bayclubs.io/court-booking/api/1.0';
const SUBSCRIPTION_KEY = 'bac44a2d04b04413b6aea6d4e3aad294';

// Token keys are per-user: refresh_token:{notificationEmail}. The bare key is
// a fallback for booking records that pre-date the per-user scheme.
const KV_REFRESH_TOKEN = 'refresh_token';

function tokenKvKey(userId) {
    return userId ? `${KV_REFRESH_TOKEN}:${userId}` : KV_REFRESH_TOKEN;
}
const KV_BOOKINGS = 'scheduled_bookings';
const KV_LAST_REFRESH = 'last_token_refresh';

const STATUS_PENDING = 'pending';
const STATUS_FIRING = 'firing';
const STATUS_SUCCEEDED = 'succeeded';
const STATUS_FAILED = 'failed';

// CORS headers allowing the extension (running on bayclubconnect.com) to call
// this Worker from its fetch() calls in the page context.
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://bayclubconnect.com',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

// #region Auth.

function buildApiHeaders(accessToken, sessionId) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
        'X-SessionId': sessionId || crypto.randomUUID(),
        'Content-Type': 'application/json',
    };
}

// Refreshes the access token for the given user (identified by their email).
// Tokens are stored per-user under refresh_token:{email} so multiple extension
// users cannot clobber each other's tokens. Rotates immediately in KV after
// use — Bay Club refresh tokens are single-use.
// Returns the new access token.
async function refreshAccessToken(env, userId) {
    const kvKey = tokenKvKey(userId);
    const currentRefreshToken = await env.BC_BOOKINGS.get(kvKey);
    if (!currentRefreshToken) {
        throw new Error(`No refresh token stored in KV for user ${userId || '(unknown)'}.`);
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
    await env.BC_BOOKINGS.put(kvKey, newRefreshToken);
    await env.BC_BOOKINGS.put(KV_LAST_REFRESH, new Date().toISOString());

    return accessToken;
}

// #endregion Auth.

// #region KV helpers.

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

// Appends a completed or cancelled booking to the D1 history table. Uses
// INSERT OR IGNORE so a dismiss (DELETE) arriving after the cron tick has
// already written the row is silently a no-op. Failures are swallowed so
// D1 unavailability can never affect the booking outcome itself.
async function appendToHistory(env, booking, status, failureReason, completedAtMs) {
    if (!env.DB) return;
    try {
        await env.DB.prepare(
            'INSERT OR IGNORE INTO booking_history' +
            ' (id, user_email, slot_label, partner_names, status, failure_reason,' +
            '  scheduled_at_ms, fire_at_ms, completed_at_ms)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            booking.id,
            booking.notificationEmail || '',
            booking.slotLabel || '',
            JSON.stringify(booking.partnerNames || []),
            status,
            failureReason || null,
            booking.createdAtMs || 0,
            booking.fireAtMs || 0,
            completedAtMs,
        ).run();
    } catch (_e) {
        // Non-critical: history write failure must not affect booking outcome.
    }
}

// #endregion KV helpers.

// #region Booking execution.

// Fires a single booking: refreshes the token for the booking's owner, POSTs
// courtbookings, then PUTs confirm. Throws on any failure so the cron tick can
// mark the booking failed.
async function fireBooking(booking, env) {
    const accessToken = await refreshAccessToken(env, booking.notificationEmail);
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

// #endregion Booking execution.

// #region Email notifications.

// Sends a success or failure email via Resend. Requires RESEND_API_KEY and
// NOTIFICATION_EMAIL secrets. Uses onboarding@resend.dev as sender until a
// custom domain is configured (Phase 5).
async function sendEmailNotification(booking, env) {
    const to = booking.notificationEmail;
    if (!env.RESEND_API_KEY || !to) return;

    const succeeded = booking.status === STATUS_SUCCEEDED;
    const subject = succeeded
        ? `✅ Booking confirmed: ${booking.slotLabel}`
        : `❌ Booking failed: ${booking.slotLabel}`;
    const partners = (booking.partnerNames || []).join(', ') || 'none';
    const html = succeeded
        ? `<p>Your scheduled booking was placed successfully.</p>
           <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>`
        : `<p>Your scheduled booking could not be placed.</p>
           <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>
           <p>Reason: ${booking.failureReason || 'Unknown error'}</p>
           <p>You can try booking manually on <a href="https://bayclubconnect.com">bayclubconnect.com</a>.</p>`;

    await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'notifications@bayclubhelper.app',
            to,
            subject,
            html,
        }),
    });
}

// #endregion Email notifications.

// #region Cron tick.

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Runs every minute. Finds all pending bookings whose fireAtMs has passed,
// marks them firing (to prevent double-fire on concurrent ticks), then
// attempts to fire each one and updates its status. Also prunes old completed
// bookings so the KV value does not grow without bound.
async function runCronTick(env) {
    const now = Date.now();
    const bookings = await loadBookings(env);

    // Prune succeeded, failed, and cancelled bookings older than 7 days.
    const retained = bookings.filter(b => {
        const isTerminal = b.status === STATUS_SUCCEEDED ||
            b.status === STATUS_FAILED ||
            b.status === 'cancelled';
        return !isTerminal || (now - (b.fireAtMs || b.createdAtMs || 0)) < RETENTION_MS;
    });
    if (retained.length !== bookings.length) {
        await saveBookings(env, retained);
    }

    const due = retained.filter(b => b.status === STATUS_PENDING && b.fireAtMs <= now);
    if (due.length === 0) return;

    // Mark all due bookings as firing before any async work so a concurrent
    // cron tick (Cloudflare may overlap) cannot pick them up again.
    for (const booking of due) {
        booking.status = STATUS_FIRING;
    }
    await saveBookings(env, retained);

    // Fire each booking and record the result.
    for (const booking of due) {
        try {
            await fireBooking(booking, env);
            booking.status = STATUS_SUCCEEDED;
            await appendToHistory(env, booking, STATUS_SUCCEEDED, null, Date.now());
        } catch (error) {
            booking.status = STATUS_FAILED;
            booking.failureReason = error.message || String(error);
            await appendToHistory(env, booking, STATUS_FAILED, booking.failureReason, Date.now());
        }
    }

    await saveBookings(env, retained);

    // Send email notification for each completed booking.
    for (const booking of due) {
        await sendEmailNotification(booking, env).catch(() => {
            // Non-critical: log failure but don't let it affect booking status.
        });
    }
}

// #endregion Cron tick.

// #region HTTP request handler.

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

// Accepts the secret via X-Worker-Secret header OR ?secret= query param so
// the dashboard and history endpoints can be bookmarked in a browser.
function checkSecretFlexible(request, env) {
    const url = new URL(request.url);
    const s = request.headers.get('X-Worker-Secret') || url.searchParams.get('secret');
    return s && s === env.WORKER_SECRET;
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

    // Dashboard and history accept the secret via query param for browser bookmarking.
    if (method === 'GET' && path === '/history') {
        if (!checkSecretFlexible(request, env)) {
            return new Response('Unauthorized', { status: 401 });
        }
        if (!env.DB) return jsonResponse([]);
        try {
            const result = await env.DB.prepare(
                'SELECT * FROM booking_history ORDER BY completed_at_ms DESC LIMIT 200'
            ).all();
            return jsonResponse(result.results);
        } catch (_e) {
            return jsonResponse([]);
        }
    }

    if (method === 'GET' && path === '/dashboard') {
        if (!checkSecretFlexible(request, env)) {
            return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
        }
        const dashSecret = new URL(request.url).searchParams.get('secret') || '';
        const activeBookings = await loadBookings(env);
        let historyRows = [];
        if (env.DB) {
            try {
                const result = await env.DB.prepare(
                    'SELECT * FROM booking_history ORDER BY completed_at_ms DESC LIMIT 100'
                ).all();
                historyRows = result.results;
            } catch (_e) {
                // Table may not exist yet if schema has not been applied.
            }
        }
        return new Response(renderDashboardHtml(activeBookings, historyRows, dashSecret), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }

    // All remaining endpoints require the secret via header.
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
        const booking = bookings.find(b => b.id === id);
        if (booking) {
            // Pending/firing bookings are being cancelled; succeeded/failed bookings
            // are being dismissed — in that case the cron tick already wrote the
            // history row and INSERT OR IGNORE will silently skip the duplicate.
            const historyStatus = (booking.status === STATUS_PENDING || booking.status === STATUS_FIRING)
                ? 'cancelled'
                : booking.status;
            await appendToHistory(env, booking, historyStatus, booking.failureReason || null, Date.now());
        }
        await saveBookings(env, bookings.filter(b => b.id !== id));
        return jsonResponse({ ok: true });
    }

    // Receives a fresh refresh token from the extension and stores it in KV
    // under the per-user key refresh_token:{userId}. Called automatically on
    // every page load, keeping each user's token perpetually up to date without
    // manual intervention.
    if (method === 'PUT' && path === '/token') {
        const { refresh_token: newToken, userId } = await request.json();
        if (!newToken) return new Response('Bad Request', { status: 400 });
        await env.BC_BOOKINGS.put(tokenKvKey(userId), newToken);
        await env.BC_BOOKINGS.put(KV_LAST_REFRESH, new Date().toISOString());
        return jsonResponse({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
}

// #endregion HTTP request handler.

// #region Dashboard.

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderDashboardHtml(activeBookings, historyRows, secret) {
    const now = Date.now();

    function ptTime(ms) {
        if (!ms) return '—';
        return new Date(ms).toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }

    function countdown(ms) {
        const diff = ms - now;
        if (diff <= 0) return 'now';
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function badge(status) {
        const styles = {
            pending:   ['#fff3e0', '#e65100', 'Pending'],
            firing:    ['#e3f2fd', '#1565c0', 'Firing'],
            succeeded: ['#e8f5e9', '#2e7d32', '✓ OK'],
            failed:    ['#ffebee', '#c62828', '✗ Failed'],
            cancelled: ['#f5f5f5', '#757575', 'Cancelled'],
        };
        const [bg, color, label] = styles[status] || ['#f5f5f5', '#333', status];
        return `<span style="background:${bg};color:${color};padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">${label}</span>`;
    }

    // Active bookings section.
    const active = activeBookings.filter(b => b.status === STATUS_PENDING || b.status === STATUS_FIRING);
    let activeHtml;
    if (active.length === 0) {
        activeHtml = '<p style="color:#999;font-style:italic;padding:8px 0;">No active bookings.</p>';
    } else {
        const rows = active.map(b => {
            const partners = (b.partnerNames || []).join(', ') || '—';
            // Only pending bookings can be cancelled — firing means the API call is already in-flight.
            const cancelCell = b.status === STATUS_PENDING
                ? `<td id="cancel-cell-${escHtml(b.id)}"><button onclick="cancelBooking('${escHtml(b.id)}')" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;">Cancel</button></td>`
                : `<td style="color:#999;font-size:12px;">Firing…</td>`;
            return `<tr>
                <td>${badge(b.status)}</td>
                <td>${escHtml(b.slotLabel || '—')}</td>
                <td>${escHtml(b.notificationEmail || '—')}</td>
                <td>${escHtml(partners)}</td>
                <td>${ptTime(b.fireAtMs)}</td>
                <td>${countdown(b.fireAtMs)}</td>
                ${cancelCell}
            </tr>`;
        }).join('');
        activeHtml = `<table><thead><tr>
            <th>Status</th><th>Slot</th><th>User</th><th>Partners</th><th>Opens At (PT)</th><th>In</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // Stats bar.
    const nSucceeded = historyRows.filter(r => r.status === STATUS_SUCCEEDED).length;
    const nFailed    = historyRows.filter(r => r.status === STATUS_FAILED).length;
    const nCancelled = historyRows.filter(r => r.status === 'cancelled').length;
    function statBox(value, label, bg, color) {
        return `<div style="background:${bg};border-radius:8px;padding:12px 20px;min-width:90px;text-align:center;">
            <div style="font-size:26px;font-weight:700;color:${color};">${value}</div>
            <div style="font-size:12px;color:#555;margin-top:2px;">${label}</div>
        </div>`;
    }
    const statsHtml = `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
        ${statBox(nSucceeded, 'Succeeded', '#e8f5e9', '#2e7d32')}
        ${statBox(nFailed,    'Failed',    '#ffebee', '#c62828')}
        ${statBox(nCancelled, 'Cancelled', '#f5f5f5', '#757575')}
    </div>`;

    // History table.
    let historyHtml;
    if (historyRows.length === 0) {
        historyHtml = '<p style="color:#999;font-style:italic;padding:8px 0;">No history yet.</p>';
    } else {
        const rows = historyRows.map(r => {
            let partners;
            try { partners = JSON.parse(r.partner_names).join(', ') || '—'; }
            catch (_e) { partners = r.partner_names || '—'; }
            const reasonCell = r.failure_reason
                ? `<td style="color:#c62828;font-size:12px;">${escHtml(r.failure_reason)}</td>`
                : '<td style="color:#999;">—</td>';
            return `<tr>
                <td>${badge(r.status)}</td>
                <td>${escHtml(r.slot_label || '—')}</td>
                <td>${escHtml(r.user_email || '—')}</td>
                <td>${escHtml(partners)}</td>
                <td style="white-space:nowrap;">${ptTime(r.completed_at_ms)}</td>
                ${reasonCell}
            </tr>`;
        }).join('');
        historyHtml = `<table><thead><tr>
            <th>Status</th><th>Slot</th><th>User</th><th>Partners</th><th>Completed (PT)</th><th>Reason</th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    }

    const timestamp = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bay Club Booking Dashboard</title>
<meta id="auto-refresh" http-equiv="refresh" content="60">
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width: 980px; margin: 32px auto; padding: 0 20px; color: #333; line-height: 1.5; }
  h1   { color: #1a73e8; margin-bottom: 4px; }
  .sub { color: #999; font-size: 13px; margin-bottom: 28px; }
  h2   { color: #444; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-top: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  th { background: #f8f8f8; text-align: left; padding: 8px 10px; font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:hover td { background: #fafafa; }
</style>
</head>
<body>
  <h1>Bay Club Booking Dashboard</h1>
  <div class="sub">Last updated: ${timestamp} PT &nbsp;·&nbsp; Auto-refreshes every 60s</div>
  <h2>Active Bookings</h2>
  ${activeHtml}
  <h2>History (last ${historyRows.length} records)</h2>
  ${statsHtml}
  ${historyHtml}
<script>
  async function cancelBooking(id) {
    // Suppress the 60s auto-refresh so it doesn't clobber our feedback.
    const meta = document.getElementById('auto-refresh');
    if (meta) meta.removeAttribute('http-equiv');

    const cell = document.getElementById('cancel-cell-' + id);
    if (!cell) return;
    cell.innerHTML = '<span style="color:#888;font-size:12px;">Cancelling…</span>';

    try {
      const res = await fetch('/bookings/' + id, {
        method: 'DELETE',
        headers: { 'X-Worker-Secret': '${escHtml(secret)}' },
      });
      if (res.ok) {
        cell.innerHTML = '<span style="color:#2e7d32;font-size:12px;font-weight:600;">Cancelled ✓</span>';
        setTimeout(() => location.reload(), 800);
      } else {
        const text = await res.text().catch(() => res.status);
        cell.innerHTML = '<span style="color:#c62828;font-size:12px;">Failed: ' + text + '</span>';
        if (meta) meta.setAttribute('http-equiv', 'refresh');
      }
    } catch (err) {
      cell.innerHTML = '<span style="color:#c62828;font-size:12px;">Error: ' + err.message + '</span>';
      if (meta) meta.setAttribute('http-equiv', 'refresh');
    }
  }
</script>
</body>
</html>`;
}

// #endregion Dashboard.
