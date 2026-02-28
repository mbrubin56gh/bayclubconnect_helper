# Scheduled / Pending Bookings Feature Design

## Status
Designed but not yet implemented. Discussed 2026-02-28. Start here when picking this up.

## What It Does
Allows booking a slot that is currently locked (outside the 3-day window). The user sets up
the booking in advance; the extension fires the actual API request at the exact moment the
booking window opens.

## Key Facts About The Booking Window
- Bay Club opens the booking window at the **exact minute** of the slot, 3 days earlier.
  Example: a 7:30 AM slot on Thursday becomes bookable at exactly 7:30 AM on Monday.
- There may be clock drift between the user's browser and Bay Club's server, so we should
  not rely on firing at T-zero; instead use an availability check loop.

## Partners Are Required
- The Bay Club booking system requires partners to be specified. A booking without partners
  fails or is rejected.
- **Open question**: are partners included in the initial `courtbookings` POST, or in a
  separate follow-up API call? Mark will do a test booking and capture the network traffic
  to determine this. **This must be resolved before implementation begins.**
- Current booking body we send (from `maybeRewriteBookingRequestToPendingSelection`):
  `{ clubId, courtId, date, timeFromInMinutes, timeToInMinutes, categoryOptionsId, timeSlotId }`
  — no partners yet.

## Proposed User Flow
1. User sees a locked slot in our availability UI and clicks it.
2. We show a "Schedule this booking?" confirmation in our UI.
3. User confirms → we allow the **normal Angular booking flow to proceed** (fake-click the
   native slot, let Angular render its partner selection screen as usual).
4. At the moment Angular submits the final booking POST (and any subsequent partner call),
   **instead of firing the request(s), we capture the full body/bodies and save to
   localStorage** as a pending booking.
5. We immediately show our own "Booking scheduled!" overlay/screen.
6. The tab must remain open for the scheduled fire to occur (no service worker for now).

## Timing and Polling Strategy
- **T-minus 2 minutes**: fire a lightweight availability check to freshen auth headers
  (they come from `getBookingStateService().getCapturedHeader()`). Alert user if session
  appears dead so they can log back in before the window opens.
- **T-zero**: fire the availability check. If slot shows as unlocked/available → fire
  the booking immediately. If still locked → enter polling loop.
- **Polling loop**: check availability every 30 seconds, max 4 attempts (~2 minutes total).
  Stop immediately on first success or on confirmed booking.
- **After 4 failed polls**: give up. Show browser notification and/or banner: "Slot didn't
  open in time — please book manually." Link user back to the booking flow.

## Auth Header Strategy
- We do NOT store auth headers at scheduling time. We use the **freshest captured headers
  at fire time**, since the SPA will have refreshed them if the tab has been active.
- The T-minus-2-minute availability check is the explicit mechanism for ensuring fresh headers.

## Notifications
- Use `navigator.Notification` API with `{ requireInteraction: true }` so the notification
  stays on screen until dismissed (works on desktop Chrome and Firefox).
- Request notification permission at scheduling time (cannot do so during a background event).
- Also open a `mailto:` draft on success/failure for email notification (same pattern as
  existing debug email logs).
- **Skip SMS** — no clean path from desktop browser without a backend.

## localStorage
- Key: `bc_scheduled_bookings` — JSON array of pending booking objects.
- Each entry shape (TBD based on partner API findings):
  ```
  {
    id: <uuid>,
    fireAtMs: <unix ms timestamp>,
    bookingBody: { ... },        // courtbookings POST body
    partnerBody: { ... } | null, // partner follow-up POST body, if separate
    partnerUrl: <string> | null, // URL for partner follow-up call, if separate
    slotLabel: "Broadway · 7:00 am–8:00 am · Mar 6",  // for display
    status: 'pending' | 'fired' | 'succeeded' | 'failed' | 'cancelled'
  }
  ```

