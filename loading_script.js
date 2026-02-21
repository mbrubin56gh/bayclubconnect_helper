// ==UserScript==
// @name         Bay Club Connect Multi-club Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.1
// @description  Shows pickleball court booking slots across multiple clubs
// @author       Mark Rubin
// @match        https://bayclubconnect.com/*
// @run-at       document-start
// @icon         https://github.com/mbrubin56gh/bayclubconnect_helper/raw/d4f3023bb29f8db0fc4799894a084bb01c81d49e/icons/pickleball_17155178.png
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let currentAbortController = null;

    let capturedHeaders = {};

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name === 'Authorization' || name === 'X-SessionId') {
            capturedHeaders[name] = value;
        }
        if (name === 'Request-Id') {
            this._requestId = value;
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url; // stash the url for use in send
        this._method = method;
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    let lastFetchParams = null;
    let lastTransformed = null;
    let pendingSlotBooking = null; // set when user clicks an injected slot
    let lastBookingRequestId = null;

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

        if (this._url &&
            this._url.match(/courtbookings$/) && // ends with 'courtbookings', not 'courtbookings/temporary'
            this._method === 'POST' &&
            pendingSlotBooking) {
            const requestId = this._requestId;
            if (requestId === lastBookingRequestId) {
                // Duplicate — swallow it entirely
                console.log('[booking] suppressing duplicate courtbookings POST');
                return;
            }
            lastBookingRequestId = requestId;
            console.log('[booking] intercepting courtbookings POST, substituting our slot');
            const ourBody = JSON.stringify({
                clubId: pendingSlotBooking.clubId,
                date: { value: pendingSlotBooking.date, date: pendingSlotBooking.date },
                timeFromInMinutes: pendingSlotBooking.fromMinutes,
                timeToInMinutes: pendingSlotBooking.toMinutes,
                categoryOptionsId: lastFetchParams.categoryOptionsId,
                timeSlotId: lastFetchParams.timeSlotId,
            });
            pendingSlotBooking = null;
            return originalXhrSend.call(this, ourBody);
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

                    // Always push the club, even if slots is empty
                    output[tod].push({
                        clubId: club.id,
                        shortName: club.shortName,
                        code: club.code,
                        availabilities: slots,
                    });
                }
            }
        }

        return output;
    }

    // Call this once after renderAllClubsAvailability injects the HTML
    function initNextButton() {
        const nextButton = Array.from(document.querySelectorAll('button.btn-light-blue'))
            .find(btn => btn.textContent.trim().includes('NEXT'));
        if (nextButton) {
            nextButton.setAttribute('disabled', '');
            nextButton.style.backgroundColor = '';
            nextButton.style.borderColor = '';
            nextButton.style.opacity = '';
            nextButton.style.cursor = '';
        }
    }

    function renderAllClubsAvailability(transformed, anchorElement, fetchDate) {
        const timeOfDays = ['Morning', 'Afternoon', 'Evening'];

        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() + 3);
        const mins = limitDate.getMinutes();
        limitDate.setMinutes(mins <= 30 ? 30 : 60, 0, 0);

        // Build club metadata lookup
        const allClubIds = [];
        const clubMeta = {};
        for (const tod of timeOfDays) {
            for (const club of (transformed[tod] || [])) {
                if (!clubMeta[club.clubId]) {
                    allClubIds.push(club.clubId);
                    clubMeta[club.clubId] = {
                        shortName: club.shortName,
                        code: club.code,
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

        let html = `<div class="all-clubs-availability" style="margin-top: 12px; padding-bottom: 200px;">`;

        for (const clubId of allClubIds) {
            const meta = clubMeta[clubId];
            const hasAnySlots = timeOfDays.some(tod => ((byClubAndTod[clubId] || {})[tod] || []).length > 0);

            html += `
        <div style="margin-bottom: 24px;">
          <div style="font-size: 18px; font-weight: bold; color: white; margin-bottom: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.2);">
            ${meta.shortName}
          </div>`;

            if (!hasAnySlots) {
                html += `
          <div class="row">
            <div class="col text-center" style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">No courts available for this location on this date.</div>
          </div>`;
            } else {
                html += `<div class="row">`;

                for (const tod of timeOfDays) {
                    const slots = (byClubAndTod[clubId] || {})[tod] || [];
                    if (slots.length === 0) continue;

                    html += `
            <div class="col">
              <div class="row"><div class="col text-center white-80 m-2">${tod.toUpperCase()}</div></div>
              <div class="row gutter-1">`;

                    for (const slot of slots) {
                        const slotDate = new Date(fetchDate + 'T00:00:00');
                        slotDate.setMinutes(slotDate.getMinutes() + slot.fromInMinutes);
                        const slotLocked = slotDate > limitDate;
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
                            `data-club-id="${clubId}" ` +
                            `data-from-minutes="${slot.fromInMinutes}" ` +
                            `data-to-minutes="${slot.toInMinutes}"`;

                        html += `
              <div class="col-12 mb-2">
                <div class="border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${disabledClass} ${slotLocked ? '' : 'clickable bc-injected-slot'}" ${dataAttrs} style="${disabledStyle}">
                  <div class="text-lowercase">${slot.fromHumanTime} - ${slot.toHumanTime}</div>
                  <div style="font-size: 10px; color: rgba(255,255,255,0.6);">${slot.courtName}</div>
                  ${lockIcon}
                </div>
              </div>`;
                    }

                    html += `
              </div>
            </div>`;
                }

                html += `</div>`;
            }

            html += `</div>`;
        }

        html += `</div>`;

        // Hide native content but keep it in DOM
        Array.from(anchorElement.children).forEach(child => {
            if (!child.classList.contains('all-clubs-availability')) {
                child.style.display = 'none';
            }
        });

        // Append our content instead of replacing
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        anchorElement.appendChild(wrapper.firstChild);

        initNextButton();

        // Wire up click handlers
        let selectedSlot = null;

        anchorElement.querySelectorAll('.bc-injected-slot').forEach(el => {
            el.addEventListener('click', () => {

                // Deselect previous
                if (selectedSlot) {
                    selectedSlot.style.backgroundColor = '';
                    selectedSlot.style.borderColor = '';
                    selectedSlot.style.color = '';
                }

                // Select this one
                el.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
                el.style.borderColor = 'rgba(255, 255, 255, 0.6)';
                el.style.color = 'white';
                selectedSlot = el;

                pendingSlotBooking = {
                    clubId: el.dataset.clubId,
                    date: lastFetchParams.date,
                    fromMinutes: parseInt(el.dataset.fromMinutes),
                    toMinutes: parseInt(el.dataset.toMinutes),
                };

                // Click a native slot to activate Angular's internal state
                const nativeSlot = document.querySelector('app-court-time-slot-item div.time-slot');
                if (nativeSlot) {
                    nativeSlot.click();
                    setTimeout(() => {
                        const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                        if (nativeInfo) nativeInfo.style.display = 'none';
                    }, 0);
                }

                const clubName = el.dataset.clubName;
                const from = el.dataset.from;
                const to = el.dataset.to;
                const court = el.dataset.court;

                const bottomBar = document.querySelector('.white-bg.p-2 .container');
                if (!bottomBar) return;

                let infoCol = bottomBar.querySelector('.bc-injected-info');
                if (!infoCol) {
                    infoCol = document.createElement('div');
                    infoCol.className = 'col-12 col-md-auto black-gray size-12 text-center text-md-right my-auto p-2 bc-injected-info';
                    const row = bottomBar.querySelector('.row');
                    row.insertBefore(infoCol, row.firstChild);
                }

                infoCol.textContent = `${clubName} · ${court} @ ${from} - ${to}`;

                const nextButton = Array.from(document.querySelectorAll('button.btn-light-blue'))
                    .find(btn => btn.textContent.trim().includes('NEXT'));

                if (nextButton) {
                    nextButton.style.backgroundColor = 'rgb(0, 188, 212)';
                    nextButton.style.borderColor = 'rgb(0, 188, 212)';
                    nextButton.style.opacity = '1';
                    nextButton.style.cursor = 'pointer';
                    nextButton.removeAttribute('disabled');
                }
            });
        });
    }

    function interceptBackToHomeButton() {
        const observer = new MutationObserver(() => {
            document.querySelectorAll('img[src="assets/back.svg"]').forEach(backImg => {
                const container = backImg.closest('[class*="col"]');
                if (container && !container.dataset.bcIntercepted) {
                    container.dataset.bcIntercepted = 'true';
                    container.addEventListener('click', () => {
                        // Abort in-flight fetches
                        if (currentAbortController) currentAbortController.abort();

                        // Clear state
                        lastTransformed = null;
                        lastFetchParams = null;
                        pendingSlotBooking = null;

                        // Remove injected content and unhide native
                        document.querySelectorAll('.all-clubs-availability').forEach(el => el.remove());
                        document.querySelectorAll('.item-tile > *, .d-md-none.px-3 > *').forEach(child => {
                            child.style.display = '';
                        });
                    }, true); // capture: true, no stopPropagation — Angular handles navigation
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Update watchForHourViewTile to detect re-renders:
    function watchForHourViewTile() {
        const observer = new MutationObserver(() => {
            injectIntoAllContainers();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function injectIntoAllContainers() {
        if (!lastTransformed) return;

        // Desktop
        const tile = document.querySelector('.item-tile');
        if (tile && !tile.querySelector('.all-clubs-availability')) {
            renderAllClubsAvailability(lastTransformed, tile, lastFetchParams.date);
        }

        // Mobile
        const mobileContainer = document.querySelector('.d-md-none.px-3');
        if (mobileContainer && !mobileContainer.querySelector('.all-clubs-availability')) {
            renderAllClubsAvailability(lastTransformed, mobileContainer, lastFetchParams.date);
        }
    }

    // Update fetchAllClubs to save results and re-inject after fresh fetch:
    async function fetchAllClubs(params) {
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;

        const clubs = [
            '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63', // Broadway
            '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18', // Redwood Shores
            'ce7e7607-09e6-4d16-8197-1fffb70db776', // South San Francisco
            '3bc78448-ec6b-49e1-a2ae-64abd68e646b'  // Santa Clara
        ];

        try {
            const results = await Promise.all(clubs.map(clubId =>
                fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${params.date}&categoryCode=${params.categoryCode}&categoryOptionsId=${params.categoryOptionsId}&timeSlotId=${params.timeSlotId}`, {
                    signal,
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
            document.querySelectorAll('.all-clubs-availability').forEach(el => el.remove());
            document.querySelectorAll('.item-tile > *, .d-md-none.px-3 > *').forEach(child => {
                child.style.display = '';
            });
            injectIntoAllContainers();
        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('[fetch] aborted');
            } else {
                throw e;
            }
        }
    };

    // Call this once at startup — it runs forever watching for tile re-renders
    interceptBackToHomeButton();
    watchForHourViewTile();
})();
