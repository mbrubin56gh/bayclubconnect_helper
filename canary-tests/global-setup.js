// Runs once before the Playwright test suite starts.  Logs in with the
// credentials from .env and saves the resulting browser storage state so
// every test can skip the login flow.
//
// If BC_EMAIL or BC_PASSWORD are absent (e.g. in a CI environment that has
// not been configured), an empty auth state is written and all tests that
// need authentication will skip themselves gracefully.

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const AUTH_STATE_PATH = path.join(__dirname, 'auth-state.json');
const LOGIN_URL = 'https://bayclubconnect.com/account/login/connect';
// The booking flow URL is at a path containing 'create-booking'.  Navigate
// to the home page first — the app will redirect to the flow from there —
// or update this constant if Bay Club changes their routing.
const POST_LOGIN_WAIT_FOR = url => !url.href.includes('/account/login');

module.exports = async function globalSetup() {
    const email    = process.env.BC_EMAIL;
    const password = process.env.BC_PASSWORD;

    if (!email || !password) {
        console.warn(
            '\n[canary] BC_EMAIL / BC_PASSWORD not set in .env — writing empty auth state.' +
            '\n         Tests that require authentication will skip.\n'
        );
        fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
        return;
    }

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

        // Fill login form.  Selectors are based on the live HTML as of May 2025.
        // ADJUST: if Bay Club changes their login form, update these selectors.
        await page.locator('input#username').fill(email);
        await page.locator('input#password').fill(password);
        await page.locator('button.btn-light-blue').filter({ hasText: /log in/i }).click();

        // Wait until the URL is no longer on the login page.
        await page.waitForURL(POST_LOGIN_WAIT_FOR, { timeout: 15_000 });

        // Allow Angular to settle before snapshotting cookies and localStorage.
        await page.waitForLoadState('networkidle');

        await context.storageState({ path: AUTH_STATE_PATH });
        console.log('[canary] Login succeeded — auth state saved.');
    } catch (err) {
        // Write empty state so tests can skip rather than crash.
        fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
        console.error('[canary] Login failed:', err.message);
    } finally {
        await browser.close();
    }
};
