# Bay Club Connect Pickleball Court Reservation Helper


## What This Is

A Tampermonkey userscript (`loading_script.user.js`) that improves the court booking experience on bayclubconnect.com. The app natively only shows availability for a single "home" club, but Bay Club members can book at any club. This script fetches availability across all four Bay Area clubs in parallel and displays them in a unified UI.

## Working style

This is a JavaScript project. Use JavaScript for all new files and modifications unless otherwise specified.

When the script is already reliable for the current friend-group scope and only minor styling or speculative edge-case ideas remain, prefer no-change unless there is a reproducible user-facing bug.

## The Four Clubs

```javascript
const CLUBS = {
    broadway:      '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63',
    redwoodShores: '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18',
    southSF:       'ce7e7607-09e6-4d16-8197-1fffb70db776',
    santaClara:    '3bc78448-ec6b-49e1-a2ae-64abd68e646b',
};
```

Broadway and South SF have indoor courts only. Santa Clara has a 60-minute max booking (no 90-minute slots).

## Key Architectural Patterns

### XHR Interception
The script patches `XMLHttpRequest.prototype.open`, `send`, and `setRequestHeader` to:
1. Intercept the native availability request and trigger our own parallel fetches for all clubs
2. Capture `Authorization` and `X-SessionId` headers for reuse in our own requests
3. Intercept the `courtbookings` POST and replace it with our own booking body (correct club, court, time)

The monkey-patch wiring is installed through an in-file `installXhrInterceptors()` function so interceptor internals (including booking dedupe state) stay closure-scoped.
Per-request XHR metadata (method, URL, Request-Id) is tracked in a closure-scoped `WeakMap` rather than custom properties on XHR instances.

### Allow-List Gating
`installXhrInterceptors()` runs unconditionally on every page load (auth header capture and token sync are harmless for any user). All visible features are gated behind an allow-list check: `readUserEmail()` reads the user's email from `localStorage.connect20auth` (which Angular writes before our script runs) with `bc_notification_email` as fallback. If an email is found, `checkAllowList(email)` fetches `GET /allowed` from the Worker; on success it initializes all feature installers. If the email is absent (not logged in) or the check returns `allowed: false`, no features start. The check fails open on any network or HTTP error so infrastructure issues never lock out legitimate users.

### Court View Multi-Club Columns

Angular's native Court View only shows courts for the home club. We extend it to show all four clubs by intercepting **two** courtsheet XHR endpoints and merging data from all other clubs into the native response before Angular reads it.

**Two-endpoint pattern** — Angular makes these two requests in sequence when entering Court View:
1. `GET /courtsheet/{clubId}/courts?date=...&categoryCode=...&categoryOptionsId=...&timeSlotId=...` — returns `{ items: [...courts] }`, the list of court columns to render.
2. `GET /courtsheet/{clubId}?date=...` — returns `{ events: [...] }`, the booking events that fill each column's availability blocks.

Both are intercepted in `XMLHttpRequest.prototype.open` using the same `stopImmediatePropagation` + re-dispatch pattern:
- Attach a `load` listener before Angular's.
- Call `event.stopImmediatePropagation()` to block Angular.
- Parse the native response, fetch the same endpoint for all other clubs in parallel via `Promise.allSettled`, merge the results, call `applyMergedPayloadToXhr`, then `dispatchEvent(new ProgressEvent('load'))` to let Angular proceed with the merged payload.
- The entire `.then()` body is wrapped in `try/catch` with the `dispatchEvent` call **outside** the try/catch, so Angular is never left hanging even if merging throws.

**Regex guards**: The courts endpoint uses `/\/courtsheet\/[^/]+\/courts(\?|$)/`. The events endpoint uses `/\/courtsheet\/[^/]+(\?|$)/` combined with `!/\/courtsheet\/[^/]+\//` to exclude `/courts` and any other sub-paths — the two interceptors do not overlap.

**`getMergedCourtsOrder()`** on `getBookingStateService()` stores the `[{courtId, clubId, courtName, courtOrder}]` array built during courts merging. `getNativeCourtColumnsService` uses this to tag each rendered `app-booking-calendar-column` with `data-bc-club-id` and `data-bc-court-id` by index position, since Angular renders columns in the same order courts appear in the response.

**Booking POST rewrite** — when the user clicks a native Court View slot, Angular POSTs `courtbookings` with the home club ID. `maybeRewriteCourtViewBooking()` intercepts this POST, looks up the correct `clubId` from `mergedCourtsOrder` using the `courtId` in Angular's POST body (which is the real UUID from our merged response), and replaces just the `clubId`. The Santa Clara 60-minute cap is also applied. `pendingSlotBooking` is not involved — no click interception is needed.

