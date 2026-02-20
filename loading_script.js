// ==UserScript==
// @name         Bay Club Connect Multi-club Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.1
// @description  Shows pickleball court booking opportunities across multiple clubs
// @author       Mark Rubin
// @match        https://bayclubconnect.com/*
// @icon         https://github.com/mbrubin56gh/bayclubconnect_helper/blob/d4f3023bb29f8db0fc4799894a084bb01c81d49e/icons/pickleball_17155178.png
// @require      http://code.jquery.com/jquery-latest.js
// @grant none
// ==/UserScript==

(function () {
    'use strict';

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
        alert("racquet sports filter loaded");
    }

    onUrlChange((url) => {
        if (url.includes('/racquet-sports/create-booking/')) {
            waitForRacquetSportsFilter(() => {
                onRacquetSportsFilterNodeLoaded();
            });
        }
    });
})();