// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    globalSetup: './global-setup.js',

    use: {
        baseURL: 'https://bayclubconnect.com',
        // Saved by global-setup.js after login. All tests reuse this auth state.
        storageState: './auth-state.json',
        // Keep screenshots and traces on failure so you have evidence of what changed.
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        // Generous navigation timeout for the Angular SPA.
        navigationTimeout: 20_000,
    },

    // Run tests serially — we share a login session and don't want parallel tab noise.
    workers: 1,

    // Canary tests are not expected to be flaky. A single attempt makes failures clear.
    retries: 0,

    // Default per-test timeout. Some tests that wait for our injected UI are given
    // an explicit higher timeout via test.setTimeout().
    timeout: 30_000,

    reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    outputDir: 'test-results',
});
