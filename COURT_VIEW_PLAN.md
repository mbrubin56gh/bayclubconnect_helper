# Court View Multi-Club Feature — Plan

## Current State (stable baseline)

All four clubs' court columns render in Court View with correct availability blocks (booked vs free). Two XHR endpoints are intercepted:
- `/courtsheet/{clubId}/courts` → court column list — merged from all clubs
- `/courtsheet/{clubId}` (no `/courts`) → booking events — merged from all clubs

`getNativeCourtColumnsService` tags each `app-booking-calendar-column` with `data-bc-club-id` via a MutationObserver, but injects no UI. All columns are always visible — no filtering, no buttons, no pills.

## Blocked Problems (do not attempt again without a clear solution)

### Column hiding / filtering
Angular absolutely-positions columns (`position: absolute; left: Npx`). Any attempt to hide columns via `display:none` does not collapse their space. Detaching/reattaching Angular-managed elements triggers Angular zone.js change detection and causes infinite MutationObserver loops. **Do not attempt column-level DOM manipulation.**

### Scroll-to-club buttons + floating pills
Attempted twice. Specific failures:
- Scroll bar must be a **sibling inserted before** `app-booking-calendar`, not a child — otherwise it scrolls with the columns.
- `scrollLeft` targeting: `getComputedStyle().overflowX === 'auto/scroll'` does not reliably find the actual scroll container. The working approach is to iterate every ancestor with `scrollWidth > clientWidth + 1` and set `scrollLeft` on all of them.
- Floating pill labels must be appended to the **column parent**, which must be forced to `position: relative` if it is `static`.
- The MutationObserver must be **disconnected before** any DOM change we make inside its target subtree, then **reconnected after** — otherwise our own pill insertions retrigger `tagColumns`.
- Despite implementing all of the above correctly, scroll was still not triggering. Root cause unclear — may be that the actual scroll container is not an ancestor of `app-booking-calendar` at all, but a sibling or cousin in Angular's layout.

**Next debugging step**: On the live page in DevTools, click a column, then run:
```js
let el = document.querySelector('app-booking-calendar-column');
while (el) { console.log(el.tagName, el.className, el.scrollLeft, el.scrollWidth, el.clientWidth); el = el.parentElement; }
```
This will identify which ancestor actually has `scrollWidth > clientWidth` and whether setting `scrollLeft` on it does anything.

### Open slots not clickable (regression)
Any DOM manipulation inside the court view calendar (even adding siblings or injecting elements into column parents) may interfere with Angular's click event handlers. The exact mechanism is unknown. **Any UI injection must be tested to confirm native slots remain clickable.**

## Proposed Next Steps (in priority order)

### 1. Booking POST rewrite for non-RS clubs (highest value, no DOM risk)
When a user clicks a non-RS court slot, Angular will POST `courtbookings` with RS as the `clubId`. We must intercept this POST and replace `clubId`, `courtId`, and `timeSlotId` with the values from `pendingSlotBooking`.

- Build `courtToClubMap` and `courtNameMap` from `getMergedCourtsOrder()` at merge time.
- In the courtbookings POST interceptor, look up `pendingSlotBooking.clubId` — if it differs from the home club, rewrite the outgoing body.
- Also rewrite the `PUT courtbookings/{id}/confirm` if needed.
- This is pure XHR-layer work with no DOM manipulation — low risk.

### 2. Bottom bar club/court label update
When a non-RS slot is selected, the Angular bottom bar will show RS court name and club. Update the label to reflect the actual selected club and court.

- Tap into the existing `tryUpdateBottomBar` / `positionOverlay` flow.
- Use `CLUB_SHORT_NAMES` + `courtNameMap` from merged courts order.
- Low DOM risk — we're updating text in elements we already touch.

### 3. Club navigation UI (revisit with fresh diagnostics)
Before attempting scroll buttons or pills again, run the DevTools scroll container diagnostic above. Once the actual scroll container is known:
- Re-implement `scrollToClub` targeting that exact container.
- Validate that clicking a slot after injection still works (open DevTools, click a colored slot, confirm booking flow advances).
- Keep pill labels minimal — maybe just colored left-border on the column header text, not absolutely-positioned overlays, to avoid the `position: relative` parent manipulation entirely.

### 4. Courtview-specific time range filter
A simpler alternative to column hiding: a time-of-day range filter that hides time **rows** rather than court columns. Angular renders time rows as elements we do not need to manage — hiding them by attribute-based CSS should be safe.

### 5. Indoor/outdoor indicator per column
Once court metadata is available at render time, inject a small 🏠/☀️ indicator into each column header.

### 6. Scheduled bookings in court view
Locked slots (beyond 3-day window) in court view should open the partner picker and follow the same `getScheduledBookingService().scheduleBooking()` path as Hour View. The `pendingSlotBooking` + `courtToClubMap` must be set correctly before the picker opens.
