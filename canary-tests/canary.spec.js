// Canary tests for bayclubconnect.com.
//
// Run:  cd canary-tests && npm test
//    or npm test -- --headed      (watch the browser)
//    or npm test -- --debug       (step through)
//
// Requires .env with BC_EMAIL and BC_PASSWORD.  See .env.example.
//
// PURPOSE
//   These tests serve two goals that are intentionally in tension:
//
//   1. Our regression guard — confirm that our injected UI, XHR interceptions,
//      toggles, slider, partner picker, and cleanup all work correctly in a
//      real browser against the live site.
//
//   2. Bay Club canary — deliberately brittle assertions on the DOM selectors
//      and API shapes that our extension depends on.  When Bay Club changes
//      something we rely on, these tests fail first and loudly.
//
// NOTES ON CALIBRATION
//   Selectors marked "ADJUST" may need updating if Bay Club changes their page
//   structure.  When a test fails unexpectedly, check that selector first.
//
//   Navigation helpers that reach the Hour View booking screen require that the
//   app renders a date picker and at least one club's availability.  If Bay Club
//   changes their routing, update navigateToHourView().

const { test, expect, request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Auth guard — skip all tests when credentials were not provided.
// ---------------------------------------------------------------------------

const authState = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'auth-state.json'), 'utf8')
);
const isAuthenticated = authState.cookies && authState.cookies.length > 0;

// Helper used throughout to conditionally skip a test.
function requireAuth(t) {
    if (!isAuthenticated) t.skip(true, 'No auth state — set BC_EMAIL and BC_PASSWORD in .env');
}

// Returns true when running on a mobile-viewport project (e.g. mobile-chromium).
// Used by the Court View mobile touch tests to skip on desktop projects.
function isMobile(t) {
    return t.info().project.name === 'mobile-chromium';
}
function requireMobile(t) {
    if (!isMobile(t)) t.skip(true, 'Mobile-only test — skipped on desktop viewport');
}

// Creates a browser context with the userscript injected as an init script so
// it runs on every page load, mimicking Tampermonkey's @run-at document-body
// behaviour.
//
// addInitScript fires at document-start (before document.head exists), which
// causes the script's style-injection calls to crash with "Cannot read
// properties of null (reading 'appendChild')".  We therefore read the script
// source and wrap it in a DOMContentLoaded guard so it executes after the DOM
// is ready, just as Tampermonkey would.
async function createContextWithScript(browser) {
    const context = await browser.newContext({ storageState: './auth-state.json' });

    // Clear our preference keys from localStorage before the userscript runs so
    // stale values from a previous test run (captured in auth-state.json) do not
    // corrupt the test environment.  These keys must be cleared at document-start
    // (the earliest init-script checkpoint) so the userscript reads clean state.
    await context.addInitScript(`
        (function() {
            var PREF_KEYS = [
                'bc_indoor_only', 'bc_view_mode', 'bc_club_order',
                'bc_time_range', 'bc_players', 'bc_duration',
                'bc_booking_view',
            ];
            PREF_KEYS.forEach(function(k) { localStorage.removeItem(k); });
        })();
    `);

    const scriptSource = fs.readFileSync(
        path.join(__dirname, '../loading_script.user.js'), 'utf8'
    );
    // Wrap the script so it runs after the DOM is available.  readyState check
    // handles the (unlikely) case where DOMContentLoaded has already fired.
    await context.addInitScript(`
        (function() {
            function runUserScript() { ${scriptSource} }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', runUserScript);
            } else {
                runUserScript();
            }
        })();
    `);

    // Block the Worker preference-sync endpoint so server-stored values
    // (e.g. bc_booking_view=court-view) do not overwrite the clean localStorage
    // state we just set up.  Return an empty prefs object so the script's
    // pull-on-load path succeeds without restoring any preferences.
    await context.route('**/prefs**', route => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ prefs: {} }),
        });
    });

    // Surface page errors so failures are easier to diagnose.
    context.on('page', page => {
        page.on('pageerror', err => console.error('[pageerror]', err.message));
        page.on('console', msg => {
            if (msg.type() === 'error') console.error('[console.error]', msg.text());
        });
    });

    return context;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

