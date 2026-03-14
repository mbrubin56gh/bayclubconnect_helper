// Cloudflare Worker for BayClub scheduled court booking execution.
//
// KV keys (all stored in BC_BOOKINGS namespace):
//   refresh_token:{email} — current valid refresh token for that user (rotates on every use)
//   scheduled_bookings    — JSON array of booking records
//   last_token_refresh    — ISO timestamp of the most recent token rotation (any user)
//   prefs:{email}         — JSON object of synced user preferences
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
//   GET  /prefs             — get synced preferences for a user (requires secret + X-User-Id header)
//   PUT  /prefs             — save synced preferences for a user (requires secret)
//   GET  /history           — booking history from D1 (requires secret; header or ?secret=)
//   GET  /dashboard         — HTML monitoring dashboard (requires secret; header or ?secret=)
//
// Cron triggers:
//   * * * * *   — fires every minute, executes any booking whose fireAtMs has passed
//   0 16 * * 1  — fires every Monday at 16:00 UTC (≈ 8 AM Pacific), sends weekly summary email
//   0 */6 * * * — fires every 6 hours, checks slot availability for pending bookings
//
// Secrets (set via `wrangler secret put`):
//   WORKER_SECRET  — required on all write endpoints (X-Worker-Secret header)
//   RESEND_API_KEY — Resend transactional email API key
//   ADMIN_EMAIL    — admin email address for the weekly summary

const AUTH_URL = 'https://authentication2-api.bayclubs.io/connect/token';
const BOOKING_API_BASE = 'https://connect-api.bayclubs.io/court-booking/api/1.0';
const SUBSCRIPTION_KEY = 'bac44a2d04b04413b6aea6d4e3aad294';

// Token keys are per-user: refresh_token:{notificationEmail}. The bare key is
// a fallback for booking records that pre-date the per-user scheme.
const KV_REFRESH_TOKEN = 'refresh_token';

function tokenKvKey(userId) {
    return userId ? `${KV_REFRESH_TOKEN}:${userId}` : KV_REFRESH_TOKEN;
}
// Cron expression for the weekly summary trigger — must match wrangler.toml exactly.
const WEEKLY_SUMMARY_CRON = '0 16 * * 1';
// Cron expression for the periodic slot availability check.
const SLOT_CHECK_CRON = '0 */6 * * *';

const KV_BOOKINGS = 'scheduled_bookings';
const KV_LAST_REFRESH = 'last_token_refresh';
const KV_PREFS = 'prefs';

const STATUS_PENDING = 'pending';
const STATUS_FIRING = 'firing';
const STATUS_SUCCEEDED = 'succeeded';
const STATUS_FAILED = 'failed';

// CORS headers allowing the extension (running on bayclubconnect.com) to call
// this Worker from its fetch() calls in the page context.
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://bayclubconnect.com',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret, X-User-Id',
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

    async scheduled(event, env, ctx) {
        if (event.cron === WEEKLY_SUMMARY_CRON) {
            ctx.waitUntil(sendWeeklySummaryEmail(env));
            return;
        }
        if (event.cron === SLOT_CHECK_CRON) {
            ctx.waitUntil(runSlotCheckTick(env));
            return;
        }
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

async function loadPrefs(env, userId) {
    const raw = await env.BC_BOOKINGS.get(`${KV_PREFS}:${userId}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_e) {
        return null;
    }
}

async function savePrefs(env, userId, prefs) {
    await env.BC_BOOKINGS.put(`${KV_PREFS}:${userId}`, JSON.stringify(prefs));
}

// Appends a completed or cancelled booking to the D1 history table. Uses
// INSERT OR IGNORE so a dismiss (DELETE) arriving after the cron tick has
// already written the row is silently a no-op. Failures are swallowed so
// D1 unavailability can never affect the booking outcome itself.
// bookedCourtName: null when the primary court was used; the fallback court name
// when the Worker substituted a different court.  Stored in the new
// booked_court_name column (added via: ALTER TABLE booking_history ADD COLUMN
// booked_court_name TEXT DEFAULT NULL).
async function appendToHistory(env, booking, status, failureReason, completedAtMs, bookedCourtName) {
    if (!env.DB) return;
    try {
        await env.DB.prepare(
            'INSERT OR IGNORE INTO booking_history' +
            ' (id, user_email, user_name, slot_label, partner_names, status, failure_reason,' +
            '  scheduled_at_ms, fire_at_ms, completed_at_ms, booked_court_name)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            booking.id,
            booking.notificationEmail || '',
            booking.userName || '',
            booking.slotLabel || '',
            JSON.stringify(booking.partnerNames || []),
            status,
            failureReason || null,
            booking.createdAtMs || 0,
            booking.fireAtMs || 0,
            completedAtMs,
            bookedCourtName || null,
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
// Attempts to POST a single court booking and PUT confirm. Throws on failure.
// Returns the courtBookingId on success.
async function attemptCourtBooking(bookingBody, confirmBody, headers) {
    const bookingResponse = await fetch(`${BOOKING_API_BASE}/courtbookings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bookingBody),
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

    const confirmResponse = await fetch(`${BOOKING_API_BASE}/courtbookings/${courtBookingId}/confirm`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(confirmBody),
    });
    if (!confirmResponse.ok) {
        const text = await confirmResponse.text().catch(() => '');
        throw new Error(`Confirm PUT failed: HTTP ${confirmResponse.status} ${text}`);
    }
    return courtBookingId;
}