## Multiple Pending Bookings
- Multiple pending bookings are allowed.
- Each is set up via a **separate booking flow session** (user goes through the flow again).
- They fire independently based on their own `fireAtMs`.

## Planned Future Enhancement: Backup Slots (Not In First Version)
- In a single booking flow, user selects a primary locked slot (e.g., Broadway 7am) and
  optionally designates one or more backup slots (e.g., South SF 7am).
- At fire time, attempt the primary. If it fails, immediately attempt the first backup, etc.
- UI for selecting backups TBD. Keep this in mind when designing the scheduling data model
  so the array structure can later hold ordered alternatives for the same "session."

## Backend Migration Path (Future, Optional)

### Why bother
- Removes tab-must-stay-open constraint
- Enables real email delivery (not just a mailto draft)
- Auth tokens still the main security concern: they'd travel from browser to server over HTTPS
  and be stored server-side; acceptable for a personal project the user controls

### Recommended platform: Cloudflare Workers
- Completely free tier: 100k requests/day, Cron Triggers (fire every minute), KV storage
- No server to manage, no sleeping instances, no credit card required
- TypeScript only (not Kotlin), but the Worker logic is simple enough that fluency isn't needed:
  store a record → check timestamps → call fetch() → write result back
- Cron Trigger checks KV every minute for pending bookings whose fire time has passed
- Email via Resend or SendGrid (both have free tiers, ~3k emails/month) — a single fetch()
  POST from the Worker is all that's needed

### Why not Kotlin on cloud
- JVM memory footprint (~256MB minimum) rules out truly free tiers
- Free tiers that could host it (Fly.io, Render, Railway) either have too little RAM or
  sleep after inactivity, which breaks scheduling reliability

### Kotlin option if cloud isn't desired
- Local Ktor server on the user's Mac, auto-started via launchd
- Same constraint as tab (Mac must be awake) but browser tab not required
- Zero cloud cost, user writes Kotlin they're comfortable with
- Viable middle step between tab-only and full cloud

### How the design changes with a backend
| Concern | Tab-stays-open | With Cloudflare Worker |
|---|---|---|
| Pending booking storage | localStorage | Worker KV |
| Timing/fire logic | setTimeout in browser | Cron Trigger server-side |
| Auth tokens | Stay in browser, always fresh | Sent to and stored by Worker |
| Notifications | Browser Notification API | Worker sends real email |
| Partners capture | Intercept Angular POST in browser | Same, then POST captured body to Worker |

### Auth token staleness — the hardest problem in the Cloudflare approach
With the tab open, the SPA keeps the session alive through its own API calls; our T-minus-2-min
availability check is just explicit insurance on top of a warm session. With Cloudflare, the tab
is closed, nothing keeps the session alive, and tokens age from the moment they were saved to KV.
Bay Club sessions are almost certainly shorter than 12 hours, so overnight pending bookings would
reliably fire with dead tokens.

Options:
1. **Hope sessions last long enough** — fragile; only works if booking is set up close to fire time.
2. **Store username/password for re-auth** — Worker authenticates fresh before firing. Most reliable
   but storing credentials server-side is a meaningful security step up.
3. **Hybrid approach (recommended)** — Worker emails user at T-minus-15-minutes: "Your booking fires
   soon — open bayclubconnect.com to refresh your session." User opens tab; Tampermonkey detects the
   imminent pending booking and POSTs fresh headers to the Worker. Worker fires within the 15-minute
   fresh-token window. Gets the "no tab overnight" benefit while solving staleness with a brief human
   touch.

This staleness problem does not exist in the tab-stays-open approach, which is a further reason to
build that first and treat the Cloudflare backend as optional polish.

### Migration strategy
1. Build tab-stays-open first (cleaner, no infrastructure)
2. Keep fire logic in a self-contained `getScheduledBookingService()` module
3. When migrating: move fire logic to Worker, update Tampermonkey to POST booking details
   to Worker endpoint instead of localStorage, poll Worker for status updates

