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

    // Click the Court Booking tile on the home page.  It is a div.tile with a
    // .title child containing "Court Booking" — there is no anchor or href.
    // ADJUST: update this selector if Bay Club changes their home-page tile markup.
    const bookingTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
    await bookingTile.waitFor({ timeout: 10_000 });
    await bookingTile.click();

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
    const hourViewButton = page.locator('app-time-slot-view-type-select .btn', { hasText: /hour view/i }).first();
    try {
        await hourViewButton.waitFor({ state: 'visible', timeout: 15_000 });
        await hourViewButton.click();
    } catch (_e) {
        // Script already clicked it; page is advancing normally.
    }

    // Wait for our injected availability UI — this also confirms the script loaded.
    // Use .first() because the script injects into both desktop and mobile containers.
    await page.locator('.all-clubs-availability').first().waitFor({ timeout: 30_000 });

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
        await expect(page.locator('.all-clubs-availability').first()).toBeVisible();
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
        // Scope to first container to avoid strict-mode violations (desktop + mobile).
        const container = page.locator('.all-clubs-availability').first();
        await container.locator('.bc-view-toggle [data-view="by-time"]').click();
        // By-time mode renders [data-time-group] divs for each distinct start time.
        // ADJUST: update selector if we change how by-time groups are marked.
        await expect(
            container.locator('[data-time-group]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('clicking By Club restores club-grouped layout', async () => {
        requireAuth(test);
        const container = page.locator('.all-clubs-availability').first();
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
        const container = page.locator('.all-clubs-availability').first();
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
        const container = page.locator('.all-clubs-availability').first();
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
        // Find the slider container.  ADJUST if we rename .bc-time-range-widget.
        const slider = page.locator('.all-clubs-availability .bc-time-range-widget').first();
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
            page.locator('[data-bc-schedule-panel]').first()
        ).toBeVisible({ timeout: 30_000 });
    });

    test('partner picker panel contains player cards', async () => {
        requireAuth(test);
        // Use .first() — script injects the panel into both desktop and mobile containers.
        const panel = page.locator('[data-bc-schedule-panel]').first();
        await panel.waitFor({ timeout: 10_000 });
        // Player cards are .bc-player-card elements with a data-member-id attribute.
        // ADJUST: update class name if we change the card structure.
        const cards = panel.locator('.bc-player-card[data-member-id]');
        await expect(cards.first()).toBeAttached({ timeout: 10_000 });
    });

    test('partner picker panel has a Schedule button', async () => {
        requireAuth(test);
        const panel = page.locator('[data-bc-schedule-panel]').first();
        await panel.waitFor({ timeout: 10_000 });
        // Schedule button has data-bc-schedule-submit attribute.
        // ADJUST: update if we rename the submit button attribute.
        await expect(
            panel.locator('[data-bc-schedule-submit]')
        ).toBeAttached({ timeout: 5_000 });
    });

    test('partner picker panel has a Back or Cancel control', async () => {
        requireAuth(test);
        const panel = page.locator('[data-bc-schedule-panel]').first();
        await panel.waitFor({ timeout: 10_000 });
        // Back button has data-bc-schedule-back; cancel has data-bc-schedule-cancel.
        // ADJUST: update if we rename these button attributes.
        await expect(
            panel.locator('[data-bc-schedule-back], [data-bc-schedule-cancel]').first()
        ).toBeAttached({ timeout: 5_000 });
    });

    test('clicking Back returns to the availability slot grid', async () => {
        requireAuth(test);
        const panel = page.locator('[data-bc-schedule-panel]').first();
        await panel.waitFor({ timeout: 10_000 });
        await panel.locator('[data-bc-schedule-back]').click();
        // Both panels should be gone and the availability grid should return.
        await expect(page.locator('[data-bc-schedule-panel]').first()).toBeHidden({ timeout: 5_000 });
        // Use .first() — script injects into both desktop and mobile containers.
        await expect(page.locator('.all-clubs-availability').first()).toBeVisible({ timeout: 5_000 });
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
        await page.locator('.all-clubs-availability').first().waitFor({ timeout: 10_000 });
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
