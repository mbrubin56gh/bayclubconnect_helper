/*jslint esversion: 11 */
// ==UserScript==
// @name         Bay Club Connect Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.3
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
        [CLUBS.santaClara]: ['Pickleball 1', 'Pickleball 2', 'Pickleball 3', 'Pickleball 4', 'Pickleball 5', 'Pickleball 6', 'Pickleball 7', 'Pickleball 8', 'Pickleball 9', 'Pickleball 10'],
    };

    // Isolated single courts, such as those surrounded by fences are the most prized of all.
    const ISOLATED_COURTS = {
        [CLUBS.santaClara]: ['Pickleball 1', 'Pickleball 6'],
    }

    const createBookingStateService = (() => {
        let serviceInstance = null;

        return function createBookingStateService() {
            if (serviceInstance) return serviceInstance;
            // Keep mutable booking/network state private and expose a narrow API for callers.
            let currentAbortController = null;
            const capturedHeaders = {};
            let lastFetchState = null;
            let pendingSlotBooking = null;

            function captureHeader(name, value) {
                capturedHeaders[name] = value;
            }

            function getCapturedHeader(name) {
                return capturedHeaders[name];
            }

            function beginFetch() {
                if (currentAbortController) currentAbortController.abort();
                currentAbortController = new AbortController();
                return currentAbortController.signal;
            }

            function abortFetch() {
                if (currentAbortController) currentAbortController.abort();
                currentAbortController = null;
            }

            function setLastFetchState(state) {
                lastFetchState = state;
            }

            function getLastFetchState() {
                return lastFetchState;
            }

            function clearLastFetchState() {
                lastFetchState = null;
            }

            function setPendingSlotBooking(booking) {
                pendingSlotBooking = booking;
            }

            function getPendingSlotBooking() {
                return pendingSlotBooking;
            }

            function clearPendingSlotBooking() {
                pendingSlotBooking = null;
            }

            serviceInstance = {
                captureHeader,
                getCapturedHeader,
                beginFetch,
                abortFetch,
                setLastFetchState,
                getLastFetchState,
                clearLastFetchState,
                setPendingSlotBooking,
                getPendingSlotBooking,
                clearPendingSlotBooking,
            };
            return serviceInstance;
        };
    })();

    function createXhrMetadataStore() {
        const metadataByRequest = new WeakMap();

        function getOrCreate(xhr) {
            let metadata = metadataByRequest.get(xhr);
            if (!metadata) {
                metadata = {};
                metadataByRequest.set(xhr, metadata);
            }
            return metadata;
        }

        function setRequestId(xhr, requestId) {
            getOrCreate(xhr).requestId = requestId;
        }

        function getRequestId(xhr) {
            return metadataByRequest.get(xhr)?.requestId;
        }

        function setRequestInfo(xhr, method, url) {
            const metadata = getOrCreate(xhr);
            metadata.method = method;
            metadata.url = url;
        }

        function getRequestInfo(xhr) {
            const metadata = metadataByRequest.get(xhr);
            if (!metadata) return null;
            return { method: metadata.method, url: metadata.url };
        }

        return {
            setRequestId,
            getRequestId,
            setRequestInfo,
            getRequestInfo,
        };
    }

    function installXhrInterceptors() {
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        const AVAILABILITY_API_PATH = 'court-booking/api/1.0/availability';
        let lastBookingRequestId = null;
        const xhrMetadataStore = createXhrMetadataStore();

        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            // Capture these so we can authenticate our own requests to the Bay Club's APIs.
            if (name === 'Authorization' || name === 'X-SessionId') {
                createBookingStateService().captureHeader(name, value);
            }
            if (name === 'Request-Id') {
                xhrMetadataStore.setRequestId(this, value);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string' && url.includes(AVAILABILITY_API_PATH)) {
                this.addEventListener('load', function () {
                    // We need Angular to think there is at least one available time slot for the native
                    // app's default selected club so Angular will render that slot in the hour view.
                    // Without that Angular rendered slot, we're not able to drive the Angular state
                    // machine forward to issue a booking request after one of our slots is selected:
                    // we fake a click on that slot, which allows the click on the Next button in the
                    // hour view to issue the booking request and render the partner selector (we make
                    // sure that the only booking requests that actually go out from the hour view are
                    // our own). So we need to make sure the request for court availabilities for the home
                    // club for a date always returns at least one slot. We do that here.

                    if (this.status < 200 || this.status >= 300) return;
                    if (!this.responseText || this.responseText.trim() === '') return;
                    try {
                        const data = JSON.parse(this.responseText);
                        if (!data.clubsAvailabilities) return;
                        const clubAvail = data.clubsAvailabilities[0];
                        const slotCount = clubAvail?.availableTimeSlots?.length ?? 0;
                        // If the club actually has availability for that date, we are good.
                        if (slotCount > 0) return;
                        // Make sure a real court is present so we can synthesize one fake slot.
                        const court = clubAvail?.courts?.[0];
                        if (!court) return;
                        // Inject one synthetic slot so Angular can continue its booking flow.
                        clubAvail.availableTimeSlots = [{ timeOfDay: 'Morning', fromInMinutes: 420, toInMinutes: 450, courtId: court.courtId, courtsVersionsIds: [court.courtSetupVersionId || court.courtId] }];
                        Object.defineProperty(this, 'response', { get: () => JSON.stringify(data), configurable: true });
                        Object.defineProperty(this, 'responseText', { get: () => JSON.stringify(data), configurable: true });
                    } catch (e) {
                        console.log('[bc] error:', e);
                    }
                });
            }
            xhrMetadataStore.setRequestInfo(this, method, url);
            return originalXhrOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function (_body) {
            // Detect the native app's native request for court availability and use it to add our own
            // for data we actually want based on what our user selected for duration across
            // all clubs.
            const requestInfo = xhrMetadataStore.getRequestInfo(this);
            const requestUrl = requestInfo?.url;
            const requestMethod = requestInfo?.method;

            if (requestUrl && requestUrl.includes(AVAILABILITY_API_PATH)) {
                const parsedUrl = new URL(requestUrl);
                const params = {
                    date: parsedUrl.searchParams.get('date'),
                    categoryCode: parsedUrl.searchParams.get('categoryCode'),
                    categoryOptionsId: parsedUrl.searchParams.get('categoryOptionsId'),
                    timeSlotId: parsedUrl.searchParams.get('timeSlotId'),
                    nativeClubId: parsedUrl.searchParams.get('clubId'),
                };
                fetchAllClubs(params);
            }

            // Intercept the native app's booking request and replace it with our own
            // for the selected club and time slot.
            if (requestUrl &&
                requestUrl.match(/courtbookings$/) &&
                requestMethod === 'POST' &&
                createBookingStateService().getPendingSlotBooking()) {

                const pendingSlotBooking = createBookingStateService().getPendingSlotBooking();
                const lastFetchState = createBookingStateService().getLastFetchState();
                if (!pendingSlotBooking || !lastFetchState) {
                    return originalXhrSend.apply(this, arguments);
                }

                // Dedupe any requests, just in case.
                const requestId = xhrMetadataStore.getRequestId(this);
                if (requestId && requestId === lastBookingRequestId) {
                    return;
                }
                if (requestId) {
                    lastBookingRequestId = requestId;
                }

                const timeSlotId = CLUB_MAX_TIMESLOT[pendingSlotBooking.clubId] &&
                    lastFetchState.params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[pendingSlotBooking.clubId]
                    : lastFetchState.params.timeSlotId;
                const ourBody = JSON.stringify({
                    clubId: pendingSlotBooking.clubId,
                    courtId: pendingSlotBooking.courtId,
                    date: { value: pendingSlotBooking.date, date: pendingSlotBooking.date },
                    timeFromInMinutes: pendingSlotBooking.fromMinutes,
                    timeToInMinutes: pendingSlotBooking.toMinutes,
                    categoryOptionsId: lastFetchState.params.categoryOptionsId,
                    timeSlotId: timeSlotId,
                });
                createBookingStateService().clearPendingSlotBooking();
                return originalXhrSend.call(this, ourBody);
            }

            return originalXhrSend.apply(this, arguments);
        };
    }

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
                                // Ugh. The server adds a space at the end of "Pickleball 1" only 
                                // for Santa Clara and only for that court. Clearly a bug on the
                                // server end. We'll trim() here to be safe.
                                courtName: (court.courtName || '').trim() || null,
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

    // Call this once after renderAllClubsAvailability injects the HTML. It disables the Next button until
    // the user selects a slot; the court option click handler re-enables it.
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

    const createBookingDomQueryService = (() => {
        let serviceInstance = null;

        return function createBookingDomQueryService() {
            if (serviceInstance) return serviceInstance;

            const DURATION_AND_PLAYERS_FILTER_SELECTOR = 'app-racquet-sports-filter div.row.row-cols-auto';
            const HOUR_VIEW_BUTTON_SELECTOR = 'app-time-slot-view-type-select .btn';
            const BOOKING_PAGE_TITLE_SELECTOR = 'app-page-title';
            const BACK_ICON_SELECTOR = 'img[src="assets/back.svg"]';
            const BACK_TEXT_SELECTOR = 'span.clickable.font-weight-bold.text-uppercase';
            const DESKTOP_TIME_SLOT_HOST_SELECTOR = '.item-tile';
            const MOBILE_TIME_SLOT_HOST_SELECTOR = '.d-md-none.px-3';
            const TIME_SLOT_HOSTS_SELECTOR = `${DESKTOP_TIME_SLOT_HOST_SELECTOR}, ${MOBILE_TIME_SLOT_HOST_SELECTOR}`;

            function getDurationAndPlayersFilterContainer() {
                return document.querySelector(DURATION_AND_PLAYERS_FILTER_SELECTOR);
            }

            function hasDurationAndPlayersFilterVisible() {
                return !!getDurationAndPlayersFilterContainer();
            }

            function hasHourViewControlsVisible() {
                return Array.from(document.querySelectorAll(HOUR_VIEW_BUTTON_SELECTOR))
                    .some(btn => btn.textContent.trim().startsWith('HOUR VIEW'));
            }

            function findHourViewButton() {
                return Array.from(document.querySelectorAll(HOUR_VIEW_BUTTON_SELECTOR))
                    .find(btn => btn.textContent.trim().startsWith('HOUR VIEW'));
            }

            function hasBookingFlowShellVisible() {
                const title = document.querySelector(BOOKING_PAGE_TITLE_SELECTOR);
                if (!title) return false;

                // Support both mobile and desktop variants by looking for the shared back icon in the page title.
                return !!title.querySelector(BACK_ICON_SELECTOR);
            }

            function hasTimeSlotHostsVisible() {
                return !!document.querySelector(TIME_SLOT_HOSTS_SELECTOR);
            }

            function getDesktopTimeSlotHost() {
                return document.querySelector(DESKTOP_TIME_SLOT_HOST_SELECTOR);
            }

            function getMobileTimeSlotHost() {
                return document.querySelector(MOBILE_TIME_SLOT_HOST_SELECTOR);
            }

            function isBackControlClickTarget(target) {
                if (!(target instanceof Element)) return false;
                const pageTitle = target.closest(BOOKING_PAGE_TITLE_SELECTOR);
                if (!pageTitle) return false;

                const hitBackIcon = !!target.closest(BACK_ICON_SELECTOR);
                const hitBackText = !!target.closest(BACK_TEXT_SELECTOR);
                return hitBackIcon || hitBackText;
            }

            serviceInstance = {
                getDurationAndPlayersFilterContainer,
                hasDurationAndPlayersFilterVisible,
                hasHourViewControlsVisible,
                findHourViewButton,
                hasBookingFlowShellVisible,
                hasTimeSlotHostsVisible,
                getDesktopTimeSlotHost,
                getMobileTimeSlotHost,
                isBackControlClickTarget,
            };
            return serviceInstance;
        };
    })();

    const createLocalStorageService = (() => {
        let serviceInstance = null;

        return function createLocalStorageService() {
            if (serviceInstance) return serviceInstance;

            function getString(key) {
                return localStorage.getItem(key);
            }

            function setString(key, value) {
                localStorage.setItem(key, value);
            }

            function getJson(key, parseErrorLogMessage) {
                const raw = localStorage.getItem(key);
                if (raw === null) return null;
                try {
                    return JSON.parse(raw);
                } catch (_e) {
                    if (parseErrorLogMessage) {
                        console.log(parseErrorLogMessage);
                    }
                    return null;
                }
            }

            function setJson(key, value) {
                localStorage.setItem(key, JSON.stringify(value));
            }

            serviceInstance = {
                getString,
                setString,
                getJson,
                setJson,
            };
            return serviceInstance;
        };
    })();

    const createPreferenceAutoSelectService = (() => {
        let serviceInstance = null;

        return function createPreferenceAutoSelectService() {
            if (serviceInstance) return serviceInstance;
            // Use these keys to store previously selected players and duration choices.
            const PLAYERS_KEY = 'bc_players';
            const DURATION_KEY = 'bc_duration';
            // Set to true while programmatically clicking a fallback duration so the save listener skips it.
            let suppressDurationSave = false;

            // The native app does not remember the previously selected player count and duration, so
            // we augment it here to do that.
            function tryToAutoSelectDurationAndPlayers() {
                document.querySelectorAll('app-button-select .btn-group').forEach(group => {
                    if (group.dataset.bcAutoSelected) return;
                    const labels = Array.from(group.querySelectorAll('.btn'))
                        .map(b => b.textContent.trim());
                    const isPlayers = labels.includes('Singles');
                    const isDuration = labels.includes('30 minutes');
                    if (!isPlayers && !isDuration) return;
                    const key = isPlayers ? PLAYERS_KEY : DURATION_KEY;
                    const saved = createLocalStorageService().getString(key);
                    if (saved) {
                        const buttons = Array.from(group.querySelectorAll('.btn'));
                        const btn = buttons.find(b => b.textContent.trim() === saved);
                        if (btn) {
                            if (!btn.classList.contains('btn-selected')) btn.click();
                        } else if (isDuration) {
                            // Saved duration is not available (for example: 90 min saved but max is 60 min).
                            // Click the highest available option without overwriting the saved preference.
                            const parseMinutes = b => parseInt(b.textContent.trim()) || 0;
                            const fallbackBtn = buttons.reduce((best, b) => parseMinutes(b) > parseMinutes(best) ? b : best);
                            if (!fallbackBtn.classList.contains('btn-selected')) {
                                suppressDurationSave = true;
                                fallbackBtn.click();
                                suppressDurationSave = false;
                            }
                        }
                    }
                    group.dataset.bcAutoSelected = 'true';
                });
            }

            function autoSelectPlayersAndDuration() {
                const container = createBookingDomQueryService().getDurationAndPlayersFilterContainer();
                if (!container) return;

                if (!container.dataset.bcListening) {
                    // Save player selection on click via delegation.
                    container.addEventListener('click', e => {
                        const btn = e.target.closest('app-button-select .btn');
                        if (!btn || suppressDurationSave) return;
                        const group = btn.closest('.btn-group');
                        const labels = Array.from(group.querySelectorAll('.btn'))
                            .map(b => b.textContent.trim());
                        if (labels.includes('Singles')) {
                            createLocalStorageService().setString(PLAYERS_KEY, btn.textContent.trim());
                        } else if (labels.includes('30 minutes')) {
                            createLocalStorageService().setString(DURATION_KEY, btn.textContent.trim());
                        }
                    });
                    container.dataset.bcListening = 'true';
                }

                // Auto-select saved player preference.
                tryToAutoSelectDurationAndPlayers();
            }

            serviceInstance = {
                autoSelectPlayersAndDuration,
            };
            return serviceInstance;
        };
    })();

    // Some clubs only let you reserve pickleball courts, but some offer the option to
    // reserve tennis and/or squash courts as well. Let's automatically select the pickleball
    // option if they do.
    function tryToAutoSelectPickleball() {
        const pickleballIcon = document.querySelector('app-court-booking-category-select .i-pickleball-white');
        if (!pickleballIcon) return;
        const tile = pickleballIcon.closest('.item-tile');
        if (!tile || tile.dataset.bcAutoSelected) return;
        tile.dataset.bcAutoSelected = 'true';
        if (!tile.classList.contains('category-selected')) tile.click();
    }

    const CLUB_SHORT_NAMES = {
        [CLUBS.broadway]: 'Broadway',
        [CLUBS.redwoodShores]: 'Redwood Shores',
        [CLUBS.southSF]: 'South SF',
        [CLUBS.santaClara]: 'Santa Clara',
    };

    function getClubOrder() {
        // Use this key to store the club ordering selected by the user for future sessions.
        const CLUB_ORDER_KEY = 'bc_club_order';
        const parsed = createLocalStorageService().getJson(CLUB_ORDER_KEY, '[bc] failed to parse stored club order JSON');
        if (Array.isArray(parsed) &&
            parsed.length === Object.values(CLUBS).length &&
            parsed.every(id => Object.values(CLUBS).includes(id))) {
            // Validate that it contains exactly our club IDs.
            return parsed;
        }

        // Default order.
        return [CLUBS.redwoodShores, CLUBS.broadway, CLUBS.southSF, CLUBS.santaClara];
    }

    function saveClubOrder(order) {
        const CLUB_ORDER_KEY = 'bc_club_order';
        createLocalStorageService().setJson(CLUB_ORDER_KEY, order);
    }

    function injectClubOrderWidget() {
        const container = createBookingDomQueryService().getDurationAndPlayersFilterContainer();
        if (!container || container.nextSibling?.classList?.contains('bc-club-order-widget')) return;

        const clubOrder = getClubOrder();

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
        createClubOrderWidgetController().initDragAndDrop(widget);
    }

    const createClubOrderWidgetController = (() => {
        let serviceInstance = null;

        return function createClubOrderWidgetController() {
            if (serviceInstance) return serviceInstance;

            function updateListNumbering(list) {
                list.querySelectorAll('.bc-club-order-item').forEach((el, i) => {
                    el.querySelectorAll('span')[1].textContent = `${i + 1}.`;
                });
            }

            function saveCurrentOrder(list) {
                const newOrder = Array.from(list.querySelectorAll('.bc-club-order-item'))
                    .map(el => el.dataset.clubId);
                saveClubOrder(newOrder);
            }

            function handleDragOver({ event, item, list, getDraggedItem }) {
                event.preventDefault();
                const draggedItem = getDraggedItem();
                if (!draggedItem || item === draggedItem) return;

                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (event.clientY < midY) {
                    list.insertBefore(draggedItem, item);
                } else {
                    list.insertBefore(draggedItem, item.nextSibling);
                }
            }

            function initDragAndDrop(widget) {
                const list = widget.querySelector('.bc-club-order-list');
                if (!list) return;

                let draggedItem = null;

                list.querySelectorAll('.bc-club-order-item').forEach(item => {
                    item.addEventListener('dragstart', () => {
                        draggedItem = item;
                        // This is a workaround for a browser quirk where setting opacity during
                        // dragstart affects the drag ghost image.
                        setTimeout(() => {
                            item.style.opacity = '0.4';
                        }, 0);
                    });

                    item.addEventListener('dragend', () => {
                        item.style.opacity = '1';
                        draggedItem = null;
                        updateListNumbering(list);
                        saveCurrentOrder(list);
                    });

                    item.addEventListener('dragover', event => {
                        handleDragOver({ event, item, list, getDraggedItem: () => draggedItem });
                    });
                });
            }

            serviceInstance = {
                initDragAndDrop,
            };
            return serviceInstance;
        };
    })();

    // We use this to store whether the user prefers the BY CLUB or BY TIME layout.
    const VIEW_MODE_BY_CLUB = 'by-club';
    const VIEW_MODE_BY_TIME = 'by-time';

    function getViewMode() {
        const VIEW_MODE_KEY = 'bc_view_mode';
        return createLocalStorageService().getString(VIEW_MODE_KEY) === VIEW_MODE_BY_TIME ? VIEW_MODE_BY_TIME : VIEW_MODE_BY_CLUB;
    }

    function saveViewMode(mode) {
        const VIEW_MODE_KEY = 'bc_view_mode';
        createLocalStorageService().setString(VIEW_MODE_KEY, mode);
    }

    function initViewToggle(anchorElement) {
        anchorElement.querySelectorAll('.bc-view-toggle .btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const newMode = btn.dataset.view;
                if (newMode === getViewMode()) return;
                saveViewMode(newMode);
                const existing = anchorElement.querySelector('.all-clubs-availability');
                if (existing) existing.remove();
                const lastFetchState = createBookingStateService().getLastFetchState();
                if (lastFetchState) {
                    createAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, anchorElement, lastFetchState.params.date);
                }
            });
        });
    }

    function getShowIndoorClubsOnly() {
        const INDOOR_ONLY_KEY = 'bc_indoor_only';
        const saved = createLocalStorageService().getJson(INDOOR_ONLY_KEY, '[bc] failed to parse stored indoor-only JSON');
        if (typeof saved === 'boolean') {
            return saved;
        }
        return false;
    }

    function saveShowIndoorClubsOnly(value) {
        const INDOOR_ONLY_KEY = 'bc_indoor_only';
        createLocalStorageService().setJson(INDOOR_ONLY_KEY, value);
    }

    function buildShowIndoorCourtsOnlyToggleHtml() {
        return `
    <div class="bc-indoor-toggle" style="margin-bottom: 16px; padding: 0 8px; display: flex; align-items: center; gap: 8px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; color: rgba(255,255,255,0.8); user-select: none;">
            <input type="checkbox" class="bc-indoor-checkbox" ${getShowIndoorClubsOnly() ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer; accent-color: rgb(0, 188, 212);">
            Indoor courts only
        </label>
    </div>`;
    }

    function buildViewToggleHtml() {
        const mode = getViewMode();
        return `
    <div class="bc-view-toggle" style="margin-bottom: 16px; padding: 0 8px;">
        <div class="btn-group" role="group">
            <button class="btn btn-outline-dark-grey size-10 py-2${mode === VIEW_MODE_BY_CLUB ? ' btn-selected' : ''}" data-view="${VIEW_MODE_BY_CLUB}">BY CLUB</button>
            <button class="btn btn-outline-dark-grey size-10 py-2${mode === VIEW_MODE_BY_TIME ? ' btn-selected' : ''}" data-view="${VIEW_MODE_BY_TIME}">BY TIME</button>
        </div>
    </div>`;
    }

    // We add a widget to allow users to filter availability by time range.
    const SLIDER_MIN_MINUTES = 360;  // 6:00 am
    const SLIDER_MAX_MINUTES = 1320; // 10:00 pm
    const SLIDER_STEP_MINUTES = 30;
    const SLIDER_STOPS = (SLIDER_MAX_MINUTES - SLIDER_MIN_MINUTES) / SLIDER_STEP_MINUTES; // 32 intervals (16 hours × 2)

    function getTimeRangeForSlider() {
        const TIME_RANGE_KEY = 'bc_time_range';
        const parsed = createLocalStorageService().getJson(TIME_RANGE_KEY, '[bc] failed to parse stored time range JSON');
        if (parsed &&
            typeof parsed.startMinutes === 'number' &&
            typeof parsed.endMinutes === 'number') {
            return parsed;
        }
        return { startMinutes: SLIDER_MIN_MINUTES, endMinutes: SLIDER_MAX_MINUTES };
    }

    function saveTimeRangeForSlider(startMinutes, endMinutes) {
        const TIME_RANGE_KEY = 'bc_time_range';
        createLocalStorageService().setJson(TIME_RANGE_KEY, { startMinutes, endMinutes });
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
            <div style="position: absolute; left: ${pct}%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;"${isHour ? ` data-tick-minutes="${m}"` : ''}>
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
        <div style="position: relative; height: 54px; margin: 0 8px;">
            ${ticks}
        </div>
    </div>`;
    }

    const createTimeRangeSliderController = (() => {
        let serviceInstance = null;

        return function createTimeRangeSliderController() {
            if (serviceInstance) return serviceInstance;

            function init(container) {
                const sliderContainer = container.querySelector('.bc-slider-container');
                const fill = container.querySelector('.bc-slider-fill');
                const label = container.querySelector('.bc-time-range-label');
                const startHandle = container.querySelector('.bc-slider-start');
                const endHandle = container.querySelector('.bc-slider-end');
                if (!sliderContainer || !fill || !label || !startHandle || !endHandle) return;

                let { startMinutes, endMinutes } = getTimeRangeForSlider();
                let dragging = null;

                function updateUi() {
                    const startPct = minutesToSliderPercent(startMinutes);
                    const endPct = minutesToSliderPercent(endMinutes);
                    startHandle.style.left = `${startPct}%`;
                    endHandle.style.left = `${endPct}%`;
                    fill.style.left = `${startPct}%`;
                    fill.style.right = `${100 - endPct}%`;
                    label.textContent = `${minutesToHumanTime(startMinutes)} – ${minutesToHumanTime(endMinutes)}`;
                }

                function removeDragListeners() {
                    document.removeEventListener('mousemove', onPointerMove);
                    document.removeEventListener('touchmove', onPointerMove);
                    document.removeEventListener('mouseup', onPointerUp);
                    document.removeEventListener('touchend', onPointerUp);
                    document.removeEventListener('touchcancel', onDragCancel);
                    window.removeEventListener('blur', onDragCancel);
                }

                function addDragListeners() {
                    document.addEventListener('mousemove', onPointerMove);
                    document.addEventListener('touchmove', onPointerMove, { passive: false });
                    document.addEventListener('mouseup', onPointerUp);
                    document.addEventListener('touchend', onPointerUp);
                    document.addEventListener('touchcancel', onDragCancel);
                    window.addEventListener('blur', onDragCancel);
                }

                function onPointerMove(event) {
                    if (!dragging) return;
                    const rect = sliderContainer.getBoundingClientRect();
                    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
                    const pct = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
                    const snapped = sliderPercentToMinutes(pct);

                    if (dragging === 'start') {
                        startMinutes = Math.min(snapped, endMinutes - SLIDER_STEP_MINUTES);
                    } else {
                        endMinutes = Math.max(snapped, startMinutes + SLIDER_STEP_MINUTES);
                    }
                    updateUi();
                }

                function onPointerUp() {
                    if (!dragging) return;
                    dragging = null;
                    saveTimeRangeForSlider(startMinutes, endMinutes);
                    // Re-filter visible slots.
                    createAvailabilityRenderPipeline().applyFilters(startMinutes, endMinutes);
                    removeDragListeners();
                }

                function onDragCancel() {
                    if (!dragging) return;
                    dragging = null;
                    removeDragListeners();
                }

                function startDrag(type, event) {
                    dragging = type;
                    removeDragListeners();
                    addDragListeners();
                    event.preventDefault();
                }

                [startHandle, endHandle].forEach(handle => {
                    handle.addEventListener('mousedown', event => startDrag(handle.dataset.type, event));
                    handle.addEventListener('touchstart', event => startDrag(handle.dataset.type, event), { passive: false });
                });
            }

            serviceInstance = {
                init,
            };
            return serviceInstance;
        };
    })();


    // Create a data structure well-tailored for rendering our slots by time of day per club.
    function buildClubIndex(transformed, failedClubIds) {
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

        for (const clubId of failedClubIds) {
            if (!clubMeta[clubId]) {
                allClubIds.push(clubId);
                clubMeta[clubId] = { shortName: CLUB_SHORT_NAMES[clubId] || clubId, code: '' };
            }
        }

        // Sort by saved club preference order.
        const preferredOrder = getClubOrder();
        allClubIds.sort((a, b) => preferredOrder.indexOf(a) - preferredOrder.indexOf(b));

        return { allClubIds, clubMeta, byClubAndTod };
    }

    const LABEL_MODE_TIME = 'time';
    const LABEL_MODE_CLUB = 'club';

    function buildSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        const slotDate = new Date(fetchDate + 'T00:00:00');
        slotDate.setMinutes(slotDate.getMinutes() + slot.fromInMinutes);
        const slotLocked = slotDate > limitDate;

        const hasIsolatedCourt = slot.courts.some(c => (ISOLATED_COURTS[clubId] || []).includes(c.courtName));
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
            const isIsolated = (ISOLATED_COURTS[clubId] || []).includes(court.courtName);
            const isEdge = (EDGE_COURTS[clubId] || []).includes(court.courtName);
            const dataAttrs = slotLocked ? '' :
                `data-club-name="${meta.shortName}"
                data-from="${slot.fromHumanTime}"
                data-to="${slot.toHumanTime}"
                data-court="${court.courtName}"
                data-court-id="${court.courtId}"
                data-club-id="${clubId}"
                data-from-minutes="${slot.fromInMinutes}"
                data-to-minutes="${slot.toInMinutes}"`;
            return `
    <div data-slot-wrapper data-from-minutes="${slot.fromInMinutes}">
      <div class="bc-court-option border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${slotLocked ? ' time-slot-disabled' : ' clickable'}"
           ${dataAttrs} style="${disabledStyle}${isIsolated ? ' border: 2px solid rgba(255,215,0,1);' : isEdge ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${court.courtName}</div>
        ${isIsolated ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 12px; color: rgba(255,215,0,1);">✦</div>' : isEdge ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 10px; color: rgba(255,200,50,0.9);">★</div>' : ''}
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
            const isIsolated = (ISOLATED_COURTS[clubId] || []).includes(court.courtName);
            const isEdge = (EDGE_COURTS[clubId] || []).includes(court.courtName);
            return `<div class="bc-court-option"
            data-club-name="${meta.shortName}"
            data-from="${slot.fromHumanTime}"
            data-to="${slot.toHumanTime}"
            data-court="${court.courtName}"
            data-court-id="${court.courtId}"
            data-club-id="${clubId}"
            data-from-minutes="${slot.fromInMinutes}"
            data-to-minutes="${slot.toInMinutes}"
            style="padding: 4px 8px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px;
                   background: rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center;">
            <span>${court.courtName}</span>
            ${isIsolated ? '<span style="color: rgba(255,215,0,1); font-size: 10px;">✦ isolated</span>' : isEdge ? '<span style="color: rgba(255,200,50,0.9); font-size: 10px;">★ edge</span>' : ''}
        </div>`;
        }).join('');

        return `
    <div data-slot-wrapper data-from-minutes="${slot.fromInMinutes}">
      <div class="bc-slot-card border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${slotLocked ? ' time-slot-disabled' : ' clickable'}"
           style="${disabledStyle}${hasIsolatedCourt ? ' border: 2px solid rgba(255,215,0,1);' : hasEdgeCourt ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${courtSummary}</div>
        ${hasIsolatedCourt ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 12px; color: rgba(255,215,0,1);">✦</div>' : hasEdgeCourt ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 10px; color: rgba(255,200,50,0.9);">★</div>' : ''}
        ${lockIcon}
        <div class="bc-court-expand" style="display: none; margin-top: 6px; text-align: left; padding: 0 4px;">
            ${expandedCourts}
        </div>
      </div>
    </div>`;
    }

    function buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet) {
        const meta = clubMeta[clubId];
        const fetchFailed = failedClubIdsSet.has(clubId);
        const hasAnySlots = TIME_OF_DAYS.some(tod => ((byClubAndTod[clubId] || {})[tod] || []).length > 0);

        let html = `
        <div data-club-id="${clubId}" style="margin-bottom: 24px;">
        <div style="font-size: 20px; font-weight: bold; color: white; margin-bottom: 12px; padding: 8px 0;">
            ${meta.shortName}
        </div>
        <div class="row bc-filter-message" style="display: none;">
            <div class="col text-center" style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">There are available slots at this location, but none match your time range filter.</div>
        </div>`;

        if (fetchFailed) {
            html += `
      <div class="row">
        <div class="col text-center" style="color: rgba(255,180,120,0.95); font-size: 12px; padding: 8px 0;">Could not load availability for this location. Try again in a moment.</div>
      </div>`;
        } else if (!hasAnySlots) {
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
            <div style="display: flex; flex-direction: column; gap: 4px; max-width: 260px;">
            <div class="text-center white-80 m-2">${tod.toUpperCase()}</div>`;

                for (const slot of slots) {
                    html += buildSlotHtml(slot, fetchDate, limitDate, meta, clubId, LABEL_MODE_TIME);
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

    function buildByTimeHtml(allClubIds, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet) {
        // Collect all slots across all clubs, keyed by fromInMinutes.
        // Iterating allClubIds first preserves club preference order within each time group.
        const slotsByTime = new Map();
        for (const clubId of allClubIds) {
            for (const tod of TIME_OF_DAYS) {
                for (const slot of ((byClubAndTod[clubId] || {})[tod] || [])) {
                    if (!slotsByTime.has(slot.fromInMinutes)) slotsByTime.set(slot.fromInMinutes, []);
                    slotsByTime.get(slot.fromInMinutes).push({ clubId, slot, meta: clubMeta[clubId] });
                }
            }
        }

        const sortedTimes = [...slotsByTime.keys()].sort((a, b) => a - b);
        if (sortedTimes.length === 0 && failedClubIdsSet.size > 0) {
            return `<div style="color: rgba(255,180,120,0.95); padding: 20px 0; text-align: center;">Some locations failed to load availability. Please try again.</div>`;
        }
        if (sortedTimes.length === 0) {
            return `<div style="color: rgba(255,255,255,0.4); padding: 20px 0; text-align: center;">No courts available for this date.</div>`;
        }

        let html = '';
        for (const fromMinutes of sortedTimes) {
            const entries = slotsByTime.get(fromMinutes);
            const { fromHumanTime, toHumanTime } = entries[0].slot;
            html += `
        <div data-time-group data-from-minutes="${fromMinutes}" style="margin-bottom: 20px;">
            <div style="font-size: 18px; font-weight: bold; color: white; margin-bottom: 8px; padding: 6px 0;">${fromHumanTime} – ${toHumanTime}</div>
            <div style="display: flex; flex-direction: column; gap: 4px; max-width: 260px;">`;
            for (const { clubId, slot, meta } of entries) {
                html += buildSlotHtml(slot, fetchDate, limitDate, meta, clubId, LABEL_MODE_CLUB);
            }
            html += `
            </div>
        </div>`;
        }
        return html;
    }

    // We show the selected reservation time slot in the native app's bottom bar.
    function getOrCreateSelectedBookingInfoHolder(bottomBar) {
        let selectedBookingInfoHolder = bottomBar.querySelector('.bc-injected-info');
        if (!selectedBookingInfoHolder) {
            selectedBookingInfoHolder = document.createElement('div');
            selectedBookingInfoHolder.className = 'col-12 col-md-auto black-gray size-12 text-center text-md-right my-auto p-2 bc-injected-info';
            const row = bottomBar.querySelector('.row');
            row.insertBefore(selectedBookingInfoHolder, row.firstChild);
        }
        return selectedBookingInfoHolder;
    }

    function buildFailedClubsWarningHtml(failedClubIdsSet) {
        if (failedClubIdsSet.size === 0) return '';

        const labels = Array.from(failedClubIdsSet).map(clubId => CLUB_SHORT_NAMES[clubId] || clubId);
        return `
    <div style="margin: 0 8px 16px; padding: 8px 12px; border-radius: 4px; border: 1px solid rgba(255,180,120,0.7); background: rgba(255,180,120,0.1); color: rgba(255,210,170,0.98); font-size: 12px;">
        Could not load availability for: ${labels.join(', ')}.
    </div>`;
    }

    // Availability filtering and rendering orchestration are encapsulated in this pipeline service.
    const createAvailabilityRenderPipeline = (() => {
        let serviceInstance = null;

        return function createAvailabilityRenderPipeline() {
            if (serviceInstance) return serviceInstance;

            function filterSlotsByTimeRange(startMinutes, endMinutes) {
                document.querySelectorAll('[data-slot-wrapper][data-from-minutes]').forEach(wrapper => {
                    const from = parseInt(wrapper.dataset.fromMinutes);
                    wrapper.style.display = from >= startMinutes && from < endMinutes ? '' : 'none';
                });
            }

            function filterOutdoorSlotsFromTimeGroups() {
                if (!getShowIndoorClubsOnly()) return;
                document.querySelectorAll('[data-time-group] [data-slot-wrapper]').forEach(wrapper => {
                    if (wrapper.style.display === 'none') return;
                    const opt = wrapper.querySelector('.bc-court-option');
                    if (opt && !INDOOR_CLUBS.has(opt.dataset.clubId)) wrapper.style.display = 'none';
                });
            }

            function collapseEmptyTimeGroups() {
                document.querySelectorAll('[data-time-group]').forEach(group => {
                    const anyVisible = [...group.querySelectorAll('[data-slot-wrapper]')]
                        .some(el => el.style.display !== 'none');
                    group.style.display = anyVisible ? '' : 'none';
                });
            }

            function updateByClubViewVisibility() {
                document.querySelectorAll('.all-clubs-availability > [data-club-id]').forEach(clubDiv => {
                    const clubId = clubDiv.dataset.clubId;

                    if (getShowIndoorClubsOnly() && !INDOOR_CLUBS.has(clubId)) {
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
                    const hasTodCols = clubDiv.querySelectorAll('[data-tod-col]').length > 0;

                    const filterMsg = clubDiv.querySelector('.bc-filter-message');
                    if (filterMsg) filterMsg.style.display = (hasTodCols && !anyTodVisible) ? '' : 'none';
                });
            }

            function applyFilters(startMinutes, endMinutes) {
                filterSlotsByTimeRange(startMinutes, endMinutes);
                if (getViewMode() === VIEW_MODE_BY_TIME) {
                    filterOutdoorSlotsFromTimeGroups();
                    collapseEmptyTimeGroups();
                } else {
                    updateByClubViewVisibility();
                }
            }

            function renderAllClubsAvailability(transformed, anchorElement, fetchDate) {
                const limitDate = new Date();
                limitDate.setDate(limitDate.getDate() + 3);
                // Floor to current 30-minute window start.
                const mins = limitDate.getMinutes();
                limitDate.setMinutes(mins < 30 ? 0 : 30, 0, 0);

                const lastFetchState = createBookingStateService().getLastFetchState();
                if (!lastFetchState) return;
                const failedClubIdsSet = new Set(lastFetchState.failedClubIds || []);
                const { allClubIds, clubMeta, byClubAndTod } = buildClubIndex(transformed, failedClubIdsSet);

                const { startMinutes, endMinutes } = getTimeRangeForSlider();
                let html = `<div class="all-clubs-availability" style="margin-top: 12px; padding-bottom: 200px;">`;
                html += buildShowIndoorCourtsOnlyToggleHtml();
                html += buildTimeRangeSliderHtml(startMinutes, endMinutes);
                html += buildViewToggleHtml();
                html += buildFailedClubsWarningHtml(failedClubIdsSet);

                // Render the time slots in the selected layout mode.
                if (getViewMode() === VIEW_MODE_BY_TIME) {
                    html += buildByTimeHtml(allClubIds, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet);
                } else {
                    for (const clubId of allClubIds) {
                        html += buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet);
                    }
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
                if (sliderWidget) createTimeRangeSliderController().init(sliderWidget);
                initViewToggle(anchorElement);
                applyFilters(startMinutes, endMinutes);

                // Listen to our indoor courts only toggle.
                const indoorCheckbox = anchorElement.querySelector('.bc-indoor-checkbox');
                if (indoorCheckbox) {
                    indoorCheckbox.addEventListener('change', () => {
                        saveShowIndoorClubsOnly(indoorCheckbox.checked);
                        const { startMinutes: curStart, endMinutes: curEnd } = getTimeRangeForSlider();
                        applyFilters(curStart, curEnd);
                    });
                }

                // Once weather data is ready, inject per-hour emoji below each hour label on the slider.
                const RAIN_EMOJIS = ['🌧️', '🌦️', '⛈️'];
                createWeatherService().whenReady().then(() => {
                    const widget = anchorElement.querySelector('.bc-time-range-widget');
                    if (!widget) return;
                    widget.querySelectorAll('[data-tick-minutes]').forEach(tickDiv => {
                        if (tickDiv.querySelector('.bc-weather-tick')) return;
                        const fromMinutes = parseInt(tickDiv.dataset.tickMinutes);
                        const emoji = createWeatherService().emojiForHour(fetchDate, fromMinutes);
                        if (!emoji) return;
                        const emojiEl = document.createElement('div');
                        emojiEl.className = 'bc-weather-tick';
                        emojiEl.style.cssText = 'font-size: 12px; line-height: 1; margin-top: 2px; text-align: center;';
                        emojiEl.textContent = emoji;
                        if (RAIN_EMOJIS.includes(emoji)) {
                            const pct = createWeatherService().rainPctForHour(fetchDate, fromMinutes);
                            if (pct != null) {
                                const pctEl = document.createElement('div');
                                pctEl.style.cssText = 'font-size: 9px; color: rgba(160,200,255,0.9); text-align: center;';
                                pctEl.textContent = `${pct}%`;
                                emojiEl.appendChild(pctEl);
                            }
                        }
                        tickDiv.appendChild(emojiEl);
                    });
                });

                // We'll take over handling the Next button.
                initNextButton();

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

                        // Select this court option.
                        el.setAttribute('data-selected', '')

                        const lastFetchState = createBookingStateService().getLastFetchState();
                        if (!lastFetchState) return;
                        createBookingStateService().setPendingSlotBooking({
                            clubId: el.dataset.clubId,
                            courtId: el.dataset.courtId,
                            date: lastFetchState.params.date,
                            fromMinutes: parseInt(el.dataset.fromMinutes),
                            toMinutes: parseInt(el.dataset.toMinutes),
                        });

                        const bottomBar = document.querySelector('.white-bg.p-2 .container');
                        if (!bottomBar) return;
                        const selectedBookingInfoHolder = getOrCreateSelectedBookingInfoHolder(bottomBar);

                        const nativeSlot = document.querySelector('app-court-time-slot-item div.time-slot');
                        if (nativeSlot) {
                            nativeSlot.click();
                            setTimeout(() => {
                                const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                                if (nativeInfo) nativeInfo.style.display = 'none';
                            }, 0);
                        } else {
                            console.log("No native slot to click");
                        }

                        selectedBookingInfoHolder.textContent = `${el.dataset.clubName} · ${el.dataset.court} @ ${el.dataset.from} - ${el.dataset.to}`;

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

            serviceInstance = {
                applyFilters,
                renderAllClubsAvailability,
            };
            return serviceInstance;
        };
    })();

    function clearBookingStateAndUi() {
        createBookingStateService().abortFetch();
        createBookingStateService().clearLastFetchState();
        createBookingStateService().clearPendingSlotBooking();
        removeOurContentAndUnhideNativeContent();
    }

    function runBookingDomTasks() {
        // Clear injected slot UI only when we are inside the booking flow shell but none of the
        // supported booking-step hosts are present. This avoids brittle title-text matching and
        // preserves behavior on the duration/player screen where controls still need augmentation.
        if (createBookingDomQueryService().hasBookingFlowShellVisible() &&
            !createBookingDomQueryService().hasTimeSlotHostsVisible() &&
            !createBookingDomQueryService().hasHourViewControlsVisible() &&
            !createBookingDomQueryService().hasDurationAndPlayersFilterVisible()) {
            createBookingStateService().clearPendingSlotBooking();
            removeOurContentAndUnhideNativeContent();
            return;
        }

        injectIntoAllContainers();
        const container = createBookingDomQueryService().getDurationAndPlayersFilterContainer();
        if (container) {
            if (!container.nextSibling?.classList?.contains('bc-club-order-widget')) {
                injectClubOrderWidget();
            }
            createPreferenceAutoSelectService().autoSelectPlayersAndDuration();
        }
        tryToAutoSelectPickleball();
    }

    function createBookingFlowMonitor() {
        function createBookingFlowMonitorResourceRegistry() {
            const observersByKey = new Map();
            const intervalsByKey = new Map();

            function ensureObserver(key, createObserver, observeObserver) {
                if (observersByKey.has(key)) return;
                const observer = createObserver();
                observeObserver(observer);
                observersByKey.set(key, observer);
            }

            function clearObserver(key) {
                const observer = observersByKey.get(key);
                if (!observer) return;
                observer.disconnect();
                observersByKey.delete(key);
            }

            function ensureInterval(key, callback, delayMs) {
                if (intervalsByKey.has(key)) return;
                intervalsByKey.set(key, setInterval(callback, delayMs));
            }

            function clearIntervalByKey(key) {
                const timer = intervalsByKey.get(key);
                if (!timer) return;
                clearInterval(timer);
                intervalsByKey.delete(key);
            }

            return {
                ensureObserver,
                clearObserver,
                ensureInterval,
                clearIntervalByKey,
            };
        }

        const BOOKING_FLOW_CONTAINER_OBSERVER_KEY = 'booking-flow-container-observer';
        const BOOKING_FLOW_NAVIGATION_POLLER_KEY = 'booking-flow-navigation-poller';
        const BOOKING_FLOW_BOOTSTRAP_POLLER_KEY = 'booking-flow-bootstrap-poller';

        // Keep watcher lifecycle state private so we don't leak more script-level mutable state.
        // This monitor has two modes:
        // 1) Active booking mode: observers + fast URL pollers are on.
        // 2) Bootstrap mode: only a slow re-entry poller is on.
        // Why we need both: this Angular SPA often swaps what look like full screens without
        // reliable URL updates or consistently observable history events. In practice we may see
        // no pushState/replaceState/popstate for transitions that still require cleanup/re-init.
        // So we use event hooks first, plus polling as a reliability backstop.
        const bookingFlowMonitorResourceRegistry = createBookingFlowMonitorResourceRegistry();
        let lastObservedHref = location.href;
        let isMonitoringBookingFlow = false;
        let historyMonitoringInstalled = false;
        let visibilityMonitoringInstalled = false;
        let backToHomeClickMonitoringInstalled = false;
        let bookingDomTasksScheduled = false;

        function isOnBookingFlowUrl() {
            return location.href.includes('create-booking');
        }

        function scheduleBookingDomTasks() {
            if (bookingDomTasksScheduled) return;
            bookingDomTasksScheduled = true;
            // Mutation bursts are common in this SPA. Schedule one reconcile per frame to avoid
            // running the full DOM task pipeline on every individual mutation callback.
            requestAnimationFrame(() => {
                bookingDomTasksScheduled = false;
                if (!isMonitoringBookingFlow) return;
                runBookingDomTasks();
            });
        }

        // Handle both mobile and desktop back controls via one delegated capture listener.
        // This avoids scanning the whole DOM on mutations just to attach click handlers.
        function installBackToHomeClickMonitoring() {
            if (backToHomeClickMonitoringInstalled) return;
            backToHomeClickMonitoringInstalled = true;

            document.addEventListener('click', event => {
                const target = event.target;
                if (!createBookingDomQueryService().isBackControlClickTarget(target)) return;

                clearBookingStateAndUi();
            }, true);
        }

        // As a single page app, we get very few hints as to when the user has taken action that causes
        // what appears to the user as a screen update: the URL rarely changes, we see very few pushStates
        // or popStates, etc. We keep this observer active only while we're in the booking flow.
        function startContainerChangeObserver() {
            bookingFlowMonitorResourceRegistry.ensureObserver(
                BOOKING_FLOW_CONTAINER_OBSERVER_KEY,
                () => new MutationObserver(() => {
                    scheduleBookingDomTasks();
                }),
                observer => {
                    observer.observe(document.body, { childList: true, subtree: true });
                }
            );
        }

        function stopContainerChangeObserver() {
            bookingFlowMonitorResourceRegistry.clearObserver(BOOKING_FLOW_CONTAINER_OBSERVER_KEY);
        }

        function startNavigationPoller() {
            lastObservedHref = location.href;
            // Fast poll while inside booking flow. The UI can transition to/from booking sub-screens
            // without a dependable history signal, and sometimes without a visible URL change until
            // after Angular has already swapped DOM. This catches those transitions quickly.
            bookingFlowMonitorResourceRegistry.ensureInterval(
                BOOKING_FLOW_NAVIGATION_POLLER_KEY,
                () => {
                    if (location.href === lastObservedHref) return;
                    lastObservedHref = location.href;
                    evaluateBookingFlowMonitoringState();
                },
                200
            );
        }

        function stopNavigationPoller() {
            bookingFlowMonitorResourceRegistry.clearIntervalByKey(BOOKING_FLOW_NAVIGATION_POLLER_KEY);
        }

        function startBootstrapPoller() {
            // Slow poll outside booking flow to detect eventual re-entry while avoiding always-on
            // heavy observers/polling on unrelated app pages.
            bookingFlowMonitorResourceRegistry.ensureInterval(
                BOOKING_FLOW_BOOTSTRAP_POLLER_KEY,
                () => {
                    if (isOnBookingFlowUrl()) {
                        evaluateBookingFlowMonitoringState();
                    }
                },
                1000
            );
        }

        function stopBootstrapPoller() {
            bookingFlowMonitorResourceRegistry.clearIntervalByKey(BOOKING_FLOW_BOOTSTRAP_POLLER_KEY);
        }

        function startBookingFlowMonitoring() {
            if (isMonitoringBookingFlow) return;
            isMonitoringBookingFlow = true;
            stopBootstrapPoller();
            if (document.visibilityState === 'hidden') return;
            startContainerChangeObserver();
            startNavigationPoller();
            // Run once immediately so controls are auto-selected even before the next mutation tick.
            runBookingDomTasks();
        }

        function stopBookingFlowMonitoring() {
            if (!isMonitoringBookingFlow) return;
            isMonitoringBookingFlow = false;
            stopContainerChangeObserver();
            stopNavigationPoller();
            if (document.visibilityState !== 'hidden') {
                startBootstrapPoller();
            }
            bookingDomTasksScheduled = false;
        }

        function evaluateBookingFlowMonitoringState() {
            if (isOnBookingFlowUrl()) {
                startBookingFlowMonitoring();
                return;
            }
            // Only clear/stop when transitioning from active booking mode.
            if (!isMonitoringBookingFlow) return;
            clearBookingStateAndUi();
            stopBookingFlowMonitoring();
        }

        function installHistoryMonitoring() {
            if (historyMonitoringInstalled) return;
            historyMonitoringInstalled = true;

            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;

            // We intentionally leave these wrappers installed for the page lifetime.
            // Restoring and re-installing them around booking-flow transitions increases the chance of
            // missing slippery SPA transitions that do not emit consistent navigation signals.
            // The wrapper cost is low, and heavy work remains gated by monitor state.
            history.pushState = function (...args) {
                originalPushState.apply(this, args);
                evaluateBookingFlowMonitoringState();
            };

            history.replaceState = function (...args) {
                originalReplaceState.apply(this, args);
                evaluateBookingFlowMonitoringState();
            };

            window.addEventListener('popstate', evaluateBookingFlowMonitoringState);
        }

        // This SPA can navigate internally while a tab is backgrounded, and we do not need to spend
        // CPU tracking those transitions in real time while hidden. We pause all monitor activity on
        // hide, then perform an immediate state reconciliation on visibility return.
        function installVisibilityMonitoring() {
            if (visibilityMonitoringInstalled) return;
            visibilityMonitoringInstalled = true;

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    // Pause all monitoring work while the tab is hidden.
                    stopContainerChangeObserver();
                    stopNavigationPoller();
                    stopBootstrapPoller();
                    bookingDomTasksScheduled = false;
                    return;
                }

                // Resume immediately when visible so we do not miss latent SPA transitions.
                if (isMonitoringBookingFlow) {
                    // If we were actively monitoring booking flow before hiding, restore the active
                    // observers and poller first, then immediately reconcile to catch latent DOM changes.
                    startContainerChangeObserver();
                    startNavigationPoller();
                    evaluateBookingFlowMonitoringState();
                    if (isMonitoringBookingFlow) {
                        runBookingDomTasks();
                    }
                    return;
                }

                // If we were not in active booking mode, restart lightweight bootstrap detection and
                // evaluate immediately in case the app moved into booking flow while hidden.
                startBootstrapPoller();
                evaluateBookingFlowMonitoringState();
            });
        }

        function initialize() {
            // Start in lightweight mode and let state evaluation upgrade to active mode if needed.
            installHistoryMonitoring();
            installVisibilityMonitoring();
            installBackToHomeClickMonitoring();
            startBootstrapPoller();
            evaluateBookingFlowMonitoringState();
        }

        return {
            initialize,
        };
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
        const lastFetchState = createBookingStateService().getLastFetchState();
        if (!lastFetchState) return;

        document.querySelectorAll('app-court-select').forEach(el => {
            el.closest('.ng-star-inserted')
                ? el.closest('.ng-star-inserted').style.display = 'none'
                : el.style.display = 'none';
        });

        const hourViewBtn = createBookingDomQueryService().findHourViewButton();
        if (hourViewBtn && !hourViewBtn.classList.contains('btn-selected') && !hourViewBtn.dataset.bcAutoSelected) {
            hourViewBtn.dataset.bcAutoSelected = 'true';
            hourViewBtn.click();
        }

        const tile = createBookingDomQueryService().getDesktopTimeSlotHost();
        if (tile && !tile.querySelector('.all-clubs-availability')) {
            createAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, tile, lastFetchState.params.date);
        }

        const mobileContainer = createBookingDomQueryService().getMobileTimeSlotHost();
        if (mobileContainer && !mobileContainer.querySelector('.all-clubs-availability')) {
            createAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, mobileContainer, lastFetchState.params.date);
        }
    }

    // Fetch availability info for all the clubs in parallel, and combine their results.
    async function fetchAllClubs(params) {
        const signal = createBookingStateService().beginFetch();

        try {
            const settled = await Promise.all(Object.values(CLUBS).map(clubId => {
                const timeSlotId = CLUB_MAX_TIMESLOT[clubId] &&
                    params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : params.timeSlotId;
                return fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${params.date}&categoryCode=${params.categoryCode}&categoryOptionsId=${params.categoryOptionsId}&timeSlotId=${timeSlotId}`, {
                    signal,
                    headers: {
                        'Authorization': createBookingStateService().getCapturedHeader('Authorization'),
                        'X-SessionId': createBookingStateService().getCapturedHeader('X-SessionId'),
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    }
                }).then(async r => {
                    if (!r.ok) {
                        throw new Error(`HTTP ${r.status}`);
                    }
                    return { clubId, data: await r.json() };
                }).catch(error => {
                    if (error?.name === 'AbortError') throw error;
                    return { clubId, error };
                });
            }));

            const successfulResults = [];
            const failedClubIds = [];
            settled.forEach(result => {
                if (result.error) {
                    failedClubIds.push(result.clubId);
                    console.log(`[bc] failed to fetch availability for ${CLUB_SHORT_NAMES[result.clubId] || result.clubId}:`, result.error);
                } else {
                    successfulResults.push(result.data);
                }
            });

            createBookingStateService().setLastFetchState({ transformed: transformAvailability(successfulResults), params, failedClubIds });
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

    const createWeatherService = (() => {
        let serviceInstance = null;

        return function createWeatherService() {
            if (serviceInstance) return serviceInstance;
            // Cache of hourly datetime string (for example: '2024-01-15T07:00') -> { rainPct, code, cloudPct }.
            // This keeps weather mutable state private while preserving single-fetch-per-session behavior.
            const cache = {};
            const readyPromise = fetchWeatherForecast();

            async function fetchWeatherForecast() {
                const url = 'https://api.open-meteo.com/v1/forecast?latitude=37.5&longitude=-122.1&hourly=precipitation_probability,weathercode,cloudcover&timezone=America%2FLos_Angeles&forecast_days=16';
                try {
                    const response = await fetch(url);
                    const data = await response.json();
                    const times = data?.hourly?.time || [];
                    const probs = data?.hourly?.precipitation_probability || [];
                    const codes = data?.hourly?.weathercode || [];
                    const clouds = data?.hourly?.cloudcover || [];
                    times.forEach((time, i) => {
                        cache[time] = { rainPct: probs[i], code: codes[i], cloudPct: clouds[i] };
                    });
                } catch (_e) {
                    // Fail silently — weather is a hint, not critical.
                }
            }

            function buildHourKey(dateString, fromInMinutes) {
                const hour = Math.floor(fromInMinutes / 60);
                return `${dateString}T${String(hour).padStart(2, '0')}:00`;
            }

            function whenReady() {
                return readyPromise;
            }

            function emojiForHour(dateString, fromInMinutes) {
                const w = cache[buildHourKey(dateString, fromInMinutes)];
                if (!w) return null;
                const { rainPct, code, cloudPct } = w;

                // WMO weather codes: 0=clear, 1-3=partly cloudy, 45/48=fog,
                // 51-67=drizzle/rain, 71-77=snow, 80-82=showers, 95+=thunderstorm.
                if (code >= 95) return '⛈️';
                if (code >= 71 && code <= 77) return '🌨️';
                if (code >= 51 || rainPct > 50) return '🌧️';
                if (rainPct > 20) return '🌦️';
                if (cloudPct > 75) return '☁️';
                if (cloudPct > 30) return '⛅';
                return '☀️';
            }

            function rainPctForHour(dateString, fromInMinutes) {
                return cache[buildHourKey(dateString, fromInMinutes)]?.rainPct ?? null;
            }

            serviceInstance = {
                whenReady,
                emojiForHour,
                rainPctForHour,
            };
            return serviceInstance;
        };
    })();

    function createCardSelectionStyle() {
        // Set up a style for selected card appearance.
        const style = document.createElement('style');
        style.textContent = `
    .bc-court-option[data-selected] {
        background-color: rgba(255,255,255,0.2) !important;
        outline: 1px solid rgba(255,255,255,0.5) !important;
    }
    .bc-view-toggle .btn.btn-outline-dark-grey {
        color: #e5e5e5;
        border-color: #a6aaae;
        font-weight: 700;
        padding-left: 2rem;
        padding-right: 2rem;
    }
    .bc-view-toggle .btn.btn-outline-dark-grey.btn-selected {
        color: #fff;
        border-color: #2c9ab8;
        background-color: rgba(44, 154, 184, 0.25) !important;
        font-weight: 900;
    }
`;
        document.head.appendChild(style);
    }

    // Let's actually start our program! We'll keep watch on the DOM starting here.
    const bookingFlowMonitor = createBookingFlowMonitor();
    installXhrInterceptors();
    createCardSelectionStyle();
    bookingFlowMonitor.initialize();
})();