**Bottom bar label** — `getNativeCourtColumnsService` installs a delegated `click` listener on `app-booking-calendar`. When a non-home-club slot is clicked, a polling interval waits for Angular's bottom bar, reads Angular's native label text (which has the correct court name and time but wrong club name), strips the home club short name, and prepends the correct club short name via `buildCourtViewBarLabel()`. The listener and interval are torn down in `clear()` on flow exit.

**Column color coding** — `CLUB_COLUMN_COLORS` maps each club UUID to a bright accent color chosen to pop against the dark blue calendar background. `injectColumnColorStyles()` (called once from `install()`) appends a `<style data-bc-col-colors>` tag to `<head>` with two rules per club: a `border-top` on `div.booking-calendar-column-header` for the colored band, and a `::before` on `div.court-name` showing the club short name in the same color above the court number. Both use purely in-flow CSS — no DOM nodes are added inside the columns, so Angular's time-position calculations are unaffected. The style tag is removed in `clear()`. Note: `border-top` on the column element itself is hidden by ancestor `overflow:hidden`; targeting the inner `div.booking-calendar-column-header` is what actually shows.

**Locked slots in Court View** — Slots with `booking-calendar-column-time-slot-unavailable` are outside the 3-day booking window and inert in Angular's native UI. We intercept clicks in capture phase (before Angular's bubble-phase listener) and call `stopPropagation()` to suppress Angular's error, then open the same partner picker / schedule panel used by Hour View locked slots (`handleCourtViewLockedSlotClick`). The panel is injected as a `position:fixed` overlay on `document.body` (attribute `data-bc-cv-schedule-overlay`) rather than into `getTimeSlotHosts()`, because those hosts contain no `app-court-time-slot-item` elements in Court View and would return empty. Hiding `app-booking-calendar` is deliberately avoided — it would trigger the MutationObserver reconcile and immediately clear the overlay. Slot time is derived from `COURT_VIEW_GRID_START_MINUTES` (5 AM = 300 min) plus the slot's index within the column × 30 min. Slots occupied by existing events (checked against `courtsheetEventsByClubId`) silently ignore clicks.

**Locked slot hover highlighting** — `injectColumnColorStyles()` also injects CSS rules that give `cursor:pointer` to all locked slots in tagged columns, and apply a teal inset box-shadow highlight to elements tagged `data-bc-hover-highlight`. `onCalendarMouseOver` (delegated `mouseover` on `app-booking-calendar`, bubble phase) detects the hovered locked slot, computes a duration-aware highlight window, and sets the attribute on each slot in the window with a position value (`first`/`middle`/`last`/`only`). The CSS uses the position value to add top/bottom inset shadows only on the outer slots, producing a single unified rectangle with no interior horizontal dividers. Window algorithm: extend downward (later in time) from the hover slot until the full booking duration is covered or a booked event is hit, then fill any shortfall by extending upward (earlier in time) from the hover slot, stopping at the next booked event or column boundary. `clearLockedSlotHover()` is called on `mouseleave` and in `clear()`.

**What still needs work**:
- Club navigation UI: scroll-to-club buttons so users can jump to a club's courts by clicking its name. DOM manipulation inside the calendar column area has repeatedly broken slot clickability and triggered Angular re-render loops. Requires careful DevTools investigation of the actual scroll container before re-attempting.
- Pod reservation conflict shading: `tagColumns()` already stamps `data-bc-pod-conflict` on columns whose club has a confirmed pod member reservation and CSS dims those columns to `opacity:0.45`. Pending conflict (scheduled booking by a pod member) dimming is not yet implemented.
- Show names of everyone on a reservation, even if they are not in the user's buddy list.
- Edge/gated court indicators: E, G, H badges on column headers (mirroring Hour View), so users can identify preferred courts at a glance.
- Time range slider: filter visible time rows by time of day, mirroring the Hour View slider.
- Weather: hourly emoji on the Court View time axis, mirroring the Hour View weather display.
- Indoor/outdoor indicator: Broadway and South SF are indoor-only; surface that in the column headers.

## XHR Response Interception (Fake Slot Injection)

Angular reads the availability response via the `response` property (not `responseText`) on the XHR object. 
We intercept this in `XMLHttpRequest.prototype.open` by attaching a `load` event listener to any request 
matching `connect-api.bayclubs.io/court-booking/api/1.0/availability`. If the response contains zero 
available time slots but does have courts, we inject a single fake 7:00–7:30 AM slot using a real courtId 
from the response, then override both `response` and `responseText` via `Object.defineProperty` so Angular 
renders it as a clickable native slot.

