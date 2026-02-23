// ==UserScript==
// @name         Bay Club Connect Multi-club Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.2
// @description  Shows pickleball court booking slots across multiple clubs
// @author       Mark Rubin
// @match        https://bayclubconnect.com/*
// @run-at       document-body
// @icon         https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/icons/pickleball_17155178.png
// @updateURL    https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/loading_script.user.js
// @downloadURL  https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/loading_script.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Set up a style for selected card appearance.
    const style = document.createElement('style');
    style.textContent = `
    .bc-court-option[data-selected] {
        background-color: rgba(255,255,255,0.2) !important;
        outline: 1px solid rgba(255,255,255,0.5) !important;
    }
`;

    document.head.appendChild(style);
    // These are the uuids the app natively uses for each site.
    const CLUBS = {
        broadway: '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63',
        redwoodShores: '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18',
        southSF: 'ce7e7607-09e6-4d16-8197-1fffb70db776',
        santaClara: '3bc78448-ec6b-49e1-a2ae-64abd68e646b',
    };

    // These clubs have only indoor courts.
    const INDOOR_CLUBS = new Set([CLUBS.broadway, CLUBS.southSF]);

    // These are the uuids the app natively uses for time slot lengths.
    const TIMESLOTS = {
        min30: '37ef7bde-8580-48c3-aced-776ada7c2832',
        min60: '89a1327a-c893-49f6-88a9-be4c9ab4d481',
        min90: 'ea57c6b1-069c-4df9-8ee6-0d63ade162bc',
    };

    // Santa Clara doesn't allow bookings greater than 60 minutes.
    const CLUB_MAX_TIMESLOT = {
        [CLUBS.santaClara]: TIMESLOTS.min60,
    };

    const TIME_OF_DAYS = ['Morning', 'Afternoon', 'Evening'];

    // Edge courts are preferable because you have fewer courts potentially hitting balls onto your court, and
    // it makes you less likely to spray balls onto another court, especially when using a pickleball machine.
    const EDGE_COURTS = {
        [CLUBS.broadway]: ['Pickleball 1', 'Pickleball 2', 'Pickleball 5', 'Pickleball 6'],
        [CLUBS.redwoodShores]: ['Pickleball 1', 'Pickleball 2', 'Pickleball 3', 'Pickleball 4'], // all courts equally good
        [CLUBS.southSF]: ['Pickleball 1', 'Pickleball 2', 'Pickleball 5', 'Pickleball 6'],
        // santaClara: TBD
    };

    // We want to abort our multiple availability requests in flight if the user clicks BACK TO HOME.
    let currentAbortController = null;

    // We capture some required headers from the app's native requests so we can reuse them for our own requests.
    let capturedHeaders = {};

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name === 'Authorization' || name === 'X-SessionId') {
            capturedHeaders[name] = value;
        }
        if (name === 'Request-Id') {
            this._requestId = value;
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        // We stash the url and method for our use in send.
        this._url = url;
        this._method = method;
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    let lastFetchParams = null;
    let lastTransformed = null;
    let lastBookingRequestId = null;
    let pendingSlotBooking = null;

    XMLHttpRequest.prototype.send = function (body) {
        // When the native app requests availability for the default club, we fire off requests for all clubs.
        if (this._url && this._url.includes('court-booking/api/1.0/availability')) {
            const parsedUrl = new URL(this._url);
            lastFetchParams = {
                date: parsedUrl.searchParams.get('date'),
                categoryCode: parsedUrl.searchParams.get('categoryCode'),
                categoryOptionsId: parsedUrl.searchParams.get('categoryOptionsId'),
                timeSlotId: parsedUrl.searchParams.get('timeSlotId'),
                nativeClubId: parsedUrl.searchParams.get('clubId'),
            };
            fetchAllClubs(lastFetchParams);
        }

        if (this._url &&
            this._url.match(/courtbookings$/) && // We're watching for just 'courtbookings', not 'courtbookings/temporary'
            this._method === 'POST' &&
            pendingSlotBooking) {

            // Let's swallow any duplicate requests that might result from our hacking.
            const requestId = this._requestId;
            if (requestId === lastBookingRequestId) {
                // Duplicate — swallow it entirely
                return;
            }
            lastBookingRequestId = requestId;

            // The app's selected club may support larger reservation blocks than a club permits. Let's cap
            // our block size requests appropriately. Right now, we only have to worry about 90 minute time slots,
            // so let's keep it simple. timeSlotId is what the app uses for a time slot length.
            const timeSlotId = CLUB_MAX_TIMESLOT[pendingSlotBooking.clubId] &&
                lastFetchParams.timeSlotId === TIMESLOTS.min90
                ? CLUB_MAX_TIMESLOT[pendingSlotBooking.clubId]
                : lastFetchParams.timeSlotId;
            const ourBody = JSON.stringify({
                clubId: pendingSlotBooking.clubId,
                date: { value: pendingSlotBooking.date, date: pendingSlotBooking.date },
                timeFromInMinutes: pendingSlotBooking.fromMinutes,
                timeToInMinutes: pendingSlotBooking.toMinutes,
                categoryOptionsId: lastFetchParams.categoryOptionsId,
                timeSlotId: timeSlotId,
            });
            pendingSlotBooking = null;
            return originalXhrSend.call(this, ourBody);
        }

        return originalXhrSend.apply(this, arguments);
    };

    // The app and its server natively represent court booking start and end times as minutes from midnight.
    // So, for example, a court availability start time of 7:00 AM is represented as 420 (7 hours past midnight
    // is 420 minutes).
    function minutesToHumanTime(minutes) {
        const totalHours = Math.floor(minutes / 60);
        const ampm = totalHours < 12 ? 'am' : 'pm';
        let h = totalHours % 12;
        if (h === 0) h = 12;
        const m = minutes % 60;
        const timeStr = m === 0 ? `${h}:00` : `${h}:${String(m).padStart(2, '0')}`;
        return `${timeStr} ${ampm}`;
    }

    // When we get back availability data from the server, we want to massage it into a useful structure for us
    // to represent visually on the screen.
    function transformAvailability(results) {
        const output = { Morning: [], Afternoon: [], Evening: [] };

        for (const result of results) {
            for (const clubAvail of result.clubsAvailabilities) {
                const { club, courts, availableTimeSlots } = clubAvail;

                const courtById = {};
                const courtByVersionId = {};
                for (const court of courts) {
                    courtById[court.courtId] = court;
                    courtByVersionId[court.courtSetupVersionId] = court;
                }

                for (const tod of TIME_OF_DAYS) {
                    // Group slots by start time, collecting all available courts per time.
                    const slotMap = new Map();
                    for (const slot of availableTimeSlots.filter(s => s.timeOfDay === tod)) {
                        if (!slotMap.has(slot.fromInMinutes)) {
                            slotMap.set(slot.fromInMinutes, {
                                fromInMinutes: slot.fromInMinutes,
                                toInMinutes: slot.toInMinutes,
                                fromHumanTime: minutesToHumanTime(slot.fromInMinutes),
                                toHumanTime: minutesToHumanTime(slot.toInMinutes),
                                courts: [],
                            });
                        }
                        const courtVersionIds = slot.courtsVersionsIds?.length > 0
                            ? slot.courtsVersionsIds
                            : [slot.courtId];
                        for (const versionId of courtVersionIds) {
                            const court = courtByVersionId[versionId] || courtById[versionId] || {};
                            slotMap.get(slot.fromInMinutes).courts.push({
                                courtId: court.courtId || versionId,
                                courtName: court.courtName || null,
                                courtOrder: court.order ?? 999,
                            });
                        }
                    }

                    const slots = Array.from(slotMap.values())
                        .sort((a, b) => a.fromInMinutes - b.fromInMinutes)
                        .map(slot => ({
                            ...slot,
                            courts: slot.courts.sort((a, b) => a.courtOrder - b.courtOrder),
                        }));

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

    // Call this once after renderAllClubsAvailability injects the HTML. It allows us to hear the Next button click
    // when a slot has been selected and take action.
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

    // Use this key to store the club ordering selected by the user for future sessions. We'll use
    // a default order if nothing is stored at this key.
    const CLUB_ORDER_KEY = 'bc_club_order';

    function getClubOrder() {
        try {
            const saved = localStorage.getItem(CLUB_ORDER_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                // Validate that it contains exactly our club IDs
                if (parsed.length === Object.values(CLUBS).length &&
                    parsed.every(id => Object.values(CLUBS).includes(id))) {
                    return parsed;
                }
            }
        } catch (e) { }
        // Default order
        return [CLUBS.redwoodShores, CLUBS.broadway, CLUBS.southSF, CLUBS.santaClara];
    }

    function saveClubOrder(order) {
        localStorage.setItem(CLUB_ORDER_KEY, JSON.stringify(order));
    }

    function injectClubOrderWidget() {
        const container = document.querySelector('app-racquet-sports-filter div.row.row-cols-auto');
        if (!container || container.nextSibling?.classList?.contains('bc-club-order-widget')) return;

        const clubOrder = getClubOrder();

        // Friendlier names
        const CLUB_SHORT_NAMES = {
            [CLUBS.broadway]: 'Broadway',
            [CLUBS.redwoodShores]: 'Redwood Shores',
            [CLUBS.southSF]: 'South SF',
            [CLUBS.santaClara]: 'Santa Clara',
        };

        const widget = document.createElement('div');
        widget.className = 'bc-club-order-widget mt-3';
        widget.innerHTML = `
        <div style="font-size: 14px; margin-bottom: 8px; color: rgba(255,255,255,0.8);">Club Preference Order</div>
        <div class="bc-club-order-list" style="display: flex; flex-direction: column; gap: 6px;">
            ${clubOrder.map((id, i) => `
                <div class="bc-club-order-item" data-club-id="${id}" draggable="true"
                    style="display: flex; align-items: center; gap: 8px; padding: 6px 10px;
                           background: rgba(255,255,255,0.08); border-radius: 4px; cursor: grab;
                           border: 1px solid rgba(255,255,255,0.15); font-size: 13px;">
                    <span style="color: rgba(255,255,255,0.4); font-size: 16px; line-height: 1;">⠿</span>
                    <span style="color: rgba(255,255,255,0.5); min-width: 16px;">${i + 1}.</span>
                    <span>${CLUB_SHORT_NAMES[id]}</span>
                </div>
            `).join('')}
        </div>
    `;

        container.insertAdjacentElement('afterend', widget);
        initClubOrderingDragAndDrop(widget, CLUB_SHORT_NAMES);
    }

    function initClubOrderingDragAndDrop(widget, clubShortNames) {
        const list = widget.querySelector('.bc-club-order-list');
        let draggedItem = null;

        list.querySelectorAll('.bc-club-order-item').forEach(item => {
            item.addEventListener('dragstart', () => {
                draggedItem = item;
                setTimeout(() => item.style.opacity = '0.4', 0);
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '1';
                draggedItem = null;
                // Update numbering
                list.querySelectorAll('.bc-club-order-item').forEach((el, i) => {
                    el.querySelectorAll('span')[1].textContent = `${i + 1}.`;
                });
                // Save new order
                const newOrder = Array.from(list.querySelectorAll('.bc-club-order-item'))
                    .map(el => el.dataset.clubId);
                saveClubOrder(newOrder);
            });
            item.addEventListener('dragover', e => {
                e.preventDefault();
                if (item !== draggedItem) {
                    const rect = item.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    if (e.clientY < midY) {
                        list.insertBefore(draggedItem, item);
                    } else {
                        list.insertBefore(draggedItem, item.nextSibling);
                    }
                }
            });
        });
    }

    const INDOOR_ONLY_KEY = 'bc_indoor_only';

    function getShowIndoorClubsOnly() {
        try {
            const saved = localStorage.getItem(INDOOR_ONLY_KEY);
            if (saved !== null) return JSON.parse(saved);
        } catch (e) { }
        return false;
    }

    function saveShowIndoorClubsOnly(value) {
        localStorage.setItem(INDOOR_ONLY_KEY, JSON.stringify(value));
    }

    function buildShowIndoorCourtsOnlyToggleHtml(indoorOnly) {
        return `
    <div class="bc-indoor-toggle" style="margin-bottom: 16px; padding: 0 8px; display: flex; align-items: center; gap: 8px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; color: rgba(255,255,255,0.8); user-select: none;">
            <input type="checkbox" class="bc-indoor-checkbox" ${indoorOnly ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer; accent-color: rgb(0, 188, 212);">
            Indoor courts only
        </label>
    </div>`;
    }

    // We add a widget to allow users to filter availability by time range.
    const TIME_RANGE_KEY = 'bc_time_range';
    const SLIDER_MIN_MINUTES = 360;  // 6:00 am
    const SLIDER_MAX_MINUTES = 1200; // 8:00 pm
    const SLIDER_STEP_MINUTES = 30;
    const SLIDER_STOPS = (SLIDER_MAX_MINUTES - SLIDER_MIN_MINUTES) / SLIDER_STEP_MINUTES; // 28 intervals

    function getTimeRangeForSlider() {
        try {
            const saved = localStorage.getItem(TIME_RANGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (typeof parsed.startMinutes === 'number' && typeof parsed.endMinutes === 'number') {
                    return parsed;
                }
            }
        } catch (e) { }
        return { startMinutes: SLIDER_MIN_MINUTES, endMinutes: SLIDER_MAX_MINUTES };
    }

    function saveTimeRangeForSlider(startMinutes, endMinutes) {
        localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ startMinutes, endMinutes }));
    }

    function minutesToSliderPercent(minutes) {
        return (minutes - SLIDER_MIN_MINUTES) / (SLIDER_MAX_MINUTES - SLIDER_MIN_MINUTES) * 100;
    }

    function sliderPercentToMinutes(percent) {
        const raw = SLIDER_MIN_MINUTES + (percent / 100) * (SLIDER_MAX_MINUTES - SLIDER_MIN_MINUTES);
        // Snap to nearest 30-minute increment.
        return Math.round(raw / SLIDER_STEP_MINUTES) * SLIDER_STEP_MINUTES;
    }

    function buildTimeRangeSliderHtml(startMinutes, endMinutes) {
        const startPct = minutesToSliderPercent(startMinutes);
        const endPct = minutesToSliderPercent(endMinutes);

        // Build tick marks and hour labels.
        let ticks = '';
        for (let i = 0; i <= SLIDER_STOPS; i++) {
            const m = SLIDER_MIN_MINUTES + i * SLIDER_STEP_MINUTES;
            const pct = minutesToSliderPercent(m);
            const isHour = m % 60 === 0;
            ticks += `
            <div style="position: absolute; left: ${pct}%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;">
                <div style="width: 1px; height: ${isHour ? '8px' : '5px'}; background: rgba(255,255,255,${isHour ? '0.4' : '0.2'}); margin-top: 2px;"></div>
                ${isHour ? `<div style="font-size: 9px; color: rgba(255,255,255,0.4); margin-top: 2px; white-space: nowrap;">${minutesToHumanTime(m)}</div>` : ''}
            </div>`;
        }

        return `
    <div class="bc-time-range-widget" style="margin-bottom: 20px; padding: 0 8px;">
        <div style="font-size: 14px; color: rgba(255,255,255,0.8); margin-bottom: 12px;">
            Time Range: <span class="bc-time-range-label" style="color: white; font-weight: bold;">${minutesToHumanTime(startMinutes)} – ${minutesToHumanTime(endMinutes)}</span>
        </div>
        <div class="bc-slider-container" style="position: relative; height: 20px; margin: 0 8px;">
            <!-- Track background -->
            <div style="position: absolute; top: 8px; left: 0; right: 0; height: 4px; background: rgba(255,255,255,0.15); border-radius: 2px;"></div>
            <!-- Active track fill -->
            <div class="bc-slider-fill" style="position: absolute; top: 8px; left: ${startPct}%; right: ${100 - endPct}%; height: 4px; background: rgba(0, 188, 212, 0.8); border-radius: 2px;"></div>
            <!-- Start handle -->
            <div class="bc-slider-handle bc-slider-start" data-type="start" style="position: absolute; top: 0; left: ${startPct}%; transform: translateX(-50%); width: 20px; height: 20px; background: rgb(0, 188, 212); border-radius: 50%; cursor: grab; z-index: 2; box-shadow: 0 1px 4px rgba(0,0,0,0.4);"></div>
            <!-- End handle -->
            <div class="bc-slider-handle bc-slider-end" data-type="end" style="position: absolute; top: 0; left: ${endPct}%; transform: translateX(-50%); width: 20px; height: 20px; background: rgb(0, 188, 212); border-radius: 50%; cursor: grab; z-index: 2; box-shadow: 0 1px 4px rgba(0,0,0,0.4);"></div>
        </div>
        <!-- Ticks and labels -->
        <div style="position: relative; height: 28px; margin: 0 8px;">
            ${ticks}
        </div>
    </div>`;
    }

    function initTimeRangeSlider(container) {
        const sliderContainer = container.querySelector('.bc-slider-container');
        const fill = container.querySelector('.bc-slider-fill');
        const label = container.querySelector('.bc-time-range-label');
        const startHandle = container.querySelector('.bc-slider-start');
        const endHandle = container.querySelector('.bc-slider-end');

        let { startMinutes, endMinutes } = getTimeRangeForSlider();
        let dragging = null;

        function updateUI() {
            const startPct = minutesToSliderPercent(startMinutes);
            const endPct = minutesToSliderPercent(endMinutes);
            startHandle.style.left = `${startPct}%`;
            endHandle.style.left = `${endPct}%`;
            fill.style.left = `${startPct}%`;
            fill.style.right = `${100 - endPct}%`;
            label.textContent = `${minutesToHumanTime(startMinutes)} – ${minutesToHumanTime(endMinutes)}`;
        }

        function onMouseMove(e) {
            if (!dragging) return;
            const rect = sliderContainer.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const pct = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
            const snapped = sliderPercentToMinutes(pct);

            if (dragging === 'start') {
                startMinutes = Math.min(snapped, endMinutes - SLIDER_STEP_MINUTES);
            } else {
                endMinutes = Math.max(snapped, startMinutes + SLIDER_STEP_MINUTES);
            }
            updateUI();
        }

        function onMouseUp() {
            if (!dragging) return;
            dragging = null;
            saveTimeRangeForSlider(startMinutes, endMinutes);
            // Re-filter visible slots.
            applyFilters(startMinutes, endMinutes, getShowIndoorClubsOnly());
        }

        [startHandle, endHandle].forEach(handle => {
            handle.addEventListener('mousedown', e => { dragging = handle.dataset.type; e.preventDefault(); });
            handle.addEventListener('touchstart', e => { dragging = handle.dataset.type; e.preventDefault(); }, { passive: false });
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('touchmove', onMouseMove, { passive: false });
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchend', onMouseUp);
    }

    function applyFilters(startMinutes, endMinutes, indoorOnly) {
        document.querySelectorAll('.bc-court-option').forEach(el => {
            const from = parseInt(el.dataset.fromMinutes);
            const visible = from >= startMinutes && from < endMinutes;
            el.closest('[data-slot-wrapper]').style.display = visible ? '' : 'none';
        });

        // Hide time-of-day columns that have no visible slots remaining.
        document.querySelectorAll('.all-clubs-availability > [data-club-id]').forEach(clubDiv => {
            const clubId = clubDiv.dataset.clubId;

            // If indoor only is on and this club is not indoor, hide it entirely.
            if (indoorOnly && !INDOOR_CLUBS.has(clubId)) {
                clubDiv.style.display = 'none';
                return;
            }
            clubDiv.style.display = '';

            clubDiv.querySelectorAll('[data-tod-col]').forEach(todCol => {
                const anyVisible = Array.from(todCol.querySelectorAll('[data-slot-wrapper]'))
                    .some(el => el.style.display !== 'none');
                todCol.style.display = anyVisible ? '' : 'none';
            });

            const anyTodVisible = Array.from(clubDiv.querySelectorAll('[data-tod-col]'))
                .some(col => col.style.display !== 'none');

            const filterMsg = clubDiv.querySelector('.bc-filter-message');
            if (filterMsg) filterMsg.style.display = anyTodVisible ? 'none' : '';
        });
    }

    // Create a data structure well-tailored for rendering our slots by time of day per club.
    function buildClubIndex(transformed) {
        const allClubIds = [];
        const clubMeta = {};
        const byClubAndTod = {};

        for (const tod of TIME_OF_DAYS) {
            for (const club of (transformed[tod] || [])) {
                if (!clubMeta[club.clubId]) {
                    allClubIds.push(club.clubId);
                    clubMeta[club.clubId] = { shortName: club.shortName, code: club.code };
                }
                if (!byClubAndTod[club.clubId]) byClubAndTod[club.clubId] = {};
                byClubAndTod[club.clubId][tod] = club.availabilities;
            }
        }

        // Sort by saved club preference order.
        const preferredOrder = getClubOrder();
        allClubIds.sort((a, b) => preferredOrder.indexOf(a) - preferredOrder.indexOf(b));

        return { allClubIds, clubMeta, byClubAndTod };
    }

    function getClubsWithAvailability(allClubIds, clubMeta, byClubAndTod) {
        return allClubIds
            .filter(id => id !== lastFetchParams.nativeClubId)
            .filter(id => TIME_OF_DAYS.some(tod =>
                ((byClubAndTod[id] || {})[tod] || []).length > 0
            ))
            .map(id => clubMeta[id].shortName);
    }

    function buildNoNativeSlotWarningHtml(allClubIds, clubMeta, byClubAndTod) {
        const clubsWithAvailability = getClubsWithAvailability(allClubIds, clubMeta, byClubAndTod);
        return `
    <div style="background-color: rgba(255, 180, 0, 0.15); border: 1px solid rgba(255, 180, 0, 0.4); border-radius: 4px; padding: 10px 12px; margin-bottom: 16px; color: rgba(255, 220, 100, 0.9); font-size: 12px;">
        ⚠️ Your home club has no availability. To book at another location, change your home club to one with availability or change to a different date when the club does have availability. These clubs have availability on the date selected: ${clubsWithAvailability.join(', ')}
    </div>`;
    }

    function buildSlotHtml(slot, fetchDate, limitDate, meta, clubId) {
        const slotDate = new Date(fetchDate + 'T00:00:00');
        slotDate.setMinutes(slotDate.getMinutes() + slot.fromInMinutes);
        const slotLocked = slotDate > limitDate;

        const hasEdgeCourt = slot.courts.some(c => (EDGE_COURTS[clubId] || []).includes(c.courtName));
        const lockIcon = slotLocked
            ? `<div class="i-lock-blue position-absolute-top position-absolute-right icon-size-16 time-slot-icon"></div>`
            : '';
        const disabledStyle = slotLocked
            ? 'opacity: 0.35; background-color: rgba(255,255,255,0.05);'
            : '';

        // Single court — render as a directly selectable card with no expand step.
        if (slot.courts.length === 1) {
            const court = slot.courts[0];
            const isEdge = (EDGE_COURTS[clubId] || []).includes(court.courtName);
            const dataAttrs = slotLocked ? '' :
                `data-club-name="${meta.shortName}"
             data-from="${slot.fromHumanTime}"
             data-to="${slot.toHumanTime}"
             data-court="${court.courtName}"
             data-club-id="${clubId}"
             data-from-minutes="${slot.fromInMinutes}"
             data-to-minutes="${slot.toInMinutes}"`;
            return `
    <div data-slot-wrapper style="margin-bottom: 8px; margin-left: 4px; margin-right: 4px; width: 100%;">
      <div class="bc-court-option border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${slotLocked ? ' time-slot-disabled' : ' clickable'}"
           ${dataAttrs} style="${disabledStyle}${isEdge ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="text-lowercase" style="font-weight: 500;">${slot.fromHumanTime} - ${slot.toHumanTime}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${court.courtName}</div>
        ${isEdge ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 10px; color: rgba(255,200,50,0.9);">★</div>' : ''}
        ${lockIcon}
      </div>
    </div>`;
        }

        // Multiple courts — abbreviate court list and show expandable options.
        const courtNumbers = slot.courts.map(c => c.courtName?.replace(/\D+/g, '')).filter(Boolean);
        const courtSummary = courtNumbers.length > 0
            ? `Pickleball ${courtNumbers.join(', ')}`
            : 'Courts available';

        const expandedCourts = slotLocked ? '' : slot.courts.map(court => {
            const isEdge = (EDGE_COURTS[clubId] || []).includes(court.courtName);
            return `<div class="bc-court-option"
            data-club-name="${meta.shortName}"
            data-from="${slot.fromHumanTime}"
            data-to="${slot.toHumanTime}"
            data-court="${court.courtName}"
            data-club-id="${clubId}"
            data-from-minutes="${slot.fromInMinutes}"
            data-to-minutes="${slot.toInMinutes}"
            style="padding: 4px 8px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px;
                   background: rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center;">
            <span>${court.courtName}</span>
            ${isEdge ? '<span style="color: rgba(255,200,50,0.9); font-size: 10px;">★ edge</span>' : ''}
        </div>`;
        }).join('');

        return `
    <div data-slot-wrapper style="margin-bottom: 8px; margin-left: 4px; margin-right: 4px; width: 100%;">
      <div class="bc-slot-card border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${slotLocked ? ' time-slot-disabled' : ' clickable'}"
           style="${disabledStyle}${hasEdgeCourt ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="text-lowercase" style="font-weight: 500;">${slot.fromHumanTime} - ${slot.toHumanTime}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${courtSummary}</div>
        ${hasEdgeCourt ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 10px; color: rgba(255,200,50,0.9);">★</div>' : ''}
        ${lockIcon}
        <div class="bc-court-expand" style="display: none; margin-top: 6px; text-align: left; padding: 0 4px;">
            ${expandedCourts}
        </div>
      </div>
    </div>`;
    }

    function buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate) {
        const meta = clubMeta[clubId];
        const hasAnySlots = TIME_OF_DAYS.some(tod => ((byClubAndTod[clubId] || {})[tod] || []).length > 0);

        let html = `
    <div data-club-id="${clubId}" style="margin-bottom: 24px;">
      <div style="font-size: 18px; font-weight: bold; color: white; margin-bottom: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.2);">
        ${meta.shortName}
      </div>
      <div class="row bc-filter-message">
        <div class="col text-center" style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">There are available slots at this location, but none match your time range filter.</div>
      </div>`;

        if (!hasAnySlots) {
            html += `
      <div class="row">
        <div class="col text-center" style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">No courts available for this location on this date.</div>
      </div>`;
        } else {
            html += `<div class="row">`;

            for (const tod of TIME_OF_DAYS) {
                const slots = (byClubAndTod[clubId] || {})[tod] || [];
                if (slots.length === 0) continue;

                html += `
          <div class="col" data-tod-col>
            <div class="row"><div class="col text-center white-80 m-2">${tod.toUpperCase()}</div></div>
            <div class="row gutter-1">`;

                for (const slot of slots) {
                    html += buildSlotHtml(slot, fetchDate, limitDate, meta, clubId);
                }

                html += `
            </div>
          </div>`;
            }

            html += `</div>`;
        }

        html += `</div>`;
        return html;
    }

    function getOrCreateInfoCol(bottomBar) {
        let infoCol = bottomBar.querySelector('.bc-injected-info');
        if (!infoCol) {
            infoCol = document.createElement('div');
            infoCol.className = 'col-12 col-md-auto black-gray size-12 text-center text-md-right my-auto p-2 bc-injected-info';
            const row = bottomBar.querySelector('.row');
            row.insertBefore(infoCol, row.firstChild);
        }
        return infoCol;
    }

    function renderAllClubsAvailability(transformed, anchorElement, fetchDate) {
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() + 3);
        const mins = limitDate.getMinutes();
        limitDate.setMinutes(mins <= 30 ? 30 : 60, 0, 0);

        const { allClubIds, clubMeta, byClubAndTod } = buildClubIndex(transformed);

        const nativeClubHasAvailability = TIME_OF_DAYS.some(tod =>
            ((byClubAndTod[lastFetchParams.nativeClubId] || {})[tod] || []).length > 0
        );

        const { startMinutes, endMinutes } = getTimeRangeForSlider();
        const indoorOnly = getShowIndoorClubsOnly();
        let html = `<div class="all-clubs-availability" style="margin-top: 12px; padding-bottom: 200px;">`;
        html += buildShowIndoorCourtsOnlyToggleHtml(indoorOnly);
        html += buildTimeRangeSliderHtml(startMinutes, endMinutes);

        // We're going to render our slots for all the clubs. But we have to handle an edge case.
        // After a user selects one of our presented slots and then clicks Next, we want to fire off
        // a reservation request to the server and advance the UI to showing the partner picker, just
        // as the app natively would. But our slots are not hooked up to Angular and so clicking on them
        // does not advance the Angular state machine. It's not simple to force an update to the Angular
        // state machine and we'd rather not own replacing the rest of the flow (e. g. create our
        // own partner picker flow). So what we do is inject our own time slots for all the clubs while
        // hiding (not removing) the native Angular slots for the selected club, and when one
        // of our slots is selected, we secretly select one of the Angular slots. That advances Angular's state
        // machine. But then we watch request going out and create our own, so the request for the secretly
        // selected slot never goes out. Unfortunately, sometimes -- rarely -- the selected club has no availability
        // for a day (maybe there's a tournament going on all day, so all courts are pre-booked). In that case,
        // we have no native slot to select and we're out of luck. We'll show a warning message to the user to
        // select a different default club or date.
        if (!nativeClubHasAvailability) {
            html += buildNoNativeSlotWarningHtml(allClubIds, clubMeta, byClubAndTod);
        }

        // Render the time slots for all clubs.
        for (const clubId of allClubIds) {
            html += buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate);
        }

        html += `</div>`;

        // Hide native content but keep it in DOM so we can secretly select a slot when the user selects one of ours.
        Array.from(anchorElement.children).forEach(child => {
            if (!child.classList.contains('all-clubs-availability')) {
                child.style.display = 'none';
            }
        });

        // Append our content instead of replacing.
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        anchorElement.appendChild(wrapper.firstChild);

        // Add our time range slider widget.
        const sliderWidget = anchorElement.querySelector('.bc-time-range-widget');
        if (sliderWidget) initTimeRangeSlider(sliderWidget);
        applyFilters(startMinutes, endMinutes, indoorOnly);

        // Listen to our indoor courts only toggle.
        const indoorCheckbox = anchorElement.querySelector('.bc-indoor-checkbox');
        if (indoorCheckbox) {
            indoorCheckbox.addEventListener('change', () => {
                saveShowIndoorClubsOnly(indoorCheckbox.checked);
                applyFilters(startMinutes, endMinutes, indoorCheckbox.checked);
            });
        }

        // Wait for the weather forecast to be ready, then update the indoor toggle hint if rain is predicted.
        weatherFetchPromise.then(() => {
            if (!isRainPredictedForDate(fetchDate)) return;
            anchorElement.querySelectorAll('.bc-indoor-checkbox').forEach(checkbox => {
                const label = checkbox.closest('label');
                if (label && !label.querySelector('.bc-rain-hint')) {
                    const hint = document.createElement('span');
                    hint.className = 'bc-rain-hint';
                    hint.textContent = `🌧️ Rain predicted: ${rainPercentageForDate(fetchDate)}%`;
                    hint.style.cssText = 'color: rgba(100, 180, 255, 0.9); font-size: 12px; margin-left: 4px;';
                    label.appendChild(hint);
                }
            });
        });

        // We'll take over handling the Next button.
        initNextButton();

        // Wire up click handlers.
        let selectedSlot = null;

        // Expand/collapse slot cards on click.
        anchorElement.querySelectorAll('.bc-slot-card').forEach(card => {
            card.addEventListener('click', e => {
                if (card.classList.contains('time-slot-disabled')) return;
                if (e.target.closest('.bc-court-option')) return;

                const expand = card.querySelector('.bc-court-expand');
                if (!expand) return;

                const isOpen = expand.style.display !== 'none';
                const hasSelection = !!card.querySelector('.bc-court-option[data-selected]');

                // Toggle open/closed, but never collapse if a selection is active within.
                if (isOpen && !hasSelection) {
                    expand.style.display = 'none';
                } else {
                    expand.style.display = 'block';
                }
            });
        });

        // Select a specific court when an expanded court option or single-court card is clicked.
        anchorElement.querySelectorAll('.bc-court-option').forEach(el => {
            el.addEventListener('click', () => {
                // Deselect any previously selected option.
                anchorElement.querySelectorAll('.bc-court-option[data-selected]').forEach(prev => {
                    prev.removeAttribute('data-selected');
                });

                // Collapse all expanded cards except the one containing the new selection.
                // Collapsing is a consequence of selection, not of expansion.
                const parentCard = el.closest('.bc-slot-card');
                anchorElement.querySelectorAll('.bc-slot-card').forEach(card => {
                    if (card === parentCard) return;
                    const otherExpand = card.querySelector('.bc-court-expand');
                    if (otherExpand) otherExpand.style.display = 'none';
                });

                selectedSlot = null;

                // Select this court option.
                el.setAttribute('data-selected', '');
                selectedSlot = el;

                pendingSlotBooking = {
                    clubId: el.dataset.clubId,
                    date: lastFetchParams.date,
                    fromMinutes: parseInt(el.dataset.fromMinutes),
                    toMinutes: parseInt(el.dataset.toMinutes),
                };

                const bottomBar = document.querySelector('.white-bg.p-2 .container');
                if (!bottomBar) return;
                const infoCol = getOrCreateInfoCol(bottomBar);

                const nativeSlot = document.querySelector('app-court-time-slot-item div.time-slot');
                if (nativeSlot) {
                    nativeSlot.click();
                    setTimeout(() => {
                        const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                        if (nativeInfo) nativeInfo.style.display = 'none';
                    }, 0);
                } else {
                    infoCol.textContent = `⚠️ To book, set your home club to one with availability: ${getClubsWithAvailability(allClubIds, clubMeta, byClubAndTod).join(', ')}`;
                    pendingSlotBooking = null;
                    return;
                }

                infoCol.textContent = `${el.dataset.clubName} · ${el.dataset.court} @ ${el.dataset.from} - ${el.dataset.to}`;

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

    // If the user selects BACK TO HOME, we need to clean ourselves up, cancel requests, etc.
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

                        removeOurContentAndUnhideNativeContent();
                    }, true); // capture: true, no stopPropagation — Angular handles navigation
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // As a single page app, we get very few hints as to when the user has taken action that causes
    // what appears to the user as a screen update: the URL rarely changes, we see very few pushStates
    // or popStates, etc. So we'll be a bit brute force here and watch for container changes. This is how
    // we know to update our time slots for a new date, for example.
    function watchForContainerChanges() {
        const observer = new MutationObserver(() => {
            injectIntoAllContainers();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // When the duration selector page appears, we'll inject our own widget for club ordering.
    function watchForDurationSelectorPage() {
        const observer = new MutationObserver(() => {
            const container = document.querySelector('app-racquet-sports-filter div.row.row-cols-auto');
            if (container && !container.nextSibling?.classList?.contains('bc-club-order-widget')) {
                injectClubOrderWidget();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function removeOurContentAndUnhideNativeContent() {
        document.querySelectorAll('.all-clubs-availability').forEach(el => el.remove());
        document.querySelectorAll('.item-tile > *, .d-md-none.px-3 > *').forEach(child => {
            child.style.display = '';
        });
    }

    // Angular supports mobile and desktop views/containers, and renders them differently. We want
    // to make sure we can handle either.
    function injectIntoAllContainers() {
        if (!lastTransformed) return;

        // Hide the court selector — not relevant when showing all clubs
        document.querySelectorAll('app-court-select').forEach(el => {
            el.closest('.ng-star-inserted')
                ? el.closest('.ng-star-inserted').style.display = 'none'
                : el.style.display = 'none';
        });

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

    function watchForNavigationAwayFromBooking() {
        let lastHref = location.href;

        setInterval(() => {
            if (location.href === lastHref) return;
            lastHref = location.href;

            // If we've navigated away from the court booking flow, clean up.
            if (!location.href.includes('create-booking')) {
                removeOurContentAndUnhideNativeContent();
                lastTransformed = null;
                lastFetchParams = null;
                pendingSlotBooking = null;
            }
        }, 300);
    }

    // Fetch availability info for all the clubs in parallel, and combine their results.
    async function fetchAllClubs(params) {
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;

        try {
            const results = await Promise.all(Object.values(CLUBS).map(clubId => {
                const timeSlotId = CLUB_MAX_TIMESLOT[clubId] &&
                    params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : params.timeSlotId;
                return fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${params.date}&categoryCode=${params.categoryCode}&categoryOptionsId=${params.categoryOptionsId}&timeSlotId=${timeSlotId}`, {
                    signal,
                    headers: {
                        'Authorization': capturedHeaders['Authorization'],
                        'X-SessionId': capturedHeaders['X-SessionId'],
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    }
                }).then(r => r.json())
            }));

            lastTransformed = transformAvailability(results);
            removeOurContentAndUnhideNativeContent();
            injectIntoAllContainers();
        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('[fetch] aborted');
            } else {
                throw e;
            }
        }
    }

    // Cache of date string -> percentage change of rain so we only fetch weather once per session.
    const rainPredictionCache = {};
    let weatherFetchPromise = null;
    const MIN_RAIN_PERCENTAGE_FOR_ALERT = 20;

    async function fetchWeatherForecast() {
        // Fetch up to 16 days of daily precipitation probability in one call.
        // Open-Meteo requires no API key and covers all Bay Area clubs with a single coordinate.
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=37.5&longitude=-122.1&daily=precipitation_probability_max&timezone=America%2FLos_Angeles&forecast_days=16';
        try {
            const response = await fetch(url);
            const data = await response.json();
            const dates = data?.daily?.time || [];
            const probs = data?.daily?.precipitation_probability_max || [];
            dates.forEach((date, i) => {
                rainPredictionCache[date] = probs[i];
            });
        } catch (e) {
            // Fail silently — weather is a hint, not critical.
        }
    }

    function rainPercentageForDate(dateString) {
        return rainPredictionCache[dateString]
    }

    function isRainPredictedForDate(dateString) {
        return rainPercentageForDate(dateString) > MIN_RAIN_PERCENTAGE_FOR_ALERT ?? false;
    }

    // Let's actually start our program! We'll keep watch on the DOM starting here.
    interceptBackToHomeButton();
    watchForContainerChanges();
    watchForDurationSelectorPage();
    watchForNavigationAwayFromBooking();
    weatherFetchPromise = fetchWeatherForecast();
})();
