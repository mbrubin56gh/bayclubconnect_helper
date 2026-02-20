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

    let lastFetchParams = null;
    let lastTransformed = null;

    // Update your XHR send interceptor to save params:
    XMLHttpRequest.prototype.send = function (body) {
        if (this._url && this._url.includes('court-booking/api/1.0/availability')) {
            const parsedUrl = new URL(this._url);
            lastFetchParams = {
                date: parsedUrl.searchParams.get('date'),
                categoryCode: parsedUrl.searchParams.get('categoryCode'),
                categoryOptionsId: parsedUrl.searchParams.get('categoryOptionsId'),
                timeSlotId: parsedUrl.searchParams.get('timeSlotId'),
            };
            fetchAllClubs(lastFetchParams);
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

    function renderAllClubsAvailability(transformed, anchorElement, fetchDate) {
        const timeOfDays = ['Morning', 'Afternoon', 'Evening'];

        // Figure out which clubs have a daysAheadLimit and whether this date exceeds it.
        // We pass fetchDate as a "YYYY-MM-DD" string from the intercepted URL param.
        const fetchDateObj = new Date(fetchDate + 'T00:00:00');
        const todayObj = new Date();
        todayObj.setHours(0, 0, 0, 0);
        const daysDiff = Math.round((fetchDateObj - todayObj) / (1000 * 60 * 60 * 24));

        // Build club metadata lookup including daysAheadLimit
        const allClubIds = [];
        const clubMeta = {};
        for (const tod of timeOfDays) {
            for (const club of (transformed[tod] || [])) {
                if (!clubMeta[club.clubId]) {
                    allClubIds.push(club.clubId);
                    clubMeta[club.clubId] = {
                        shortName: club.shortName,
                        code: club.code,
                        daysAheadLimit: club.daysAheadLimit,
                    };
                }
            }
        }

        const byClubAndTod = {};
        for (const tod of timeOfDays) {
            for (const club of (transformed[tod] || [])) {
                if (!byClubAndTod[club.clubId]) byClubAndTod[club.clubId] = {};
                byClubAndTod[club.clubId][tod] = club.availabilities;
            }
        }

        let html = `<div class="all-clubs-availability" style="margin-top: 12px;">`;

        for (const clubId of allClubIds) {
            const meta = clubMeta[clubId];
            const isLocked = daysDiff > (meta.daysAheadLimit ?? 3);

            html += `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 18px; font-weight: bold; color: white; margin-bottom: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.2);">
          ${meta.shortName}
        </div>
        <div class="row">`;

            for (const tod of timeOfDays) {
                const slots = (byClubAndTod[clubId] || {})[tod] || [];
                html += `
          <div class="col">
            <div class="row"><div class="col text-center white-80 m-2">${tod.toUpperCase()}</div></div>
            <div class="row gutter-1">`;

                if (slots.length === 0) {
                    html += `<div class="col-12 mb-2 text-center" style="color: rgba(255,255,255,0.4); font-size: 12px;">No availability</div>`;
                } else {
                    for (const slot of slots) {
                        const slotLocked = isLocked;
                        const disabledStyle = slotLocked
                            ? 'opacity: 0.35; background-color: rgba(255,255,255,0.05);'
                            : '';
                        const disabledClass = slotLocked ? ' time-slot-disabled' : '';
                        const lockIcon = slotLocked
                            ? `<div class="i-lock-blue position-absolute-top position-absolute-right icon-size-16 time-slot-icon"></div>`
                            : '';
                        const dataAttrs = slotLocked ? '' :
                            `data-club-name="${meta.shortName}" ` +
                            `data-from="${slot.fromHumanTime}" ` +
                            `data-to="${slot.toHumanTime}" ` +
                            `data-court="${slot.courtName}" ` +
                            `data-club-id="${clubId}"`;

                        html += `
              <div class="col-12 mb-2">
                <div class="border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${disabledClass} ${slotLocked ? '' : 'clickable bc-injected-slot'}" ${dataAttrs} style="${disabledStyle}">
                  <div class="text-lowercase">${slot.fromHumanTime} - ${slot.toHumanTime}</div>
                  <div style="font-size: 10px; color: rgba(255,255,255,0.6);">${slot.courtName}</div>
                  ${lockIcon}
                </div>
              </div>`;
                    }
                }

                html += `
            </div>
          </div>`;
            }

            html += `
        </div>
      </div>`;
        }

        html += `</div>`;

        anchorElement.innerHTML = html;

        // Wire up click handlers
        anchorElement.querySelectorAll('.bc-injected-slot').forEach(el => {
            el.addEventListener('click', () => {
                const clubName = el.dataset.clubName;
                const from = el.dataset.from;
                const to = el.dataset.to;
                const court = el.dataset.court;

                const bottomBar = document.querySelector('.white-bg.p-2 .container');
                if (!bottomBar) return;

                // Find or create the info col
                let infoCol = bottomBar.querySelector('.bc-injected-info');
                if (!infoCol) {
                    infoCol = document.createElement('div');
                    infoCol.className = 'col-12 col-md-auto black-gray size-12 text-center text-md-right my-auto p-2 bc-injected-info';
                    const row = bottomBar.querySelector('.row');
                    row.insertBefore(infoCol, row.firstChild);
                }

                infoCol.textContent = `${clubName} · ${court} @ ${from} - ${to}`;
            });
        });
    }

    // Update watchForHourViewTile to detect re-renders:
    function watchForHourViewTile() {
        const observer = new MutationObserver(() => {
            const tile = document.querySelector('.item-tile');
            if (tile && !tile.dataset.allClubsInjected) {
                if (lastTransformed) {
                    // Tile was re-rendered (e.g. date change) — re-inject immediately
                    // with stale data while fresh fetch is in flight
                    tile.dataset.allClubsInjected = 'true';
                    renderAllClubsAvailability(lastTransformed, tile, lastFetchParams.date);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Update fetchAllClubs to save results and re-inject after fresh fetch:
    async function fetchAllClubs(params) {
        const clubs = [
            '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63', // Broadway
            '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18', // Redwood Shores
            'ce7e7607-09e6-4d16-8197-1fffb70db776', // South San Francisco
            '3bc78448-ec6b-49e1-a2ae-64abd68e646b'  // Santa Clara
        ];

        const results = await Promise.all(clubs.map(clubId =>
            fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${params.date}&categoryCode=${params.categoryCode}&categoryOptionsId=${params.categoryOptionsId}&timeSlotId=${params.timeSlotId}`, {
                headers: {
                    'Authorization': capturedHeaders['Authorization'],
                    'X-SessionId': capturedHeaders['X-SessionId'],
                    'Request-Id': crypto.randomUUID(),
                    'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                    'Accept': 'application/json',
                }
            }).then(r => r.json())
        ));

        lastTransformed = transformAvailability(results);

        // Re-inject with fresh data — clear the flag so renderAllClubsAvailability runs again
        const tile = document.querySelector('.item-tile');
        if (tile) {
            tile.dataset.allClubsInjected = 'true';
            renderAllClubsAvailability(lastTransformed, tile, lastFetchParams.date);
        }
    }

    onUrlChange((url) => {
        if (url.includes('/racquet-sports/create-booking/')) {
            waitForRacquetSportsFilter(() => {
                onRacquetSportsFilterNodeLoaded();
            });
        }
    });

    // Call this once at startup — it runs forever watching for tile re-renders
    watchForHourViewTile();
})();