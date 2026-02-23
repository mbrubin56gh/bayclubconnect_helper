# Bay Club Connect Pickleball Court Reservation Helper

## What This Is

A Tampermonkey userscript (`loading_script.user.js`) that improves the court booking experience on bayclubconnect.com. The app natively only shows availability for a single "home" club, but Bay Club members can book at any club. This script fetches availability across all four Bay Area clubs in parallel and displays them in a unified UI.

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

### Angular State Machine Hack
The app is Angular-based. We can't easily drive its state machine directly, so when a user selects one of our injected slots, we secretly click a native Angular time slot to advance Angular's state. We then intercept the outgoing booking request and replace it with our own. This means the native club must have at least one available slot on the selected date — if not, we show a warning.

### DOM Injection
We hide (not remove) native content and inject our own `<div class="all-clubs-availability">` into two containers Angular uses for desktop (`.item-tile`) and mobile (`.d-md-none.px-3`). We re-inject whenever the MutationObserver detects container changes (e.g. date change).

### Navigation Cleanup
We patch `history.pushState` and `history.replaceState` (and listen to `popstate`) to detect navigation away from the booking flow and clean up injected content. We also have an setInterval timer to look for URL changes. This is set up fresh each time we render, and tears itself down after firing once.

## UI Features

- **Multi-club availability**: All four clubs shown grouped by Morning / Afternoon / Evening
- **Grouped time slots**: Multiple courts at the same time shown as a single expandable card; single-court slots are directly selectable
- **Edge court indicators**: ★ marks courts on the edges of the court area (less ball spillage)
- **Club preference ordering**: Drag-and-drop widget on the duration selector page, persisted to localStorage
- **Time range filter**: Dual-handle slider to filter slots by time of day, persisted to localStorage
- **Indoor courts toggle**: Hides outdoor-only clubs; persisted to localStorage
- **Weather hint**: Shows rain probability from Open-Meteo API next to the indoor toggle when rain > 20%
- **Hour View auto-select**: Automatically clicks "HOUR VIEW" button on first render (marked with `data-bc-auto-selected` to avoid re-firing)

## Code Conventions

- **Prefer `data-*` attributes over structural CSS selectors** for targeting injected elements
- **Encode state in the DOM where possible** rather than global variables (e.g. `data-bc-auto-selected`, `data-selected`, `data-bc-intercepted`)
- **Avoid timers and pollers** — use event-driven approaches (MutationObserver, patched history methods, DOM events)
- **Minimize global state** — use closures (IIFEs) to scope implementation details (e.g. `lastBookingRequestId` is scoped inside the `send` IIFE)
- **CSS for visual state** — selection appearance is driven by `[data-selected]` CSS rules, not inline style mutations
- **No external dependencies** — single self-contained userscript file

## Global State (intentional)

- `lastFetchState` — `{ transformed, params }` — the last fetched and transformed availability data plus request params
- `pendingSlotBooking` — `{ clubId, courtId, date, fromMinutes, toMinutes }` — set when user selects a slot, consumed by the XHR interceptor
- `currentAbortController` — lets us cancel in-flight fetches when user navigates away
- `capturedHeaders` — auth headers captured from native XHR requests
- `weather` — `{ cache, promise }` — rain prediction data from Open-Meteo

## localStorage Keys

- `bc_club_order` — JSON array of club UUIDs in user's preferred display order
- `bc_time_range` — `{ startMinutes, endMinutes }` — time range filter state
- `bc_indoor_only` — boolean — indoor courts filter state

## File

Single file: `loading_script.user.js`. The whole script is wrapped in an IIFE for scope isolation. No build step, no dependencies.

## Linting

ESLint with flat config (`eslint.config.mjs`). Parameters intentionally unused (e.g. in XHR overrides) are prefixed with `_` and ignored via `argsIgnorePattern: '^_'`. When you lint, check for function calls that don't agree with the arity of the functions being called.