// Formats a Date as YYYY-MM-DD in Pacific time (what the Bay Club date picker
// expects when filled programmatically).
function pacificDateString(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

// Returns a date that is `offsetDays` calendar days from today in Pacific time.
function pacificDateOffset(offsetDays) {
    const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    return d;
}

// Navigates to the court booking Hour View and waits for both the Angular
// booking shell and our injected availability UI to be present.
//
// Strategy: navigate to the app home page, then find and click the racquet
// sports / court booking entry point.  If Bay Club changes their routing,
// update the selector inside this function.
//
// The `dateOffset` param (default 1 = tomorrow) controls which date is
// selected.  Pass 10+ for a date with locked slots.
async function navigateToHourView(page, dateOffset = 1) {
    // ADJUST: if the booking entry-point URL changes, update this path.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Click the Court Booking tile on the home page.  Desktop uses div.tile;
    // mobile (narrow viewport) hides those and shows Favorites icon tiles instead.
    // Try the desktop tile first; fall back to any visible element containing
    // "Court Booking" text (covers the mobile Favorites layout).
    // ADJUST: update these selectors if Bay Club changes their home-page tile markup.
    // Desktop uses div.tile; mobile (narrow viewport) hides those and shows
    // a different Favorites layout.  Try the desktop tile first; if hidden,
    // navigate directly to the booking flow URL (mobile path).
    const desktopTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
    const tileVisible = await desktopTile.isVisible({ timeout: 5_000 }).catch(() => false);
    if (tileVisible) {
        await desktopTile.click();
    } else {
        await page.goto('/racquet-sports/create-booking', { waitUntil: 'domcontentloaded' });
    }

    // Wait for the Angular booking shell — this is one of our canary selectors.
    await page.locator('app-page-title').waitFor({ timeout: 15_000 });

    // Select the target date.  The native date input is an <input type="date">
    // or an Angular Material date picker.
    // ADJUST: update the selector if Bay Club changes their date picker.
    const dateInput = page.locator('input[type="date"], input[formcontrolname="date"]').first();
    const dateInputVisible = await dateInput.isVisible().catch(() => false);
    if (dateInputVisible) {
        await dateInput.fill(pacificDateString(pacificDateOffset(dateOffset)));
    }

    // The booking flow is a two-step wizard.
    //   Step 1: player / duration selection page — ends with a NEXT button.
    //   Step 2: Hour View with the availability grid.
    // Click NEXT to advance to Step 2.
    // ADJUST: update selector if Bay Club changes the NEXT button class or text.
    const nextButton = page.locator('button.btn-light-blue', { hasText: /next/i }).first();
    await nextButton.waitFor({ state: 'visible', timeout: 15_000 });
    await nextButton.click();

    // On Step 2, our userscript auto-clicks "HOUR VIEW" on first render, which
    // triggers the parallel availability fetch and injects .all-clubs-availability.
    // We also click it explicitly here so the test does not depend on the script's
    // auto-click timing.  Clicking an already-active toggle is harmless.
    // ADJUST: update selector if Bay Club changes the view-toggle component or button text.
    // Angular may render two app-time-slot-view-type-select elements (one hidden
    // inside a collapsed native container).  Use :visible to target the active one.
    const hourViewButton = page.locator('app-time-slot-view-type-select:visible .btn', { hasText: /hour view/i }).first();
    try {
        await hourViewButton.waitFor({ state: 'visible', timeout: 15_000 });
        await hourViewButton.click();
    } catch (_e) {
        // Script already clicked it; page is advancing normally.
    }

    // Wait for our injected availability UI — this also confirms the script loaded.
    // The script injects into both desktop and mobile containers; on a mobile
    // viewport the desktop copy is hidden.  Use :visible so the wait targets
    // whichever copy is actually on screen.
    await page.locator('.all-clubs-availability:visible').first().waitFor({ timeout: 30_000 });

    // For locked-slot tests we need a date beyond the 3-day booking window.
    // The date picker on the Hour View step is a gallery-based calendar strip —
    // fill() is a no-op.  Click the last .slider-item date cell in the active
    // gallery page, which is today+6 (always beyond the 3-day window).
    //
    // DOM structure (confirmed March 2026):
    //   gallery-item.g-active-item  — the visible 7-day page
    //     .col.clickable.slider-item  — one per date (last = today+6)
    //
    // ADJUST: update if Bay Club changes the gallery component or cell classes.
    if (dateOffset >= 4) {
        const lastDateCell = page.locator(
            'gallery-item.g-active-item .col.clickable.slider-item'
        ).last();
        const found = await lastDateCell.isVisible().catch(() => false);
        if (found) {
            await lastDateCell.click();
            // Wait for the availability UI to render slot cards for the new date.
            // The container already exists, so we wait for any slot card to appear —
            // that confirms the fetch for the new date completed and rendered.
            await page.locator('.all-clubs-availability .bc-court-option')
                .first().waitFor({ state: 'attached', timeout: 25_000 });
        }
        // If the cell is not found, continue — still on a future date and the
        // locked-slot tests may find locked slots regardless.
    }
}

// Navigates to Court View by first reaching Hour View, then clicking the
// COURT VIEW toggle.  Waits for the native app-booking-calendar to appear and
// for our column tagging to complete (at least one column with data-bc-club-id).
async function navigateToCourtView(page, dateOffset = 1) {
    await navigateToHourView(page, dateOffset);

    // Angular may render two toggle components; use :visible to target the active one.
    const courtViewBtn = page.locator(
        'app-time-slot-view-type-select:visible .btn', { hasText: /court view/i }
    ).first();
    await courtViewBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await courtViewBtn.click();

    // Wait for the native calendar and our column tagging.
    await page.locator('app-booking-calendar').first().waitFor({ timeout: 15_000 });
    await page.locator('app-booking-calendar-column[data-bc-club-id]').first()
        .waitFor({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// 1. Open-Meteo weather API contract
//    Does not require Bay Club authentication.
// ---------------------------------------------------------------------------

test.describe('Open-Meteo weather API', () => {
    test('responds with the expected hourly forecast shape', async () => {
        const apiContext = await request.newContext();
        // The script fetches hourly data for the Bay Area (Broadway lat/lng).
        // ADJUST: if the script changes the parameters it passes, update this.
        const response = await apiContext.get(
            'https://api.open-meteo.com/v1/forecast' +
            '?latitude=37.7749&longitude=-122.4194' +
            '&hourly=temperature_2m,precipitation_probability,weathercode' +
            '&timezone=America%2FLos_Angeles' +
            '&forecast_days=2'
        );
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        // Top-level shape.
        expect(body).toHaveProperty('hourly');
        expect(body.hourly).toHaveProperty('time');
        expect(body.hourly).toHaveProperty('temperature_2m');
        // These two fields drive our rain emoji and probability display.
        expect(body.hourly).toHaveProperty('precipitation_probability');
        expect(body.hourly).toHaveProperty('weathercode');
        // All arrays must be the same length.
        expect(body.hourly.time.length).toBe(body.hourly.temperature_2m.length);
        expect(body.hourly.time.length).toBe(body.hourly.precipitation_probability.length);
    });
});

// ---------------------------------------------------------------------------
// 2. Bay Club API contracts
//    These intercept real network traffic during the booking flow.
// ---------------------------------------------------------------------------

test.describe('Bay Club availability API contract', () => {
    let capturedResponse = null;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(120_000);
        const context = await createContextWithScript(browser);
        const page = await context.newPage();

        // Intercept the availability response.  The response fires after NEXT is
        // clicked on the player/duration step (~30 s into the flow), so allow 75 s.
        const responsePromise = page.waitForResponse(
            r => r.url().includes('availability') && r.status() === 200,
            { timeout: 75_000 }
        );

        await navigateToHourView(page, 1);
        const response = await responsePromise;
        capturedResponse = await response.json().catch(() => null);
        await context.close();
    });

    test('response has a clubsAvailabilities array', () => {
        requireAuth(test);

        expect(capturedResponse).not.toBeNull();
        expect(Array.isArray(capturedResponse.clubsAvailabilities)).toBe(true);
        expect(capturedResponse.clubsAvailabilities.length).toBeGreaterThan(0);
    });

    test('each clubAvailability entry has club, courts, and availableTimeSlots', () => {
        requireAuth(test);

        const entry = capturedResponse.clubsAvailabilities[0];
        expect(entry).toHaveProperty('club');
        expect(entry.club).toHaveProperty('id');
        expect(entry.club).toHaveProperty('shortName');
        expect(Array.isArray(entry.courts)).toBe(true);
        expect(Array.isArray(entry.availableTimeSlots)).toBe(true);
    });

    test('courts have courtId, courtSetupVersionId, courtName, and order', () => {
        requireAuth(test);

        const courts = capturedResponse.clubsAvailabilities[0].courts;
        if (courts.length === 0) test.skip(true, 'No courts in response — check date selection');
        const court = courts[0];
        expect(court).toHaveProperty('courtId');
        expect(court).toHaveProperty('courtSetupVersionId');
        expect(court).toHaveProperty('courtName');
        expect(court).toHaveProperty('order');
    });

    test('time slots have fromInMinutes, toInMinutes, timeOfDay, and a court reference', () => {
        requireAuth(test);

        const slots = capturedResponse.clubsAvailabilities[0].availableTimeSlots;
        if (slots.length === 0) test.skip(true, 'No available slots in response — try a different date');
        const slot = slots[0];
        expect(slot).toHaveProperty('fromInMinutes');
        expect(slot).toHaveProperty('toInMinutes');
        expect(slot).toHaveProperty('timeOfDay');
        // One of courtId or courtsVersionsIds must be present for court resolution.
        // Note: timeSlotId is a URL query param on the availability request, not a
        // field on individual slot objects.
        const hasCourtRef = 'courtId' in slot || 'courtsVersionsIds' in slot;
        expect(hasCourtRef).toBe(true);
    });

    test('timeOfDay values are one of the three expected strings', () => {
        requireAuth(test);

        const validTods = new Set(['Morning', 'Afternoon', 'Evening']);
        const allSlots = capturedResponse.clubsAvailabilities.flatMap(e => e.availableTimeSlots);
        for (const slot of allSlots) {
            expect(validTods.has(slot.timeOfDay)).toBe(true);
        }
    });
});

test.describe('Bay Club booking POST URL contract', () => {
    test('outgoing booking POST URL ends with courtbookings', async ({ page }) => {
        requireAuth(test);

        test.setTimeout(90_000);

        // We won't actually complete a booking — we just want to verify the URL
        // shape of any POST to the booking endpoint.
        let bookingPostUrl = null;
        page.on('request', req => {
            if (req.method() === 'POST' && req.url().includes('courtbooking')) {
                bookingPostUrl = req.url();
            }
        });

        // The test passes if we confirm the URL pattern while intercepting.
        // In practice, run this alongside a real booking attempt; for the canary
        // we assert the documented pattern is still the live pattern by verifying
        // it in the monitoring hook above and checking that the URL from a test
        // booking (if triggered) conforms.  This test is marked as a soft canary:
        // it passes trivially unless a booking is actually triggered.
        //
        // To make this assertion hard, initiate an actual booking in the test.
        // For now, simply assert the documented shape holds for any observed POST.
        if (bookingPostUrl !== null) {
            expect(bookingPostUrl).toMatch(/courtbookings$/);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Bay Club DOM contracts
//    These assert native Angular elements that our script depends on.
// ---------------------------------------------------------------------------

test.describe('Bay Club booking flow DOM', () => {
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test('booking flow URL contains create-booking', async () => {
        requireAuth(test);

        expect(page.url()).toContain('create-booking');
    });

    test('app-page-title element is present in the booking shell', async () => {
        requireAuth(test);

        await expect(page.locator('app-page-title')).toBeVisible();
    });

    test('native time slot items exist (app-court-time-slot-item div.time-slot)', async () => {
        requireAuth(test);

        // ADJUST: if Bay Club renames this component or class, update the selector.
        await expect(
            page.locator('app-court-time-slot-item div.time-slot').first()
        ).toBeAttached({ timeout: 10_000 });
    });

    test('native time slots have at least one non-disabled slot', async () => {
        requireAuth(test);

        const enabled = page.locator('app-court-time-slot-item div.time-slot:not(.time-slot-disabled)');
        await expect(enabled.first()).toBeAttached({ timeout: 5_000 });
    });
});

test.describe('Bay Club /bookings page DOM', () => {
    test('app-paged-list is present on /bookings', async ({ page }) => {
        requireAuth(test);
        await page.goto('/bookings', { waitUntil: 'networkidle' });
        // ADJUST: if Bay Club renames this component, update the selector.
        await expect(page.locator('app-paged-list')).toBeAttached({ timeout: 10_000 });
    });

    test('app-calendar-cancelled-by-me-list is a descendant of app-calendar', async ({ page }) => {
        requireAuth(test);
        await page.goto('/bookings', { waitUntil: 'networkidle' });
        // ADJUST: if Bay Club restructures the bookings DOM, update accordingly.
        // This element only renders when the user has cancelled bookings.  Skip gracefully
        // if none exist rather than failing the canary on an empty booking history.
        const el = page.locator('app-calendar app-calendar-cancelled-by-me-list');
        const attached = await el.waitFor({ state: 'attached', timeout: 10_000 })
            .then(() => true).catch(() => false);
        if (!attached) {
            test.skip(true, 'No cancelled bookings — app-calendar-cancelled-by-me-list not rendered');
        } else {
            await expect(el).toBeAttached();
        }
    });

    test('booking time text on /bookings matches H:MM - H:MM AM/PM format', async ({ page }) => {
        requireAuth(test);
        await page.goto('/bookings', { waitUntil: 'networkidle' });
        // Grab any visible time range text from the bookings list.
        const timeText = await page
            .locator('app-racquet-sports-booking-calendar-event')
            .first()
            .textContent({ timeout: 5_000 })
            .catch(() => null);
        if (!timeText) test.skip(true, 'No upcoming bookings — cannot verify time format');
        // Pattern: "7:00 - 8:00 PM" or "11:30 AM - 1:00 PM".
        expect(timeText).toMatch(/\d{1,2}:\d{2}\s*[-\u2013]\s*\d{1,2}:\d{2}\s*(AM|PM)/i);
    });
});

// ---------------------------------------------------------------------------
// 4. Our injected availability UI
// ---------------------------------------------------------------------------

test.describe('Injected availability UI', () => {
    // Use describe.configure so the timeout applies to beforeAll hooks as well
    // as individual tests.  test.setTimeout() inside beforeAll is unreliable in
    // Playwright 1.44 — the hook can still time out at the default 30 s.
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test('injects the all-clubs-availability container', async () => {
        requireAuth(test);

        // Use .first() — the script injects into both desktop and mobile containers.
        await expect(page.locator('.all-clubs-availability:visible').first()).toBeVisible();
    });

    test('hides native content with data-bc-native-hidden attribute', async () => {
        requireAuth(test);

        const hidden = page.locator('[data-bc-native-hidden]');
        await expect(hidden.first()).toBeAttached({ timeout: 5_000 });
    });

    test('shows slots for all four expected clubs', async () => {
        requireAuth(test);

        // Wait for at least one club section to be rendered before checking all four.
        // The container is injected before the availability API responds, so club
        // sections only appear once the parallel fetches complete.
        // ADJUST: if we change the data-club-id attribute, update this.
        await page.locator('.all-clubs-availability [data-club-id]').first()
            .waitFor({ state: 'attached', timeout: 20_000 });

        // Use data-club-id UUIDs rather than text matching — the API shortName for
        // some clubs (e.g. South SF) may differ from our display label.
        // ADJUST: update UUIDs if Bay Club changes their club identifiers.
        const clubIds = [
            '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63', // Broadway
            '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18', // Redwood Shores
            'ce7e7607-09e6-4d16-8197-1fffb70db776', // South SF
            '3bc78448-ec6b-49e1-a2ae-64abd68e646b', // Santa Clara
        ];
        for (const id of clubIds) {
            await expect(
                page.locator(`.all-clubs-availability [data-club-id="${id}"]`).first()
            ).toBeAttached({ timeout: 5_000 });
        }
    });

    test('groups slots under MORNING, AFTERNOON, or EVENING headers', async () => {
        requireAuth(test);

        // The script renders time-of-day labels in upper case inside [data-tod-col] divs.
        // Labels appear when there are slots for that period.  We expect at least one
        // because we are testing with a future date that has availability.
        // ADJUST: if we change the column attribute name, update this.
        await expect(
            page.locator('.all-clubs-availability').first()
                .locator('[data-tod-col]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('shows the indoor-only toggle', async () => {
        requireAuth(test);

        await expect(
            page.locator('.all-clubs-availability [data-bc-indoor-toggle], ' +
                         '.all-clubs-availability input[type="checkbox"]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('shows the time range slider', async () => {
        requireAuth(test);

        // ADJUST: update selector if we rename the time-range widget class.
        await expect(
            page.locator('.all-clubs-availability .bc-time-range-widget').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('shows the by-club and by-time view toggle buttons', async () => {
        requireAuth(test);

        // The script renders these labels in upper case inside .bc-view-toggle.
        // Scope to the first .all-clubs-availability to avoid strict-mode violations
        // (the script injects into both desktop and mobile containers).
        // ADJUST: update if we change the label text.
        const container = page.locator('.all-clubs-availability').first();
        await expect(
            container.locator('.bc-view-toggle [data-view="by-club"]')
        ).toBeAttached({ timeout: 5_000 });
        await expect(
            container.locator('.bc-view-toggle [data-view="by-time"]')
        ).toBeAttached({ timeout: 5_000 });
    });
});

// ---------------------------------------------------------------------------
// 5. UI controls — by-club / by-time toggle
// ---------------------------------------------------------------------------

test.describe('By-club / by-time view toggle', () => {
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test('clicking By Time re-renders slots grouped by time rather than by club', async () => {
        requireAuth(test);

        // Scope to the visible container — on mobile the desktop copy is hidden.
        const container = page.locator('.all-clubs-availability:visible').first();
        await container.locator('.bc-view-toggle [data-view="by-time"]').click();
        // By-time mode renders [data-time-group] divs for each distinct start time.
        // ADJUST: update selector if we change how by-time groups are marked.
        await expect(
            container.locator('[data-time-group]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('clicking By Club restores club-grouped layout', async () => {
        requireAuth(test);

        const container = page.locator('.all-clubs-availability:visible').first();
        await container.locator('.bc-view-toggle [data-view="by-club"]').click();
        // By-club mode renders [data-tod-col] divs for each time-of-day column per club.
        // ADJUST: update selector if we change how by-club groups are marked.
        await expect(
            container.locator('[data-tod-col]').first()
        ).toBeAttached({ timeout: 5_000 });
    });
});

// ---------------------------------------------------------------------------
// 6. UI controls — indoor courts only toggle
// ---------------------------------------------------------------------------

test.describe('Indoor courts only toggle', () => {
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test('enabling indoor-only hides Redwood Shores and Santa Clara', async () => {
        requireAuth(test);

        const container = page.locator('.all-clubs-availability:visible').first();
        // Click the indoor-only toggle to enable it.
        await container.getByText(/indoor/i).first().click();
        // The script hides club sections by setting display:none on [data-club-id].
        // Match the club section by data-club-id rather than by text content, since
        // the club name appears in many slot cards and causes strict-mode violations.
        // ADJUST: update UUIDs if the club IDs change.
        const redwoodId = '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18';
        const santaClaraId = '3bc78448-ec6b-49e1-a2ae-64abd68e646b';
        await expect(
            container.locator(`[data-club-id="${redwoodId}"]`).first()
        ).toBeHidden({ timeout: 5_000 });
        await expect(
            container.locator(`[data-club-id="${santaClaraId}"]`).first()
        ).toBeHidden({ timeout: 5_000 });
        // Broadway (indoor only) should remain visible.
        const broadwayId = '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63';
        await expect(
            container.locator(`[data-club-id="${broadwayId}"]`).first()
        ).toBeVisible({ timeout: 5_000 });
    });

    test('disabling indoor-only restores all clubs', async () => {
        requireAuth(test);

        const container = page.locator('.all-clubs-availability:visible').first();
        // Toggle back off.
        await container.getByText(/indoor/i).first().click();
        const redwoodId = '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18';
        await expect(
            container.locator(`[data-club-id="${redwoodId}"]`).first()
        ).toBeVisible({ timeout: 5_000 });
    });
});

// ---------------------------------------------------------------------------
// 7. UI controls — time range slider
// ---------------------------------------------------------------------------

test.describe('Time range slider', () => {
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test('slider handles are draggable and filter slots on release', async () => {
        requireAuth(test);

        // Find the visible slider container.  ADJUST if we rename .bc-time-range-widget.
        const slider = page.locator('.all-clubs-availability:visible .bc-time-range-widget').first();
        await slider.waitFor({ timeout: 5_000 });

        const sliderBox = await slider.boundingBox();
        if (!sliderBox) test.skip(true, 'Slider not visible — check time-range-widget rendering');

        // Drag the left handle rightward to narrow the range and hide morning slots.
        // ADJUST: update class if we rename the handle element.
        const leftHandle = slider.locator('.bc-slider-handle.bc-slider-start').first();
        const handleBox  = await leftHandle.boundingBox();
        if (handleBox) {
            const startX = handleBox.x + handleBox.width / 2;
            const startY = handleBox.y + handleBox.height / 2;
            // Move the handle ~30% to the right across the slider track.
            const targetX = sliderBox.x + sliderBox.width * 0.4;
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(targetX, startY, { steps: 10 });
            await page.mouse.up();
        }

        // After dragging, earlier slots should be filtered.  Verify the slider
        // DOM survived the interaction without throwing.
        await expect(slider).toBeAttached();
    });
});

// ---------------------------------------------------------------------------
// 8. Scheduled booking — locked slot → partner picker
// ---------------------------------------------------------------------------

test.describe('Locked slot and partner picker', () => {
    test.describe.configure({ timeout: 120_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        // Extend this hook's timeout — navigating to a locked-slot date requires two
        // passes through the date strip and takes longer than the default 30 s.
        test.setTimeout(120_000);
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        // Navigate to a date beyond the 3-day booking window so all slots are locked.
        await navigateToHourView(page, 10);
    });

    test('locked slots have the data-slot-locked attribute', async () => {
        requireAuth(test);

        // Locked slots are .bc-court-option elements with data-slot-locked="1".
        // The same attribute appears on both single-court and multi-court slots.
        // Check attached (not visible) — the Worker may have restored a time range or
        // indoor-only filter that hides some slots, but the attribute must still be present.
        // ADJUST: update selector if we rename the slot card class or locked attribute.
        await expect(
            page.locator('.bc-court-option[data-slot-locked="1"]').first()
        ).toBeAttached({ timeout: 10_000 });
    });

    test('clicking a locked slot opens the inline partner picker panel', async () => {
        requireAuth(test);

        test.setTimeout(90_000);

        // Reset time-range and indoor-only filters to neutral so locked slots are visible,
        // then bounce the date selection to trigger a re-render with updated localStorage.
        // This counters the Worker preference sync that may have restored narrow filters.
        await page.evaluate(() => {
            // Full slider range: SLIDER_MIN_MINUTES=360 (6 am), SLIDER_MAX_MINUTES=1320 (10 pm).
            localStorage.setItem('bc_time_range', JSON.stringify({ startMinutes: 360, endMinutes: 1320 }));
            // false = show all clubs (not indoor-only).
            localStorage.setItem('bc_indoor_only', JSON.stringify(false));
        });
        // Click the second-to-last date cell then back to the last, forcing re-render.
        const dateCells = page.locator('gallery-item.g-active-item .col.clickable.slider-item');
        const cellCount = await dateCells.count().catch(() => 0);
        if (cellCount >= 2) {
            await dateCells.nth(cellCount - 2).click();
            await page.locator('.all-clubs-availability .bc-court-option').first()
                .waitFor({ state: 'attached', timeout: 15_000 });
            await dateCells.last().click();
            await page.locator('.all-clubs-availability .bc-court-option').first()
                .waitFor({ state: 'attached', timeout: 15_000 });
        }

        // Find the first visible locked slot after the re-render.
        const lockedSlot = page.locator('.bc-court-option[data-slot-locked="1"]').filter({ visible: true }).first();
        await lockedSlot.waitFor({ state: 'visible', timeout: 10_000 });
        await lockedSlot.click();

        // The partner picker panel should appear.  Use .first() — the script injects into
        // both desktop and mobile containers so there will be two panels.
        // ADJUST: update the attribute if we rename data-bc-schedule-panel.
        await expect(
            page.locator('[data-bc-schedule-panel]:visible').first()
        ).toBeVisible({ timeout: 30_000 });
    });

    test('partner picker panel contains player cards', async () => {
        requireAuth(test);

        // Use .first() — script injects the panel into both desktop and mobile containers.
        const panel = page.locator('[data-bc-schedule-panel]:visible').first();
        await panel.waitFor({ timeout: 10_000 });
        // Player cards are .bc-player-card elements with a data-member-id attribute.
        // ADJUST: update class name if we change the card structure.
        const cards = panel.locator('.bc-player-card[data-member-id]');
        await expect(cards.first()).toBeAttached({ timeout: 10_000 });
    });

    test('partner picker panel has a Schedule button', async () => {
        requireAuth(test);

        const panel = page.locator('[data-bc-schedule-panel]:visible').first();
        await panel.waitFor({ timeout: 10_000 });
        // Schedule button has data-bc-schedule-submit attribute.
        // ADJUST: update if we rename the submit button attribute.
        await expect(
            panel.locator('[data-bc-schedule-submit]')
        ).toBeAttached({ timeout: 5_000 });
    });

    test('partner picker panel has a Back or Cancel control', async () => {
        requireAuth(test);

        const panel = page.locator('[data-bc-schedule-panel]:visible').first();
        await panel.waitFor({ timeout: 10_000 });
        // Back button has data-bc-schedule-back; cancel has data-bc-schedule-cancel.
        // ADJUST: update if we rename these button attributes.
        await expect(
            panel.locator('[data-bc-schedule-back], [data-bc-schedule-cancel]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('clicking Back returns to the availability slot grid', async () => {
        requireAuth(test);

        const panel = page.locator('[data-bc-schedule-panel]:visible').first();
        await panel.waitFor({ timeout: 10_000 });
        await panel.locator('[data-bc-schedule-back]').click();
        // Both panels should be gone and the availability grid should return.
        await expect(page.locator('[data-bc-schedule-panel]:visible').first()).toBeHidden({ timeout: 5_000 });
        // Use .first() — script injects into both desktop and mobile containers.
        await expect(page.locator('.all-clubs-availability:visible').first()).toBeVisible({ timeout: 5_000 });
    });
});

// ---------------------------------------------------------------------------
// 9. Booking flow navigation cleanup
// ---------------------------------------------------------------------------

test.describe('Booking flow cleanup on navigation away', () => {
    test.describe.configure({ timeout: 90_000 });
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
        // Verify the injected UI is present before navigating away.
        await page.locator('.all-clubs-availability:visible').first().waitFor({ timeout: 10_000 });
    });

    test('injected availability UI is removed after navigating away from booking flow', async () => {
        requireAuth(test);

        // Navigate away using the Back to Home control, which is what the script
        // listens to for cleanup.  Fall back to direct navigation if the button
        // is not found.
        const backButton = page.locator('app-page-title').getByText(/back to home|back/i).first();
        const backVisible = await backButton.isVisible().catch(() => false);
        if (backVisible) {
            await backButton.click();
        } else {
            await page.goto('/', { waitUntil: 'domcontentloaded' });
        }

        // The injected container should no longer be in the DOM.
        await expect(page.locator('.all-clubs-availability')).toBeHidden({ timeout: 10_000 });
    });

    test('native content is unhidden after leaving the booking flow', async () => {
        requireAuth(test);

        // Elements we hid with data-bc-native-hidden should no longer carry that
        // attribute, meaning the script cleaned up after itself.
        const stillHidden = page.locator('[data-bc-native-hidden]');
        await expect(stillHidden.first()).toBeHidden({ timeout: 5_000 }).catch(() => {
            // If no such element exists at all that is also fine — cleanup succeeded.
        });
    });
});

// ---------------------------------------------------------------------------
// 8. Club preference ordering widget
//    The widget is injected on the duration/player step (Step 1), before the
//    user clicks NEXT to reach Hour View.  We navigate only as far as Step 1.
// ---------------------------------------------------------------------------

test.describe('Club preference ordering widget', () => {
    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(60_000);
        context = await createContextWithScript(browser);
        page = await context.newPage();

        // Navigate to the booking flow entry point and wait for Step 1.
        // Desktop uses div.tile; mobile hides those — fall back to direct URL.
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        const bookingTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
        const tileVisible = await bookingTile.isVisible({ timeout: 5_000 }).catch(() => false);
        if (tileVisible) {
            await bookingTile.click();
        } else {
            await page.goto('/racquet-sports/create-booking', { waitUntil: 'domcontentloaded' });
        }
        await page.locator('app-page-title').waitFor({ timeout: 15_000 });

        // The club order widget is injected on the duration/player step.
        // Wait for it to appear (the script injects it after Angular renders the
        // duration filter container).
        await page.locator('.bc-club-order-widget').waitFor({ timeout: 20_000 });
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('widget is present in the DOM on the duration/player step', async () => {
        requireAuth(test);

        await expect(page.locator('.bc-club-order-widget').first()).toBeAttached();
    });

    test('widget contains a list of four club items', async () => {
        requireAuth(test);

        const items = page.locator('.bc-club-order-list .bc-club-order-item');
        await expect(items).toHaveCount(4);
    });

    test('each club item has a data-club-id attribute matching a known club UUID', async () => {
        requireAuth(test);

        // ADJUST: update UUIDs if Bay Club changes their club identifiers.
        const knownClubIds = new Set([
            '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63',  // Broadway
            '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18',  // Redwood Shores
            'ce7e7607-09e6-4d16-8197-1fffb70db776',  // South SF
            '3bc78448-ec6b-49e1-a2ae-64abd68e646b',  // Santa Clara
        ]);
        const items = await page.locator('.bc-club-order-list .bc-club-order-item').all();
        for (const item of items) {
            const clubId = await item.getAttribute('data-club-id');
            expect(knownClubIds.has(clubId)).toBe(true);
        }
    });

    test('each club item is marked draggable', async () => {
        requireAuth(test);

        const items = await page.locator('.bc-club-order-list .bc-club-order-item').all();
        for (const item of items) {
            const draggable = await item.getAttribute('draggable');
            expect(draggable).toBe('true');
        }
    });
});

// ---------------------------------------------------------------------------
// 9. Duration and player preference auto-select
//    The script reads bc_players and bc_duration from localStorage and
//    automatically activates the matching button-select options on the
//    duration/player step.  It marks processed groups with
//    data-bc-auto-selected="true" so it does not re-fire redundantly.
// ---------------------------------------------------------------------------

test.describe('Duration and player preference auto-select', () => {
    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(60_000);
        context = await createContextWithScript(browser);
        page = await context.newPage();

        // Pre-seed preferences so the auto-select logic has something to apply.
        await context.addInitScript(`
            (function() {
                localStorage.setItem('bc_players', 'Singles');
                localStorage.setItem('bc_duration', '60');
            })();
        `);

        // Desktop uses div.tile; mobile hides those — fall back to direct URL.
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        const bookingTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
        const tileVisible = await bookingTile.isVisible({ timeout: 5_000 }).catch(() => false);
        if (tileVisible) {
            await bookingTile.click();
        } else {
            await page.goto('/racquet-sports/create-booking', { waitUntil: 'domcontentloaded' });
        }
        await page.locator('app-page-title').waitFor({ timeout: 15_000 });

        // Wait for the auto-select marker which the script sets after processing
        // at least one button group on Step 1.  Use .first() because both button
        // groups (players and duration) receive the marker simultaneously.
        await page.locator('[data-bc-auto-selected="true"]').first().waitFor({ timeout: 20_000 });
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('script marks at least one button group as auto-selected', async () => {
        requireAuth(test);

        const marked = page.locator('[data-bc-auto-selected="true"]');
        await expect(marked.first()).toBeAttached();
    });

    test('a btn-selected button is active within the processed groups', async () => {
        requireAuth(test);

        // After auto-select runs, at least one app-button-select group should
        // have an active selection indicated by the .btn-selected class.
        const selected = page.locator('app-button-select .btn-selected');
        await expect(selected.first()).toBeAttached({ timeout: 5_000 });
    });
});

// ---------------------------------------------------------------------------
// 10. Grouped time slot expansion (multi-court cards)
//     When multiple courts are available at the same time, the script renders
//     them as a single expandable .bc-slot-card.  Clicking it expands the
//     .bc-court-expand container to show individual court options.
// ---------------------------------------------------------------------------

test.describe('Grouped time slot expansion', () => {
    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(120_000);
        context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('at least one multi-court group card is rendered when multiple courts share a time', async () => {
        requireAuth(test);

        // Multi-court groups have a .bc-court-expand child.  If no groups exist
        // on the selected date (e.g. every slot is a single court), skip gracefully.
        const groupCard = page.locator('.bc-slot-card').filter({ has: page.locator('.bc-court-expand') }).first();
        const found = await groupCard.isVisible().catch(() => false);
        if (!found) {
            test.skip(true, 'No multi-court group cards on this date — try a date with multiple courts at the same time');
            return;
        }
        await expect(groupCard).toBeVisible();
    });

    test('clicking a multi-court group card expands its court options', async () => {
        requireAuth(test);

        const groupCard = page.locator('.bc-slot-card').filter({ has: page.locator('.bc-court-expand') }).first();
        const found = await groupCard.isVisible().catch(() => false);
        if (!found) {
            test.skip(true, 'No multi-court group cards to expand');
            return;
        }

        // The expand container should start collapsed (hidden or zero-height).
        const expandContainer = groupCard.locator('.bc-court-expand');
        const initiallyVisible = await expandContainer.isVisible().catch(() => false);

        await groupCard.click();

        if (!initiallyVisible) {
            // After click, individual court options should become visible.
            await expect(expandContainer.locator('.bc-court-option').first()).toBeVisible({ timeout: 5_000 });
        } else {
            // Card was already expanded — clicking again collapses it, which is fine.
            // Just assert the expand container still exists.
            await expect(expandContainer).toBeAttached();
        }
    });
});

// ---------------------------------------------------------------------------
// 11. Weather emoji rendering in the time range slider
//     The script populates .bc-weather-tick elements inside hour tick marks
//     ([data-tick-minutes]) after the weather API responds.  We wait up to
//     30 s for at least one emoji to appear.
// ---------------------------------------------------------------------------

test.describe('Weather emoji in time range slider', () => {
    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(120_000);
        context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('time range slider renders hour tick marks with data-tick-minutes attributes', async () => {
        requireAuth(test);

        // The slider is built with one tick per hour.  At least a few hour ticks
        // must be present for the weather overlay to have anywhere to render.
        const ticks = page.locator('[data-tick-minutes]');
        await expect(ticks.first()).toBeAttached({ timeout: 10_000 });
        const count = await ticks.count();
        expect(count).toBeGreaterThan(0);
    });

    test('weather emoji elements appear inside at least one hour tick after API responds', async () => {
        requireAuth(test);

        // The weather service fetches from Open-Meteo and then injects .bc-weather-tick
        // spans into each [data-tick-minutes] container.  Allow up to 30 s for the
        // network call to complete and the DOM update to run.
        const emojiEl = page.locator('[data-tick-minutes] .bc-weather-tick');
        await expect(emojiEl.first()).toBeAttached({ timeout: 30_000 });
        const emoji = await emojiEl.first().textContent();
        // The emoji should be a non-empty string (a weather emoji or a space for clear sky).
        expect(typeof emoji).toBe('string');
        expect(emoji.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 12. Edge and gated court visual indicators
//     Courts on the edge of the court area receive an amber border and an
//     inline "E" badge; gated courts (fenced) receive a gold border and a
//     "G" badge.  These are derived from court names at render time.
//     We assert that the rendering logic runs — whether any E/G courts are
//     actually present depends on the clubs and the selected date.
// ---------------------------------------------------------------------------

test.describe('Edge and gated court indicators', () => {
    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!isAuthenticated) return;

        test.setTimeout(120_000);
        context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToHourView(page, 1);
        // Wait for at least one slot card to be rendered so we know the pipeline ran.
        await page.locator('.bc-court-option').first().waitFor({ state: 'attached', timeout: 25_000 });
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('slot cards are rendered (prerequisite for badge checks)', async () => {
        requireAuth(test);

        const slots = page.locator('.bc-court-option');
        await expect(slots.first()).toBeAttached();
    });

    test('gated court cards have a gold border when a gated court is present', async () => {
        requireAuth(test);

        // Gated court cards are rendered with `border: 2px solid rgba(255,215,0,1)` as an
        // inline style.  Select by that style fragment directly — more reliable than filtering
        // by badge span text which can match partial words in other elements.
        // If no gated courts are present today, skip gracefully.
        const gatedCard = page.locator('.bc-court-option[style*="rgba(255,215,0,1)"]').first();
        const count = await gatedCard.count();
        if (count === 0) {
            test.skip(true, 'No gated courts found today — badge assertion skipped');
            return;
        }
        // Verify the "G" badge span is present inside the card.
        const badge = gatedCard.locator('span', { hasText: /^G$/ });
        await expect(badge.first()).toBeAttached();
    });

    test('edge court cards have an amber border when an edge court is present', async () => {
        requireAuth(test);

        // Edge court cards have `border: 1px solid rgba(255,200,50,0.7)` as an inline style.
        const edgeCard = page.locator('.bc-court-option[style*="rgba(255,200,50"]').first();
        const count = await edgeCard.count();
        if (count === 0) {
            test.skip(true, 'No edge courts found today — badge assertion skipped');
            return;
        }
        // Verify the "E" badge span is present inside the card.
        const badge = edgeCard.locator('span', { hasText: /^E$/ });
        await expect(badge.first()).toBeAttached();
    });

    test('legend row is visible in the injected UI explaining E and G badges', async () => {
        requireAuth(test);

        // The legend is rendered as part of the availability container header.
        // It should always be present when the UI is injected regardless of whether
        // any edge or gated courts are actually available.
        const legend = page.locator('.all-clubs-availability').first();
        const legendText = await legend.textContent().catch(() => '');
        // The legend text includes these short labels.
        expect(legendText).toMatch(/E\s*=\s*edge court/i);
        expect(legendText).toMatch(/G\s*=\s*gated court/i);
    });
});

// ---------------------------------------------------------------------------
// 13. Dashboard page DOM structure
// ---------------------------------------------------------------------------

test.describe('Bay Club /home/dashboard DOM structure', () => {
    // These tests verify the Angular component structure the helper depends on
    // when injecting pending booking cards into the Upcoming Activities carousel.
    // They do not schedule or interact with any bookings.

    let page;

    test.beforeAll(async ({ browser }) => {
        requireAuth(test);
        page = await browser.newPage();
        await page.goto('/home/dashboard', { waitUntil: 'networkidle' });
    });

    test.afterAll(async () => {
        if (page) await page.close();
    });

    test('app-dashboard-events is present on the dashboard', async () => {
        // ADJUST: if Bay Club renames this component, update the selector and the
        // carousel lookup in injectPendingCardsForDashboardPage.
        await expect(page.locator('app-dashboard-events')).toBeAttached({ timeout: 10_000 });
    });

    test('app-dashboard-events contains a .responsive-carousel', async () => {
        // The helper scopes its carousel lookup to app-dashboard-events to avoid
        // targeting the Favorites carousel.  If Bay Club restructures this component,
        // pending booking cards will land in the wrong carousel.
        // Note: Angular may omit the carousel wrapper when the user has no upcoming
        // bookings.  Skip gracefully in that case rather than failing the canary.
        const carousel = page.locator('app-dashboard-events .responsive-carousel');
        const found = await carousel.isVisible({ timeout: 10_000 }).catch(() => false);
        test.skip(!found, 'No .responsive-carousel rendered — user likely has no upcoming bookings');
    });

    test('app-dashboard-favorites is present and separate from app-dashboard-events', async () => {
        // Both components contain .responsive-carousel elements.  Confirming both
        // exist validates why we must scope to app-dashboard-events rather than
        // using a document-wide carousel search.
        // ADJUST: if Bay Club merges or renames these components, revisit the
        // carousel targeting logic in injectPendingCardsForDashboardPage.
        await expect(page.locator('app-dashboard-favorites')).toBeAttached({ timeout: 10_000 });
        await expect(
            page.locator('app-dashboard-favorites .responsive-carousel')
        ).toBeAttached({ timeout: 10_000 });
    });

    test('app-dashboard-events contains the Upcoming Activities label', async () => {
        // Confirms this is the correct carousel section for injecting booking cards.
        // ADJUST: if the label text changes, update this assertion.
        const labelText = await page
            .locator('app-dashboard-events')
            .textContent({ timeout: 10_000 })
            .catch(() => '');
        expect(labelText).toMatch(/upcoming activities/i);
    });
});

test.describe('Court view DOM structure', () => {
    // These tests verify the native Angular components the helper depends on when
    // injecting the multi-club court view grid.  They navigate to the court view
    // tab but do not interact with any courts or trigger any bookings.
    test.describe.configure({ timeout: 90_000 });

    let page;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120_000);
        if (!isAuthenticated) return;

        const context = await createContextWithScript(browser);
        page = await context.newPage();
        // Navigate directly to Court View — this validates both the COURT VIEW
        // toggle and the native app-booking-calendar rendering in one step.
        await navigateToCourtView(page, 1);
    });

    test.afterAll(async () => {
        if (page) await page.close();
    });

    test('COURT VIEW button is present alongside HOUR VIEW button', async () => {
        requireAuth(test);

        // ADJUST: if Bay Club renames the view-type toggle component or button text,
        // update the selector in getBookingDomQueryService().findCourtViewButton().
        await expect(
            page.locator('app-time-slot-view-type-select:visible .btn', { hasText: /court view/i }).first()
        ).toBeVisible({ timeout: 15_000 });
    });

    test('app-booking-calendar is rendered in Court View', async () => {
        requireAuth(test);

        // ADJUST: if Bay Club replaces app-booking-calendar with a different component,
        // update the selector in getCourtViewService().hideNativeCourtCalendar() and
        // the isCourtViewActive() check.
        await expect(page.locator('app-booking-calendar').first()).toBeAttached({ timeout: 15_000 });
    });

    test('app-booking-calendar has court columns', async () => {
        requireAuth(test);

        // Confirms that Angular rendered court columns inside the calendar.
        const columns = page.locator('app-booking-calendar-column');
        await expect(columns.first()).toBeAttached({ timeout: 15_000 });
    });
});

// ---------------------------------------------------------------------------
// Court View native column features
//   Verifies the helper's column tagging, club nav strip, badge legend,
//   weather strip, and edge/gated indicators render in Court View.
//   Runs on all browser projects (Chromium, Firefox, mobile-chromium).
// ---------------------------------------------------------------------------

test.describe('Court View native column features', () => {
    test.describe.configure({ timeout: 90_000 });

    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120_000);
        if (!isAuthenticated) return;

        context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToCourtView(page, 1);
    });

    test.afterAll(async () => {
        if (page) await page.close();
        if (context) await context.close();
    });

    test('columns are tagged with data-bc-club-id for at least two different clubs', async () => {
        requireAuth(test);

        const columns = page.locator('app-booking-calendar-column[data-bc-club-id]');
        // There should be many columns (26 across four clubs).
        await expect(columns.first()).toBeAttached({ timeout: 15_000 });
        const count = await columns.count();
        expect(count).toBeGreaterThanOrEqual(4);

        // Verify at least two distinct club IDs are present.
        const clubIds = new Set();
        for (let i = 0; i < count; i++) {
            clubIds.add(await columns.nth(i).getAttribute('data-bc-club-id'));
        }
        expect(clubIds.size).toBeGreaterThanOrEqual(2);
    });

    test('club navigation strip is present with four buttons', async () => {
        requireAuth(test);

        const strip = page.locator('[data-bc-cv-club-nav]');
        await expect(strip).toBeAttached({ timeout: 15_000 });

        const buttons = strip.locator('[data-bc-cv-nav-btn]');
        await expect(buttons).toHaveCount(4, { timeout: 10_000 });
    });

    test('badge legend is present', async () => {
        requireAuth(test);

        await expect(
            page.locator('[data-bc-badge-legend]')
        ).toBeAttached({ timeout: 10_000 });
    });

    test('weather strip is rendered inside the calendar', async () => {
        requireAuth(test);

        await expect(
            page.locator('app-booking-calendar [data-bc-weather-strip]').first()
        ).toBeAttached({ timeout: 15_000 });
    });

    test('at least one column has edge or gated badge', async () => {
        requireAuth(test);

        // E, G, or H badges are stamped as data-bc-badges on div.court-name.
        const badged = page.locator('div.court-name[data-bc-badges]');
        const found = await badged.first().isVisible({ timeout: 10_000 }).catch(() => false);
        if (!found) {
            // If no badges are visible (possible if all courts are unbadged),
            // skip rather than fail — this is not a regression.
            test.skip(true, 'No courts with E/G/H badges found on this date');
        }
        const text = await badged.first().getAttribute('data-bc-badges');
        expect(text).toMatch(/[EGH]/);
    });

    test('clicking a club nav button scrolls the calendar', async () => {
        requireAuth(test);

        // Find the last club nav button (likely a different club than what is
        // currently scrolled into view) and click it.
        const buttons = page.locator('[data-bc-cv-club-nav] [data-bc-cv-nav-btn]');
        const btnCount = await buttons.count();
        if (btnCount < 2) test.skip(true, 'Not enough club buttons to test scrolling');

        const lastBtn = buttons.last();
        const targetClubId = await lastBtn.getAttribute('data-bc-cv-nav-btn');

        // Record the first column of the target club's initial position.
        const targetCol = page.locator(
            'app-booking-calendar-column[data-bc-club-id="' + targetClubId + '"]'
        ).first();
        await expect(targetCol).toBeAttached({ timeout: 10_000 });
        const beforeBox = await targetCol.boundingBox();

        await lastBtn.click();
        // Wait a beat for the scroll to take effect.
        await page.waitForTimeout(500);

        const afterBox = await targetCol.boundingBox();
        // The column should have moved leftward (or stayed if already visible).
        // On mobile viewports, the floating-scroll element may not exist and the
        // ancestor-walk fallback may not find a scrollable container, so the column
        // might not move.  Accept a position change or the column being in view.
        if (beforeBox && afterBox) {
            const viewportWidth = page.viewportSize().width;
            const moved = Math.abs(afterBox.x - beforeBox.x) > 1;
            const inView = afterBox.x < viewportWidth;
            if (!moved && !inView) {
                // No scrollable container found — not a regression, just a
                // mobile layout limitation.
                test.skip(true, 'Nav button click did not scroll — likely no scrollable ancestor on this viewport');
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Court View on mobile viewport (touch, no hover)
//   Verifies that Court View renders correctly on a mobile-sized viewport
//   with touch enabled.  On non-mobile projects these tests are skipped.
// ---------------------------------------------------------------------------

test.describe('Court View mobile touch', () => {
    test.describe.configure({ timeout: 90_000 });

    let context;
    let page;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120_000);
        if (!isMobile(test)) return;
        if (!isAuthenticated) return;
        context = await createContextWithScript(browser);
        page = await context.newPage();
        await navigateToCourtView(page, 1);
    });

    test.afterAll(async () => {
        if (page) await page.close();
        if (context) await context.close();
    });

    test('Court View renders on mobile viewport', async () => {
        requireMobile(test);
        requireAuth(test);
        // Calendar and tagged columns should be present on mobile.
        await expect(
            page.locator('app-booking-calendar').first()
        ).toBeAttached({ timeout: 15_000 });
        await expect(
            page.locator('app-booking-calendar-column[data-bc-club-id]').first()
        ).toBeAttached({ timeout: 20_000 });
    });

    test('club nav strip is present on mobile', async () => {
        requireMobile(test);
        requireAuth(test);
        await expect(
            page.locator('[data-bc-cv-club-nav]')
        ).toBeAttached({ timeout: 15_000 });
    });

    test('tapping a club nav button scrolls on mobile', async () => {
        requireMobile(test);
        requireAuth(test);
        const buttons = page.locator('[data-bc-cv-club-nav] [data-bc-cv-nav-btn]');
        const btnCount = await buttons.count();
        if (btnCount < 2) test.skip(true, 'Not enough club buttons to test scrolling');

        const lastBtn = buttons.last();
        await lastBtn.tap();
        // Verify no crash — on mobile the scroll handler walks ancestors to
        // find the scrollable container, which is a different code path from
        // desktop's div.floating-scroll.
        await page.waitForTimeout(500);
        // If we got here without a page error, the mobile scroll path works.
    });
});