This solves the fundamental problem that our multi-club UI needs a native Angular slot to secretly click 
in order to advance the Angular state machine when the user hits Next. Without this, if the home club has 
no availability for the selected date, there would be nothing to click and the booking flow would be dead. 
The fake slot is never actually booked — our `send` interceptor replaces the outgoing booking request with 
the user's real selection before it reaches the server.

Note: `configurable: true` is required on the `Object.defineProperty` calls to avoid errors if the 
property is defined more than once.

### Angular State Machine Hack
The app is Angular-based. We can't easily drive its state machine directly, so when a user selects one of our injected slots, we secretly click a native Angular time slot to advance Angular's state. We then intercept the outgoing booking request and replace it with our own. This means the native club must have at least one available slot on the selected date.  See the documentation for XHR Response Interception (Fake Slot Injection) on how we ensure that there is always an available slot on the selected date, even if we have to synthesize falsely that slot.
Cross-browser note: Chrome pre-renders the bottom bar container (`.white-bg.p-2 .container`) in a disabled state before any slot is clicked, so it is always present when `selectCourtOption` runs. Firefox renders it asynchronously, only after Angular processes the `nativeSlot.click()`. Therefore `nativeSlot.click()` must be called unconditionally before any bottom bar querySelector check; a one-shot `MutationObserver` (`tryUpdateBottomBar`) then fires once Angular renders the bar.
 
### DOM Injection
We hide (not remove) native content and inject our own `<div class="all-clubs-availability">` into two containers Angular uses for desktop (`.item-tile`) and mobile (`.d-md-none.px-3`). We re-inject whenever the MutationObserver detects container changes (e.g. date change).
When resolving injection hosts, prefer containers that actually contain native time-slot rows (`app-court-time-slot-item`) rather than matching broad layout selectors globally. This avoids mis-targeting unrelated `.item-tile` nodes in some mobile/browser variants (for example, Firefox Android layout behavior).
When unhiding native UI, only unhide elements the helper explicitly hid (using a `data-*` marker), rather than globally unhiding all children under broad host selectors.

To reduce churn from Angular mutation bursts, booking-flow DOM reconciliation is batched through `requestAnimationFrame`, so repeated mutation callbacks collapse into one reconcile pass per frame.
Booking-step selectors and related visibility checks are centralized in `getBookingDomQueryService()` so monitor, injection, and cleanup logic share one source of truth for brittle Angular DOM signatures.

### Scheduled Bookings

Bay Club opens booking windows exactly 3 days in advance at the minute of the slot. The helper makes locked slots (beyond the window) clickable and books them automatically when the window opens.

**Locked slot → partner picker flow**: Clicking a locked slot calls `handleLockedSlotClick`, which fetches the player list (see below), then renders an inline partner picker entirely within the helper UI. No Angular state machine interaction occurs. The user selects partners and clicks Schedule; `getScheduledBookingService().scheduleBooking()` persists the record and sets timers.

**Player list strategy (cache-first)**:
1. Check `bc_possible_players` and `bc_player_photos` in localStorage. If present, use immediately.
2. If absent, XHR interception of the native `possiblePlayers` and `photos/members` endpoints populates the cache automatically during any normal booking flow.
3. If still absent, `fetchPossiblePlayers` fetches `GET /profile/api/1.0/profile/household` and `GET /buddy-list/api/1.0/buddylist` in parallel. It merges household `addOns` (status `Active`) and buddy list items (status `Approved`), deduped by `personId`. Photos are fetched for all players plus the primary user in the same call, then both player list and photos are cached. No `courtBookingId` is needed.
- Player objects from household use `memberIdentifier` for photo lookup; buddy list objects use `memberId` for the same concept. Both are normalized to `memberIdentifier` in the merged result. Photo lookups and `data-member-id` card attributes use `player.memberIdentifier || player.memberId` to handle both XHR-cached (old format) and API-fetched (new format) players.
- Player objects include `email` (from both household and buddy list API responses) so partner email addresses are available at scheduling time. The XHR-intercepted `possiblePlayers` cache also stores raw API objects wholesale, so email is present there too if the endpoint returns it.
- The photos API (`checkin/api/1.0/photos/members`) requires **repeated** query params (`?membersIds=X&membersIds=Y`), not comma-separated. Only use a photo when `state !== 'NotAllowed'`.
- `cachePhotosFromXhr` always **merges** into the existing cache — never replaces — so a sparse on-demand result cannot evict richer XHR-intercepted data.

