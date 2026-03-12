#!/usr/bin/env node
// smoke-court-view.js
//
// Standalone Playwright smoke script that:
//   1. Loads the booking flow with the userscript injected.
//   2. Navigates to the COURT VIEW tab.
//   3. Waits up to 20 seconds for the injected container to appear.
//   4. Collects all unhandled JS errors (pageerror) during that time.
//   5. Exits 0 if no errors were captured, 1 otherwise.
//
// Only "pageerror" events (uncaught JavaScript exceptions) are counted as
// failures.  Network/CORS/401 console.error noise from third-party resources
// (GTM, analytics, etc.) is intentionally ignored.
//
// Run from the repo root:
//   node canary-tests/smoke-court-view.js
//
// Requires canary-tests/auth-state.json (produced by global-setup.js).

'use strict';

const { chromium } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

// Load BC_EMAIL / BC_PASSWORD from canary-tests/.env so global-setup has credentials.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CANARY_DIR  = __dirname;
const SCRIPT_PATH = path.join(CANARY_DIR, '..', 'loading_script.user.js');
const AUTH_PATH   = path.join(CANARY_DIR, 'auth-state.json');
const BASE_URL    = 'https://bayclubconnect.com';

const COURT_VIEW_WAIT_MS = 20_000;
const SETTLE_MS          = 5_000;

function pacificDateString(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}
function tomorrowPacific() {
    return pacificDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

(async () => {
    const errors = [];

    // Re-run login so the access token is always fresh.  global-setup.js writes
    // a new auth-state.json; if BC_EMAIL/BC_PASSWORD are absent it writes an
    // empty file and we exit immediately.
    console.log('[smoke] Refreshing auth state via global-setup…');
    const globalSetup = require('./global-setup');
    await globalSetup();

    const authState = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (!authState.cookies || authState.cookies.length === 0) {
        console.error('[smoke] No auth state — set BC_EMAIL and BC_PASSWORD in canary-tests/.env');
        process.exit(1);
    }

    const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        storageState: AUTH_PATH,
        baseURL: BASE_URL,
        // Match the device preset used by playwright.config.js so the app renders
        // the same layout the canary tests depend on.
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

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

    const page = await context.newPage();

    // Only track real unhandled JS exceptions — not network/CORS noise.
    page.on('pageerror', err => {
        const msg = `[pageerror] ${err.message}`;
        errors.push(msg);
        console.error(msg);
    });

    // Log console errors to stdout for visibility but do not count them as failures
    // unless they look like actual thrown errors (Error: prefix or TypeError/ReferenceError).
    page.on('console', msg => {
        if (msg.type() === 'error') {
            const text = msg.text();
            console.log(`[console.error] ${text}`);
        }
    });

    try {
        console.log('[smoke] Navigating to home…');
        await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
        console.log('[smoke] Landed at:', page.url());
        console.log('[smoke] Title:', await page.title());

        const bookingTile = page.locator('div.tile').filter({ hasText: /Court Booking/i }).first();
        await bookingTile.waitFor({ timeout: 30_000 });
        await bookingTile.click();
        await page.locator('app-page-title').waitFor({ timeout: 15_000 });

        console.log('[smoke] Selecting date and advancing to Step 2…');
        const dateInput = page.locator('input[type="date"], input[formcontrolname="date"]').first();
        if (await dateInput.isVisible().catch(() => false)) {
            await dateInput.fill(tomorrowPacific());
        }

        const nextButton = page.locator('button.btn-light-blue', { hasText: /next/i }).first();
        await nextButton.waitFor({ state: 'visible', timeout: 15_000 });
        await nextButton.click();

        // Wait for the userscript to auto-select HOUR VIEW and inject the availability UI.
        // The script stamps data-bc-auto-selected on the HOUR VIEW button once it fires;
        // waiting for .all-clubs-availability confirms the full hour view render cycle
        // completed, which also means auth headers and lastFetchState.params are captured.
        console.log('[smoke] Waiting for Hour View to stabilize…');
        await page.locator('[data-bc-auto-selected]').waitFor({ state: 'attached', timeout: 20_000 });
        await page.locator('.all-clubs-availability').first().waitFor({ timeout: 20_000 });

        console.log('[smoke] Clicking COURT VIEW…');
        const courtViewBtn = page.locator('app-time-slot-view-type-select .btn', { hasText: /court view/i }).first();
        await courtViewBtn.waitFor({ state: 'attached', timeout: 10_000 });
        // The button may be visually hidden by the toggle component; use evaluate to fire
        // a direct DOM click bypassing Playwright's actionability checks entirely.
        await courtViewBtn.evaluate(el => el.click());

        console.log('[smoke] Waiting for injected court view container…');
        try {
            await page.locator('[data-bc-court-view]').waitFor({ timeout: COURT_VIEW_WAIT_MS });
            console.log('[smoke] Court view container found.');
        } catch (_e) {
            const msg = '[smoke] Timed out waiting for [data-bc-court-view] — container never appeared.';
            errors.push(msg);
            console.error(msg);
        }

        console.log(`[smoke] Settling for ${SETTLE_MS / 1000}s…`);
        await page.waitForTimeout(SETTLE_MS);

    } catch (err) {
        const msg = `[smoke] Navigation error: ${err.message}`;
        errors.push(msg);
        console.error(msg);
    } finally {
        await browser.close();
    }

    if (errors.length === 0) {
        console.log('[smoke] ✓ No JS errors detected.');
        process.exit(0);
    } else {
        console.error(`\n[smoke] ✗ ${errors.length} error(s):`);
        errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
        process.exit(1);
    }
})();
