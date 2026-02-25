# Bay Club Connect Pickleball Court Reservation Helper

## What This Is

A Tampermonkey userscript (`loading_script.user.js`) that improves the court booking experience on bayclubconnect.com. The app natively only shows availability for a single "home" club, but Bay Club members can book at any club. This script fetches availability across all four Bay Area clubs in parallel and displays them in a unified UI.

## Working style

This is a JavaScript project. Use JavaScript for all new files and modifications unless otherwise specified.

Write comments as complete sentences that end in punctuation. Avoid abbreviations when reasonable so comments are easy to scan later.

Prefer closures and other encapsulation techniques over free-floating global variables, and keep mutable state in the narrowest possible scope.

After completing a set of changes, offer to commit and push with a descriptive commit message summarizing what changed.

When resuming work from a previous session, start by reading recent git log and checking git status to understand current state.

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
The app is Angular-based. We can't easily drive its state machine directly, so when a user selects one of our injected slots, we secretly click a native Angular time slot to advance Angular's state. We then intercept the outgoing booking request and replace it with our own. This means the native club must have at least one available slot on the selected date — if not, we show a warning.

### DOM Injection
We hide (not remove) native content and inject our own `<div class="all-clubs-availability">` into two containers Angular uses for desktop (`.item-tile`) and mobile (`.d-md-none.px-3`). We re-inject whenever the MutationObserver detects container changes (e.g. date change).

To reduce churn from Angular mutation bursts, booking-flow DOM reconciliation is batched through `requestAnimationFrame`, so repeated mutation callbacks collapse into one reconcile pass per frame.

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
- **Edge court indicators**: ★ marks courts on the edges of the court area (less ball spillage)
- **Club preference ordering**: Drag-and-drop widget on the duration selector page, persisted to localStorage
  Drag lifecycle wiring for this widget is encapsulated in `createClubOrderWidgetController()`, keeping transient drag state private.
- **Time range filter**: Dual-handle slider to filter slots by time of day, persisted to localStorage
  Slider drag lifecycle and transient drag state are encapsulated in `createTimeRangeSliderController()`.
- **Indoor courts toggle**: Hides outdoor-only clubs; persisted to localStorage
- **Hourly weather**: Fetches hourly forecast from Open-Meteo API; shows the relevant emoji below each hour label on the time range slider; rain emojis are accompanied by a centred rain-probability percentage
  Weather data and cache are encapsulated in an in-file `createWeatherService()` closure with a narrow API (`whenReady`, `emojiForHour`, `rainPctForHour`).
- **Hour View auto-select**: Automatically clicks "HOUR VIEW" button on first render (marked with `data-bc-auto-selected` to avoid re-firing)
- **By-club / By-time toggle**: Two-button toggle switches between grouping slots by club (default) or by time slot; persisted to localStorage
- **Duration and player preference auto-select**: Native selection controls are re-applied from localStorage through a dedicated `createPreferenceAutoSelectService()` closure so temporary fallback-suppression state stays internal.

## Code Conventions

- **Prefer `data-*` attributes over structural CSS selectors** for targeting injected elements
- **Encode state in the DOM where possible** rather than global variables (e.g. `data-bc-auto-selected`, `data-selected`, `data-bc-intercepted`)
- **Prefer event-driven detection first, then add polling only as a reliability backstop** — this SPA sometimes does not emit dependable history signals, so scoped pollers are acceptable when lifecycle-managed
- **Minimize global state** — use closures (IIFEs) to scope implementation details (e.g. `lastBookingRequestId` is scoped inside the `send` IIFE)
  For example, drag-and-drop item reordering state is scoped inside `createClubOrderWidgetController()` rather than script scope.
  Time-range slider drag state is similarly scoped inside `createTimeRangeSliderController()`.
- **CSS for visual state** — selection appearance is driven by `[data-selected]` CSS rules, not inline style mutations
- **No external dependencies** — single self-contained userscript file
- **Prefer explicit enum-like values over nullable/optional parameters for behavioral variation** — when a parameter controls which behavior a function performs, always pass an explicit string constant (e.g. `LABEL_MODE_TIME`, `LABEL_MODE_CLUB`) rather than a nullable or omitted argument (e.g. `labelOverride = null`). Nullable optionals hide intent at call sites and are easy to accidentally omit. Explicit constants make every call self-documenting.
- **Define enum values as SCREAMING_SNAKE_CASE constants** — string literals used as enum-like values should be named constants (e.g. `const VIEW_MODE_BY_TIME = 'by-time'`), not bare string literals scattered across the codebase. This ensures typos are caught by linting and refactoring is safe.
- **Decompose multi-step functions into named helpers** — rather than using inline comments like `// Step 1: ...`, extract each step into a function whose name describes *what* it does (e.g. `filterSlotsByTimeRange`, `collapseEmptyTimeGroups`). The sequence of calls in the top-level function then reads as self-documenting prose without needing comments.

## Global State (intentional)

Most mutable booking/network state is encapsulated in a singleton in-file service (`getBookingStateService()`), rather than free-floating script-level variables.
Duration/player preference auto-selection also uses an in-file closure service (`createPreferenceAutoSelectService()`) so transient selection-suppression state is not exposed at script scope.

- `lastFetchState` — `{ transformed, params, failedClubIds }` — the last fetched and transformed availability data plus request params and per-club failure markers
- `pendingSlotBooking` — `{ clubId, courtId, date, fromMinutes, toMinutes }` — set when user selects a slot, consumed by the XHR interceptor
- `currentAbortController` — lets us cancel in-flight fetches when user navigates away
- `capturedHeaders` — auth headers captured from native XHR requests

## localStorage Keys

- `bc_club_order` — JSON array of club UUIDs in user's preferred display order
- `bc_time_range` — `{ startMinutes, endMinutes }` — time range filter state
- `bc_indoor_only` — boolean — indoor courts filter state
- `bc_view_mode` — `'by-club'` | `'by-time'` — availability panel layout mode

## File

Single file: `loading_script.user.js`. The whole script is wrapped in an IIFE for scope isolation. No build step, no dependencies.

## Linting

ESLint with flat config (`eslint.config.mjs`). Intentionally unused args, vars, and caught errors can be prefixed with `_` and are ignored by lint. When you lint, check for function calls that don't agree with the arity of the functions being called.