**Two-step booking API**:
1. `POST courtbookings` with `{ clubId, courtId, date, timeFromInMinutes, timeToInMinutes, categoryOptionsId, timeSlotId }` → response `{ courtBookingId }`.
2. `PUT courtbookings/{courtBookingId}/confirm` with `{ invitations: [{ personId }], isVisibleToBuddies: true }`.
Partners are mandatory. The `Ocp-Apim-Subscription-Key` header is static.

**Fire sequence**: Handled entirely server-side by the Cloudflare Worker cron (see below). The browser tab does not need to stay open. On success or failure, the Worker sends an email notification via Resend from `notifications@bayclubhelper.app` — both to the scheduler (`notificationEmail`) and to each partner whose email was captured at scheduling time (`partnerEmails`). Partner emails are looked up from the cached player list at the moment `scheduleBooking` is called; partners without a stored email are silently skipped. The scheduler's email is not sent a second time if it also appears in `partnerEmails`. Partner notification subjects use `booking.userName` as the scheduler label, falling back to `booking.notificationEmail`, then a generic phrase.

**Dashboard pending cards**: `injectPendingCardsForDashboardPage` injects cards for active scheduled bookings into the dashboard carousel (`.responsive-carousel`) on `/home/dashboard`. Each card matches the native tile dimensions (205px) and uses native dashboard CSS classes (`dashboard-card`, `dashboard-card--vertical`, etc.) so it blends visually with confirmed booking cards. A `⏳ PENDING` badge overlays the image. Clicking the card navigates to `/bookings`. Calendar export links are appended via `appendCalendarActions`. Cards are filtered via `isBookingRelevantToCurrentUser` (same as the `/bookings` pending section), inserted before the "Book an Activity" tile, and tracked by `data-bc-dashboard-pending="{id}"` for idempotent add/remove on each reconcile pass.

**`/bookings` pending section**: `injectPendingBookingsSection` injects a "Pending Bookings" section showing active (pending/firing) and failed bookings. The section is filtered to bookings where the current user is the scheduler (`notificationEmail`) or an invited partner (`partnerEmails`), via `isBookingRelevantToCurrentUser`. Partner rows show a "Scheduled by [name]" attribution and omit the Cancel/Dismiss buttons — only the scheduler can cancel or dismiss. Countdowns are updated by a dedicated 60-second `setInterval` that also polls the Worker for status changes. Never update DOM text inside `injectPendingBookingsSection` when the section already exists — doing so re-triggers the `MutationObserver → scheduleReconcile → RAF` cycle at up to 60 fps, making the page unresponsive. Structural moves (e.g. `insertBefore` to relocate the section above `app-calendar-cancelled-by-me-list` when the cancelled list renders after initial injection) are safe because they are one-shot and stabilize immediately. `fetchAllFromWorker` dispatches a `CustomEvent('bc-bookings-updated')` after updating `cachedBookings`; `createBookingsCalendarExportInstaller` listens for it to call `scheduleReconcile`. This is more reliable than the MutationObserver DOM-nudge pattern in Firefox, where an append+remove that resolves before the next microtask checkpoint may not trigger the observer.

**`getScheduledBookingService()`** is the singleton closure service owning all of: Worker API calls, local booking cache, player/photo caching, notification email/phone fetching, refresh token sync, and the public API (`scheduleBooking`, `cancelBooking`, `dismissBooking`, `getActiveBookings`, `getFailedBookings`, `fetchPossiblePlayers`, `fetchNotificationEmail`, `pushRefreshToken`, `syncRefreshTokenFromAppStorage`, `initializeOnPageLoad`, and XHR cache helpers).

**`connect20auth` as a synchronous profile source**: Angular writes `localStorage.connect20auth` (including `profile.data.email`, `firstName`, `lastName`) before our script runs on every authenticated page load. Prefer reading from `connect20auth` first — before falling back to cached `bc_*` keys or making a network call — whenever user identity data is needed at startup. This avoids unnecessary API round-trips and eliminates first-load grace periods. `readUserEmail()` (IIFE scope) and `readProfileFromAppStorage()` (`getScheduledBookingService()` scope) encapsulate this pattern.

**Refresh token management**: On every page load, `syncRefreshTokenFromAppStorage()` reads the Angular app's auth state from `localStorage.connect20auth` (where the app persists its token after login) and PUTs the refresh token to the Worker's `PUT /token` endpoint. The XHR and fetch interceptors also forward any token responses seen during the session. This keeps the Worker's KV refresh token perpetually current without manual bootstrapping.

