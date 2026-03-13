// Standalone Playwright script that captures screenshots of the Bay Club
// Connect Helper UI for use in README.md.  Not a test file — run directly
// with: node take-screenshots.js
//
// Requires auth-state.json (created by global-setup.js) or .env with
// BC_EMAIL and BC_PASSWORD so this script can create it on the fly.

const { chromium } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

// Load .env from the canary-tests directory so BC_EMAIL / BC_PASSWORD are
// available when auth-state.json is absent.
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_e) {
    // dotenv is optional — if absent, we rely on auth-state.json existing.
}

const AUTH_STATE_PATH    = path.join(__dirname, 'auth-state.json');
const SCREENSHOTS_DIR    = path.join(__dirname, '..', 'screenshots');
const SCRIPT_PATH        = path.join(__dirname, '..', 'loading_script.user.js');
const LOGIN_URL          = 'https://bayclubconnect.com/account/login/connect';
const VIEWPORT           = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Ensures the screenshots output directory exists.
function ensureScreenshotsDir() {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        console.log('[screenshots] Created directory:', SCREENSHOTS_DIR);
    }
}

// Logs a warning and continues when a screenshot target cannot be reached.
function warnSkip(name, reason) {
    console.warn('[screenshots] SKIP', name, '—', reason);
}

// Runs the login flow and writes auth-state.json.  Called only when the
// file is absent or empty.
async function runLogin(browser) {
    const email    = process.env.BC_EMAIL;
    const password = process.env.BC_PASSWORD;

    if (!email || !password) {
        throw new Error(
            'auth-state.json is absent and BC_EMAIL / BC_PASSWORD are not set in .env. ' +
            'Run "node global-setup.js" first or set credentials in .env.'
        );
    }

    console.log('[screenshots] auth-state.json absent — running login flow...');
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page    = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.locator('input#username').fill(email);
    await page.locator('input#password').fill(password);
    await page.locator('button.btn-light-blue').filter({ hasText: /log in/i }).click();
    await page.waitForURL(url => !url.href.includes('/account/login'), { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
    console.log('[screenshots] Login succeeded — auth state saved.');
}

// Creates a browser context with the userscript injected via addInitScript,
// mirroring the pattern used in canary.spec.js so the helper behaves exactly
// as it would under Tampermonkey.
async function createContextWithScript(browser, preferHourView) {
    const context = await browser.newContext({
        storageState: AUTH_STATE_PATH,
        viewport: VIEWPORT,
    });

    // Clear saved preferences so stale filter values do not hide content in
    // the screenshots.  When preferHourView is true, also clear bc_booking_view
    // so the script defaults to Hour View rather than Court View.
    const prefsToClear = [
        'bc_indoor_only', 'bc_view_mode', 'bc_club_order',
        'bc_time_range', 'bc_players', 'bc_duration',
    ];
    if (preferHourView) {
        prefsToClear.push('bc_booking_view');
    }

    await context.addInitScript(`
        (function() {
            var PREF_KEYS = ${JSON.stringify(prefsToClear)};
            PREF_KEYS.forEach(function(k) { try { localStorage.removeItem(k); } catch(_e) {} });
        })();
    `);

    const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Wrap the userscript in a DOMContentLoaded guard so it fires after the DOM
    // is ready, matching Tampermonkey's @run-at document-body behaviour.
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

    context.on('page', page => {
        page.on('pageerror', err => {
            // Suppress the benign cross-origin localStorage error that fires
            // on Angular's embedded iframes — it does not affect functionality.
            if (!err.message.includes('localStorage')) {
                console.error('[pageerror]', err.message);
            }
        });
    });

    return context;
}

// Navigates from the home page through the booking wizard to the booking step,
// waits for either Hour View (.all-clubs-availability) or Court View
// (app-booking-calendar) injected UI to appear, and returns which view loaded.
async function navigateToBookingStep(page) {
    await page.goto('https://bayclubconnect.com/', { waitUntil: 'domcontentloaded' });

    const bookingTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
    await bookingTile.waitFor({ timeout: 15_000 });
    await bookingTile.click();

    await page.locator('app-page-title').waitFor({ timeout: 15_000 });
    // Give the userscript a moment to auto-select duration/players before
    // clicking NEXT so the button is enabled.
    await page.waitForTimeout(2000);

    const nextButton = page.locator('button.btn-light-blue', { hasText: /next/i }).first();
    await nextButton.waitFor({ state: 'visible', timeout: 15_000 });
    await nextButton.click();

    // The booking step shows either Hour View or Court View depending on the
    // bc_booking_view preference.  Wait for whichever arrives first.
    await Promise.race([
        page.locator('.all-clubs-availability').first().waitFor({ timeout: 45_000 }),
        page.locator('app-booking-calendar').first().waitFor({ timeout: 45_000 }),
    ]);
}

// ---------------------------------------------------------------------------
// Screenshot capture functions
// ---------------------------------------------------------------------------

// Captures the Hour View showing all four clubs' availability.
async function captureHourView(browser) {
    const NAME = 'hour-view-multi-club.png';
    console.log('[screenshots] Capturing', NAME, '...');
    // Use a fresh context so that Worker preference sync (which overrides our
    // cleared bc_booking_view) cannot fight us.  We explicitly click HOUR VIEW
    // after landing on the booking step regardless of what preference was loaded.
    const context = await createContextWithScript(browser, true);
    const page = await context.newPage();
    try {
        await navigateToBookingStep(page);

        // Explicitly click HOUR VIEW so we are not dependent on the preference
        // that the Worker may have synced back.  The view-type selector renders
        // multiple instances (desktop + mobile), and the first DOM match may be
        // hidden.  Use page.evaluate to find and click the first visible one.
        const clickedHourView = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('app-time-slot-view-type-select .btn'));
            const visible = btns.filter(b => b.textContent.trim() === 'HOUR VIEW' && b.getBoundingClientRect().width > 0);
            if (visible.length > 0) { visible[0].click(); return true; }
            return false;
        });
        if (!clickedHourView) {
            warnSkip(NAME, 'Could not find a visible HOUR VIEW button to click.');
            return;
        }

        // Wait for our injected availability UI to appear and for at least one
        // slot card to render so the screenshot is not empty.
        await page.locator('.all-clubs-availability').first().waitFor({ timeout: 35_000 });
        await page.locator('.bc-court-option').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});

        // Let the slot cards fully render before snapping.
        await page.waitForTimeout(2000);

        // Scroll the page so the first club section and its slots are centred
        // in the viewport rather than the header controls.
        await page.evaluate(() => {
            const firstClubSection = document.querySelector('.all-clubs-availability [data-club-id]');
            if (firstClubSection) {
                firstClubSection.scrollIntoView({ block: 'start' });
                window.scrollBy(0, -60);
            }
        });
        await page.waitForTimeout(500);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, NAME),
            fullPage: false,
        });
        console.log('[screenshots] Saved', NAME);
    } catch (err) {
        warnSkip(NAME, err.message);
    } finally {
        await page.close();
        await context.close();
    }
}