## Tab-Close Prevention UI

While a pending booking is active, we must keep the user from accidentally closing the tab
before the booking fires. Three mechanisms work together:

### 1. Title Prefix (most visible)
- Prepend an emoji + countdown to `document.title`:
  `⏳ Booking in 2h 14m · COURT BOOKING` (or whatever the native Angular title is).
- Update every minute via `setInterval`.
- Angular overwrites `document.title` on route changes; counter this by installing a
  `MutationObserver` on the `<title>` element and immediately re-prepending the prefix
  after any Angular-driven title update.
- Remove the prefix and the observer when the last pending booking is resolved.

### 2. Favicon Canvas Overlay (ambient reminder)
- Draw a small amber circle over the existing favicon using an off-screen `<canvas>`.
- `URL.createObjectURL(canvas.toBlob(...))` → set as `link[rel=icon]` href.
- Revert the favicon when all pending bookings are resolved.

### 3. `beforeunload` Dialog (safety net)
- Register a `beforeunload` handler that sets `event.returnValue` to a non-empty string.
- The browser shows its own generic "Leave site? Changes you made may not be saved" dialog —
  modern browsers do not allow custom text, which is fine for our purposes.
- Deregister the handler once all pending bookings are resolved.

## Why Non-Tab Approaches Were Rejected

The fundamental constraint is **auth token staleness**. The `Authorization` and `X-SessionId`
headers we need to fire the booking request are captured from live XHR calls made by the
Angular SPA. They expire on the Bay Club server after some session lifetime (almost certainly
well under 12 hours). There is no browser mechanism that can refresh Bay Club session tokens
without the SPA actively running.

### Service Workers
- Service Workers are event-driven; they do not run on a timer unless woken by a push event
  from a backend server. Without a backend, there is no reliable way to wake a Service Worker
  at a specific future time.
- Even if woken, the Service Worker has no access to the SPA's live session; the tokens it
  would hold are the same stale ones captured at scheduling time.
- Periodic Background Sync is browser-discretionary and not suitable for time-critical bookings.

### Cloudflare Workers (or any server-based approach)
- Eliminates the tab-must-stay-open constraint, but the auth token staleness problem does not
  go away — it just moves from the browser to the server.
- Bay Club tokens would need to travel from the browser to the Worker over HTTPS and be stored
  in KV. Tokens age from the moment the user closes the tab; if the booking window is overnight
  or many hours away, tokens are almost certainly dead at fire time.
- The least-bad mitigation is a "hybrid" approach: Worker emails user at T-minus-15-minutes,
  user opens a tab, Tampermonkey detects the imminent booking and POSTs fresh headers to the
  Worker. This adds meaningful user friction and requires the user to be available and
  responsive shortly before every scheduled booking — which partly defeats the purpose.
- Storing username/password in the Worker for re-auth is the most reliable alternative, but
  is a meaningful security step up that is not appropriate for this personal-project scope.

### Conclusion
The tab-stays-open approach handles token freshness naturally: the SPA keeps its own session
alive through normal API calls, and our T-minus-2-minute availability check is explicit
insurance on top of an already-warm session. Build this first. The Cloudflare path remains
a viable optional polish step later if the hybrid auth approach is acceptable.

## Architecture Notes
- Implement as a new `getScheduledBookingService()` creator following existing singleton
  closure patterns in the script.
- The service owns: reading/writing `bc_scheduled_bookings`, scheduling `setTimeout` timers,
  executing the fire sequence, and triggering notifications.
- On every page load, check for any pending bookings whose `fireAtMs` is in the past
  (overdue) and attempt them immediately.
- The XHR interceptor's `send` handler will need a new branch: if a `courtbookings` POST
  fires and there is an **active scheduling flow in progress** (a flag the service sets),
  capture and suppress rather than rewrite-and-send.
