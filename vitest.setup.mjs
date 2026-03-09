// Stub fetch globally before the userscript IIFE runs, so the startup calls to
// getScheduledBookingService().initializeOnPageLoad() and
// getPreferenceSyncService().initializeOnPageLoad() don't make real network requests.
globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve([]),
    text: () => Promise.resolve(''),
});

// Stub Notification API, which jsdom does not provide.
globalThis.Notification = { requestPermission: () => Promise.resolve('default'), permission: 'default' };

// Provide a minimal localStorage stub so the script's getLocalStorageService()
// does not emit console noise about getItem not being a function.  jsdom may
// provide window.localStorage but sometimes without a working getItem when no
// origin URL is configured for the test environment.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.getItem !== 'function') {
    const _store = new Map();
    globalThis.localStorage = {
        getItem: key => _store.get(key) ?? null,
        setItem: (key, val) => _store.set(key, String(val)),
        removeItem: key => _store.delete(key),
        clear: () => _store.clear(),
    };
}