// Captures the Court View with the multi-club column grid.
async function captureCourtView(browser) {
    const NAME = 'court-view.png';
    console.log('[screenshots] Capturing', NAME, '...');
    const context = await createContextWithScript(browser, false);
    const page = await context.newPage();
    try {
        await navigateToBookingStep(page);

        // If we landed on Hour View, click COURT VIEW to switch.  The
        // view-type selector renders multiple instances; use evaluate to find
        // and click the first visible COURT VIEW button.
        const hvContent = await page.locator('.all-clubs-availability').first().isVisible().catch(() => false);
        if (hvContent) {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('app-time-slot-view-type-select .btn'));
                const visible = btns.filter(b => b.textContent.trim() === 'COURT VIEW' && b.getBoundingClientRect().width > 0);
                if (visible.length > 0) { visible[0].click(); }
            });
            await page.locator('app-booking-calendar').first().waitFor({ timeout: 20_000 });
        }

        await page.waitForTimeout(2000);

        // Scroll to the top of the calendar grid so the club nav strip and
        // first columns are all visible in the 1280x800 viewport.
        await page.evaluate(() => {
            const cal = document.querySelector('app-booking-calendar');
            if (cal) cal.scrollIntoView({ block: 'start' });
        });
        await page.waitForTimeout(300);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, NAME),
            fullPage: false,
        });
        console.log('[screenshots] Saved', NAME);
    } catch (err) {
        warnSkip(NAME, err.message);
    } finally {
        await page.close();
        await context.close();
    }
}