// Fires a single booking: refreshes the token, then tries the primary court followed
// by each fallback court (in preference order, as sorted by the extension at scheduling
// time: gated > edge > neither).  Returns { bookedCourtId, bookedCourtName } on success;
// throws if every court attempt fails.
async function fireBooking(booking, env) {
    const accessToken = await refreshAccessToken(env, booking.notificationEmail);
    const headers = buildApiHeaders(accessToken, crypto.randomUUID());

    // Build the ordered list of courts to try: primary first, then fallbacks.
    const primaryCourt = {
        courtId: booking.bookingBody.courtId,
        courtName: booking.originalCourtName || null,
    };
    const courts = [primaryCourt, ...(booking.fallbackCourts || [])];

    let lastError;
    for (const court of courts) {
        const bodyForCourt = Object.assign({}, booking.bookingBody, { courtId: court.courtId });
        try {
            await attemptCourtBooking(bodyForCourt, booking.confirmBody, headers);
            return { bookedCourtId: court.courtId, bookedCourtName: court.courtName };
        } catch (err) {
            lastError = err;
            // Continue to the next fallback court.
        }
    }

    // All courts exhausted — throw with a summary that includes the original error.
    const fallbackCount = (booking.fallbackCourts || []).length;
    const extra = fallbackCount > 0 ? ` (tried ${fallbackCount} fallback court${fallbackCount === 1 ? '' : 's'})` : '';
    throw new Error((lastError && lastError.message ? lastError.message : String(lastError)) + extra);
}

// #endregion Booking execution.

// #region Email notifications.

