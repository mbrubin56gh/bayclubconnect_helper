// ==UserScript==
// @name         Bay Club Connect Multi-club Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.1
// @description  Shows pickleball court booking opportunities across multiple clubs
// @author       Mark Rubin
// @match        https://bayclubconnect.com/*
// @run-at       document-start
// @icon         https://github.com/mbrubin56gh/bayclubconnect_helper/blob/d4f3023bb29f8db0fc4799894a084bb01c81d49e/icons/pickleball_17155178.png
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let capturedHeaders = {};
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name === 'Authorization' || name === 'X-SessionId') {
            capturedHeaders[name] = value;
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url; // stash the url for use in send
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (this._url && this._url.includes('court-booking/api/1.0/availability')) {
            alert("original call detected");
            const parsedUrl = new URL(this._url);
            const date = parsedUrl.searchParams.get('date');
            const categoryCode = parsedUrl.searchParams.get('categoryCode');
            const categoryOptionsId = parsedUrl.searchParams.get('categoryOptionsId');
            const timeSlotId = parsedUrl.searchParams.get('timeSlotId');

            fetchAllClubs(date, timeSlotId);
        }
        return originalXhrSend.apply(this, arguments);
    };
    // const originalFetch = window.fetch;
    // window.fetch = function (url, options = {}) {
    //     alert(url);
    //     if (url.includes('availability')) {
    //         alert("original call detected")
    //         // Capture headers as before
    //         const h = options.headers || {};
    //         if (h['Authorization']) capturedHeaders['Authorization'] = h['Authorization'];
    //         if (h['X-SessionId']) capturedHeaders['X-SessionId'] = h['X-SessionId'];

    //         // Parse the URL to extract the params the page is using
    //         const parsedUrl = new URL(url);
    //         const date = parsedUrl.searchParams.get('date');
    //         const categoryCode = parsedUrl.searchParams.get('categoryCode');
    //         const categoryOptionsId = parsedUrl.searchParams.get('categoryOptionsId');
    //         const timeSlotId = parsedUrl.searchParams.get('timeSlotId');

    //         // Fire your multi-club batch
    //         fetchAllClubs({ date, categoryCode, categoryOptionsId, timeSlotId, headers: h });

    //         // Still let the original request proceed so the page works normally
    //         return originalFetch.apply(this, arguments);
    //     }

    //     return originalFetch.apply(this, arguments);
    // };

    function onUrlChange(callback) {
        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);

        history.pushState = function (...args) {
            originalPushState(...args);
            callback(location.href);
        };
        history.replaceState = function (...args) {
            originalReplaceState(...args);
            callback(location.href);
        };

        window.addEventListener('popstate', () => callback(location.href));
    }

    function waitForRacquetSportsFilter(callback) {
        const observer = new MutationObserver(() => {
            const el = document.querySelector('app-racquet-sports-filter');
            if (el) {
                observer.disconnect();
                callback();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function onRacquetSportsFilterNodeLoaded() {
        // alert("racquet sports filter loaded");
    }

    function fetchAllClubs(selectedDate, timeSlotId) {
        const clubs = [
            '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63', // Broadway
            '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18', // Redwood Shores
            'ce7e7607-09e6-4d16-8197-1fffb70db776', // South San Francisco
            '3bc78448-ec6b-49e1-a2ae-64abd68e646b'  // Santa Clara
        ];

        (async () => {
            const results = await Promise.all(clubs.map(clubId =>
                fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${selectedDate}&categoryCode=pickleball&categoryOptionsId=182a18e2-fd11-4868-a6be-36d96f7f2645&timeSlotId=${timeSlotId}}`, {
                    headers: {
                        'Authorization': capturedHeaders['Authorization'],
                        'X-SessionId': capturedHeaders['X-SessionId'],
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    }
                }).then(r => r.json())
            ));
            alert("RESULTS: " + results);
        })();
    }

    onUrlChange((url) => {
        if (url.includes('/racquet-sports/create-booking/')) {
            waitForRacquetSportsFilter(() => {
                onRacquetSportsFilterNodeLoaded();
            });
        }
    });
})();