// Captures the inline partner picker by clicking a locked (future) slot.
async function capturePartnerPicker(browser) {
    const NAME = 'partner-picker.png';
    console.log('[screenshots] Capturing', NAME, '...');
    // Use Hour View for locked slot access.
    const context = await createContextWithScript(browser, true);
    const page = await context.newPage();
    try {
        await navigateToBookingStep(page);

        // Ensure we are on Hour View.
        const allClubsVisible = await page.locator('.all-clubs-availability').first().isVisible().catch(() => false);
        if (!allClubsVisible) {
            // Try clicking HOUR VIEW if Court View is shown instead.
            const clickedHv = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('app-time-slot-view-type-select .btn'));
                const visible = btns.filter(b => b.textContent.trim() === 'HOUR VIEW' && b.getBoundingClientRect().width > 0);
                if (visible.length > 0) { visible[0].click(); return true; }
                return false;
            });
            if (!clickedHv) {
                warnSkip(NAME, 'Could not navigate to Hour View for locked slot capture.');
                return;
            }
            await page.locator('.all-clubs-availability').first().waitFor({ timeout: 30_000 });
        }

        // Navigate to a date beyond the 3-day booking window by clicking the
        // last date cell in the gallery strip.
        const lastDateCell = page.locator(
            'gallery-item.g-active-item .col.clickable.slider-item'
        ).last();
        const cellVisible = await lastDateCell.isVisible().catch(() => false);
        if (!cellVisible) {
            warnSkip(NAME, 'Date gallery strip not found — cannot navigate to locked date.');
            return;
        }
        await lastDateCell.click();

        // Wait for slot cards to re-render for the new date.
        await page.locator('.all-clubs-availability .bc-court-option')
            .first().waitFor({ state: 'attached', timeout: 30_000 });

        // Click the first locked slot card.  Locked slots carry a
        // data-slot-locked attribute when they are beyond the booking window.
        const lockedSlot = page.locator('.bc-court-option[data-slot-locked]').first();
        const lockedVisible = await lockedSlot.isVisible().catch(() => false);
        if (!lockedVisible) {
            warnSkip(NAME, 'No locked slot cards (data-slot-locked) found — all slots may be within the booking window.');
            return;
        }
        await lockedSlot.click();

        // Wait for the partner picker (schedule panel) to appear.
        const picker = page.locator('[data-bc-schedule-panel]').first();
        const pickerAppeared = await picker.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
        if (!pickerAppeared) {
            warnSkip(NAME, 'Partner picker did not appear after clicking locked slot.');
            return;
        }

        await page.waitForTimeout(1000);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, NAME),
            fullPage: false,
        });
        console.log('[screenshots] Saved', NAME);
    } catch (err) {
        warnSkip(NAME, err.message);
    } finally {
        await page.close();
        await context.close();
    }
}

// Captures the /bookings page showing the pending bookings section and
// calendar export links on confirmed bookings.
async function captureBookingsPage(browser) {
    const NAME = 'bookings-page.png';
    console.log('[screenshots] Capturing', NAME, '...');
    const context = await createContextWithScript(browser, false);
    const page = await context.newPage();
    try {
        await page.goto('https://bayclubconnect.com/bookings', { waitUntil: 'domcontentloaded' });
        // Wait for Angular to render any bookings list element.
        await page.waitForSelector('app-calendar, app-paged-list, app-racquet-sports-booking-calendar-event', { timeout: 20_000 });
        await page.waitForTimeout(3000);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, NAME),
            fullPage: true,
        });
        console.log('[screenshots] Saved', NAME);
    } catch (err) {
        warnSkip(NAME, err.message);
    } finally {
        await page.close();
        await context.close();
    }
}

// Captures the dashboard showing native tiles and any pending booking cards.
async function captureDashboard(browser) {
    const NAME = 'dashboard.png';
    console.log('[screenshots] Capturing', NAME, '...');
    const context = await createContextWithScript(browser, false);
    const page = await context.newPage();
    try {
        await page.goto('https://bayclubconnect.com/home/dashboard', { waitUntil: 'domcontentloaded' });
        // Wait for the Angular home page to render something meaningful.
        await page.locator('div.tile, app-dashboard-events').first().waitFor({ timeout: 20_000 });
        await page.waitForTimeout(3000);

        await page.screenshot({
            path: path.join(SCREENSHOTS_DIR, NAME),
            fullPage: false,
        });
        console.log('[screenshots] Saved', NAME);
    } catch (err) {
        warnSkip(NAME, err.message);
    } finally {
        await page.close();
        await context.close();
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async function main() {
    ensureScreenshotsDir();

    const browser = await chromium.launch({ headless: true });

    try {
        // Ensure auth state exists, running the login flow if it does not.
        const authExists = fs.existsSync(AUTH_STATE_PATH);
        if (!authExists) {
            await runLogin(browser);
        }

        // Verify auth state is non-empty (not the empty stub written on failure).
        const authState = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
        if (!authState.cookies || authState.cookies.length === 0) {
            throw new Error(
                'auth-state.json exists but contains no cookies. ' +
                'Re-run "node global-setup.js" with valid credentials.'
            );
        }

        // Capture each screen in turn.  Failures are caught inside each
        // function and logged as warnings so the script continues.
        await captureHourView(browser);
        await captureCourtView(browser);
        await capturePartnerPicker(browser);
        await captureBookingsPage(browser);
        await captureDashboard(browser);

        console.log('[screenshots] Done. Files saved to:', SCREENSHOTS_DIR);
    } finally {
        await browser.close();
    }
})();