### Navigation Cleanup
The script uses a booking-flow monitor with lifecycle management:
- It patches `history.pushState` and `history.replaceState` (and listens to `popstate`) to detect flow transitions when Angular emits them.
- Those history wrappers are intentionally left installed for the page lifetime. They are lightweight and improve reliability because uninstalling and reinstalling wrappers around flow transitions can miss Angular navigation events.
- While on the booking flow, it runs active monitoring (MutationObservers plus a fast URL poll) to catch transitions that Angular performs without reliable history events.
- Outside the booking flow, it tears down active monitoring and switches to a lightweight bootstrap poll that only checks for re-entry.
- On `visibilitychange`, it pauses monitoring while the tab is hidden and performs immediate state reconciliation when the tab becomes visible again.
- Back-to-home cleanup is triggered through one delegated capture-phase click listener on `document`, scoped to `app-page-title`, covering both the back arrow icon and `BACK TO HOME` text controls.
- On exit from booking flow, it cleans up injected content, clears booking state, and aborts in-flight availability fetches.
- As an additional safeguard, if the page title is `COURT BOOKING` and Hour View controls are absent, injected slot UI is cleared. This guard is intentionally constrained so it does not trigger on the duration/player filter screen where auto-selection and club-order injection still need to run.

## UI Features

- **Multi-club availability**: All four clubs shown grouped by Morning / Afternoon / Evening
- **Grouped time slots**: Multiple courts at the same time shown as a single expandable card; single-court slots are directly selectable
- **Edge court indicators**: **E** marks courts on the edges of the court area (less ball spillage); **G** marks gated courts (e.g. surrounded by a fence), which are the most prized; **H** marks courts adjacent to a hitting wall, displayed alongside E or G
- **Club preference ordering**: Drag-and-drop widget on the duration selector page, persisted to localStorage
  Drag lifecycle wiring for this widget is encapsulated in `getClubOrderWidgetController()`, keeping transient drag state private.
- **Time range filter**: Dual-handle slider to filter slots by time of day, persisted to localStorage
  Slider drag lifecycle and transient drag state are encapsulated in `getTimeRangeSliderController()`.
- **Indoor courts toggle**: Hides outdoor-only clubs; persisted to localStorage
- **Hourly weather**: Fetches hourly forecast from Open-Meteo API; shows the relevant emoji below each hour label on the time range slider; rain emojis are accompanied by a centred rain-probability percentage
  Weather data and cache are encapsulated in an in-file `getWeatherService()` closure with a narrow API (`whenReady`, `emojiForHour`, `rainPctForHour`).
- **Hour View auto-select**: Automatically clicks "HOUR VIEW" button on first render (marked with `data-bc-auto-selected` to avoid re-firing)
- **By-club / By-time toggle**: Two-button toggle switches between grouping slots by club (default) or by time slot; persisted to localStorage
- **Duration and player preference auto-select**: Native selection controls are re-applied from localStorage through a dedicated `getPreferenceAutoSelectService()` closure so temporary fallback-suppression state stays internal.
- **Scheduled bookings**: Locked slots (beyond the 3-day booking window) are clickable. Clicking one opens an inline partner picker built entirely by the helper — no Angular state machine involvement. After the user selects partners and taps Schedule, the helper persists the booking to localStorage and fires the two-step booking API (`POST courtbookings` → `PUT courtbookings/{id}/confirm`) at the exact moment the window opens. A "Pending Bookings" section on `/bookings` shows countdown, scheduled time, and a Cancel button for each pending booking. Failed attempts show with a red error row and a Dismiss button.
- **Debug mode panel**: When debug mode is enabled, the injected availability UI includes a compact panel with a toggle plus `Copy logs`, `Email logs`, `Download logs`, and `Clear logs` controls for support troubleshooting.
- **Bookings**: We augment scheduled court bookings on the /bookings page with links to create or download a calendar entry. We also inject scheduled bookings on the /bookings page.

## Debug Mode Activation And Logging

- Debug mode is intentionally hidden behind a user-friendly activation handshake that works on any Bay Club page.
- Activation methods:
  Five taps/clicks in the top-left corner (72 by 72 pixels) within 4 seconds.
  Typing `debug` within 5 seconds while focus is not in an input, textarea, or contenteditable field.
- Activation should set `bc_debug_enabled` to `'1'` and show a confirmation alert.
- Debug entries are capped in a ring buffer (`MAX_DEBUG_ENTRIES`) and persisted so logs survive page refreshes.
- Debug payloads must be sanitized before persistence or console output. Sensitive keys such as authorization, session, token, and request identifiers should be redacted.
- The `Email logs` action should attempt to open a `mailto:` draft in a new tab first, with a same-tab fallback if pop-up policies block opening a new tab.
- Debug panel action buttons should follow the same visual style as the helper controls and should not appear sticky after click.

