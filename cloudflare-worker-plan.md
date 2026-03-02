# Cloudflare Worker Migration Plan

## Goal

Move scheduled booking execution from the browser extension (localStorage +
timers + tab-must-stay-open) to a Cloudflare Worker that runs 24/7 without
any browser involvement. The extension becomes a thin scheduling UI that
reads/writes booking records via the Worker API.

---

## What Gets Reverted from the Extension

On a new branch, before building the Worker:

- Auto-login banner (`installLoginAutoLoginBanner`, `startLoginCountdown`)
- Title prefix countdown (`⏳ Booking in 2h 14m ·` updates to `document.title`)
- `beforeunload` dialog (tab-close prevention)
- `installTabClosePreventionIfNeeded` / `removeTabClosePreventionIfDone`
- Client-side fire sequence (`executeFireSequence`, `attemptFireWithPolling`)
- Client-side timer management (`scheduleTimersForBooking`, `timersByBookingId`)
- Prefire auth check (`prefireAuthCheck`)
- Slot monitoring polling (`startSlotMonitoringForBooking`, `checkSlotTaken`)
- `getScheduledBookingService()` localStorage persistence (gut and replace with
  Worker HTTP calls — the service stays but becomes a thin HTTP client)

## What Stays in the Extension

- Locked slot click → partner picker UI (how the user schedules a booking)
- `/bookings` page pending section (the dashboard — reads from Worker instead
  of localStorage)
- `getScheduledBookingService()` shell — public API stays the same but calls
  Worker endpoints instead of reading/writing localStorage

---

## Confirmed API Knowledge

All of the following have been tested end-to-end via curl and confirmed working:

- **Auth (password grant)**:
  `POST https://authentication2-api.bayclubs.io/connect/token`
  body: `grant_type=password&username=...&password=...&scope=... offline_access`

- **Token refresh**:
  `POST https://authentication2-api.bayclubs.io/connect/token`
  body: `grant_type=refresh_token&refresh_token=...`
  Note: refresh tokens **rotate on every use** — Worker must update KV immediately.

- **Availability check**:
  `GET https://connect-api.bayclubs.io/court-booking/api/1.0/availability`
  params: `clubId, date, categoryCode=pickleball,
           categoryOptionsId=182a18e2-fd11-4868-a6be-36d96f7f2645,
           timeSlotId=89a1327a-c893-49f6-88a9-be4c9ab4d481`

- **Booking POST**:
  `POST https://connect-api.bayclubs.io/court-booking/api/1.0/courtbookings`
  body: `{ clubId, courtId, date, timeFromInMinutes, timeToInMinutes,
           categoryOptionsId, timeSlotId, categoryCode }`
  response: `{ courtBookingId }`

- **Possible players**:
  `GET https://connect-api.bayclubs.io/court-booking/api/1.0/courtbookings/{id}/possiblePlayers`

- **Booking confirm**:
  `PUT https://connect-api.bayclubs.io/court-booking/api/1.0/courtbookings/{id}/confirm`
  body: `{ invitations: [{ personId }], isVisibleToBuddies: true }`
  response: empty body on success

All requests require:
- `Authorization: Bearer {access_token}`
- `Ocp-Apim-Subscription-Key: bac44a2d04b04413b6aea6d4e3aad294`
- `X-SessionId: {any UUID}`

---

## Step-by-Step Implementation Plan

### Phase 1 — Cloudflare Account + Wrangler Setup

1. Create a free Cloudflare account at cloudflare.com
2. Install Wrangler CLI: `npm install -g wrangler`
3. Authenticate: `wrangler login` (opens browser, click approve)
4. Create KV namespace: `wrangler kv namespace create "BC_AUTH"`
   — Note the namespace ID returned; goes into `wrangler.toml`
5. Bootstrap the refresh token into KV (one-time):
   `wrangler kv key put --namespace-id=XXX "refresh_token" "your-token-here"`

### Phase 2 — Build the Worker

Worker file: `worker.js` (new repo or subdirectory)
Config file: `wrangler.toml`

**KV keys:**
- `refresh_token` — current valid refresh token (rotated on every use)
- `scheduled_bookings` — JSON array of pending booking records
- `last_token_refresh` — ISO timestamp of last successful token refresh

**Worker endpoints (HTTP):**
- `POST /bookings` — add a scheduled booking (called by extension)
- `GET /bookings` — list all bookings (called by extension dashboard)
- `DELETE /bookings/{id}` — cancel a booking (called by extension dashboard)
- `GET /status` — health check: returns KV state, last token refresh time,
                   pending booking count, next fire time

**Cron trigger:** every 1 minute
- Check `scheduled_bookings` for any record whose `fireAtMs <= Date.now()`
- If found: refresh token → POST courtbookings → PUT confirm
- Update booking status in KV (`pending` → `succeeded` | `failed`)
- Send email notification (see Phase 4)

**Auth:** simple secret header (`X-Worker-Secret`) checked on all write
endpoints. Value stored as a Wrangler secret, also hardcoded in the extension.
Note: since the extension is public on GitHub this is noise-filtering only,
not real security. The actual security boundary is the refresh token in KV
which never leaves the Worker.

### Phase 3 — Adapt the Extension

- Replace `getScheduledBookingService()` localStorage reads/writes with
  `fetch()` calls to the Worker endpoints
- `/bookings` dashboard reads from `GET /bookings` instead of localStorage
- Cancel button calls `DELETE /bookings/{id}`
- Status polling: extension calls `GET /bookings` periodically to pick up
  `succeeded` / `failed` status updates written by the Worker cron

### Phase 4 — Email Notifications via Resend

1. Sign up at resend.com
2. Store API key as Wrangler secret: `wrangler secret put RESEND_API_KEY`
3. Add email send call to Worker fire sequence (success and failure)
4. For now use `onboarding@resend.dev` as sender (dev/testing only)

### Phase 5 — Custom Domain + Production Email

1. Buy a domain via **Cloudflare Registrar** (at-cost, no markup)
   Suggestion: something simple like a personal or project domain
2. Enable **Cloudflare Email Routing** (free) — forwards
   `bookings@yourdomain.com` to your Gmail
3. Verify the domain with Resend (add DNS TXT record — ~5 minutes)
4. Update Worker to send from `bookings@yourdomain.com`

### Phase 6 — SMS via Twilio (optional, after email is working)

1. Create Twilio account, get a phone number
2. Store `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
   as Wrangler secrets
3. Add SMS send call alongside email in the Worker fire sequence

---

## Cron Timing Note

Cloudflare cron triggers have a **minimum interval of 1 minute**. The Worker
fires within 1 minute of the target booking time, checks if `fireAtMs` has
passed, and executes if so. Precision is ±1 minute which is fine in practice
since the booking window opens at a specific minute anyway.

---

## Worker Health Check Endpoint (`GET /status`)

Returns a JSON snapshot useful for debugging:

```json
{
  "lastTokenRefresh": "2026-03-04T07:23:11Z",
  "pendingBookings": 2,
  "nextFireAt": "2026-03-06T07:00:00Z",
  "scheduledBookings": [ ... ]
}
```

---

## Open Questions / Nice-to-Haves for Later

- Backup slot support (if primary slot is taken, try a fallback slot)
- Favicon canvas overlay showing pending booking count
- Push notifications via Web Push API (for mobile, avoids SMS cost)
