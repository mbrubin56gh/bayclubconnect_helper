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
            const parsedUrl = new URL(this._url);
            const date = parsedUrl.searchParams.get('date');
            const categoryCode = parsedUrl.searchParams.get('categoryCode');
            const categoryOptionsId = parsedUrl.searchParams.get('categoryOptionsId');
            const timeSlotId = parsedUrl.searchParams.get('timeSlotId');

            fetchAllClubs(date, timeSlotId);
        }
        return originalXhrSend.apply(this, arguments);
    };

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
    function minutesToHumanTime(minutes) {
        const totalHours = Math.floor(minutes / 60);
        const ampm = totalHours < 12 ? 'am' : 'pm';
        let h = totalHours % 12;
        if (h === 0) h = 12;
        const m = minutes % 60;
        const timeStr = m === 0 ? `${h}:00` : `${h}:${String(m).padStart(2, '0')}`;
        return `${timeStr} ${ampm}`;
    }
    
    function transformAvailability(results) {
        const timeOfDays = ['Morning', 'Afternoon', 'Evening'];
        const output = { Morning: [], Afternoon: [], Evening: [] };

        for (const result of results) {
            for (const clubAvail of result.clubsAvailabilities) {
                const { club, courts, availableTimeSlots } = clubAvail;

                // Build a lookup from courtId -> court info
                const courtById = {};
                for (const court of courts) {
                    courtById[court.courtId] = court;
                }

                for (const tod of timeOfDays) {
                    const slots = availableTimeSlots
                        .filter(slot => slot.timeOfDay === tod)
                        .sort((a, b) => a.fromInMinutes - b.fromInMinutes)
                        .map(slot => {
                            const court = courtById[slot.courtId] || {};
                            return {
                                fromInMinutes: slot.fromInMinutes,
                                toInMinutes: slot.toInMinutes,
                                fromHumanTime: minutesToHumanTime(slot.fromInMinutes),
                                toHumanTime: minutesToHumanTime(slot.toInMinutes),
                                courtId: slot.courtId,
                                courtName: court.courtName || null,
                                courtShortName: court.courtShortName || null,
                            };
                        });

                    if (slots.length > 0) {
                        output[tod].push({
                            clubId: club.id,
                            shortName: club.shortName,
                            code: club.code,
                            availabilities: slots,
                        });
                    }
                }
            }
        }

        return output;
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
                fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${selectedDate}&categoryCode=pickleball&categoryOptionsId=182a18e2-fd11-4868-a6be-36d96f7f2645&timeSlotId=${timeSlotId}`, {
                    headers: {
                        'Authorization': capturedHeaders['Authorization'],
                        'X-SessionId': capturedHeaders['X-SessionId'],
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    }
                }).then(r => r.json())
            ));
            const transformed = transformAvailability(results);
            console.log(JSON.stringify(transformed, null, 2));
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