## Global State (intentional)

Most mutable booking/network state is encapsulated in a singleton in-file service (`getBookingStateService()`), rather than free-floating script-level variables.
Duration/player preference auto-selection also uses an in-file closure service (`getPreferenceAutoSelectService()`) so transient selection-suppression state is not exposed at script scope.

- `lastFetchState` — `{ transformed, params, failedClubIds }` — the last fetched and transformed availability data plus request params and per-club failure markers
- `pendingSlotBooking` — `{ clubId, courtId, date, fromMinutes, toMinutes }` — set when user selects a slot, consumed by the XHR interceptor
- `currentAbortController` — lets us cancel in-flight fetches when user navigates away
- `capturedHeaders` — auth headers captured from native XHR requests

## localStorage Keys

- `bc_club_order` — JSON array of club UUIDs in user's preferred display order *(synced to Worker KV)*
- `bc_time_range` — `{ startMinutes, endMinutes }` — time range filter state *(synced to Worker KV)*
- `bc_indoor_only` — boolean — indoor courts filter state *(synced to Worker KV)*
- `bc_view_mode` — `'by-club'` | `'by-time'` — availability panel layout mode *(synced to Worker KV)*
- `bc_booking_view` — `'hour-view'` | `'court-view'` — which booking calendar tab to auto-select on load; defaults to `'hour-view'` when absent *(synced to Worker KV)*
- `bc_debug_enabled` — `'1'` | `'0'` — debug mode enabled state
- `bc_debug_entries` — JSON array of debug log entries for copy/download support workflows
- `bc_possible_players` — player list cached from the `possiblePlayers` API, populated by XHR interception during normal booking flows and used by the partner picker for locked slots
- `bc_player_photos` — photo map `{ memberId: { photoId, state } }`, always merged (never replaced) on update to preserve richer XHR-intercepted data over sparser on-demand fetch results
- `bc_notification_email` — user's email address cached from `profile/api/1.0/profile`, embedded in booking records for Worker email notifications
- `bc_self_profile` — `{ firstName, lastName }` of the logged-in user, cached from `connect20auth` or `profile/api/1.0/profile`; used to show the logged-in user as a pre-selected non-interactive card at the top of the partner picker

Note: scheduled booking records are stored in Cloudflare Worker KV (`scheduled_bookings` key), not in localStorage. The extension maintains a local `cachedBookings` array populated by `GET /bookings` from the Worker. The seven synced preferences (`bc_club_order`, `bc_view_mode`, `bc_indoor_only`, `bc_time_range`, `bc_players`, `bc_duration`, `bc_booking_view`) are also mirrored to Worker KV under `prefs:{email}` via `getPreferenceSyncService()`, which pulls on page load (server wins) and pushes on change with an 800 ms debounce.

## Cloudflare Worker (`cloudflare-worker/`)

Server-side component that executes scheduled bookings without requiring the browser tab to stay open.