// Sends a success or failure email via Resend. Requires RESEND_API_KEY and
// NOTIFICATION_EMAIL secrets. Uses onboarding@resend.dev as sender until a
// custom domain is configured (Phase 5).
async function sendResendEmail(env, to, subject, html) {
    const response = await fetch('https://api.resend.com/emails', {
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
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Resend email failed: HTTP ${response.status} ${text}`);
    }
}

async function sendEmailNotification(booking, env) {
    if (!env.RESEND_API_KEY) return;

    const succeeded = booking.status === STATUS_SUCCEEDED;
    const partners = (booking.partnerNames || []).join(', ') || 'none';

    // Build a substitution note shown when the Worker booked a fallback court instead
    // of the originally scheduled one (e.g. primary court was snagged first).
    const substitutionNote = (succeeded && booking.usedFallback && booking.originalCourtName && booking.bookedCourtName)
        ? `<p style="color:#b45309;"><strong>Note:</strong> ${booking.originalCourtName} was unavailable — you were booked on ${booking.bookedCourtName} instead.</p>`
        : '';

    // Notify the scheduler.
    if (booking.notificationEmail) {
        const subject = succeeded
            ? `✅ Booking confirmed: ${booking.slotLabel}`
            : `❌ Booking failed: ${booking.slotLabel}`;
        const html = succeeded
            ? `<p>Your scheduled booking was placed successfully.</p>
               ${substitutionNote}
               <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>`
            : `<p>Your scheduled booking could not be placed.</p>
               <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>
               <p>Reason: ${booking.failureReason || 'Unknown error'}</p>
               <p>You can try booking manually on <a href="https://bayclubconnect.com">bayclubconnect.com</a>.</p>`;
        await sendResendEmail(env, booking.notificationEmail, subject, html);
    }

    // Notify each partner whose email was captured at scheduling time.
    // Partners without a stored email are silently skipped.
    const partnerEmails = (booking.partnerEmails || []).filter(
        e => e && e !== booking.notificationEmail
    );
    if (partnerEmails.length === 0) return;

    // Use the scheduler's name in the subject if available, falling back to
    // their notification email, then a generic phrase.
    const schedulerLabel = booking.userName || booking.notificationEmail || 'Someone';
    const partnerSubject = succeeded
        ? `✅ ${schedulerLabel}'s pending booking succeeded: ${booking.slotLabel}`
        : `❌ ${schedulerLabel}'s pending booking failed: ${booking.slotLabel}`;
    const partnerHtml = succeeded
        ? `<p>${schedulerLabel}'s scheduled booking was placed successfully — you're on the court!</p>
           ${substitutionNote}
           <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>`
        : `<p>${schedulerLabel}'s scheduled booking could not be placed.</p>
           <p><strong>${booking.slotLabel}</strong><br>Partners: ${partners}</p>
           <p>Reason: ${booking.failureReason || 'Unknown error'}</p>
           <p>You may want to book manually on <a href="https://bayclubconnect.com">bayclubconnect.com</a>.</p>`;

    await Promise.all(partnerEmails.map(email => sendResendEmail(env, email, partnerSubject, partnerHtml)));
}

// Sends a weekly activity summary to the admin email. Queries D1 for the
// past 7 days of booking_history. Skips sending if there was no activity.
// Flags unusual volume (> 20 bookings) and any failures in an alert banner.
// Requires RESEND_API_KEY, ADMIN_EMAIL, and DB bindings.
async function sendWeeklySummaryEmail(env) {
    if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.DB) return;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let rows;
    try {
        const result = await env.DB.prepare(
            'SELECT * FROM booking_history WHERE completed_at_ms >= ? ORDER BY completed_at_ms DESC'
        ).bind(sevenDaysAgo).all();
        rows = result.results || [];
    } catch (_e) {
        return;
    }

    // Nothing happened this week — skip the email to avoid noise.
    if (rows.length === 0) return;

    const nSucceeded = rows.filter(r => r.status === STATUS_SUCCEEDED).length;
    const nFailed    = rows.filter(r => r.status === STATUS_FAILED).length;
    const nCancelled = rows.filter(r => r.status === 'cancelled').length;

    const isHighActivity = rows.length > 20;
    const hasFailed      = nFailed > 0;

    const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
    });
    const fmtDateTime = (ms) => new Date(ms).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: 'America/Los_Angeles',
    });

    const weekStart = fmtDate(sevenDaysAgo);
    const weekEnd   = fmtDate(Date.now());
    const dashUrl   = `https://bayclubconnect-bookings.mark-rubin.workers.dev/dashboard?secret=${env.WORKER_SECRET || ''}`;

    const alertLines = [];
    if (isHighActivity) {
        alertLines.push(`⚠️ Unusually high activity this week (${rows.length} bookings).`);
    }
    if (hasFailed) {
        alertLines.push(`⚠️ ${nFailed} booking${nFailed === 1 ? '' : 's'} failed — <a href="${dashUrl}">check the dashboard</a> for details.`);
    }
    const alertBanner = alertLines.length > 0
        ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin-bottom:20px;">${alertLines.map(l => `<p style="margin:0 0 4px;">${l}</p>`).join('')}</div>`
        : '';

    const statsHtml = `
        <div style="display:flex;gap:32px;margin-bottom:24px;">
            <div style="text-align:center;">
                <div style="font-size:32px;font-weight:700;color:#2e7d32;">${nSucceeded}</div>
                <div style="color:#555;font-size:13px;">Succeeded</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:32px;font-weight:700;color:#c62828;">${nFailed}</div>
                <div style="color:#555;font-size:13px;">Failed</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:32px;font-weight:700;color:#777;">${nCancelled}</div>
                <div style="color:#555;font-size:13px;">Cancelled</div>
            </div>
        </div>`;

    const tableRows = rows.map(r => {
        const statusIcon = r.status === STATUS_SUCCEEDED ? '✅'
            : r.status === STATUS_FAILED ? '❌' : '✗';
        const partners = (() => {
            try { return JSON.parse(r.partner_names || '[]').join(', ') || '—'; } catch (_e) { return '—'; }
        })();
        return `<tr>
            <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;">${statusIcon}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;">${escHtml(r.slot_label || '—')}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;color:#555;">${escHtml(r.user_name || r.user_email || '—')}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;color:#555;">${escHtml(partners)}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;color:#888;">${fmtDateTime(r.completed_at_ms)}</td>
        </tr>`;
    }).join('');

    const html = `<div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px;color:#1a1a1a;">
        <h2 style="margin:0 0 4px;">Bay Club Bookings — Weekly Summary</h2>
        <p style="margin:0 0 20px;color:#888;font-size:13px;">${weekStart} – ${weekEnd}</p>
        ${alertBanner}
        ${statsHtml}
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr style="background:#f5f5f5;">
                    <th style="padding:6px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;width:28px;"></th>
                    <th style="padding:6px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;">Slot</th>
                    <th style="padding:6px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;">User</th>
                    <th style="padding:6px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;">Partners</th>
                    <th style="padding:6px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;">Completed</th>
                </tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>
        <p style="margin:20px 0 0;font-size:12px;color:#aaa;">
            <a href="${dashUrl}" style="color:#1a73e8;">Open dashboard</a> · Sent by bayclubhelper.app
        </p>
    </div>`;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'notifications@bayclubhelper.app',
            to: env.ADMIN_EMAIL,
            subject: `Bay Club Bookings — Week of ${weekStart}`,
            html,
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Resend sendWeeklySummaryEmail failed: HTTP ${response.status} ${text}`);
    }
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
            const { bookedCourtId, bookedCourtName } = await fireBooking(booking, env);
            booking.status = STATUS_SUCCEEDED;
            // Track which court was actually booked so the email can mention a substitution.
            booking.bookedCourtId = bookedCourtId;
            booking.bookedCourtName = bookedCourtName;
            booking.usedFallback = bookedCourtId !== booking.bookingBody.courtId;
            await appendToHistory(env, booking, STATUS_SUCCEEDED, null, Date.now(),
                booking.usedFallback ? bookedCourtName : null);
        } catch (error) {
            booking.status = STATUS_FAILED;
            booking.failureReason = error.message || String(error);
            await appendToHistory(env, booking, STATUS_FAILED, booking.failureReason, Date.now(), null);
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

// #region Slot availability check.

// Minimum interval between checks for the same booking.  Set slightly below
// the 6-hour cron so back-to-back ticks do not skip a booking.
const SLOT_CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000;

function groupBy(arr, keyFn) {
    const result = {};
    for (const item of arr) {
        const key = keyFn(item);
        if (!result[key]) result[key] = [];
        result[key].push(item);
    }
    return result;
}

// Fetches the availability API for a booking's club and date, then returns
// the set of court IDs available at the booking's time window.
async function fetchAvailableCourtIds(booking, headers) {
    const body = booking.bookingBody;
    const dateValue = (body.date && body.date.value) || body.date;
    const params = new URLSearchParams({
        clubId: body.clubId,
        date: dateValue,
        categoryCode: body.categoryCode || 'pickleball',
        categoryOptionsId: body.categoryOptionsId || '',
        timeSlotId: body.timeSlotId || '',
    });
    const url = `${BOOKING_API_BASE}/availability?${params.toString()}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`Availability check failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    const clubAvail = (data.clubsAvailabilities || [])[0];
    if (!clubAvail) return new Set();

    // Build lookup maps mirroring the userscript pattern: courtById and
    // courtByVersionId so we can resolve courtsVersionsIds to real court IDs.
    const courtById = {};
    const courtByVersionId = {};
    for (const court of (clubAvail.courts || [])) {
        courtById[court.courtId] = court;
        if (court.courtSetupVersionId) {
            courtByVersionId[court.courtSetupVersionId] = court;
        }
    }

    const available = new Set();
    for (const slot of (clubAvail.availableTimeSlots || [])) {
        if (slot.fromInMinutes === body.timeFromInMinutes &&
            slot.toInMinutes === body.timeToInMinutes) {
            const versionIds = (slot.courtsVersionsIds && slot.courtsVersionsIds.length > 0)
                ? slot.courtsVersionsIds
                : (slot.courtId ? [slot.courtId] : []);
            for (const vid of versionIds) {
                const court = courtById[vid] || courtByVersionId[vid];
                if (court) {
                    available.add(court.courtId);
                }
            }
        }
    }
    return available;
}

// Picks the best available fallback court, preferring the same type as the
// primary court.  Falls back to the existing sort order (gated > edge >
// standard) established at scheduling time for backward compatibility with
// bookings that lack courtType tags.
function pickBestFallback(fallbackCourts, availableCourtIds, primaryType) {
    const available = (fallbackCourts || []).filter(
        c => availableCourtIds.has(c.courtId)
    );
    if (available.length === 0) return null;
    if (primaryType) {
        const sameType = available.filter(c => c.courtType === primaryType);
        if (sameType.length > 0) return sameType[0];
    }
    // Fall back to existing sort order.
    return available[0];
}

// Updates the court segment in the slot label.  The label format is
// "Club · Court · Time · Date", so index 1 is the court name.
function rebuildSlotLabel(booking) {
    const parts = (booking.slotLabel || '').split(' \u00b7 ');
    if (parts.length >= 4) {
        parts[1] = booking.originalCourtName || parts[1];
        return parts.join(' \u00b7 ');
    }
    return booking.slotLabel || '';
}

// Sends a notification email about the slot availability check result.
// Type is 'switched' (auto-switched to fallback) or 'taken' (no fallbacks).
async function sendSlotCheckEmail(env, booking, type, fallback) {
    if (!env.RESEND_API_KEY || !booking.notificationEmail) return;

    const recipients = [booking.notificationEmail, ...(booking.partnerEmails || [])]
        .filter((e, i, arr) => e && arr.indexOf(e) === i);

    let subject;
    let html;
    if (type === 'switched') {
        subject = `Court change: ${booking.slotLabel}`;
        html = [
            '<p>Your scheduled court <strong>' + escHtml(booking.switchedFromCourtName || 'unknown') + '</strong>',
            ' is currently taken by another member.</p>',
            '<p>We have automatically switched your booking to <strong>' + escHtml(fallback.courtName || 'another court') + '</strong>.</p>',
            '<p>The booking will still fire at the scheduled time.',
            ' You can cancel and reschedule if you prefer a different court.</p>',
            '<p><strong>' + escHtml(booking.slotLabel) + '</strong></p>',
        ].join('');
    } else {
        subject = 'Court unavailable: ' + booking.slotLabel;
        html = [
            '<p>Your scheduled court is currently taken by another member,',
            ' and no fallback courts are available at this time.</p>',
            '<p>The booking will still attempt to fire at the scheduled time,',
            ' but it is unlikely to succeed unless a court opens up.</p>',
            '<p>You can cancel and reschedule for a different time if needed.</p>',
            '<p><strong>' + escHtml(booking.slotLabel) + '</strong></p>',
        ].join('');
    }

    for (const email of recipients) {
        await sendResendEmail(env, email, subject, html).catch(() => {});
    }
}

// Runs every 6 hours.  For each pending booking whose fire time is still in
// the future, checks whether the scheduled court is still available.  If taken,
// auto-switches to the best available fallback and notifies the user.
async function runSlotCheckTick(env) {
    const now = Date.now();
    const bookings = await loadBookings(env);

    const candidates = bookings.filter(b =>
        b.status === STATUS_PENDING &&
        b.fireAtMs > now &&
        (!b.lastSlotCheckMs || (now - b.lastSlotCheckMs) > SLOT_CHECK_INTERVAL_MS)
    );

    if (candidates.length === 0) return;

    // Group by user so we only rotate one refresh token per user per cycle.
    const byUser = groupBy(candidates, b => b.notificationEmail);

    for (const [userEmail, userBookings] of Object.entries(byUser)) {
        let accessToken;
        try {
            accessToken = await refreshAccessToken(env, userEmail);
        } catch (_err) {
            // Cannot authenticate this user — skip their bookings this cycle.
            continue;
        }
        const headers = buildApiHeaders(accessToken, crypto.randomUUID());

        for (const booking of userBookings) {
            try {
                const availableCourtIds = await fetchAvailableCourtIds(booking, headers);
                booking.lastSlotCheckMs = now;

                if (availableCourtIds.has(booking.bookingBody.courtId)) {
                    // Primary court is still available.
                    booking.slotCheckStatus = 'available';
                } else {
                    // Primary court is taken.  Try to auto-switch.
                    const best = pickBestFallback(
                        booking.fallbackCourts,
                        availableCourtIds,
                        booking.primaryCourtType
                    );
                    if (best) {
                        booking.switchedFromCourtName = booking.originalCourtName;
                        booking.originalCourtName = best.courtName;
                        booking.bookingBody.courtId = best.courtId;
                        booking.fallbackCourts = (booking.fallbackCourts || [])
                            .filter(c => c.courtId !== best.courtId);
                        booking.slotCheckStatus = 'switched';
                        booking.slotLabel = rebuildSlotLabel(booking);
                        await sendSlotCheckEmail(env, booking, 'switched', best);
                        booking.slotCheckNotifiedAt = now;
                    } else {
                        booking.slotCheckStatus = 'taken';
                        // Only send the "taken" notification once per check cycle.
                        if (!booking.slotCheckNotifiedAt ||
                            booking.slotCheckNotifiedAt < (booking.lastSlotCheckMs || 0)) {
                            await sendSlotCheckEmail(env, booking, 'taken', null);
                            booking.slotCheckNotifiedAt = now;
                        }
                    }
                }
            } catch (_err) {
                // Availability check failed (network, API error) — skip this
                // booking and try again next cycle.
            }
        }
    }

    await saveBookings(env, bookings);
}

// #endregion Slot availability check.

// #region HTTP request handler.

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function checkSecret(request, env) {
    const secret = request.headers.get('X-Worker-Secret');
    return !!secret && secret === env.WORKER_SECRET;
}

// Accepts the secret via X-Worker-Secret header OR ?secret= query param so
// the dashboard and history endpoints can be bookmarked in a browser.
function checkSecretFlexible(request, env) {
    const url = new URL(request.url);
    const s = request.headers.get('X-Worker-Secret') || url.searchParams.get('secret');
    return !!s && s === env.WORKER_SECRET;
}

async function readJsonBody(request) {
    try {
        return { ok: true, data: await request.json() };
    } catch (_e) {
        return { ok: false, response: new Response('Invalid JSON body', { status: 400 }) };
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidBookingPayload(booking) {
    return isPlainObject(booking) &&
        typeof booking.id === 'string' &&
        booking.id.length > 0 &&
        Number.isFinite(booking.fireAtMs) &&
        isPlainObject(booking.bookingBody) &&
        isPlainObject(booking.confirmBody);
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check — publicly readable, no secret required.
    // Returns aggregate state for everyone; includes full booking details only
    // when a valid secret is supplied.
    if (method === 'GET' && path === '/status') {
        const bookings = await loadBookings(env);
        const lastRefresh = await env.BC_BOOKINGS.get(KV_LAST_REFRESH);
        const pending = bookings.filter(b => b.status === STATUS_PENDING);
        const nextFireAt = pending.length > 0
            ? new Date(Math.min(...pending.map(b => b.fireAtMs))).toISOString()
            : null;
        const statusPayload = {
            lastTokenRefresh: lastRefresh,
            pendingBookings: pending.length,
            nextFireAt,
        };
        if (checkSecretFlexible(request, env)) {
            statusPayload.scheduledBookings = bookings;
        }
        return jsonResponse(statusPayload);
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
        const dashUrl = new URL(request.url);
        const dashSecret = dashUrl.searchParams.get('secret') || '';
        const pageSize = 25;
        const page = Math.max(1, parseInt(dashUrl.searchParams.get('page') || '1', 10) || 1);
        const activeBookings = await loadBookings(env);
        let historyRows = [];
        let statsRows = [];
        let totalHistoryCount = 0;
        if (env.DB) {
            try {
                // Three parallel queries: paginated rows, all-time status counts, total row count.
                const [histResult, statsResult, countResult] = await Promise.all([
                    env.DB.prepare(
                        'SELECT * FROM booking_history ORDER BY completed_at_ms DESC LIMIT ? OFFSET ?'
                    ).bind(pageSize, (page - 1) * pageSize).all(),
                    env.DB.prepare(
                        'SELECT status, COUNT(*) as count FROM booking_history GROUP BY status'
                    ).all(),
                    env.DB.prepare('SELECT COUNT(*) as total FROM booking_history').all(),
                ]);
                historyRows = histResult.results;
                statsRows = statsResult.results;
                totalHistoryCount = (countResult.results[0] && countResult.results[0].total) || 0;
            } catch (_e) {
                // Table may not exist yet if schema has not been applied.
            }
        }
        return new Response(
            renderDashboardHtml(activeBookings, historyRows, statsRows, totalHistoryCount, page, pageSize, dashSecret),
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
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
        const parsed = await readJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const booking = parsed.data;
        if (!isValidBookingPayload(booking)) {
            return new Response('Bad Request', { status: 400 });
        }
        const bookings = await loadBookings(env);
        if (bookings.some(b => b.id === booking.id)) {
            return jsonResponse({ ok: true, duplicate: true });
        }
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
        const parsed = await readJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const { refresh_token: newToken, userId } = parsed.data || {};
        if (typeof newToken !== 'string' || newToken.length === 0 || typeof userId !== 'string' || userId.length === 0) {
            return new Response('Bad Request', { status: 400 });
        }
        await env.BC_BOOKINGS.put(tokenKvKey(userId), newToken);
        await env.BC_BOOKINGS.put(KV_LAST_REFRESH, new Date().toISOString());
        return jsonResponse({ ok: true });
    }

    // Returns the stored preference object for a user. The extension calls this
    // on every page load to propagate preferences across devices.
    // Returns { allowed: true } when the email is on the allow-list, { allowed: false }
    // otherwise.  The allow-list is a JSON array of lowercase email strings stored in KV
    // under the key "allowed_users".  An absent or empty allow-list permits everyone so
    // the feature degrades gracefully before the list is configured.
    if (method === 'GET' && path === '/allowed') {
        if (!checkSecret(request, env)) return new Response('Unauthorized', { status: 401 });
        const email = (request.headers.get('X-User-Id') || '').trim().toLowerCase();
        if (!email) return jsonResponse({ allowed: false });
        const raw = await env.BC_BOOKINGS.get('allowed_users');
        if (!raw) return jsonResponse({ allowed: true }); // no list configured — open
        let list;
        try { list = JSON.parse(raw); } catch (_e) { return jsonResponse({ allowed: true }); }
        if (!Array.isArray(list) || list.length === 0) return jsonResponse({ allowed: true });
        return jsonResponse({ allowed: list.map(e => String(e).trim().toLowerCase()).includes(email) });
    }

    if (method === 'GET' && path === '/prefs') {
        const userId = request.headers.get('X-User-Id');
        if (!userId) return new Response('Bad Request', { status: 400 });
        const prefs = await loadPrefs(env, userId);
        return jsonResponse(prefs || {});
    }

    // Stores the full preference object for a user. Called whenever the user
    // changes a preference, with an 800 ms debounce on the extension side.
    if (method === 'PUT' && path === '/prefs') {
        const parsed = await readJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const { userId, prefs } = parsed.data || {};
        if (typeof userId !== 'string' || userId.length === 0 || !isPlainObject(prefs)) {
            return new Response('Bad Request', { status: 400 });
        }
        await savePrefs(env, userId, prefs);
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

function renderDashboardHtml(activeBookings, historyRows, statsRows, totalHistoryCount, page, pageSize, secret) {
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
            const fallbackNames = (b.fallbackCourts || []).map(c => escHtml(c.courtName || c.courtId)).filter(Boolean);
            const fallbackCell = fallbackNames.length > 0
                ? `<td style="font-size:12px;color:#555;">${fallbackNames.join(', ')}</td>`
                : `<td style="color:#bbb;font-size:12px;">—</td>`;
            // Slot availability check status badge.
            const checkStatus = b.slotCheckStatus || 'unknown';
            const checkColors = { available: '#2e7d32', taken: '#c62828', switched: '#1565c0', unknown: '#999' };
            const checkLabels = { available: '✓ Available', taken: '⚠ Taken', switched: '↩ Switched', unknown: '—' };
            const checkCell = `<td style="font-size:12px;color:${checkColors[checkStatus] || '#999'};">${checkLabels[checkStatus] || checkStatus}</td>`;
            // Only pending bookings can be cancelled — firing means the API call is already in-flight.
            const cancelCell = b.status === STATUS_PENDING
                ? `<td id="cancel-cell-${escHtml(b.id)}"><button onclick="cancelBooking('${escHtml(b.id)}')" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;">Cancel</button></td>`
                : `<td style="color:#999;font-size:12px;">Firing…</td>`;
            return `<tr>
                <td>${badge(b.status)}</td>
                <td>${escHtml(b.slotLabel || '—')}</td>
                <td>${escHtml(b.userName || b.notificationEmail || '—')}</td>
                <td>${escHtml(partners)}</td>
                <td>${ptTime(b.fireAtMs)}</td>
                <td>${countdown(b.fireAtMs)}</td>
                ${checkCell}
                ${fallbackCell}
                ${cancelCell}
            </tr>`;
        }).join('');
        activeHtml = `<table><thead><tr>
            <th>Status</th><th>Slot</th><th>User</th><th>Partners</th><th>Opens At (PT)</th><th>In</th><th>Slot Check</th><th>Fallbacks</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // Stats bar — derived from the all-time aggregate query, not the paginated rows.
    const statsByStatus = {};
    statsRows.forEach(r => { statsByStatus[r.status] = r.count; });
    const nSucceeded = statsByStatus[STATUS_SUCCEEDED] || 0;
    const nFailed    = statsByStatus[STATUS_FAILED]    || 0;
    const nCancelled = statsByStatus['cancelled']      || 0;
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

    // History table with pagination.
    const totalPages = Math.max(1, Math.ceil(totalHistoryCount / pageSize));
    const firstOnPage = totalHistoryCount === 0 ? 0 : (page - 1) * pageSize + 1;
    const lastOnPage  = Math.min(page * pageSize, totalHistoryCount);
    const pageBase    = `/dashboard?secret=${escHtml(secret)}`;

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
            // booked_court_name is non-null only when the Worker used a fallback court.
            const courtCell = r.booked_court_name
                ? `<td style="font-size:12px;color:#b45309;" title="Original court was unavailable">↩ ${escHtml(r.booked_court_name)}</td>`
                : `<td style="color:#bbb;font-size:12px;">—</td>`;
            return `<tr>
                <td>${badge(r.status)}</td>
                <td>${escHtml(r.slot_label || '—')}</td>
                <td>${escHtml(r.user_name || r.user_email || '—')}</td>
                <td>${escHtml(partners)}</td>
                <td style="white-space:nowrap;">${ptTime(r.completed_at_ms)}</td>
                ${courtCell}
                ${reasonCell}
            </tr>`;
        }).join('');
        const prevLink = page > 1
            ? `<a href="${pageBase}&page=${page - 1}" style="color:#1a73e8;">← Previous</a>`
            : `<span style="color:#ccc;">← Previous</span>`;
        const nextLink = page < totalPages
            ? `<a href="${pageBase}&page=${page + 1}" style="color:#1a73e8;">Next →</a>`
            : `<span style="color:#ccc;">Next →</span>`;
        const paginationHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px;">
            ${prevLink}
            <span style="color:#999;">Showing ${firstOnPage}–${lastOnPage} of ${totalHistoryCount}</span>
            ${nextLink}
        </div>`;
        historyHtml = `<table><thead><tr>
            <th>Status</th><th>Slot</th><th>User</th><th>Partners</th><th>Completed (PT)</th><th>Fallback Used</th><th>Reason</th>
        </tr></thead><tbody>${rows}</tbody></table>${paginationHtml}`;
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
  <h2>History</h2>
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

// Named exports for unit testing — the Cloudflare runtime only invokes the
// default export's fetch and scheduled handlers, so these have no effect on
// production behavior.
export {
    tokenKvKey,
    isPlainObject,
    isValidBookingPayload,
    escHtml,
    checkSecret,
    checkSecretFlexible,
    handleRequest,
    runCronTick,
    runSlotCheckTick,
    fetchAvailableCourtIds,
    pickBestFallback,
    rebuildSlotLabel,
    groupBy,
};