- **Worker URL**: `https://bayclubconnect-bookings.mark-rubin.workers.dev`
- **Secrets** (set via `wrangler secret put`): `WORKER_SECRET`, `RESEND_API_KEY`
- **KV namespace**: `BC_BOOKINGS` (id `299d14645bed49458addc9751cc6c241`); keys: `refresh_token:{email}` (per user), `scheduled_bookings`, `last_token_refresh`, `prefs:{email}` (per user)
- **D1 database**: `bayclubconnect-history` (id `e1f2166f-1c61-47f4-8675-bfa4a003d29a`); bound as `DB`; table `booking_history` — permanent record of every completed, failed, or cancelled booking. Rows written via `appendToHistory()` after every cron outcome and every cancel/dismiss. Uses `INSERT OR IGNORE` to prevent duplicates.
- **Cron**: every minute — finds `status === 'pending'` bookings whose `fireAtMs` has passed, marks `firing`, calls Bay Club two-step booking API, saves result, sends email
- **Auth**: Bay Club refresh token stored in KV per-user under `refresh_token:{notificationEmail}`; rotated immediately after every use (single-use tokens). `client_id=connect20`, `client_secret=connectSecret` for both password and refresh grants. Per-user storage prevents multiple extension users from overwriting each other's tokens.
- **Email**: Resend API, sender `notifications@bayclubhelper.app`. `RESEND_API_KEY` secret. Primary recipient is `notificationEmail` in the booking record (fetched from `profile/api/1.0/profile` at scheduling time). Additional recipients are `partnerEmails` — a list of partner email addresses captured from the player cache at scheduling time. Partner emails are deduped against the scheduler's address. Partner subjects reference the scheduler's name (`booking.userName`) or fall back to their email or a generic phrase.
- **CORS**: allows `https://bayclubconnect.com` for `GET, POST, PUT, DELETE, OPTIONS`.
- **HTTP endpoints**:
  - `GET /status` — public health check (aggregate only); includes full `scheduledBookings` only when secret-authenticated
  - `GET /bookings` — list all bookings (secret required)
  - `POST /bookings` — add a booking (secret required)
  - `DELETE /bookings/{id}` — remove a booking (secret required)
  - `PUT /token` — store a fresh refresh token in KV under `refresh_token:{userId}` (secret required); called automatically by the extension on page load
  - `GET /prefs` — get synced preferences for a user (secret + `X-User-Id` header required); called by `getPreferenceSyncService()` on page load
  - `PUT /prefs` — save synced preferences for a user (secret required); body `{ userId, prefs }`; called with 800 ms debounce after any preference change
  - `GET /history` — last 100 rows from D1 `booking_history` as JSON (secret required; header or `?secret=`)
  - `GET /dashboard` — self-refreshing HTML monitoring page with active bookings + history (secret required; header or `?secret=`)
  - `GET /allowed` — checks whether `X-User-Id` email is on the allow-list (secret required); returns `{ allowed: true|false }`; absent/empty/malformed list returns `allowed: true` (fail open). Email comparison is case-insensitive on both ends.
- **Allow-list**: `allowed_users` KV key holds a JSON array of lowercase email strings. Absent or empty = everyone allowed. Update via `npx wrangler kv key put --namespace-id 299d14645bed49458addc9751cc6c241 --remote "allowed_users" '["email@example.com"]'`.
- **Token bootstrap**: if a user's KV token is ever lost, reload bayclubconnect.com — `syncRefreshTokenFromAppStorage()` pushes it automatically. For manual recovery: `wrangler kv key put --namespace-id 299d14645bed49458addc9751cc6c241 "refresh_token:email@example.com" "<token>" --remote`.
- **Deploy**: `cd cloudflare-worker && wrangler deploy`

## Files

- `loading_script.user.js` — Tampermonkey userscript, wrapped in an IIFE. No build step, no dependencies.
- `cloudflare-worker/worker.js` — Cloudflare Worker source.
- `cloudflare-worker/wrangler.toml` — Worker configuration (KV binding, D1 binding, cron schedule).
- `cloudflare-worker/CLOUDFLARE.md` — Detailed setup, architecture, and dev workflow notes for the Worker, written for someone new to Cloudflare.
- `canary-tests/canary.spec.js` — Playwright end-to-end canary suite (57 tests) run against the live site.
- `canary-tests/playwright.config.js` — Playwright configuration (single Chromium worker, auth state, timeouts).
- `canary-tests/global-setup.js` — Logs in with BC_EMAIL/BC_PASSWORD from `.env` and saves auth state before the suite runs.

## External Assumptions And Contracts

These are the main Bay Club behaviors and DOM patterns the helper depends on. When something breaks after a Bay Club change, this list is a good first place to check.

- **Availability API endpoint and shape**:
  - The native Hour View uses `https://connect-api.bayclubs.io/court-booking/api/1.0/availability?...`.
  - The JSON response has a `clubsAvailabilities` array; the first element is the home club whose availability the native Hour View is rendering.
  - Each entry contains `courts` and `availableTimeSlots` collections shaped as of March 2026.
- **Booking API endpoint**:
  - The native booking flow posts to a URL whose path ends with `courtbookings`.
  - The helper rewrites only these POSTs, based on `pendingSlotBooking` and the last availability params.
- **Native Hour View slot DOM**:
  - Hour View renders native slots as `app-court-time-slot-item div.time-slot`.
  - The helper clicks one of these slots on selection so Angular’s booking state machine advances correctly.
  - If these elements disappear or are renamed, the helper’s injected UI should fall back to the native Hour View via the on-error banner.
- **Booking-flow URLs and shell**:
  - The court booking flow currently uses URLs containing `create-booking`.
  - The shared booking shell (including `app-page-title` and Hour View controls) continues to exist even if Bay Club tweaks intermediate steps.
- **Bookings pages for calendar export and scheduled bookings**:
  - The bookings list is at `/bookings`. Individual upcoming events are `app-racquet-sports-booking-calendar-event` inside `app-paged-list`. Note: `app-calendar-events-list` does **not** exist in the live DOM (as of March 2026).
  - Cancelled bookings live inside `app-calendar-cancelled-by-me-list`, which is inside `app-calendar`.
  - `app-calendar` and `app-paged-list` have **different parent `DIV`s** — do not assume a shared ancestor when finding insertion points.
  - Booking detail pages live at `/racquet-sports/booking/:id` and expose a header container matching `.image-background .px-4.pb-4`.
  - The “Reservation made by” row matches `.row.mt-2.size-14` with text containing “reservation made by”.
- **Date and time text formats on bookings screens**:
  - Day labels are one of:
    - `Today` / `Tomorrow`.
    - Month–day strings like `Feb 27`.
    - A browser-parsable date string handled by `new Date(...)`.
  - Time ranges are formatted as `H:MM - H:MM AM/PM` (for example: `7:00 - 8:30 PM`) when start and end are in the same period, or as `H:MM AM - H:MM PM` when the slot crosses noon (for example: `11:30 AM - 1:00 PM`).
  - When these assumptions fail, the helper logs `bookings-parse-day-label-failed` or `bookings-parse-time-range-failed` in debug mode to make format changes easier to diagnose.

## Linting

ESLint with flat config (`eslint.config.mjs`). Intentionally unused args, vars, and caught errors can be prefixed with `_` and are ignored by lint. When you lint, check for function calls that don't agree with the arity of the functions being called.

## Userscript Tests

The userscript has a Vitest suite (`loading_script.test.mjs`) covering pure utility functions that have historically had bugs. Run it after any change to `loading_script.user.js`:

```bash
npm run test:script
```

Functions covered: `pacificSlotTimeMs`, `timePartsTo24Hour`, `inferStartHour24`, `parseTimeRange`, `normalizeWhitespace`, `buildGoogleCalendarUrl`, `buildIcsContent`, `getIcsDownloadFileName`, `formatCountdown`, and their helpers. The script is loaded under jsdom via a `module.exports` escape hatch at the end of the IIFE (`_bcTestExports` accumulator). External fetch calls are stubbed in `vitest.setup.mjs`.

## Worker Tests

The Cloudflare Worker has a Vitest suite. Run it after any change to `cloudflare-worker/worker.js` and before running `wrangler deploy`:

```bash
cd cloudflare-worker && npm test
```

Tests cover all HTTP endpoints, pure helper functions, and the cron tick logic (KV and D1 are in-memory mocks; external fetch calls are stubbed). See `cloudflare-worker/CLOUDFLARE.md` → Testing for details.

## Canary Tests

Playwright end-to-end tests that run against the live bayclubconnect.com site with the userscript injected. They serve as both a regression guard for our own code and a canary for Bay Club DOM/API changes. Requires `.env` with `BC_EMAIL` and `BC_PASSWORD` (copied from `canary-tests/.env.example`).

```bash
cd canary-tests && npm test                   # headless (CI mode)
cd canary-tests && npm test -- --headed       # watch the browser run
cd canary-tests && npm test -- --ui           # Playwright interactive UI (time-travel debugger)
cd canary-tests && npm test -- --debug        # step through with Playwright Inspector
```

The suite covers: Open-Meteo weather API shape, Bay Club availability API contract, booking POST URL, native booking DOM selectors, `/bookings` page DOM, our injected availability UI, by-club/by-time toggle, indoor-only toggle, time range slider, weather emoji ticks on the slider, club preference ordering widget, grouped time slot expansion, duration/player preference auto-select, edge/gated court indicators, locked slot → partner picker flow, booking flow cleanup, dashboard carousel DOM structure (`app-dashboard-events` / `app-dashboard-favorites` separation), and court view DOM structure (COURT VIEW button, `app-booking-calendar`, injected container, club selector).

**Key calibration notes**:
- Club sections are identified by `data-club-id` UUID attributes, not by text — the API `shortName` for some clubs may differ from our display label.
- Locked-slot tests reset `bc_time_range` and `bc_indoor_only` in localStorage before clicking a slot, then bounce the date selection to force a re-render, because the Worker preference sync may have restored narrow filter values on page load.
- The `app-calendar-cancelled-by-me-list` test skips gracefully when the user has no cancelled bookings (the element is conditionally rendered by Angular).
- `test.setTimeout(120_000)` must be called at the top of `beforeAll` for the locked-slot describe block — `test.describe.configure({ timeout })` does not extend `beforeAll` hook timeouts in Playwright 1.58.

## Running All Tests

```bash
npm test                             # runs test:script then test:worker (unit + worker)
cd canary-tests && npm test          # end-to-end canary suite (requires live credentials)
```
