/*jslint esversion: 11 */
// ==UserScript==
// @name         Bay Club Connect Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.76
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

    // #region Core constants and club metadata.
    // These are the UUIDs the app natively uses for each site.
    const CLUBS = {
        broadway: '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63',
        redwoodShores: '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18',
        southSF: 'ce7e7607-09e6-4d16-8197-1fffb70db776',
        santaClara: '3bc78448-ec6b-49e1-a2ae-64abd68e646b',
    };

    // These clubs have only indoor courts.
    const INDOOR_CLUBS = new Set([CLUBS.broadway, CLUBS.southSF]);

    // These are the UUIDs the app natively uses for time slot lengths.
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

    // Gated single courts are the most prized of all.
    const GATED_COURTS = {
        [CLUBS.santaClara]: ['Pickleball 1', 'Pickleball 6'],
    };

    // Some courts are adjacent to a hitting wall, so you can reserve the court, and also get access to the wall
    // to drill against.
    const HITTING_WALL_COURTS = {
        [CLUBS.santaClara]: ['Pickleball 9', 'Pickleball 10'],
    };
    // #endregion Core constants and club metadata.

    // #region Booking state and XHR interception.
    const getBookingStateService = (() => {
        let serviceInstance = null;

        return function getBookingStateService() {
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

    function installXhrInterceptors() {
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        const AVAILABILITY_API_PATH = 'court-booking/api/1.0/availability';
        const metadataByRequest = new WeakMap();
        let lastBookingRequestId = null;

        function getOrCreateRequestMetadata(xhr) {
            let metadata = metadataByRequest.get(xhr);
            if (!metadata) {
                metadata = {};
                metadataByRequest.set(xhr, metadata);
            }
            return metadata;
        }

        function setRequestId(xhr, requestId) {
            getOrCreateRequestMetadata(xhr).requestId = requestId;
        }

        function getRequestId(xhr) {
            return metadataByRequest.get(xhr)?.requestId;
        }

        function setRequestInfo(xhr, method, url) {
            const metadata = getOrCreateRequestMetadata(xhr);
            metadata.method = method;
            metadata.url = url;
        }

        function getRequestInfo(xhr) {
            const metadata = metadataByRequest.get(xhr);
            if (!metadata) return null;
            return { method: metadata.method, url: metadata.url };
        }

        function maybePatchAvailabilityResponseForAngular(xhr) {
            // We need Angular to think there is at least one available time slot for the native
            // app's default selected club so Angular will render that slot in the hour view.
            // Without that Angular rendered slot, we're not able to drive the Angular state
            // machine forward to issue a booking request after one of our slots is selected:
            // we fake a click on that slot, which allows the click on the Next button in the
            // hour view to issue the booking request and render the partner selector (we make
            // sure that the only booking requests that actually go out from the hour view are
            // our own). So we need to make sure the request for court availabilities for the home
            // club for a date always returns at least one slot. We do that here.
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (!xhr.responseText || xhr.responseText.trim() === '') return;
            try {
                const data = JSON.parse(xhr.responseText);
                if (!data.clubsAvailabilities) return;
                // We assume the first element here is the home club whose availability the native
                // Hour View is about to render. If Bay Club changes this to include multiple clubs
                // or to change the ordering, we will still inject at most one synthetic slot in
                // the first entry so we preserve the invariant that Angular has something clickable.
                const clubAvail = data.clubsAvailabilities[0];
                const slotCount = clubAvail?.availableTimeSlots?.length ?? 0;
                // If the club actually has availability for that date, we are good.
                if (slotCount > 0) return;
                // Make sure a real court is present so we can synthesize one fake slot.
                const court = clubAvail?.courts?.[0];
                if (!court) return;
                // Inject one synthetic slot so Angular can continue its booking flow.
                clubAvail.availableTimeSlots = [{ timeOfDay: 'Morning', fromInMinutes: 420, toInMinutes: 450, courtId: court.courtId, courtsVersionsIds: [court.courtSetupVersionId || court.courtId] }];
                Object.defineProperty(xhr, 'response', { get: () => JSON.stringify(data), configurable: true });
                Object.defineProperty(xhr, 'responseText', { get: () => JSON.stringify(data), configurable: true });
            } catch (e) {
                console.log('[bc] error:', e);
            }
        }

        function fetchAvailabilityAcrossAllClubsForRequestUrl(requestUrl) {
            if (!requestUrl || !requestUrl.includes(AVAILABILITY_API_PATH)) return;
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

        function maybeRewriteBookingRequestToPendingSelection(xhr, requestUrl, requestMethod, originalArgs) {
            // Intercept the native app's booking request and replace it with our own
            // for the selected club and time slot.
            if (!requestUrl ||
                !requestUrl.match(/courtbookings$/) ||
                requestMethod !== 'POST' ||
                !getBookingStateService().getPendingSlotBooking()) {
                return { handled: false };
            }

            const pendingSlotBooking = getBookingStateService().getPendingSlotBooking();
            const lastFetchState = getBookingStateService().getLastFetchState();
            if (!pendingSlotBooking || !lastFetchState) {
                return { handled: true, value: originalXhrSend.apply(xhr, originalArgs) };
            }

            // Dedupe any requests, just in case.
            const requestId = getRequestId(xhr);
            if (requestId && requestId === lastBookingRequestId) {
                return { handled: true, value: undefined };
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
            getBookingStateService().clearPendingSlotBooking();
            return { handled: true, value: originalXhrSend.call(xhr, ourBody) };
        }

        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            // Capture these so we can authenticate our own requests to the Bay Club's APIs.
            if (name === 'Authorization' || name === 'X-SessionId') {
                getBookingStateService().captureHeader(name, value);
            }
            if (name === 'Request-Id') {
                setRequestId(this, value);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };

        // Extracts a refresh token from an auth endpoint response and forwards it to
        // the Worker's KV store via pushRefreshToken(). The userId (email) is read
        // from the cached bc_notification_email key so the Worker stores the token
        // under the per-user key rather than overwriting a shared global token.
        // If the email is not yet cached (e.g. very first login), the push is skipped;
        // syncRefreshTokenFromAppStorage() on the next page load will catch it.
        function maybePushRefreshTokenToWorker(xhr) {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (!xhr.responseText) return;
            try {
                const data = JSON.parse(xhr.responseText);
                if (data && data.refresh_token) {
                    const userId = getLocalStorageService().getString('bc_notification_email');
                    if (userId) {
                        getScheduledBookingService().pushRefreshToken(data.refresh_token, userId);
                    }
                }
            } catch (_e) {
                // Not parseable; skip.
            }
        }

        function maybeCachePossiblePlayersResponse(xhr) {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (!xhr.responseText) return;
            try {
                const players = JSON.parse(xhr.responseText);
                if (Array.isArray(players) && players.length > 0 && players[0].personId) {
                    getScheduledBookingService().cachePlayersFromXhr(players);
                    getDebugService().log('info', 'cached-possible-players-from-xhr', { count: players.length });
                }
            } catch (_e) {
                // Not parseable; skip caching.
            }
        }

        function maybeCachePlayerPhotosResponse(xhr) {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (!xhr.responseText) return;
            try {
                const data = JSON.parse(xhr.responseText);
                if (data && data.memberPhotos && typeof data.memberPhotos === 'object') {
                    getScheduledBookingService().cachePhotosFromXhr(data.memberPhotos);
                    getDebugService().log('info', 'cached-player-photos-from-xhr', { count: Object.keys(data.memberPhotos).length });
                }
            } catch (_e) {
                // Not parseable; skip caching.
            }
        }

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string' && url.includes(AVAILABILITY_API_PATH)) {
                this.addEventListener('load', function () {
                    maybePatchAvailabilityResponseForAngular(this);
                });
            }
            if (typeof url === 'string' && url.includes('possiblePlayers')) {
                this.addEventListener('load', function () {
                    maybeCachePossiblePlayersResponse(this);
                });
            }
            if (typeof url === 'string' && url.includes('photos/members')) {
                this.addEventListener('load', function () {
                    maybeCachePlayerPhotosResponse(this);
                });
            }
            if (typeof url === 'string' && url.includes('authentication2-api.bayclubs.io/connect/token')) {
                this.addEventListener('load', function () {
                    maybePushRefreshTokenToWorker(this);
                });
            }
            setRequestInfo(this, method, url);
            return originalXhrOpen.apply(this, [method, url, ...rest]);
        };

        // Intercept fetch()-based token calls (the Bay Club app uses fetch rather than
        // XHR for authentication). Any refresh_token in the response is forwarded to
        // the Worker's KV via maybePushRefreshTokenToWorker(). We clone the response
        // before consuming it so the app's own handlers receive the original unread body.
        const originalFetch = window.fetch;
        window.fetch = function (input, _init) {
            const urlStr = typeof input === 'string' ? input : (input?.url || '');
            const promise = originalFetch.apply(this, arguments);
            if (urlStr.includes('authentication2-api.bayclubs.io/connect/token')) {
                promise.then(function (response) {
                    response.clone().json().then(function (data) {
                        if (data && data.refresh_token) {
                            maybePushRefreshTokenToWorker({ status: 200, responseText: JSON.stringify(data) });
                        }
                    }).catch(function () { });
                }).catch(function () { });
            }
            return promise;
        };

        XMLHttpRequest.prototype.send = function (_body) {
            // Detect the native app's native request for court availability and use it to add our own
            // for data we actually want based on what our user selected for duration across
            // all clubs.
            const requestInfo = getRequestInfo(this);
            const requestUrl = requestInfo?.url;
            const requestMethod = requestInfo?.method;

            fetchAvailabilityAcrossAllClubsForRequestUrl(requestUrl);

            const rewrittenSendResult = maybeRewriteBookingRequestToPendingSelection(this, requestUrl, requestMethod, arguments);
            if (rewrittenSendResult.handled) return rewrittenSendResult.value;

            return originalXhrSend.apply(this, arguments);
        };
    }
    // #endregion Booking state and XHR interception.

    // #region Core time and availability transformations.
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
                                // The server adds a trailing space to "Pickleball 1" for Santa Clara
                                // and only for that court. This appears to be a server-side bug, so
                                // we trim here defensively.
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
    // #endregion Core time and availability transformations.

    // #region DOM query and localStorage services.
    const getBookingDomQueryService = (() => {
        let serviceInstance = null;

        return function getBookingDomQueryService() {
            if (serviceInstance) return serviceInstance;

            const DURATION_AND_PLAYERS_FILTER_SELECTOR = 'app-racquet-sports-filter div.row.row-cols-auto';
            const HOUR_VIEW_BUTTON_SELECTOR = 'app-time-slot-view-type-select .btn';
            const BOOKING_PAGE_TITLE_SELECTOR = 'app-page-title';
            const BACK_ICON_SELECTOR = 'img[src="assets/back.svg"]';
            const BACK_TEXT_SELECTOR = 'span.clickable.font-weight-bold.text-uppercase';
            const DESKTOP_TIME_SLOT_HOST_SELECTOR = '.item-tile';
            const MOBILE_TIME_SLOT_HOST_SELECTOR = '.d-md-none.px-3';
            const TIME_SLOT_HOSTS_SELECTOR = `${DESKTOP_TIME_SLOT_HOST_SELECTOR}, ${MOBILE_TIME_SLOT_HOST_SELECTOR}`;
            const NATIVE_TIME_SLOT_ITEM_SELECTOR = 'app-court-time-slot-item';
            const NATIVE_HIDDEN_ATTR = 'data-bc-native-hidden';

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

            function getTimeSlotHosts() {
                // Prefer hosts that actually contain native time slot rows to avoid matching
                // unrelated .item-tile containers (for example, date tiles in mobile layouts).
                const hosts = [];
                const seen = new Set();
                document.querySelectorAll(NATIVE_TIME_SLOT_ITEM_SELECTOR).forEach(slotItem => {
                    const host = slotItem.closest(TIME_SLOT_HOSTS_SELECTOR);
                    if (!host || seen.has(host)) return;
                    seen.add(host);
                    hosts.push(host);
                });

                if (hosts.length > 0) return hosts;

                // Fallback for transitional DOM states where slot rows are not yet rendered.
                return Array.from(document.querySelectorAll(TIME_SLOT_HOSTS_SELECTOR));
            }

            function hasTimeSlotHostsVisible() {
                return getTimeSlotHosts().length > 0;
            }

            function getDesktopTimeSlotHost() {
                return getTimeSlotHosts()
                    .find(host => !host.matches(MOBILE_TIME_SLOT_HOST_SELECTOR)) || null;
            }

            function getMobileTimeSlotHost() {
                return getTimeSlotHosts()
                    .find(host => host.matches(MOBILE_TIME_SLOT_HOST_SELECTOR)) || null;
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
                getTimeSlotHosts,
                NATIVE_HIDDEN_ATTR,
                isBackControlClickTarget,
            };
            return serviceInstance;
        };
    })();

    const getLocalStorageService = (() => {
        let serviceInstance = null;

        return function getLocalStorageService() {
            if (serviceInstance) return serviceInstance;

            function getString(key) {
                try {
                    return localStorage.getItem(key);
                } catch (error) {
                    console.log(`[bc] localStorage read failed for key "${key}":`, error);
                    return null;
                }
            }

            function setString(key, value) {
                try {
                    localStorage.setItem(key, value);
                } catch (error) {
                    console.log(`[bc] localStorage write failed for key "${key}":`, error);
                }
            }

            function getJson(key, parseErrorLogMessage) {
                const raw = getString(key);
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
                setString(key, JSON.stringify(value));
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
    // #endregion DOM query and localStorage services.

    // #region Preference sync service.

    // Syncs the six user-configurable preferences to the Cloudflare Worker KV so
    // they follow the user across devices and browsers. On page load the service
    // pulls the stored prefs and writes them to localStorage (server wins). After
    // any preference change it debounces for 800 ms then pushes all six keys.
    const getPreferenceSyncService = (() => {
        let serviceInstance = null;

        return function getPreferenceSyncService() {
            if (serviceInstance) return serviceInstance;

            const WORKER_URL = 'https://bayclubconnect-bookings.mark-rubin.workers.dev';
            const WORKER_SECRET = '724468735aec045b6ec464fce6dce1133142bb3a8fcc2cfd68dc0abdebbd0c3d';
            const PREF_KEYS = [
                'bc_club_order', 'bc_view_mode', 'bc_indoor_only',
                'bc_time_range', 'bc_players', 'bc_duration',
            ];

            let debounceTimer = null;

            function getUserId() {
                return getLocalStorageService().getString('bc_notification_email');
            }

            function readAllPrefsFromLocalStorage() {
                const prefs = {};
                PREF_KEYS.forEach(function (key) {
                    const val = getLocalStorageService().getString(key);
                    if (val !== null) prefs[key] = val;
                });
                return prefs;
            }

            function applyPrefsToLocalStorage(prefs) {
                PREF_KEYS.forEach(function (key) {
                    if (prefs[key] !== undefined && prefs[key] !== null) {
                        getLocalStorageService().setString(key, prefs[key]);
                    }
                });
            }

            async function pushToWorker() {
                const userId = getUserId();
                if (!userId) return;
                const prefs = readAllPrefsFromLocalStorage();
                try {
                    await fetch(`${WORKER_URL}/prefs`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': WORKER_SECRET },
                        body: JSON.stringify({ userId, prefs }),
                    });
                } catch (e) {
                    getDebugService().log('warn', 'prefs-push-failed', { error: e.message });
                }
            }

            async function pullFromWorker() {
                const userId = getUserId();
                if (!userId) return;
                try {
                    const response = await fetch(`${WORKER_URL}/prefs`, {
                        headers: { 'X-Worker-Secret': WORKER_SECRET, 'X-User-Id': userId },
                    });
                    if (!response.ok) return;
                    const prefs = await response.json();
                    if (prefs && typeof prefs === 'object') {
                        applyPrefsToLocalStorage(prefs);
                    }
                } catch (e) {
                    getDebugService().log('warn', 'prefs-pull-failed', { error: e.message });
                }
            }

            // Schedules a push after 800 ms, cancelling any pending push. This
            // collapses rapid successive changes (e.g. slider drags) into one call.
            function notifyPreferenceChanged() {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(pushToWorker, 800);
            }

            async function initializeOnPageLoad() {
                await pullFromWorker();
            }

            serviceInstance = { notifyPreferenceChanged, initializeOnPageLoad };
            return serviceInstance;
        };
    })();

    // #endregion Preference sync service.

    // #region Debug mode service, panel, and activation.
    // These constants identify where a debug panel instance is rendered.
    // They let us target cleanup and binding behavior without fragile selectors.
    const DEBUG_PANEL_SURFACE_AVAILABILITY = 'availability';
    const DEBUG_PANEL_SURFACE_DURATION = 'duration';
    const DEBUG_PANEL_SURFACE_ON_ERROR = 'on_error';

    const getDebugService = (() => {
        let serviceInstance = null;

        return function getDebugService() {
            if (serviceInstance) return serviceInstance;

            const DEBUG_ENABLED_KEY = 'bc_debug_enabled';
            const DEBUG_ENTRIES_KEY = 'bc_debug_entries';
            const MAX_DEBUG_ENTRIES = 600;
            let debugEnabled = getLocalStorageService().getString(DEBUG_ENABLED_KEY) === '1';
            let logEntries = getLocalStorageService().getJson(DEBUG_ENTRIES_KEY, '[bc] failed to parse stored debug log JSON');
            if (!Array.isArray(logEntries)) {
                logEntries = [];
            }

            function persistDebugEnabled() {
                getLocalStorageService().setString(DEBUG_ENABLED_KEY, debugEnabled ? '1' : '0');
            }

            function persistLogEntries() {
                getLocalStorageService().setJson(DEBUG_ENTRIES_KEY, logEntries);
            }

            function sanitizePayload(payload, depth = 0) {
                if (payload == null || typeof payload !== 'object') return payload;
                if (depth > 3) return '[Max depth]';
                if (Array.isArray(payload)) {
                    return payload.map(item => sanitizePayload(item, depth + 1));
                }

                const SENSITIVE_KEY_PATTERNS = [
                    'authorization',
                    'auth',
                    'session',
                    'token',
                    'request-id',
                    'requestid',
                    'cookie',
                    'secret',
                    'apikey',
                    'api-key',
                ];
                const output = {};
                for (const [key, value] of Object.entries(payload)) {
                    const normalizedKey = key.toLowerCase().replace(/[_\s]/g, '').replace(/-/g, '');
                    const isSensitive = SENSITIVE_KEY_PATTERNS.some(pattern => {
                        const normalizedPattern = pattern.replace(/[_\s-]/g, '');
                        return normalizedKey.includes(normalizedPattern);
                    });
                    if (isSensitive) {
                        output[key] = '[REDACTED]';
                    } else {
                        output[key] = sanitizePayload(value, depth + 1);
                    }
                }
                return output;
            }

            function appendLogEntry(level, eventName, payload) {
                const entry = {
                    timestamp: new Date().toISOString(),
                    level,
                    eventName,
                    payload: sanitizePayload(payload),
                };

                logEntries.push(entry);
                if (logEntries.length > MAX_DEBUG_ENTRIES) {
                    logEntries = logEntries.slice(logEntries.length - MAX_DEBUG_ENTRIES);
                }
                persistLogEntries();
            }

            function setEnabled(nextValue) {
                debugEnabled = !!nextValue;
                persistDebugEnabled();
                appendLogEntry('info', 'debug-mode-changed', { enabled: debugEnabled });
            }

            function isEnabled() {
                return debugEnabled;
            }

            function log(level, eventName, payload = null) {
                if (!debugEnabled) return;
                appendLogEntry(level, eventName, payload);
                console.log(`[bc-debug:${level}] ${eventName}`, sanitizePayload(payload));
            }

            function getEntries() {
                return [...logEntries];
            }

            function clearEntries() {
                logEntries = [];
                persistLogEntries();
                if (debugEnabled) {
                    appendLogEntry('info', 'debug-log-cleared', null);
                }
            }

            function buildLogsText() {
                return logEntries.map(entry => {
                    const payloadText = entry.payload == null
                        ? ''
                        : ` ${JSON.stringify(entry.payload)}`;
                    return `${entry.timestamp} [${entry.level}] ${entry.eventName}${payloadText}`;
                }).join('\n');
            }

            function buildSupportPacketText() {
                const lines = [
                    'Bay Club helper debug report',
                    `Generated: ${new Date().toISOString()}`,
                    `Path: ${location.pathname}`,
                    `Href: ${location.href}`,
                    `User agent: ${navigator.userAgent}`,
                    `Log entry count: ${logEntries.length}`,
                    '',
                    'Logs:',
                    buildLogsText(),
                ];
                return lines.join('\n');
            }

            async function copyLogsToClipboard() {
                const text = buildSupportPacketText();
                if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                    throw new Error('Clipboard API unavailable');
                }
                await navigator.clipboard.writeText(text);
                log('info', 'debug-log-copied-to-clipboard', { lineCount: logEntries.length });
            }

            function downloadLogsFile() {
                const text = buildSupportPacketText();
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                const timestamp = new Date().toISOString().replaceAll(':', '-');
                anchor.href = url;
                anchor.download = `bc-debug-${timestamp}.log`;
                document.body.appendChild(anchor);
                anchor.click();
                document.body.removeChild(anchor);
                URL.revokeObjectURL(url);
                log('info', 'debug-log-downloaded', { lineCount: logEntries.length });
            }

            function openEmailDraftWithLogs() {
                const subject = `Bay Club helper debug logs ${new Date().toISOString().slice(0, 10)}`;
                const fullBody = buildSupportPacketText();
                const MAX_EMAIL_BODY_CHARS = 6000;
                const truncatedBody = fullBody.length > MAX_EMAIL_BODY_CHARS
                    ? `${fullBody.slice(0, MAX_EMAIL_BODY_CHARS)}\n\n[Truncated due to mailto length. Use Download logs for full report.]`
                    : fullBody;
                const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(truncatedBody)}`;
                const opened = window.open(mailtoUrl, '_blank', 'noopener');
                if (!opened) {
                    window.location.href = mailtoUrl;
                }
                log('info', 'debug-email-draft-opened', {
                    lineCount: logEntries.length,
                    truncated: fullBody.length > MAX_EMAIL_BODY_CHARS,
                });
            }

            serviceInstance = {
                setEnabled,
                isEnabled,
                log,
                getEntries,
                clearEntries,
                copyLogsToClipboard,
                openEmailDraftWithLogs,
                downloadLogsFile,
            };
            return serviceInstance;
        };
    })();

    const createDashboardDebugActivationMonitor = (() => {
        let alreadyInitialized = false;

        return function createDashboardDebugActivationMonitor() {
            if (alreadyInitialized) return;
            alreadyInitialized = true;

            // Use a hidden activation gesture that does not depend on page-specific navigation timing.
            // Users can tap the top-left corner five times within a short window on any app page
            // to enable debug mode.
            const CORNER_TAP_REQUIRED_COUNT = 5;
            const CORNER_TAP_WINDOW_MS = 4000;
            const CORNER_HITBOX_SIZE_PX = 72;
            let cornerTapCount = 0;
            let cornerTapWindowTimer = null;

            function resetCornerTapState() {
                cornerTapCount = 0;
                if (cornerTapWindowTimer) {
                    clearTimeout(cornerTapWindowTimer);
                    cornerTapWindowTimer = null;
                }
            }

            function activateDebugMode(source) {
                if (getDebugService().isEnabled()) {
                    getDebugService().log('info', 'debug-mode-activation-ignored-already-enabled', {
                        source,
                        path: location.pathname,
                    });
                    return;
                }
                getDebugService().setEnabled(true);
                getDebugService().log('info', 'debug-mode-activated', {
                    source,
                    path: location.pathname,
                });
                window.alert('Bay Club helper debug mode is now enabled. Continue into Court Booking to use the debug panel.');
            }

            document.addEventListener('pointerdown', event => {
                if (event.clientX > CORNER_HITBOX_SIZE_PX || event.clientY > CORNER_HITBOX_SIZE_PX) return;

                if (cornerTapCount === 0) {
                    cornerTapWindowTimer = setTimeout(() => {
                        resetCornerTapState();
                    }, CORNER_TAP_WINDOW_MS);
                }

                cornerTapCount += 1;
                if (cornerTapCount < CORNER_TAP_REQUIRED_COUNT) return;

                resetCornerTapState();
                activateDebugMode('corner-tap');
            }, true);

            // Provide a desktop-friendly fallback: type DEBUG on any app page.
            const KEYBOARD_SEQUENCE = 'debug';
            const KEYBOARD_SEQUENCE_WINDOW_MS = 5000;
            let recentKeys = '';
            let keyboardWindowTimer = null;

            function resetKeyboardSequence() {
                recentKeys = '';
                if (keyboardWindowTimer) {
                    clearTimeout(keyboardWindowTimer);
                    keyboardWindowTimer = null;
                }
            }

            document.addEventListener('keydown', event => {
                const key = event.key?.toLowerCase();
                if (!key || key.length !== 1 || !/[a-z]/.test(key)) return;
                if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;

                if (!keyboardWindowTimer) {
                    keyboardWindowTimer = setTimeout(() => {
                        resetKeyboardSequence();
                    }, KEYBOARD_SEQUENCE_WINDOW_MS);
                }

                recentKeys = (recentKeys + key).slice(-KEYBOARD_SEQUENCE.length);
                if (recentKeys !== KEYBOARD_SEQUENCE) return;

                resetKeyboardSequence();
                activateDebugMode('keyboard-sequence');
            }, true);
        };
    })();

    function buildDebugPanelHtml(surface = DEBUG_PANEL_SURFACE_AVAILABILITY) {
        if (!getDebugService().isEnabled()) return '';

        return `
    <div class="bc-debug-panel" data-bc-debug-surface="${surface}" style="margin: 0 8px 16px; padding: 10px 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.2); color: rgba(255,255,255,0.92); font-size: 12px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
            <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="checkbox" class="bc-debug-enabled" checked style="width: 14px; height: 14px; cursor: pointer;">
                Debug mode
            </label>
            <span class="bc-debug-count" style="opacity: 0.8;">${getDebugService().getEntries().length} log entries</span>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-outline-dark-grey size-10 py-2 bc-debug-action bc-debug-copy">Copy logs</button>
            <button type="button" class="btn btn-outline-dark-grey size-10 py-2 bc-debug-action bc-debug-email">Email logs</button>
            <button type="button" class="btn btn-outline-dark-grey size-10 py-2 bc-debug-action bc-debug-download">Download logs</button>
            <button type="button" class="btn btn-outline-dark-grey size-10 py-2 bc-debug-action bc-debug-clear">Clear logs</button>
        </div>
    </div>`;
    }

    function refreshAllDebugPanelEntryCounts() {
        // Keep all visible debug panels in sync when logs are added, cleared, or exported.
        document.querySelectorAll('.bc-debug-panel .bc-debug-count').forEach(countElement => {
            countElement.textContent = `${getDebugService().getEntries().length} log entries`;
        });
    }

    function bindDebugPanelControls(rootElement) {
        // Multiple panel instances can exist across booking steps, so bind once per panel.
        rootElement.querySelectorAll('.bc-debug-panel').forEach(panel => {
            if (panel.dataset.bcDebugBound) return;
            panel.dataset.bcDebugBound = 'true';

            const enabledCheckbox = panel.querySelector('.bc-debug-enabled');
            if (enabledCheckbox) {
                enabledCheckbox.addEventListener('change', () => {
                    getDebugService().setEnabled(enabledCheckbox.checked);
                    if (!enabledCheckbox.checked) {
                        // Remove every instance immediately so the UI always reflects debug state.
                        document.querySelectorAll('.bc-debug-panel').forEach(el => el.remove());
                    }
                });
            }

            const copyButton = panel.querySelector('.bc-debug-copy');
            if (copyButton) {
                copyButton.addEventListener('click', async () => {
                    try {
                        await getDebugService().copyLogsToClipboard();
                        refreshAllDebugPanelEntryCounts();
                        copyButton.blur();
                    } catch (error) {
                        getDebugService().log('error', 'debug-log-copy-failed', { message: error?.message || String(error) });
                        console.log('[bc] failed to copy debug logs:', error);
                    }
                });
            }

            const emailButton = panel.querySelector('.bc-debug-email');
            if (emailButton) {
                emailButton.addEventListener('click', () => {
                    getDebugService().openEmailDraftWithLogs();
                    refreshAllDebugPanelEntryCounts();
                    emailButton.blur();
                });
            }

            const downloadButton = panel.querySelector('.bc-debug-download');
            if (downloadButton) {
                downloadButton.addEventListener('click', () => {
                    getDebugService().downloadLogsFile();
                    refreshAllDebugPanelEntryCounts();
                    downloadButton.blur();
                });
            }

            const clearButton = panel.querySelector('.bc-debug-clear');
            if (clearButton) {
                clearButton.addEventListener('click', () => {
                    getDebugService().clearEntries();
                    refreshAllDebugPanelEntryCounts();
                    clearButton.blur();
                });
            }
        });
    }

    function injectDurationFlowDebugPanel(durationFilterContainer) {
        if (!getDebugService().isEnabled()) return;

        // Prefer rendering after the club-order widget when present so helper controls stay grouped.
        const anchor = durationFilterContainer.nextSibling?.classList?.contains('bc-club-order-widget')
            ? durationFilterContainer.nextSibling
            : durationFilterContainer;

        const existingPanels = Array.from(document.querySelectorAll(`.bc-debug-panel[data-bc-debug-surface="${DEBUG_PANEL_SURFACE_DURATION}"]`));
        const anchoredPanel = anchor.nextElementSibling?.matches?.(`.bc-debug-panel[data-bc-debug-surface="${DEBUG_PANEL_SURFACE_DURATION}"]`)
            ? anchor.nextElementSibling
            : null;

        // Keep exactly one duration-surface panel attached to the current anchor.
        // Recreating this panel on every mutation can race with user interaction.
        existingPanels.forEach(panel => {
            if (panel !== anchoredPanel) panel.remove();
        });

        if (!anchoredPanel) {
            anchor.insertAdjacentHTML('afterend', buildDebugPanelHtml(DEBUG_PANEL_SURFACE_DURATION));
        }

        bindDebugPanelControls(document);
        refreshAllDebugPanelEntryCounts();
    }

    function showHelperFailureBannerAndRestoreNative(reasonCode, message, extraPayload) {
        // Avoid duplicating the fallback banner if multiple error paths trigger in quick succession.
        if (document.querySelector('.bc-helper-fallback-warning')) return;

        removeOurContentAndUnhideNativeContent();

        let debugJustEnabled = false;
        if (!getDebugService().isEnabled()) {
            debugJustEnabled = true;
            getDebugService().setEnabled(true);
        }

        getDebugService().log('error', 'helper-fallback-activated', {
            reasonCode,
            debugJustEnabled,
            path: location.pathname,
            href: location.href,
            ...extraPayload,
        });

        const bookingDomQueryService = getBookingDomQueryService();
        const hosts = bookingDomQueryService.getTimeSlotHosts();
        const host = hosts && hosts.length > 0 ? hosts[0] : null;
        const banner = document.createElement('div');
        banner.className = 'bc-helper-fallback-warning';
        banner.innerHTML = `
    <div style="margin: 8px 0 16px; padding: 10px 12px; border-radius: 4px; border: 1px solid rgba(255,180,120,0.9); background: rgba(255,140,0,0.15); color: rgba(255,240,220,0.96); font-size: 12px;">
        <div style="font-weight: 600; margin-bottom: 6px;">Bay Club helper is temporarily using the native court picker.</div>
        <div style="margin-bottom: 6px;">${message}</div>
        <div style="margin-bottom: 8px;">We have enabled debug logging so that you can send diagnostics if this keeps happening. You can copy, email, or download logs using the controls below.</div>
        ${buildDebugPanelHtml(DEBUG_PANEL_SURFACE_ON_ERROR)}
    </div>`;

        if (host && host.parentElement) {
            host.parentElement.insertBefore(banner, host);
        } else {
            document.body.insertBefore(banner, document.body.firstChild);
        }

        bindDebugPanelControls(banner);
        refreshAllDebugPanelEntryCounts();
    }
    // #endregion Debug mode service, panel, and activation.

    // #region Scheduled bookings service.
    const getScheduledBookingService = (() => {
        let serviceInstance = null;

        return function getScheduledBookingService() {
            if (serviceInstance) return serviceInstance;

            const SCHEDULED_BOOKING_ADVANCE_DAYS = 3;
            const POSSIBLE_PLAYERS_KEY = 'bc_possible_players';
            const PLAYER_PHOTOS_KEY = 'bc_player_photos';
            const NOTIFICATION_EMAIL_KEY = 'bc_notification_email';
            const SELF_PROFILE_KEY = 'bc_self_profile';
            const PHOTOS_API_BASE = 'https://connect-api.bayclubs.io/checkin/api/1.0';
            const PHOTO_CDN_BASE = 'https://photomanagement-cdn.bayclubs.io/api/1.0/pub/photos';
            const SUBSCRIPTION_KEY = 'bac44a2d04b04413b6aea6d4e3aad294';

            const WORKER_URL = 'https://bayclubconnect-bookings.mark-rubin.workers.dev';
            const WORKER_SECRET = '724468735aec045b6ec464fce6dce1133142bb3a8fcc2cfd68dc0abdebbd0c3d';

            const SCHEDULED_STATUS_PENDING = 'pending';
            const SCHEDULED_STATUS_FIRING = 'firing';
            const SCHEDULED_STATUS_FAILED = 'failed';

            // Enum values for whether a locked slot was taken by a premium
            // member during their 4-day advance window. Exposed on serviceInstance
            // so the bookings page UI can reference them without coupling to the
            // service's internal constants.
            const SLOT_CHECK_STATUS = Object.freeze({
                UNKNOWN: 'unknown',
                AVAILABLE: 'available',
                TAKEN: 'taken',
            });

            // Local cache of bookings fetched from the Worker. Reads use this
            // synchronously; writes update it optimistically then call the Worker.
            let cachedBookings = [];

            // Returns the authentication header required on all write endpoints of the
            // Cloudflare Worker. The secret is shared between the extension and the Worker
            // via the WORKER_SECRET environment variable set with wrangler secret put.
            function workerHeaders() {
                return { 'X-Worker-Secret': WORKER_SECRET };
            }

            // Persistence helpers.

            function loadAll() {
                return cachedBookings;
            }

            // Fetches all bookings from the Worker and refreshes the local cache.
            // After updating the cache, nudges the MutationObserver so the /bookings
            // page reconciliation loop re-runs with the fresh data immediately.
            async function fetchAllFromWorker() {
                try {
                    const response = await fetch(`${WORKER_URL}/bookings`, { headers: workerHeaders() });
                    if (!response.ok) {
                        getDebugService().log('warn', 'worker-get-bookings-failed', { status: response.status });
                        return;
                    }
                    cachedBookings = await response.json();
                    // Dispatch a CustomEvent so the bookings-page reconciliation loop
                    // picks up the updated cache immediately. Also nudge the
                    // MutationObserver via a transient DOM element as a belt-and-suspenders
                    // backup, since some mobile browsers may not fire the observer for
                    // an append+remove that resolves before the next microtask checkpoint.
                    document.dispatchEvent(new CustomEvent('bc-bookings-updated'));
                    if (document.body) {
                        const trigger = document.createElement('span');
                        trigger.setAttribute('data-bc-worker-sync', '');
                        document.body.appendChild(trigger);
                        trigger.remove();
                    }
                } catch (e) {
                    getDebugService().log('warn', 'worker-get-bookings-error', { error: e.message });
                }
            }

            // Returns bookings that have not yet fired (awaiting the cron tick).
            function getPendingBookings() {
                return loadAll().filter(b => b.status === SCHEDULED_STATUS_PENDING);
            }

            // Returns bookings the Worker should still be monitoring — both those waiting
            // to fire (pending) and those currently being executed by the cron (firing).
            // Used to decide whether the pending section needs to be shown.
            function getActiveBookings() {
                return loadAll().filter(b => b.status === SCHEDULED_STATUS_PENDING || b.status === SCHEDULED_STATUS_FIRING);
            }

            // Returns bookings the Worker could not complete. Shown in the pending section
            // with a Dismiss button so the user can acknowledge and clear them.
            function getFailedBookings() {
                return loadAll().filter(b => b.status === SCHEDULED_STATUS_FAILED);
            }

            // Removes a failed booking from the local cache and deletes it from the
            // Worker's KV store. Used when the user dismisses a failed booking row.
            function dismissBooking(id) {
                cachedBookings = cachedBookings.filter(b => b.id !== id);
                fetch(`${WORKER_URL}/bookings/${id}`, {
                    method: 'DELETE',
                    headers: workerHeaders(),
                }).catch(e => getDebugService().log('warn', 'worker-delete-booking-failed', { error: e.message }));
                getDebugService().log('info', 'scheduled-booking-dismissed', { id });
            }

            // Auth headers for scheduled booking API calls.

            function buildAuthHeaders() {
                const auth = getBookingStateService().getCapturedHeader('Authorization');
                const session = getBookingStateService().getCapturedHeader('X-SessionId');
                if (!auth || !session) return null;
                return {
                    'Authorization': auth,
                    'X-SessionId': session,
                    'Request-Id': crypto.randomUUID(),
                    'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                };
            }

            // Partner list: cache-first. XHR interception populates the cache during normal
            // booking flows. On cache miss, fetches household members and buddy list directly
            // (no courtBookingId needed) and merges them into a unified player list.

            async function fetchPossiblePlayers() {
                const players = getLocalStorageService().getJson(POSSIBLE_PLAYERS_KEY, '[bc] failed to parse cached players');
                const photosByMemberId = getLocalStorageService().getJson(PLAYER_PHOTOS_KEY, '[bc] failed to parse cached player photos') || {};
                if (players && Array.isArray(players) && players.length > 0) {
                    return { players, photosByMemberId };
                }

                getDebugService().log('info', 'fetch-possible-players-cache-miss-fetching-api');
                const headers = buildAuthHeaders();
                if (!headers) {
                    throw new Error('Session not ready — please interact with the page first to load partner list.');
                }

                const getHeaders = Object.assign({}, headers);
                delete getHeaders['Content-Type'];

                const [householdResp, buddyResp] = await Promise.all([
                    fetch('https://connect-api.bayclubs.io/profile/api/1.0/profile/household', { headers: getHeaders }),
                    fetch('https://connect-api.bayclubs.io/buddy-list/api/1.0/buddylist', { headers: getHeaders }),
                ]);

                if (!householdResp.ok) throw new Error(`Household fetch failed (${householdResp.status}).`);
                if (!buddyResp.ok) throw new Error(`Buddy list fetch failed (${buddyResp.status}).`);

                const [householdData, buddyData] = await Promise.all([householdResp.json(), buddyResp.json()]);

                // Merge household addOns (Active) and buddy list items (Approved), deduped by personId.
                const byPersonId = new Map();

                (householdData.addOns || [])
                    .filter(m => m.status === 'Active')
                    .forEach(m => byPersonId.set(m.personId, {
                        personId: m.personId,
                        firstName: m.firstName,
                        lastName: m.lastName,
                        memberIdentifier: m.memberIdentifier,
                    }));

                (buddyData.buddyListItems || [])
                    .filter(item => item.status === 'Approved')
                    .forEach(item => {
                        const buddy = item.buddy;
                        if (!byPersonId.has(buddy.personId)) {
                            byPersonId.set(buddy.personId, {
                                personId: buddy.personId,
                                firstName: buddy.firstName,
                                lastName: buddy.lastName,
                                // Buddy list uses memberId for the same numeric member identifier.
                                memberIdentifier: buddy.memberId,
                                isPermanentMember: buddy.isPermanentMember,
                            });
                        }
                    });

                const mergedPlayers = Array.from(byPersonId.values());

                // Include the primary (logged-in) user's memberIdentifier so their photo is
                // fetched together with the rest, avoiding a separate request later.
                const primaryMemberIdentifier = householdData.primary && householdData.primary.memberIdentifier;
                const allMemberIdentifiers = mergedPlayers.map(p => p.memberIdentifier).filter(Boolean);
                if (primaryMemberIdentifier) allMemberIdentifiers.push(primaryMemberIdentifier);

                const fetchedPhotos = await fetchPhotos(allMemberIdentifiers);
                cachePlayersFromXhr(mergedPlayers);
                cachePhotosFromXhr(fetchedPhotos || {});

                const finalPhotos = getLocalStorageService().getJson(PLAYER_PHOTOS_KEY, '[bc] failed to read cached photos after merge') || {};
                getDebugService().log('info', 'fetch-possible-players-api-success', {
                    playerCount: mergedPlayers.length,
                    photoCount: Object.keys(finalPhotos).length,
                });
                return { players: mergedPlayers, photosByMemberId: finalPhotos };
            }

            // Called by the XHR interceptor when the native booking flow fetches the player list.
            function cachePlayersFromXhr(players) {
                getLocalStorageService().setJson(POSSIBLE_PLAYERS_KEY, players);
            }

            // Called by the XHR interceptor when the native booking flow fetches player photos,
            // and by fetchPhotos after a direct API call. Merges incoming photos into the existing
            // cache so a sparse result never evicts richer data from a full booking flow.
            function cachePhotosFromXhr(photosByMemberId) {
                const existing = getLocalStorageService().getJson(PLAYER_PHOTOS_KEY, '[bc] failed to parse cached player photos') || {};
                const merged = Object.assign({}, existing, photosByMemberId);
                getLocalStorageService().setJson(PLAYER_PHOTOS_KEY, merged);
            }

            // Fetch photos for a list of member identifiers. Accepts either an array of ID
            // strings or an array of player objects (using memberIdentifier or memberId field).
            // Uses repeated query params as required by the API. Returns the photosByMemberId
            // map, or null on failure.
            async function fetchPhotos(playersOrIds) {
                const headers = buildAuthHeaders();
                if (!headers) {
                    getDebugService().log('warn', 'fetch-photos-no-auth-headers');
                    return null;
                }

                const memberIds = playersOrIds.map(item => {
                    if (typeof item === 'string') return item;
                    return item.memberIdentifier || item.memberId;
                }).filter(Boolean);
                if (memberIds.length === 0) {
                    getDebugService().log('warn', 'fetch-photos-no-member-ids');
                    return null;
                }

                // GET requests must not include Content-Type or they may be rejected.
                const getHeaders = Object.assign({}, headers);
                delete getHeaders['Content-Type'];

                // The photos API requires repeated params (not comma-separated).
                const qs = memberIds.map(id => 'membersIds=' + encodeURIComponent(id)).join('&');
                const url = `${PHOTOS_API_BASE}/photos/members?${qs}`;
                getDebugService().log('info', 'fetch-photos-request', { count: memberIds.length });

                try {
                    const response = await fetch(url, { headers: getHeaders });
                    if (!response.ok) {
                        getDebugService().log('warn', 'fetch-photos-http-error', { status: response.status });
                        return null;
                    }
                    const data = await response.json();
                    const photosByMemberId = data.memberPhotos || {};
                    cachePhotosFromXhr(photosByMemberId);
                    getDebugService().log('info', 'fetch-photos-success', { count: Object.keys(photosByMemberId).length });
                    return photosByMemberId;
                } catch (e) {
                    getDebugService().log('warn', 'fetch-photos-exception', { message: e.message });
                    return null;
                }
            }

            // Photo URL helper. Returns null when no photo is available or the API has
            // marked the photo as not allowed for display.
            function getPlayerPhotoUrl(memberId, photosByMemberId) {
                const photoInfo = photosByMemberId[memberId];
                if (!photoInfo || !photoInfo.photoId || photoInfo.state === 'NotAllowed') return null;
                return `${PHOTO_CDN_BASE}/${photoInfo.photoId}?format=raw&&height=192`;
            }

            // Compute when the booking window opens for a given slot.
            function computeFireAtMs(date, fromMinutes) {
                const slotDate = new Date(date + 'T00:00:00');
                slotDate.setMinutes(slotDate.getMinutes() + fromMinutes);
                slotDate.setDate(slotDate.getDate() - SCHEDULED_BOOKING_ADVANCE_DAYS);
                return slotDate.getTime();
            }

            // Schedule a booking: build bodies and POST to Worker. Returns a promise
            // that resolves once the Worker has confirmed the booking is stored, so
            // callers can safely navigate away without cancelling the in-flight request.
            async function scheduleBooking(slotInfo, selectedPartners, isVisibleToBuddies) {
                const lastFetchState = getBookingStateService().getLastFetchState();
                if (!lastFetchState) throw new Error('No fetch state available to build booking body.');

                const timeSlotId = CLUB_MAX_TIMESLOT[slotInfo.clubId] &&
                    lastFetchState.params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[slotInfo.clubId]
                    : lastFetchState.params.timeSlotId;

                const booking = {
                    id: crypto.randomUUID(),
                    fireAtMs: computeFireAtMs(slotInfo.date, slotInfo.fromMinutes),
                    bookingBody: {
                        clubId: slotInfo.clubId,
                        courtId: slotInfo.courtId,
                        date: { value: slotInfo.date, date: slotInfo.date },
                        timeFromInMinutes: slotInfo.fromMinutes,
                        timeToInMinutes: slotInfo.toMinutes,
                        categoryOptionsId: lastFetchState.params.categoryOptionsId,
                        timeSlotId: timeSlotId,
                        categoryCode: lastFetchState.params.categoryCode,
                    },
                    confirmBody: {
                        invitations: selectedPartners.map(p => ({ personId: p.personId })),
                        isVisibleToBuddies: isVisibleToBuddies !== false,
                    },
                    slotLabel: `${CLUB_SHORT_NAMES[slotInfo.clubId] || 'Unknown'} \u00b7 ${slotInfo.courtName || 'Court'} \u00b7 ${minutesToHumanTime(slotInfo.fromMinutes)}\u2013${minutesToHumanTime(slotInfo.toMinutes)} \u00b7 ${formatDateForSlotLabel(slotInfo.date)}`,
                    partnerNames: selectedPartners.map(p => `${p.firstName} ${p.lastName}`),
                    notificationEmail: await fetchNotificationEmail(),
                    userName: (() => {
                        const p = getLocalStorageService().getJson(SELF_PROFILE_KEY, '[bc] failed to parse self profile');
                        return (p && p.firstName && p.lastName) ? `${p.firstName} ${p.lastName}` : '';
                    })(),
                    status: SCHEDULED_STATUS_PENDING,
                    slotCheckStatus: SLOT_CHECK_STATUS.UNKNOWN,
                    failureReason: null,
                    createdAtMs: Date.now(),
                };

                cachedBookings = [...cachedBookings, booking];
                try {
                    const response = await fetch(`${WORKER_URL}/bookings`, {
                        method: 'POST',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, workerHeaders()),
                        body: JSON.stringify(booking),
                    });
                    if (!response.ok) {
                        throw new Error(`Worker rejected booking: HTTP ${response.status}`);
                    }
                } catch (e) {
                    getDebugService().log('warn', 'worker-post-booking-failed', { error: e.message });
                    throw e;
                }

                getDebugService().log('info', 'scheduled-booking-created', {
                    id: booking.id,
                    slotLabel: booking.slotLabel,
                    fireAtMs: booking.fireAtMs,
                });

                return booking;
            }

            function formatDateForSlotLabel(dateString) {
                const d = new Date(dateString + 'T00:00:00');
                return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            }

            // Booking lifecycle helpers.

            function cancelBooking(id) {
                cachedBookings = cachedBookings.filter(b => b.id !== id);
                fetch(`${WORKER_URL}/bookings/${id}`, {
                    method: 'DELETE',
                    headers: workerHeaders(),
                }).catch(e => getDebugService().log('warn', 'worker-delete-booking-failed', { error: e.message }));
                getDebugService().log('info', 'scheduled-booking-cancelled', { id });
            }

            // Fetches the logged-in user's email from the Bay Club profile API,
            // caching the result in localStorage so only one API call is ever made
            // per device. Returns null if auth headers are unavailable or the call
            // fails — in which case the Worker will simply skip the email notification.
            async function fetchNotificationEmail() {
                const cached = getLocalStorageService().getString(NOTIFICATION_EMAIL_KEY);
                if (cached) return cached;
                const headers = buildAuthHeaders();
                if (!headers) return null;
                try {
                    const response = await fetch('https://connect-api.bayclubs.io/profile/api/1.0/profile', { headers });
                    if (!response.ok) return null;
                    const data = await response.json();
                    const email = data.email || null;
                    if (email) {
                        getLocalStorageService().setString(NOTIFICATION_EMAIL_KEY, email);
                    }
                    // Also cache name and memberIdentifier for the partner picker self card.
                    // The photos API keys photos by memberIdentifier (the numeric member
                    // number), not by personId (the CRM UUID).
                    if (data.firstName && data.lastName) {
                        getLocalStorageService().setJson(SELF_PROFILE_KEY, {
                            firstName: data.firstName,
                            lastName: data.lastName,
                            memberId: data.memberIdentifier || null,
                        });
                    }
                    return email;
                } catch (_e) {
                    return null;
                }
            }

            // Forwards a fresh refresh token to the Worker's KV store. Called by the
            // XHR interceptor whenever the Bay Club app renews its access token so the
            // Worker always has a valid token to use when firing scheduled bookings.
            // Pushes a refresh token to the Worker keyed by userId (the user's email).
            // Per-user keys prevent multiple extension users from overwriting each
            // other's tokens in KV.
            function pushRefreshToken(token, userId) {
                fetch(`${WORKER_URL}/token`, {
                    method: 'PUT',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, workerHeaders()),
                    body: JSON.stringify({ refresh_token: token, userId }),
                }).catch(e => getDebugService().log('warn', 'worker-push-token-failed', { error: e.message }));
            }

            // Reads the refresh token and email the Angular app persists to localStorage
            // after login and pushes both to the Worker. The app writes connect20auth
            // before our script runs, so this reliably captures the token on every page
            // load without needing to intercept any network calls.
            function syncRefreshTokenFromAppStorage() {
                try {
                    const raw = localStorage.getItem('connect20auth');
                    if (!raw) return;
                    const state = JSON.parse(raw);
                    const profileData = state && state.profile && state.profile.data;
                    const token = state && state.token && state.token.refresh_token;
                    const userId = profileData && profileData.email;
                    if (token && userId) {
                        pushRefreshToken(token, userId);
                    }
                    // Seed the self profile cache from connect20auth if memberId is not
                    // yet cached. fetchNotificationEmail will overwrite with the
                    // authoritative profile API result. memberIdentifier is the numeric
                    // member number the photos API keys photos by.
                    if (profileData && profileData.firstName && profileData.lastName) {
                        const existing = getLocalStorageService().getJson(SELF_PROFILE_KEY, '[bc] failed to parse self profile') || {};
                        if (!existing.memberId) {
                            getLocalStorageService().setJson(SELF_PROFILE_KEY, {
                                firstName: profileData.firstName,
                                lastName: profileData.lastName,
                                memberId: profileData.memberIdentifier || null,
                            });
                        }
                    }
                } catch (_e) {
                    // Ignore parse errors — app storage format may change.
                }
            }

            function initializeOnPageLoad() {
                // Fetch bookings from the Worker to populate the local cache. The
                // /bookings page reconciliation loop picks up results on the next 
                // requestAnimationFrame tick.
                fetchAllFromWorker();
                // Keep the Worker's KV refresh token current on every page load.
                syncRefreshTokenFromAppStorage();
                getDebugService().log('info', 'scheduled-bookings-initialized-on-load');
            }

            serviceInstance = {
                fetchPossiblePlayers,
                getPlayerPhotoUrl,
                computeFireAtMs,
                scheduleBooking,
                loadAll,
                getPendingBookings,
                getActiveBookings,
                getFailedBookings,
                cancelBooking,
                dismissBooking,
                initializeOnPageLoad,
                refreshFromWorker: fetchAllFromWorker,
                pushRefreshToken,
                cachePlayersFromXhr,
                cachePhotosFromXhr,
                fetchPhotos,
                SLOT_CHECK_STATUS,
            };
            return serviceInstance;
        };
    })();
    // #endregion Scheduled bookings service.

    // #region Bookings page: calendar export and pending bookings.
    const getBookingsDomQueryService = (() => {
        let serviceInstance = null;

        return function getBookingsDomQueryService() {
            if (serviceInstance) return serviceInstance;

            const EVENTS_LIST_SELECTOR = 'app-calendar-events-list app-racquet-sports-booking-calendar-event';
            const DESKTOP_TILE_SELECTOR = '.item-tile.d-none.d-md-flex';
            const BOOKING_DETAILS_HEADER_SELECTOR = '.image-background .px-4.pb-4';
            const RESERVATION_MADE_BY_ROW_SELECTOR = '.row.mt-2.size-14';

            function isOnBookingsPage() {
                return location.pathname === '/bookings';
            }

            function isOnBookingDetailsPage() {
                return /^\/racquet-sports\/booking\/[0-9a-f-]+$/i.test(location.pathname);
            }

            function getCalendarEventElements() {
                return Array.from(document.querySelectorAll(EVENTS_LIST_SELECTOR));
            }

            function findDesktopTile(eventElement) {
                if (!eventElement) return null;
                return eventElement.querySelector(DESKTOP_TILE_SELECTOR);
            }

            function getBookingDetailsHeader() {
                return document.querySelector(BOOKING_DETAILS_HEADER_SELECTOR);
            }

            function findReservationMadeByRow(matchesReservationText) {
                const candidates = Array.from(document.querySelectorAll(RESERVATION_MADE_BY_ROW_SELECTOR));
                if (candidates.length === 0) return null;
                const match = candidates.find(row => matchesReservationText(row.textContent || ''));
                return match || null;
            }

            serviceInstance = {
                isOnBookingsPage,
                isOnBookingDetailsPage,
                getCalendarEventElements,
                findDesktopTile,
                getBookingDetailsHeader,
                findReservationMadeByRow,
            };
            return serviceInstance;
        };
    })();

    const createBookingsCalendarExportInstaller = (() => {
        let alreadyInitialized = false;

        return function createBookingsCalendarExportInstaller() {
            if (alreadyInitialized) return;
            alreadyInitialized = true;

            let reconcileScheduled = false;

            function normalizeWhitespace(value) {
                return (value || '').replace(/\s+/g, ' ').trim();
            }

            function simplifyClubName(clubName) {
                return normalizeWhitespace(clubName).replace(/^Bay Club\s+/i, '');
            }

            function extractCourtDisplayName(courtText) {
                const normalized = normalizeWhitespace(courtText);
                const numberMatch = normalized.match(/(\d+)/);
                if (numberMatch) return `Court ${numberMatch[1]}`;
                return normalized || 'Court';
            }

            function parseDayLabel(dayLabel) {
                const normalized = normalizeWhitespace(dayLabel).toLowerCase();
                const baseDate = new Date();
                baseDate.setHours(0, 0, 0, 0);
                if (normalized === 'today') return new Date(baseDate);
                if (normalized === 'tomorrow') {
                    const tomorrow = new Date(baseDate);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    return tomorrow;
                }

                const monthDayMatch = normalizeWhitespace(dayLabel).match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
                if (monthDayMatch) {
                    const parsed = new Date(`${monthDayMatch[1]} ${monthDayMatch[2]}, ${baseDate.getFullYear()}`);
                    if (!Number.isNaN(parsed.getTime())) {
                        parsed.setHours(0, 0, 0, 0);
                        // If the parsed date is clearly in the past, assume a year rollover.
                        if (parsed < baseDate) {
                            parsed.setFullYear(parsed.getFullYear() + 1);
                        }
                        return parsed;
                    }
                }

                const parsed = new Date(dayLabel);
                if (!Number.isNaN(parsed.getTime())) {
                    parsed.setHours(0, 0, 0, 0);
                    return parsed;
                }
                getDebugService().log('warn', 'bookings-parse-day-label-failed', {
                    rawDayLabel: dayLabel,
                    normalizedDayLabel: normalized,
                });
                return null;
            }

            function timePartsTo24Hour(hour12, minute, meridiem) {
                const normalizedHour = hour12 % 12;
                if (meridiem === 'PM') return normalizedHour + 12;
                return normalizedHour;
            }

            function inferStartHour24(startHour12, endHour24) {
                const startAm = startHour12 % 12;
                const startPm = (startHour12 % 12) + 12;
                const minuteCandidates = [startAm, startPm];
                const plausible = minuteCandidates.filter(candidate => {
                    const delta = endHour24 - candidate;
                    return delta >= 0 && delta <= 4;
                });
                if (plausible.length > 0) return plausible[0];

                const byDistance = minuteCandidates
                    .map(candidate => ({ candidate, distance: Math.abs(candidate - endHour24) }))
                    .sort((a, b) => a.distance - b.distance);
                return byDistance[0].candidate;
            }

            function parseTimeRange(timeText) {
                const match = normalizeWhitespace(timeText).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
                if (!match) {
                    getDebugService().log('warn', 'bookings-parse-time-range-failed', {
                        rawTimeText: timeText,
                    });
                    return null;
                }
                const startHour12 = parseInt(match[1], 10);
                const startMinute = parseInt(match[2], 10);
                const endHour12 = parseInt(match[3], 10);
                const endMinute = parseInt(match[4], 10);
                const endMeridiem = match[5].toUpperCase();

                const endHour24 = timePartsTo24Hour(endHour12, endMinute, endMeridiem);
                const startHour24 = inferStartHour24(startHour12, endHour24);
                return {
                    startHour24,
                    startMinute,
                    endHour24,
                    endMinute,
                };
            }

            function buildBookingDataFromFields({ dayLabel, timeRangeText, club, court, participantNames, playersLine }) {
                if (!dayLabel || !timeRangeText || !club) return null;
                const bookingDate = parseDayLabel(dayLabel);
                const timeRange = parseTimeRange(timeRangeText);
                if (!bookingDate || !timeRange) return null;

                const startDate = new Date(bookingDate);
                startDate.setHours(timeRange.startHour24, timeRange.startMinute, 0, 0);
                const endDate = new Date(bookingDate);
                endDate.setHours(timeRange.endHour24, timeRange.endMinute, 0, 0);
                if (endDate <= startDate) {
                    endDate.setDate(endDate.getDate() + 1);
                }

                const shortClubName = simplifyClubName(club);
                const courtDisplayName = extractCourtDisplayName(court);
                const participantSuffix = (participantNames || []).length > 0
                    ? ` with ${participantNames.join(', ')}`
                    : '';
                return {
                    title: `Pickleball at ${shortClubName}${participantSuffix} on ${courtDisplayName}`,
                    startDate,
                    endDate,
                    location: normalizeWhitespace(`${club}${court ? `, ${court}` : ''}`),
                    details: playersLine || 'Booked via Bay Club Connect.',
                };
            }

            function extractBookingData(eventElement) {
                const desktopTile = getBookingsDomQueryService().findDesktopTile(eventElement);
                if (!desktopTile) return null;

                const dayLabel = normalizeWhitespace(desktopTile.querySelector('.col-2 div:first-child')?.textContent);
                const timeRangeText = normalizeWhitespace(desktopTile.querySelector('.col-2 div:nth-child(2)')?.textContent);
                const club = normalizeWhitespace(desktopTile.querySelector('.col-3 div:first-child')?.textContent);
                const court = normalizeWhitespace(desktopTile.querySelector('.col-3 div:nth-child(2)')?.textContent);
                const playersLine = normalizeWhitespace(Array.from(desktopTile.querySelectorAll('.size-12'))
                    .map(node => node.textContent)
                    .find(text => (text || '').includes('Players:')) || '');
                const participantNames = Array.from(desktopTile.querySelectorAll('app-racquet-sports-booking-player'))
                    .map(player => normalizeWhitespace(player.textContent))
                    .filter(Boolean)
                    .filter(name => name.toLowerCase() !== 'you');

                return buildBookingDataFromFields({
                    dayLabel,
                    timeRangeText,
                    club,
                    court,
                    participantNames,
                    playersLine,
                });
            }

            function extractBookingDataFromDetailsPage() {
                const header = getBookingsDomQueryService().getBookingDetailsHeader();
                if (!header) return null;

                const headerText = normalizeWhitespace(header.textContent);
                const dayLabelMatch = headerText.match(/\b([A-Za-z]{3,9}\s+\d{1,2})\b/);
                const timeMatch = headerText.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*(AM|PM))/i);
                const dayLabel = dayLabelMatch ? dayLabelMatch[1] : '';
                const timeRangeText = timeMatch ? timeMatch[1] : '';
                const club = normalizeWhitespace(header.querySelector('.size-14.mt-3')?.textContent);
                const court = normalizeWhitespace(header.querySelector('.size-14.mt-3 + span + .size-14')?.textContent);
                const playersLine = normalizeWhitespace(Array.from(document.querySelectorAll('app-racquet-sports-player .grey.size-12'))
                    .map(node => node.textContent)
                    .find(text => (text || '').includes('You')) || '');
                const participantNames = Array.from(document.querySelectorAll('app-racquet-sports-player'))
                    .map(player => {
                        const primary = normalizeWhitespace(player.querySelector('.flex-grow-1 > div:first-child')?.textContent || '')
                            .replace(/\bChange\b/gi, '')
                            .trim();
                        const secondary = normalizeWhitespace(player.querySelector('.flex-grow-1 > div:nth-child(2)')?.textContent || '');
                        if (!primary || secondary.toLowerCase().includes('you')) return null;
                        return primary;
                    })
                    .filter(Boolean);

                return buildBookingDataFromFields({
                    dayLabel,
                    timeRangeText,
                    club,
                    court,
                    participantNames,
                    playersLine,
                });
            }

            function toGoogleDateStamp(date) {
                return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            }

            function buildGoogleCalendarUrl(booking) {
                const params = new URLSearchParams({
                    action: 'TEMPLATE',
                    text: booking.title,
                    dates: `${toGoogleDateStamp(booking.startDate)}/${toGoogleDateStamp(booking.endDate)}`,
                    details: booking.details,
                    location: booking.location,
                });
                return `https://calendar.google.com/calendar/render?${params.toString()}`;
            }

            function toIcsDateStamp(date) {
                return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            }

            function sanitizeIcsText(text) {
                return (text || '')
                    .replace(/\\/g, '\\\\')
                    .replace(/\n/g, '\\n')
                    .replace(/,/g, '\\,')
                    .replace(/;/g, '\\;');
            }

            function buildIcsContent(booking) {
                const nowStamp = toIcsDateStamp(new Date());
                const startStamp = toIcsDateStamp(booking.startDate);
                const endStamp = toIcsDateStamp(booking.endDate);
                const uid = `${startStamp}-${Math.random().toString(36).slice(2)}@bayclubconnect-helper`;

                return [
                    'BEGIN:VCALENDAR',
                    'VERSION:2.0',
                    'PRODID:-//Bay Club Connect Helper//EN',
                    'CALSCALE:GREGORIAN',
                    'METHOD:PUBLISH',
                    'BEGIN:VEVENT',
                    `UID:${uid}`,
                    `DTSTAMP:${nowStamp}`,
                    `DTSTART:${startStamp}`,
                    `DTEND:${endStamp}`,
                    `SUMMARY:${sanitizeIcsText(booking.title)}`,
                    `LOCATION:${sanitizeIcsText(booking.location)}`,
                    `DESCRIPTION:${sanitizeIcsText(booking.details)}`,
                    'END:VEVENT',
                    'END:VCALENDAR',
                    '',
                ].join('\r\n');
            }

            function getIcsDownloadFileName(booking) {
                const safeTitle = booking.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
                return `${safeTitle || 'pickleball-booking'}.ics`;
            }

            function preventBookingTileClickThrough(element) {
                ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(eventName => {
                    element.addEventListener(eventName, event => {
                        event.stopPropagation();
                    }, true);
                });
            }

            function appendCalendarActions(tile, booking, googleCalendarUrl) {
                if (tile.querySelector('.bc-calendar-action')) return;

                const actionContainer = document.createElement('div');
                actionContainer.className = 'bc-calendar-action';
                const icon = document.createElement('span');
                icon.className = 'bc-calendar-icon';
                icon.textContent = '📅';

                const googleLink = document.createElement('a');
                googleLink.className = 'bc-calendar-add-link';
                googleLink.href = googleCalendarUrl;
                googleLink.target = '_blank';
                googleLink.rel = 'noopener noreferrer';
                googleLink.textContent = 'Google Calendar';
                preventBookingTileClickThrough(googleLink);

                const icsLink = document.createElement('a');
                icsLink.className = 'bc-calendar-ics-link';
                icsLink.textContent = 'Download event';
                icsLink.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcsContent(booking))}`;
                icsLink.download = getIcsDownloadFileName(booking);
                preventBookingTileClickThrough(icsLink);

                actionContainer.appendChild(icon);
                actionContainer.appendChild(googleLink);
                actionContainer.appendChild(icsLink);
                tile.appendChild(actionContainer);
            }

            function isCanceledBooking(eventElement) {
                if (eventElement.closest('app-calendar-cancelled-by-me-list')) return true;
                return normalizeWhitespace(eventElement.textContent).toLowerCase().includes('canceled');
            }

            function injectButtonsForBookingsPage() {
                if (!getBookingsDomQueryService().isOnBookingsPage()) return;

                getBookingsDomQueryService().getCalendarEventElements().forEach(eventElement => {
                    if (isCanceledBooking(eventElement)) return;
                    const booking = extractBookingData(eventElement);
                    if (!booking) return;
                    const calendarUrl = buildGoogleCalendarUrl(booking);
                    eventElement.querySelectorAll('.item-tile').forEach(tile => {
                        appendCalendarActions(tile, booking, calendarUrl);
                    });
                });
            }

            function injectButtonsForBookingDetailsPage() {
                if (!getBookingsDomQueryService().isOnBookingDetailsPage()) return;
                const booking = extractBookingDataFromDetailsPage();
                if (!booking) return;

                const calendarUrl = buildGoogleCalendarUrl(booking);
                const reservationMadeByRow = getBookingsDomQueryService().findReservationMadeByRow(text =>
                    normalizeWhitespace(text).toLowerCase().includes('reservation made by')
                );
                if (!reservationMadeByRow) return;

                if (reservationMadeByRow.parentElement?.querySelector('.bc-calendar-action')) return;
                const actionHost = document.createElement('div');
                reservationMadeByRow.insertAdjacentElement('afterend', actionHost);
                appendCalendarActions(actionHost, booking, calendarUrl);
            }

            function formatCountdown(fireAtMs) {
                const diff = fireAtMs - Date.now();
                if (diff <= 0) return 'Booking attempt in progress\u2026';
                const hours = Math.floor(diff / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const remaining = hours > 24
                    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
                    : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                const d = new Date(fireAtMs);
                const datePart = d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                const timePart = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
                return `We will attempt to book this in ${remaining} on ${datePart} at ${timePart}`;
            }

            function buildPendingBookingRowHtml(booking) {
                const partnerList = (booking.partnerNames || []).join(', ') || 'No partners';
                const isTaken = booking.slotCheckStatus === getScheduledBookingService().SLOT_CHECK_STATUS.TAKEN;
                const warningStyle = isTaken ? '' : 'display: none;';
                return `<div data-bc-pending-booking="${booking.id}" style="background: rgba(0,188,212,0.08); border: 1px solid rgba(0,188,212,0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: white;">${booking.slotLabel}</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 4px;">Partners: ${partnerList}</div>
                        <div data-bc-slot-warning style="font-size: 12px; color: #ffb74d; margin-top: 4px; ${warningStyle}">\u26a0\ufe0f The court was booked by someone else</div>
                        <div data-bc-countdown style="font-size: 12px; color: rgb(0,188,212); margin-top: 4px;">${formatCountdown(booking.fireAtMs)}</div>
                    </div>
                    <button data-bc-cancel-booking="${booking.id}" style="background: none; border: 1px solid rgba(239,83,80,0.5); color: #ef5350; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;">Cancel</button>
                </div>`;
            }

            function buildFailedBookingRowHtml(booking) {
                const reason = booking.failureReason || 'The booking attempt was unsuccessful.';
                return `<div data-bc-failed-booking="${booking.id}" style="background: rgba(239,83,80,0.08); border: 1px solid rgba(239,83,80,0.35); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: white;">${booking.slotLabel}</div>
                        <div style="font-size: 12px; color: #ef5350; margin-top: 4px;">Booking unsuccessful</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 2px;">${reason}</div>
                    </div>
                    <button data-bc-dismiss-booking="${booking.id}" style="background: none; border: 1px solid rgba(255,255,255,0.3); color: rgba(255,255,255,0.7); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;">Dismiss</button>
                </div>`;
            }

            function injectPendingBookingsSection() {
                if (!getBookingsDomQueryService().isOnBookingsPage()) return;

                const activeBookings = getScheduledBookingService().getActiveBookings();
                const failedBookings = getScheduledBookingService().getFailedBookings();
                const existingSection = document.querySelector('[data-bc-pending-section]');

                if (activeBookings.length === 0 && failedBookings.length === 0) {
                    if (existingSection) existingSection.remove();
                    return;
                }

                // Section already present — countdowns are updated by the dedicated interval
                // in startPendingCountdownUpdates(). Updating textContent here would re-trigger
                // the MutationObserver, causing scheduleReconcile to loop at requestAnimationFrame 
                // speed.
                if (existingSection) return;

                // Insert before app-calendar-cancelled-by-me-list so the pending section
                // appears near the cancelled bookings area. Fall back through progressively
                // broader elements when earlier selectors are absent.
                const insertionPoint =
                    document.querySelector('app-calendar-cancelled-by-me-list') ||
                    document.querySelector('app-calendar-events-list') ||
                    document.querySelector('app-paged-list') ||
                    document.querySelector('app-calendar');
                if (!insertionPoint || !insertionPoint.parentElement) return;

                const section = document.createElement('div');
                section.setAttribute('data-bc-pending-section', '');
                section.style.cssText = 'margin: 16px 16px 24px; padding: 0;';
                section.innerHTML = `
                    <div style="font-size: 16px; font-weight: 600; color: white; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                        <span>\u23f3</span> Pending Bookings
                    </div>
                    ${activeBookings.map(buildPendingBookingRowHtml).join('')}
                    ${failedBookings.map(buildFailedBookingRowHtml).join('')}
                `;

                // Bind cancel buttons for pending bookings.
                section.querySelectorAll('[data-bc-cancel-booking]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const bookingId = btn.dataset.bcCancelBooking;
                        getScheduledBookingService().cancelBooking(bookingId);
                        const row = section.querySelector(`[data-bc-pending-booking="${bookingId}"]`);
                        if (row) row.remove();
                        if (getScheduledBookingService().getActiveBookings().length === 0 &&
                            getScheduledBookingService().getFailedBookings().length === 0) {
                            section.remove();
                        }
                    });
                });

                // Bind dismiss buttons for failed bookings.
                section.querySelectorAll('[data-bc-dismiss-booking]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const bookingId = btn.dataset.bcDismissBooking;
                        getScheduledBookingService().dismissBooking(bookingId);
                        const row = section.querySelector(`[data-bc-failed-booking="${bookingId}"]`);
                        if (row) row.remove();
                        if (getScheduledBookingService().getActiveBookings().length === 0 &&
                            getScheduledBookingService().getFailedBookings().length === 0) {
                            section.remove();
                        }
                    });
                });

                insertionPoint.parentElement.insertBefore(section, insertionPoint);
            }

            // Starts a 60-second interval that refreshes the booking cache from the Worker
            // (so succeeded/failed status changes are picked up) and updates countdown text
            // in the pending section. If the booking list changes the section is removed and
            // re-injected on the next reconcile pass rather than updated in place, to avoid
            // triggering the MutationObserver → scheduleReconcile → requestAnimationFrame loop.
            let pendingCountdownInterval = null;

            function startPendingCountdownUpdates() {
                if (pendingCountdownInterval) return;
                pendingCountdownInterval = setInterval(async () => {
                    // Refresh from Worker so status changes (succeeded/failed) are picked up.
                    await getScheduledBookingService().refreshFromWorker();

                    const section = document.querySelector('[data-bc-pending-section]');
                    const activeBookings = getScheduledBookingService().getActiveBookings();
                    const failedBookings = getScheduledBookingService().getFailedBookings();

                    if (activeBookings.length === 0 && failedBookings.length === 0) {
                        if (section) section.remove();
                        clearInterval(pendingCountdownInterval);
                        pendingCountdownInterval = null;
                        return;
                    }

                    if (!section) return;

                    // If the rendered rows no longer match current bookings (e.g. a booking
                    // succeeded or failed), remove the section. The MutationObserver will
                    // trigger scheduleReconcile which re-injects it with fresh data.
                    const currentIds = new Set([...activeBookings, ...failedBookings].map(b => b.id));
                    const renderedIds = new Set(
                        Array.from(section.querySelectorAll('[data-bc-pending-booking],[data-bc-failed-booking]'))
                            .map(el => el.dataset.bcPendingBooking || el.dataset.bcFailedBooking)
                    );
                    const needsRebuild = currentIds.size !== renderedIds.size ||
                        [...currentIds].some(id => !renderedIds.has(id));
                    if (needsRebuild) {
                        section.remove();
                        return;
                    }

                    // Update countdown text in place.
                    activeBookings.forEach(booking => {
                        const row = section.querySelector(`[data-bc-pending-booking="${booking.id}"]`);
                        if (row) {
                            const countdown = row.querySelector('[data-bc-countdown]');
                            if (countdown) countdown.textContent = formatCountdown(booking.fireAtMs);
                            const warning = row.querySelector('[data-bc-slot-warning]');
                            if (warning) {
                                const isTaken = booking.slotCheckStatus === getScheduledBookingService().SLOT_CHECK_STATUS.TAKEN;
                                warning.style.display = isTaken ? '' : 'none';
                            }
                        }
                    });
                }, 60 * 1000);
            }

            function scheduleReconcile() {
                if (reconcileScheduled) return;
                reconcileScheduled = true;
                requestAnimationFrame(() => {
                    reconcileScheduled = false;
                    injectButtonsForBookingsPage();
                    injectButtonsForBookingDetailsPage();
                    injectPendingBookingsSection();
                    if (getScheduledBookingService().getActiveBookings().length > 0) {
                        startPendingCountdownUpdates();
                    }
                });
            }

            const observer = new MutationObserver(() => {
                scheduleReconcile();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            // Also reconcile whenever the Worker bookings cache is refreshed, so
            // the pending section appears even on mobile browsers where the
            // MutationObserver DOM nudge does not reliably trigger a reconcile.
            document.addEventListener('bc-bookings-updated', () => scheduleReconcile());
            scheduleReconcile();
        };
    })();
    // #endregion Bookings page: calendar export and pending bookings.

    // #region UI preference controls and filter widgets.
    const getPreferenceAutoSelectService = (() => {
        let serviceInstance = null;

        return function getPreferenceAutoSelectService() {
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
                    const saved = getLocalStorageService().getString(key);
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
                const container = getBookingDomQueryService().getDurationAndPlayersFilterContainer();
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
                            getLocalStorageService().setString(PLAYERS_KEY, btn.textContent.trim());
                            getPreferenceSyncService().notifyPreferenceChanged();
                        } else if (labels.includes('30 minutes')) {
                            getLocalStorageService().setString(DURATION_KEY, btn.textContent.trim());
                            getPreferenceSyncService().notifyPreferenceChanged();
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
    function autoSelectPickleballSportIfAvailable() {
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

    // Stores the club ordering selected by the user for future sessions.
    const CLUB_ORDER_KEY = 'bc_club_order';

    function getClubOrder() {
        const parsed = getLocalStorageService().getJson(CLUB_ORDER_KEY, '[bc] failed to parse stored club order JSON');
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
        getLocalStorageService().setJson(CLUB_ORDER_KEY, order);
        getPreferenceSyncService().notifyPreferenceChanged();
    }

    function injectClubOrderWidget() {
        const container = getBookingDomQueryService().getDurationAndPlayersFilterContainer();
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
        getClubOrderWidgetController().initDragAndDrop(widget);
    }

    const getClubOrderWidgetController = (() => {
        let serviceInstance = null;

        return function getClubOrderWidgetController() {
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

            function reorderDraggedItemWithinList({ list, item, draggedItem, clientY }) {
                if (!draggedItem || item === draggedItem) return;

                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (clientY < midY) {
                    list.insertBefore(draggedItem, item);
                } else {
                    list.insertBefore(draggedItem, item.nextSibling);
                }
            }

            function initDragAndDrop(widget) {
                const list = widget.querySelector('.bc-club-order-list');
                if (!list) return;

                let draggedItem = null;
                let touchDraggedItem = null;

                function finalizeReorder(item) {
                    if (!item) return;
                    item.style.opacity = '1';
                    updateListNumbering(list);
                    saveCurrentOrder(list);
                }

                function onTouchMove(event) {
                    if (!touchDraggedItem) return;
                    const touch = event.touches && event.touches[0];
                    if (!touch) return;

                    const target = document.elementFromPoint(touch.clientX, touch.clientY);
                    const overItem = target?.closest('.bc-club-order-item');
                    if (!overItem || overItem.closest('.bc-club-order-list') !== list) return;

                    event.preventDefault();
                    reorderDraggedItemWithinList({
                        list,
                        item: overItem,
                        draggedItem: touchDraggedItem,
                        clientY: touch.clientY,
                    });
                }

                function stopTouchDrag() {
                    if (!touchDraggedItem) return;
                    const item = touchDraggedItem;
                    touchDraggedItem = null;
                    document.removeEventListener('touchmove', onTouchMove);
                    document.removeEventListener('touchend', stopTouchDrag);
                    document.removeEventListener('touchcancel', stopTouchDrag);
                    finalizeReorder(item);
                }

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
                        finalizeReorder(item);
                        draggedItem = null;
                    });

                    item.addEventListener('dragover', event => {
                        event.preventDefault();
                        reorderDraggedItemWithinList({
                            list,
                            item,
                            draggedItem,
                            clientY: event.clientY,
                        });
                    });

                    item.addEventListener('touchstart', event => {
                        if (!event.touches || event.touches.length !== 1) return;
                        touchDraggedItem = item;
                        item.style.opacity = '0.4';
                        document.addEventListener('touchmove', onTouchMove, { passive: false });
                        document.addEventListener('touchend', stopTouchDrag);
                        document.addEventListener('touchcancel', stopTouchDrag);
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

    const VIEW_MODE_KEY = 'bc_view_mode';

    function getViewMode() {
        return getLocalStorageService().getString(VIEW_MODE_KEY) === VIEW_MODE_BY_TIME ? VIEW_MODE_BY_TIME : VIEW_MODE_BY_CLUB;
    }

    function saveViewMode(mode) {
        getLocalStorageService().setString(VIEW_MODE_KEY, mode);
        getPreferenceSyncService().notifyPreferenceChanged();
    }

    function initViewToggle(anchorElement) {
        anchorElement.querySelectorAll('.bc-view-toggle .btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const newMode = btn.dataset.view;
                if (newMode === getViewMode()) return;
                saveViewMode(newMode);
                const existing = anchorElement.querySelector('.all-clubs-availability');
                if (existing) existing.remove();
                const lastFetchState = getBookingStateService().getLastFetchState();
                if (lastFetchState) {
                    getAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, anchorElement, lastFetchState.params.date);
                }
            });
        });
    }

    const INDOOR_ONLY_KEY = 'bc_indoor_only';

    function getShowIndoorClubsOnly() {
        const saved = getLocalStorageService().getJson(INDOOR_ONLY_KEY, '[bc] failed to parse stored indoor-only JSON');
        if (typeof saved === 'boolean') {
            return saved;
        }
        return false;
    }

    function saveShowIndoorClubsOnly(value) {
        getLocalStorageService().setJson(INDOOR_ONLY_KEY, value);
        getPreferenceSyncService().notifyPreferenceChanged();
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
    <div class="bc-view-toggle" style="margin-bottom: 16px; padding: 0 8px; display: flex; align-items: center; gap: 12px;">
        <div class="btn-group" role="group">
            <button class="btn btn-outline-dark-grey size-10 py-2${mode === VIEW_MODE_BY_CLUB ? ' btn-selected' : ''}" data-view="${VIEW_MODE_BY_CLUB}">BY CLUB</button>
            <button class="btn btn-outline-dark-grey size-10 py-2${mode === VIEW_MODE_BY_TIME ? ' btn-selected' : ''}" data-view="${VIEW_MODE_BY_TIME}">BY TIME</button>
        </div>
        <div style="font-size: 11px; color: rgba(255,215,0,0.85); display: flex; flex-direction: column; gap: 2px;">
            <span>E = edge court</span>
            <span>G = gated court</span>
            <span>H = hitting wall</span>
        </div>
    </div>`;
    }

    // We add a widget to allow users to filter availability by time range.
    const SLIDER_MIN_MINUTES = 360;  // 6:00 am
    const SLIDER_MAX_MINUTES = 1320; // 10:00 pm
    const SLIDER_STEP_MINUTES = 30;
    const SLIDER_STOPS = (SLIDER_MAX_MINUTES - SLIDER_MIN_MINUTES) / SLIDER_STEP_MINUTES; // 32 intervals (16 hours × 2)

    const TIME_RANGE_KEY = 'bc_time_range';

    function getTimeRange() {
        const parsed = getLocalStorageService().getJson(TIME_RANGE_KEY, '[bc] failed to parse stored time range JSON');
        if (parsed &&
            typeof parsed.startMinutes === 'number' &&
            typeof parsed.endMinutes === 'number') {
            return parsed;
        }
        return { startMinutes: SLIDER_MIN_MINUTES, endMinutes: SLIDER_MAX_MINUTES };
    }

    function saveTimeRange(startMinutes, endMinutes) {
        getLocalStorageService().setJson(TIME_RANGE_KEY, { startMinutes, endMinutes });
        getPreferenceSyncService().notifyPreferenceChanged();
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

        // Build tick marks and hour labels. Each label renders as "7:00 am" on
        // desktop; the ":00 am"/":00 pm" suffix is wrapped in bc-tick-label-detail
        // so it can be hidden on narrow screens via a media query, leaving just
        // the bare hour number "7" where space is tight.
        let ticks = '';
        for (let i = 0; i <= SLIDER_STOPS; i++) {
            const m = SLIDER_MIN_MINUTES + i * SLIDER_STEP_MINUTES;
            const pct = minutesToSliderPercent(m);
            const isHour = m % 60 === 0;
            let tickLabelHtml = '';
            if (isHour) {
                const totalHours = m / 60;
                const ampm = totalHours < 12 ? 'am' : 'pm';
                let h = totalHours % 12;
                if (h === 0) h = 12;
                tickLabelHtml = `<div style="font-size: 9px; color: rgba(255,255,255,0.4); margin-top: 2px; white-space: nowrap;">${h}<span class="bc-tick-colon-zero">:00</span><span class="bc-tick-ampm"> ${ampm}</span></div>`;
            }
            ticks += `
            <div style="position: absolute; left: ${pct}%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;"${isHour ? ` data-tick-minutes="${m}"` : ''}>
                <div style="width: 1px; height: ${isHour ? '8px' : '5px'}; background: rgba(255,255,255,${isHour ? '0.4' : '0.2'}); margin-top: 2px;"></div>
                ${tickLabelHtml}
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

    const getTimeRangeSliderController = (() => {
        let serviceInstance = null;

        return function getTimeRangeSliderController() {
            if (serviceInstance) return serviceInstance;

            function init(container) {
                const sliderContainer = container.querySelector('.bc-slider-container');
                const fill = container.querySelector('.bc-slider-fill');
                const label = container.querySelector('.bc-time-range-label');
                const startHandle = container.querySelector('.bc-slider-start');
                const endHandle = container.querySelector('.bc-slider-end');
                if (!sliderContainer || !fill || !label || !startHandle || !endHandle) return;

                let { startMinutes, endMinutes } = getTimeRange();
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
                    saveTimeRange(startMinutes, endMinutes);
                    // Re-filter visible slots.
                    getAvailabilityRenderPipeline().applyFilters(startMinutes, endMinutes);
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
    // #endregion UI preference controls and filter widgets.

    // #region Availability rendering and interaction pipeline.
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

    function isCourtGated(courtName, clubId) {
        return (GATED_COURTS[clubId] || []).includes(courtName);
    }

    function isCourtEdge(courtName, clubId) {
        return (EDGE_COURTS[clubId] || []).includes(courtName);
    }

    function courtHasHittingWall(courtName, clubId) {
        return (HITTING_WALL_COURTS[clubId] || []).includes(courtName);
    }

    function computeSlotLockState(slot, fetchDate, limitDate) {
        const slotDate = new Date(fetchDate + 'T00:00:00');
        slotDate.setMinutes(slotDate.getMinutes() + slot.fromInMinutes);
        const slotLocked = slotDate > limitDate;

        // Flip-calendar SVG returned as a bare element (no wrapper) so callers can
        // place it inside a shared flex row alongside the E/G/H badge text.
        // Filled body + colored header + two binding posts gives the "tear-off
        // calendar" look that connotes scheduling rather than a blocked slot.
        const calendarIcon = slotLocked
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    stroke-linecap="round" stroke-linejoin="round">
                 <rect x="3" y="4" width="18" height="18" rx="2" fill="rgba(80,140,255,0.3)" stroke="rgba(180,215,255,0.9)" stroke-width="2"/>
                 <rect x="4" y="5" width="16" height="6" fill="rgba(130,180,255,0.85)" stroke="none"/>
                 <line x1="3" y1="11" x2="21" y2="11" stroke="rgba(180,215,255,0.4)" stroke-width="1"/>
                 <line x1="8" y1="2" x2="8" y2="7" stroke="rgba(200,225,255,1)" stroke-width="2.5"/>
                 <line x1="16" y1="2" x2="16" y2="7" stroke="rgba(200,225,255,1)" stroke-width="2.5"/>
               </svg>`
            : '';

        // Raised to 0.80 so locked slots read as clearly actionable.
        const disabledStyle = slotLocked
            ? 'opacity: 0.80; background-color: rgba(255,255,255,0.05);'
            : '';

        // "Opens Wed 3/5" label — shown inside the card below the court list.
        let openDateLabel = '';
        if (slotLocked) {
            const openDate = new Date(slotDate.getTime() - 3 * 24 * 60 * 60 * 1000);
            const weekday = openDate.toLocaleDateString('en-US', { weekday: 'short' });
            const month = openDate.getMonth() + 1;
            const day = openDate.getDate();
            openDateLabel = `Opens ${weekday} ${month}/${day}`;
        }

        return { slotLocked, lockIcon: calendarIcon, disabledStyle, openDateLabel };
    }

    function buildSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        return slot.courts.length === 1
            ? buildSingleCourtSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode)
            : buildMultiCourtGroupHtml(slot, fetchDate, limitDate, meta, clubId, labelMode);
    }

    function buildSingleCourtSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        const { slotLocked, lockIcon, disabledStyle, openDateLabel } = computeSlotLockState(slot, fetchDate, limitDate);
        const court = slot.courts[0];
        const gated = isCourtGated(court.courtName, clubId);
        const edge = isCourtEdge(court.courtName, clubId);
        const hasHittingWall = courtHasHittingWall(court.courtName, clubId);
        const primaryLabel = gated ? 'G' : edge ? 'E' : '';
        const badgeText = [primaryLabel, hasHittingWall ? 'H' : ''].filter(Boolean).join(' ');
        const badgeColor = gated ? 'rgba(255,215,0,1)' : 'rgba(255,200,50,0.9)';
        // Single flex-row container in the top-right corner holds both the E/G/H
        // badge text and the calendar icon so they never overlap each other.
        const topRightHtml = (badgeText || slotLocked) ? `
        <div style="position: absolute; top: 2px; right: 4px; display: flex; align-items: center; gap: 3px;">
          ${badgeText ? `<span style="font-size: 11px; font-weight: bold; color: ${badgeColor};">${badgeText}</span>` : ''}
          ${lockIcon}
        </div>` : '';
        const dataAttrs = `data-club-name="${meta.shortName}"
                data-from="${slot.fromHumanTime}"
                data-to="${slot.toHumanTime}"
                data-court="${court.courtName}"
                data-court-id="${court.courtId}"
                data-club-id="${clubId}"
                data-from-minutes="${slot.fromInMinutes}"
                data-to-minutes="${slot.toInMinutes}"
                ${slotLocked ? 'data-slot-locked="1"' : ''}`;
        return `
    <div data-slot-wrapper data-from-minutes="${slot.fromInMinutes}">
      <div class="bc-court-option border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible clickable"
           ${dataAttrs} style="${disabledStyle}${gated ? ' border: 2px solid rgba(255,215,0,1);' : edge ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${court.courtName}</div>
        ${openDateLabel ? `<div style="font-size: 10px; color: rgba(255,215,90,0.95); margin-top: 5px;">${openDateLabel}</div>` : ''}
        ${topRightHtml}
      </div>
    </div>`;
    }

    function buildMultiCourtGroupHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        const { slotLocked, lockIcon, disabledStyle, openDateLabel } = computeSlotLockState(slot, fetchDate, limitDate);
        const hasGatedCourt = slot.courts.some(c => isCourtGated(c.courtName, clubId));
        const hasEdgeCourt = slot.courts.some(c => isCourtEdge(c.courtName, clubId));
        const hasHittingWallCourt = slot.courts.some(c => courtHasHittingWall(c.courtName, clubId));

        const courtNumbers = slot.courts.map(c => c.courtName?.replace(/\D+/g, '')).filter(Boolean);
        const courtSummary = courtNumbers.length > 0
            ? `Pickleball ${courtNumbers.join(', ')}`
            : 'Courts available';

        const expandedCourts = slot.courts.map(court => {
            const gated = isCourtGated(court.courtName, clubId);
            const edge = isCourtEdge(court.courtName, clubId);
            const hittingWall = courtHasHittingWall(court.courtName, clubId);
            const courtLabelsHtml = [
                gated ? '<span style="color: rgba(255,215,0,1); font-size: 10px; font-weight: bold;">Gated</span>' : edge ? '<span style="color: rgba(255,200,50,0.9); font-size: 10px; font-weight: bold;">Edge</span>' : '',
                hittingWall ? '<span style="color: rgba(255,200,50,0.9); font-size: 10px; font-weight: bold;">Hitting wall</span>' : '',
            ].filter(Boolean).join(' ');
            return `<div class="bc-court-option"
            data-club-name="${meta.shortName}"
            data-from="${slot.fromHumanTime}"
            data-to="${slot.toHumanTime}"
            data-court="${court.courtName}"
            data-court-id="${court.courtId}"
            data-club-id="${clubId}"
            data-from-minutes="${slot.fromInMinutes}"
            data-to-minutes="${slot.toInMinutes}"
            ${slotLocked ? 'data-slot-locked="1"' : ''}
            style="padding: 4px 8px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px;
                   background: rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center;">
            <span>${court.courtName}</span>
            ${courtLabelsHtml}
        </div>`;
        }).join('');

        const primaryLabel = hasGatedCourt ? 'G' : hasEdgeCourt ? 'E' : '';
        const badgeText = [primaryLabel, hasHittingWallCourt ? 'H' : ''].filter(Boolean).join(' ');
        const badgeColor = hasGatedCourt ? 'rgba(255,215,0,1)' : 'rgba(255,200,50,0.9)';
        // Same combined flex-row top-right container as the single-court builder.
        const topRightHtml = (badgeText || slotLocked) ? `
        <div style="position: absolute; top: 2px; right: 4px; display: flex; align-items: center; gap: 3px;">
          ${badgeText ? `<span style="font-size: 11px; font-weight: bold; color: ${badgeColor};">${badgeText}</span>` : ''}
          ${lockIcon}
        </div>` : '';

        return `
    <div data-slot-wrapper data-from-minutes="${slot.fromInMinutes}">
      <div class="bc-slot-card border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible clickable"
           style="${disabledStyle}${hasGatedCourt ? ' border: 2px solid rgba(255,215,0,1);' : hasEdgeCourt ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${courtSummary}</div>
        ${topRightHtml}
        <div class="bc-court-expand" style="display: none; margin-top: 6px; text-align: left; padding: 0 4px;">
            ${expandedCourts}
        </div>
        ${openDateLabel ? `<div style="font-size: 10px; color: rgba(255,215,90,0.95); margin-top: 5px;">${openDateLabel}</div>` : ''}
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
    const getAvailabilityRenderPipeline = (() => {
        // Bay Club allows booking at most this many days in advance.
        // We mirror that in the helper so our lock icons and disabled styling match what the
        // native UI would consider bookable. If Bay Club adjusts this window, updating this
        // constant keeps our visual treatment aligned.
        const BOOKING_ADVANCE_DAYS = 3;
        let serviceInstance = null;

        return function getAvailabilityRenderPipeline() {
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

            function hideNativeAvailabilityContent(anchorElement) {
                // Hide native content but keep it in the DOM so we can secretly select a slot when users pick one of ours.
                Array.from(anchorElement.children).forEach(child => {
                    if (!child.classList.contains('all-clubs-availability')) {
                        child.style.display = 'none';
                        child.setAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR, '1');
                    }
                });
            }

            function appendRenderedAvailabilityHtml(anchorElement, html) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html;
                anchorElement.appendChild(wrapper.firstChild);
            }

            function initializeRenderControls(anchorElement, startMinutes, endMinutes) {
                const sliderWidget = anchorElement.querySelector('.bc-time-range-widget');
                if (sliderWidget) getTimeRangeSliderController().init(sliderWidget);
                initViewToggle(anchorElement);
                applyFilters(startMinutes, endMinutes);
            }

            function bindIndoorOnlyToggle(anchorElement) {
                const indoorCheckbox = anchorElement.querySelector('.bc-indoor-checkbox');
                if (!indoorCheckbox) return;

                indoorCheckbox.addEventListener('change', () => {
                    saveShowIndoorClubsOnly(indoorCheckbox.checked);
                    const { startMinutes: curStart, endMinutes: curEnd } = getTimeRange();
                    applyFilters(curStart, curEnd);
                });
            }

            function appendWeatherTicksWhenReady(anchorElement, fetchDate) {
                const RAIN_EMOJIS = ['🌧️', '🌦️', '⛈️'];
                getWeatherService().whenReady().then(() => {
                    const widget = anchorElement.querySelector('.bc-time-range-widget');
                    if (!widget) return;
                    widget.querySelectorAll('[data-tick-minutes]').forEach(tickDiv => {
                        if (tickDiv.querySelector('.bc-weather-tick')) return;
                        const fromMinutes = parseInt(tickDiv.dataset.tickMinutes);
                        const emoji = getWeatherService().emojiForHour(fetchDate, fromMinutes);
                        if (!emoji) return;
                        const emojiEl = document.createElement('div');
                        emojiEl.className = 'bc-weather-tick';
                        emojiEl.style.cssText = 'font-size: 12px; line-height: 1; margin-top: 2px; text-align: center;';
                        emojiEl.textContent = emoji;
                        if (RAIN_EMOJIS.includes(emoji)) {
                            const pct = getWeatherService().rainPctForHour(fetchDate, fromMinutes);
                            if (pct !== null && pct !== undefined) {
                                const pctEl = document.createElement('div');
                                pctEl.style.cssText = 'font-size: 9px; color: rgba(160,200,255,0.9); text-align: center;';
                                pctEl.textContent = `${pct}%`;
                                emojiEl.appendChild(pctEl);
                            }
                        }
                        tickDiv.appendChild(emojiEl);
                    });
                });
            }

            function bindSlotCardExpandCollapse(anchorElement) {
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
            }

            function selectCourtOption(anchorElement, el) {
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

                const lastFetchState = getBookingStateService().getLastFetchState();
                if (!lastFetchState) return;
                getBookingStateService().setPendingSlotBooking({
                    clubId: el.dataset.clubId,
                    courtId: el.dataset.courtId,
                    date: lastFetchState.params.date,
                    fromMinutes: parseInt(el.dataset.fromMinutes),
                    toMinutes: parseInt(el.dataset.toMinutes),
                });

                // Click the native slot to advance Angular's state machine. This must
                // happen before any bottom bar check — Firefox renders the bottom bar
                // asynchronously after the click, whereas Chrome pre-renders it in a
                // disabled state. Skipping the click because the bottom bar is absent
                // would leave Angular stuck and the Next button never appearing.
                const nativeSlot = document.querySelector('app-court-time-slot-item div.time-slot');
                if (nativeSlot) {
                    nativeSlot.click();
                } else {
                    console.log("No native slot to click");
                }

                // Update the bottom bar with our selection info and style the Next button.
                // In Chrome the bottom bar is already in the DOM so this runs immediately.
                // In Firefox it appears after Angular processes the click above, so we
                // observe and update once it arrives. The observer is bounded by a timeout
                // to avoid dangling if the bottom bar never appears for any reason.
                const slotInfoText = `${el.dataset.clubName} · ${el.dataset.court} @ ${el.dataset.from} - ${el.dataset.to}`;
                function tryUpdateBottomBar() {
                    const bottomBar = document.querySelector('.white-bg.p-2 .container');
                    if (!bottomBar) return false;
                    const selectedBookingInfoHolder = getOrCreateSelectedBookingInfoHolder(bottomBar);
                    const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                    if (nativeInfo) nativeInfo.style.display = 'none';
                    selectedBookingInfoHolder.textContent = slotInfoText;
                    const nextButton = Array.from(document.querySelectorAll('button.btn-light-blue'))
                        .find(btn => btn.textContent.trim().includes('NEXT'));
                    if (nextButton) {
                        nextButton.style.backgroundColor = 'rgb(0, 188, 212)';
                        nextButton.style.borderColor = 'rgb(0, 188, 212)';
                        nextButton.style.opacity = '1';
                        nextButton.style.cursor = 'pointer';
                        nextButton.removeAttribute('disabled');
                    }
                    return true;
                }
                if (!tryUpdateBottomBar()) {
                    const bottomBarObserver = new MutationObserver(() => {
                        if (tryUpdateBottomBar()) bottomBarObserver.disconnect();
                    });
                    bottomBarObserver.observe(document.body, { childList: true, subtree: true });
                    setTimeout(() => bottomBarObserver.disconnect(), 5000);
                }
            }

            function getRequiredPartnerCount() {
                const playersPref = getLocalStorageService().getString('bc_players');
                if (playersPref === 'Doubles') return 3;
                return 1;
            }

            // Renders a non-interactive self card for the logged-in user, shown as
            // the first item in the partner picker grid to match the native Bay Club
            // UI where the logged-in user appears pre-selected and cannot be removed.
            function buildSelfCardHtml(selfProfile, photoUrl) {
                const initials = (selfProfile.firstName[0] || '') + (selfProfile.lastName[0] || '');
                let hash = 0;
                const nameStr = selfProfile.firstName + selfProfile.lastName;
                for (let i = 0; i < nameStr.length; i++) {
                    hash = nameStr.charCodeAt(i) + ((hash << 5) - hash);
                }
                const hue = Math.abs(hash) % 360;
                const avatarHtml = photoUrl
                    ? `<img src="${photoUrl}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover;" alt="${selfProfile.firstName}">`
                    : `<div data-bc-initials style="width: 56px; height: 56px; border-radius: 50%; background: hsl(${hue}, 45%, 45%); display: flex; align-items: center; justify-content: center; color: white; font-size: 18px; font-weight: 600;">${initials}</div>`;
                return `<div data-bc-self-card style="display: flex; flex-direction: column; align-items: center; padding: 8px; border-radius: 8px; position: relative; min-width: 80px; pointer-events: none; cursor: default;">
                    <div style="position: relative;">
                        ${avatarHtml}
                        <div style="position: absolute; bottom: -2px; right: -2px; width: 20px; height: 20px; border-radius: 50%; background: rgba(160,160,160,0.9); color: white; display: flex; align-items: center; justify-content: center; font-size: 12px;">&#10003;</div>
                    </div>
                    <div style="margin-top: 4px; font-size: 12px; color: white; text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${selfProfile.firstName}</div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.6); text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${selfProfile.lastName}</div>
                </div>`;
            }

            function buildPlayerCardHtml(player, photoUrl) {
                const initials = ((player.firstName || '')[0] || '') + ((player.lastName || '')[0] || '');
                // Derive a background color from the player's name for the initials circle.
                let hash = 0;
                const nameStr = (player.firstName || '') + (player.lastName || '');
                for (let i = 0; i < nameStr.length; i++) {
                    hash = nameStr.charCodeAt(i) + ((hash << 5) - hash);
                }
                const hue = Math.abs(hash) % 360;

                const avatarHtml = photoUrl
                    ? `<img src="${photoUrl}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover;" alt="${player.firstName}">`
                    : `<div data-bc-initials style="width: 56px; height: 56px; border-radius: 50%; background: hsl(${hue}, 45%, 45%); display: flex; align-items: center; justify-content: center; color: white; font-size: 18px; font-weight: 600;">${initials}</div>`;

                return `<div class="bc-player-card" data-person-id="${player.personId}" data-member-id="${player.memberIdentifier || player.memberId || ''}"
                    data-first-name="${player.firstName || ''}" data-last-name="${player.lastName || ''}"
                    style="display: flex; flex-direction: column; align-items: center; padding: 8px; cursor: pointer; border-radius: 8px; position: relative; min-width: 80px;">
                    <div data-bc-avatar style="position: relative;">
                        ${avatarHtml}
                        <div class="bc-player-check" style="position: absolute; bottom: -2px; right: -2px; width: 20px; height: 20px; border-radius: 50%; background: rgb(0,188,212); color: white; display: none; align-items: center; justify-content: center; font-size: 12px;">&#10003;</div>
                    </div>
                    <div style="margin-top: 4px; font-size: 12px; color: white; text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${player.firstName || ''}</div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.6); text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${player.lastName || ''}</div>
                </div>`;
            }

            function buildSchedulePanelHtml(slotInfo, players, photosByMemberId) {
                const requiredPartners = getRequiredPartnerCount();
                const partnerLabel = requiredPartners === 1 ? 'Select 1 partner' : `Select ${requiredPartners} partners`;

                const fireAt = new Date(getScheduledBookingService().computeFireAtMs(slotInfo.date, slotInfo.fromMinutes));
                const fireAtIsToday = fireAt.toDateString() === new Date().toDateString();
                const fireAtTimeLabel = fireAt.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
                const fireAtLabel = fireAtIsToday
                    ? `today at ${fireAtTimeLabel}`
                    : fireAt.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

                const selfProfile = getLocalStorageService().getJson('bc_self_profile', '[bc] failed to parse self profile');
                const selfPhotoUrl = selfProfile && selfProfile.memberId
                    ? getScheduledBookingService().getPlayerPhotoUrl(selfProfile.memberId, photosByMemberId)
                    : null;
                const playerCardsHtml = (selfProfile ? buildSelfCardHtml(selfProfile, selfPhotoUrl) : '') +
                    players.map(player => {
                        const photoUrl = getScheduledBookingService().getPlayerPhotoUrl(player.memberIdentifier || player.memberId, photosByMemberId);
                        return buildPlayerCardHtml(player, photoUrl);
                    }).join('');

                return `<div data-bc-schedule-panel style="padding: 16px;">
                    <div style="display: flex; align-items: center; margin-bottom: 16px;">
                        <button data-bc-schedule-back style="background: none; border: none; color: rgb(0,188,212); font-size: 14px; cursor: pointer; padding: 4px 8px; margin-right: 8px;">&#8592; Back</button>
                        <div style="font-size: 18px; font-weight: 600; color: white;">Schedule Booking</div>
                    </div>
                    <div style="background: rgba(255,255,255,0.08); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                        <div style="font-size: 14px; color: white; font-weight: 500;">${slotInfo.clubName} \u00b7 ${slotInfo.courtName}</div>
                        <div style="font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 4px;">${slotInfo.fromTime}\u2013${slotInfo.toTime} \u00b7 ${slotInfo.dateLabel}</div>
                        <div style="font-size: 12px; color: rgb(0,188,212); margin-top: 6px;">Opens ${fireAtLabel} \u2014 books automatically</div>
                    </div>
                    <div data-bc-buddy-vis-toggle data-checked="true" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid rgba(0,188,212,0.3); border-bottom: 1px solid rgba(0,188,212,0.3); margin-bottom: 12px; cursor: pointer;">
                        <span style="font-size: 13px; color: rgba(255,255,255,0.85);">Show to Buddy List</span>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span data-bc-buddy-vis-label style="font-size: 12px; font-weight: 600; color: rgb(0,188,212);">On</span>
                            <div style="position: relative; width: 40px; height: 22px; flex-shrink: 0;">
                                <div data-bc-toggle-track style="width: 40px; height: 22px; border-radius: 11px; background: rgb(0,188,212);"></div>
                                <div data-bc-toggle-thumb style="position: absolute; top: 3px; right: 3px; left: auto; width: 16px; height: 16px; border-radius: 50%; background: white; transition: left 0.15s, right 0.15s;"></div>
                            </div>
                        </div>
                    </div>
                    <div data-bc-partner-prompt style="font-size: 14px; color: #ef5350; margin-bottom: 12px; font-weight: 500;">${partnerLabel}</div>
                    <div data-bc-player-grid style="display: grid; grid-template-columns: repeat(auto-fill, 96px); justify-content: center; gap: 8px; margin: 0 auto 20px; max-width: 420px;">
                        ${playerCardsHtml}
                    </div>
                    <div style="display: flex; justify-content: center; gap: 12px; align-items: center;">
                        <button data-bc-schedule-submit disabled style="background: rgba(0,188,212,0.4); color: white; border: none; border-radius: 4px; padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: not-allowed; opacity: 0.6;">Schedule</button>
                        <button data-bc-schedule-cancel style="background: none; border: none; color: rgba(255,255,255,0.85); font-size: 13px; cursor: pointer; text-decoration: underline;">Cancel</button>
                    </div>
                </div>`;
            }

            function bindSchedulePanelInteractions(panel, _anchorElement, slotInfo) {
                const requiredPartners = getRequiredPartnerCount();

                function updatePartnerPromptAndSubmitButton() {
                    const selectedCount = panel.querySelectorAll('.bc-player-card[data-player-selected]:not([data-current-user])').length;
                    const prompt = panel.querySelector('[data-bc-partner-prompt]');
                    const submitBtn = panel.querySelector('[data-bc-schedule-submit]');
                    const remaining = requiredPartners - selectedCount;

                    if (remaining > 0) {
                        prompt.textContent = remaining === 1 ? 'Select 1 more partner' : `Select ${remaining} more partners`;
                        prompt.style.color = '#ef5350';
                        submitBtn.disabled = true;
                        submitBtn.style.opacity = '0.6';
                        submitBtn.style.cursor = 'not-allowed';
                        submitBtn.style.background = 'rgba(0,188,212,0.4)';
                    } else {
                        prompt.textContent = `${requiredPartners} partner${requiredPartners > 1 ? 's' : ''} selected`;
                        prompt.style.color = 'rgb(0,188,212)';
                        submitBtn.disabled = false;
                        submitBtn.style.opacity = '1';
                        submitBtn.style.cursor = 'pointer';
                        submitBtn.style.background = 'rgb(0,188,212)';
                    }
                }

                // Player card selection toggle.
                panel.querySelectorAll('.bc-player-card').forEach(card => {
                    if (card.dataset.currentUser) return;
                    card.addEventListener('click', () => {
                        const isSelected = card.hasAttribute('data-player-selected');
                        const checkEl = card.querySelector('.bc-player-check');
                        if (isSelected) {
                            card.removeAttribute('data-player-selected');
                            if (checkEl) checkEl.style.display = 'none';
                            card.style.background = '';
                        } else {
                            // Enforce max selection count.
                            const currentSelected = panel.querySelectorAll('.bc-player-card[data-player-selected]:not([data-current-user])').length;
                            if (currentSelected >= requiredPartners) return;
                            card.setAttribute('data-player-selected', '1');
                            if (checkEl) checkEl.style.display = 'flex';
                            card.style.background = 'rgba(0,188,212,0.15)';
                        }
                        updatePartnerPromptAndSubmitButton();
                    });
                });

                // Back and cancel buttons return to the slot grid.
                function returnToSlotGrid() {
                    // Remove all panel instances — one may exist per injection host.
                    document.querySelectorAll('[data-bc-schedule-panel]').forEach(p => p.remove());
                    document.querySelectorAll('.all-clubs-availability').forEach(el => { el.style.display = ''; });
                    // Restore the Next button visibility and put it back in its normal disabled state.
                    const nextButton = Array.from(document.querySelectorAll('button.btn-light-blue'))
                        .find(btn => btn.textContent.trim().includes('NEXT'));
                    if (nextButton) nextButton.style.display = '';
                    initNextButton();
                }

                panel.querySelector('[data-bc-schedule-back]')?.addEventListener('click', returnToSlotGrid);
                panel.querySelector('[data-bc-schedule-cancel]')?.addEventListener('click', returnToSlotGrid);

                // Buddy visibility toggle.
                const buddyVisToggle = panel.querySelector('[data-bc-buddy-vis-toggle]');
                if (buddyVisToggle) {
                    buddyVisToggle.addEventListener('click', () => {
                        const isOn = buddyVisToggle.dataset.checked !== 'true';
                        buddyVisToggle.dataset.checked = String(isOn);
                        const label = buddyVisToggle.querySelector('[data-bc-buddy-vis-label]');
                        const track = buddyVisToggle.querySelector('[data-bc-toggle-track]');
                        const thumb = buddyVisToggle.querySelector('[data-bc-toggle-thumb]');
                        if (label) {
                            label.textContent = isOn ? 'On' : 'Off';
                            label.style.color = isOn ? 'rgb(0,188,212)' : 'rgba(255,255,255,0.5)';
                        }
                        if (track) track.style.background = isOn ? 'rgb(0,188,212)' : 'rgba(255,255,255,0.2)';
                        if (thumb) {
                            thumb.style.right = isOn ? '3px' : 'auto';
                            thumb.style.left = isOn ? 'auto' : '3px';
                        }
                    });
                }

                // Schedule button submits the booking. Guard against double-submit when the
                // panel is injected into multiple hosts for responsive layout support.
                panel.querySelector('[data-bc-schedule-submit]')?.addEventListener('click', async () => {
                    if (document.querySelector('[data-bc-schedule-panel][data-bc-submitting]')) return;
                    panel.setAttribute('data-bc-submitting', '1');
                    const selectedCards = panel.querySelectorAll('.bc-player-card[data-player-selected]:not([data-current-user])');
                    const selectedPartners = Array.from(selectedCards).map(card => ({
                        personId: card.dataset.personId,
                        firstName: card.dataset.firstName,
                        lastName: card.dataset.lastName,
                    }));
                    const isVisibleToBuddies = !buddyVisToggle || buddyVisToggle.dataset.checked !== 'false';

                    try {
                        await getScheduledBookingService().scheduleBooking(slotInfo, selectedPartners, isVisibleToBuddies);
                        window.location.href = '/bookings';
                    } catch (error) {
                        console.log('[bc] failed to schedule booking:', error);
                        const prompt = panel.querySelector('[data-bc-partner-prompt]');
                        if (prompt) {
                            prompt.textContent = `Error: ${error.message}`;
                            prompt.style.color = '#ef5350';
                        }
                    }
                });
            }

            async function handleLockedSlotClick(anchorElement, el) {
                let players, photosByMemberId;
                try {
                    ({ players, photosByMemberId } = await getScheduledBookingService().fetchPossiblePlayers());
                } catch (error) {
                    console.log('[bc] failed to load partner picker:', error);
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'color: #ef5350; font-size: 11px; padding: 4px; margin-top: 4px;';
                    errorDiv.textContent = error.message || 'Failed to load partners.';
                    el.parentElement?.appendChild(errorDiv);
                    setTimeout(() => errorDiv.remove(), 5000);
                    return;
                }

                const lastFetchState = getBookingStateService().getLastFetchState();
                const slotInfo = {
                    clubId: el.dataset.clubId,
                    courtId: el.dataset.courtId,
                    courtName: el.dataset.court,
                    clubName: el.dataset.clubName,
                    date: lastFetchState?.params?.date,
                    fromMinutes: parseInt(el.dataset.fromMinutes),
                    toMinutes: parseInt(el.dataset.toMinutes),
                    fromTime: el.dataset.from,
                    toTime: el.dataset.to,
                    dateLabel: lastFetchState?.params?.date
                        ? new Date(lastFetchState.params.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        : '',
                };

                // Hide all availability grids (both desktop and mobile injection hosts) so
                // neither shows through when the browser is resized across the layout breakpoint.
                document.querySelectorAll('.all-clubs-availability').forEach(el => { el.style.display = 'none'; });

                // Hide the Next button — it only drives the Angular state machine and has no
                // role in the scheduled booking flow.
                const nextButton = Array.from(document.querySelectorAll('button.btn-light-blue'))
                    .find(btn => btn.textContent.trim().includes('NEXT'));
                if (nextButton) nextButton.style.display = 'none';

                // Inject the panel into every active time slot host so it remains visible
                // when the browser is resized across the Bootstrap responsive breakpoint.
                const panelHtml = buildSchedulePanelHtml(slotInfo, players, photosByMemberId);
                const allHosts = getBookingDomQueryService().getTimeSlotHosts();
                const hostsToUse = allHosts.length > 0 ? allHosts : [anchorElement];
                hostsToUse.forEach(host => {
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = panelHtml;
                    host.appendChild(wrapper.firstElementChild);
                    const hostPanel = host.querySelector('[data-bc-schedule-panel]');
                    if (hostPanel) {
                        bindSchedulePanelInteractions(hostPanel, anchorElement, slotInfo);
                    }
                });

                // Fetch fresh photos as needed. The logged-in user is never in the possible
                // players list (you cannot invite yourself), so their photo must be fetched
                // separately even when other player photos are already cached.
                const selfProfileForPhoto = getLocalStorageService().getJson('bc_self_profile', '[bc] failed to parse self profile');
                const selfMemberId = selfProfileForPhoto && selfProfileForPhoto.memberId;
                const selfPhotoMissing = selfMemberId && !photosByMemberId[selfMemberId];
                const hasCachedPhotosForPlayers = Object.keys(photosByMemberId).length > 0;

                let freshPhotos = null;
                if (!hasCachedPhotosForPlayers) {
                    // Cache is empty: fetch photos for all players and the logged-in user together.
                    const playersForPhotos = selfMemberId ? players.concat([{ memberId: selfMemberId }]) : players;
                    freshPhotos = await getScheduledBookingService().fetchPhotos(playersForPhotos);
                } else if (selfPhotoMissing) {
                    // Player photos are cached but the logged-in user's photo is absent: fetch only self.
                    freshPhotos = await getScheduledBookingService().fetchPhotos([{ memberId: selfMemberId }]);
                }

                if (freshPhotos) {
                    // Swap initials to photos for partner cards across all panel instances.
                    document.querySelectorAll('[data-bc-schedule-panel] .bc-player-card').forEach(card => {
                        const memberId = card.dataset.memberId;
                        const photoInfo = freshPhotos[memberId];
                        if (!photoInfo || !photoInfo.photoId) return;
                        const initialsEl = card.querySelector('[data-bc-initials]');
                        if (!initialsEl) return;
                        const photoUrl = getScheduledBookingService().getPlayerPhotoUrl(memberId, freshPhotos);
                        const img = document.createElement('img');
                        img.src = photoUrl;
                        img.style.cssText = 'width: 56px; height: 56px; border-radius: 50%; object-fit: cover;';
                        img.alt = card.dataset.firstName || '';
                        initialsEl.replaceWith(img);
                    });
                    // Swap initials to photo for the self card — fetched above since self
                    // is never in the possible players list.
                    if (selfPhotoMissing || !hasCachedPhotosForPlayers) {
                        const selfCard = document.querySelector('[data-bc-schedule-panel] [data-bc-self-card]');
                        if (selfCard && selfMemberId) {
                            const photoInfo = freshPhotos[selfMemberId];
                            const initialsEl = selfCard.querySelector('[data-bc-initials]');
                            if (photoInfo && photoInfo.photoId && initialsEl) {
                                const photoUrl = getScheduledBookingService().getPlayerPhotoUrl(selfMemberId, freshPhotos);
                                if (photoUrl) {
                                    const img = document.createElement('img');
                                    img.src = photoUrl;
                                    img.style.cssText = 'width: 56px; height: 56px; border-radius: 50%; object-fit: cover;';
                                    img.alt = (selfProfileForPhoto && selfProfileForPhoto.firstName) || '';
                                    initialsEl.replaceWith(img);
                                }
                            }
                        }
                    }
                }
            }

            function bindCourtOptionSelection(anchorElement) {
                // Select a specific court when an expanded court option or single-court card is clicked.
                anchorElement.querySelectorAll('.bc-court-option').forEach(el => {
                    el.addEventListener('click', () => {
                        if (el.dataset.slotLocked === '1') {
                            handleLockedSlotClick(anchorElement, el);
                        } else {
                            selectCourtOption(anchorElement, el);
                        }
                    });
                });
            }

            function wirePostRenderInteractions(anchorElement, startMinutes, endMinutes, fetchDate) {
                initializeRenderControls(anchorElement, startMinutes, endMinutes);
                bindIndoorOnlyToggle(anchorElement);
                bindDebugPanelControls(anchorElement);
                appendWeatherTicksWhenReady(anchorElement, fetchDate);
                initNextButton();
                bindSlotCardExpandCollapse(anchorElement);
                bindCourtOptionSelection(anchorElement);
            }

            function renderAllClubsAvailability(transformed, anchorElement, fetchDate) {
                const limitDate = new Date();
                limitDate.setDate(limitDate.getDate() + BOOKING_ADVANCE_DAYS);
                // Floor to current 30-minute window start.
                const mins = limitDate.getMinutes();
                limitDate.setMinutes(mins < 30 ? 0 : 30, 0, 0);

                const lastFetchState = getBookingStateService().getLastFetchState();
                if (!lastFetchState) return;
                const failedClubIdsSet = new Set(lastFetchState.failedClubIds || []);
                const { allClubIds, clubMeta, byClubAndTod } = buildClubIndex(transformed, failedClubIdsSet);

                const { startMinutes, endMinutes } = getTimeRange();
                let html = `<div class="all-clubs-availability" style="margin-top: 12px; padding-bottom: 200px;">`;
                html += buildShowIndoorCourtsOnlyToggleHtml();
                html += buildTimeRangeSliderHtml(startMinutes, endMinutes);
                html += buildViewToggleHtml();
                html += buildDebugPanelHtml(DEBUG_PANEL_SURFACE_AVAILABILITY);
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

                hideNativeAvailabilityContent(anchorElement);
                appendRenderedAvailabilityHtml(anchorElement, html);
                wirePostRenderInteractions(anchorElement, startMinutes, endMinutes, fetchDate);
            }

            serviceInstance = {
                applyFilters,
                renderAllClubsAvailability,
            };
            return serviceInstance;
        };
    })();
    // #endregion Availability rendering and interaction pipeline.

    // #region Booking flow monitor and DOM injection.
    function clearBookingStateAndUi() {
        getDebugService().log('info', 'booking-flow-state-cleared', null);
        getBookingStateService().abortFetch();
        getBookingStateService().clearLastFetchState();
        getBookingStateService().clearPendingSlotBooking();
        removeOurContentAndUnhideNativeContent();
    }

    function runBookingDomTasks() {
        const bookingDomQueryService = getBookingDomQueryService();
        // Clear injected slot UI only when we are inside the booking flow shell but none of the
        // supported booking-step hosts are present. This avoids brittle title-text matching and
        // preserves behavior on the duration/player screen where controls still need augmentation.
        if (bookingDomQueryService.hasBookingFlowShellVisible() &&
            !bookingDomQueryService.hasTimeSlotHostsVisible() &&
            !bookingDomQueryService.hasHourViewControlsVisible() &&
            !bookingDomQueryService.hasDurationAndPlayersFilterVisible()) {
            getDebugService().log('info', 'stale-injected-slot-ui-cleared', {
                reason: 'booking-shell-visible-without-supported-step-hosts',
            });
            getBookingStateService().clearPendingSlotBooking();
            removeOurContentAndUnhideNativeContent();
            return;
        }

        injectIntoAllContainers();
        const container = bookingDomQueryService.getDurationAndPlayersFilterContainer();
        if (container) {
            if (!container.nextSibling?.classList?.contains('bc-club-order-widget')) {
                injectClubOrderWidget();
            }
            injectDurationFlowDebugPanel(container);
            getPreferenceAutoSelectService().autoSelectPlayersAndDuration();
        }
        autoSelectPickleballSportIfAvailable();
    }

    const createBookingFlowMonitor = (() => {
        let alreadyInitialized = false;

        return function createBookingFlowMonitor() {
            if (alreadyInitialized) return;
            alreadyInitialized = true;

            const BOOKING_FLOW_CONTAINER_OBSERVER_KEY = 'booking-flow-container-observer';
            const BOOKING_FLOW_NAVIGATION_POLLER_KEY = 'booking-flow-navigation-poller';
            const BOOKING_FLOW_BOOTSTRAP_POLLER_KEY = 'booking-flow-bootstrap-poller';
            const observersByKey = new Map();
            const intervalsByKey = new Map();

            // Keep watcher lifecycle state private so we do not leak more script-level mutable state.
            // This monitor has two modes:
            // 1) Active booking mode: observers and fast URL pollers are on.
            // 2) Bootstrap mode: only a slow re-entry poller is on.
            // Why we need both: this Angular SPA often swaps what look like full screens without
            // reliable URL updates or consistently observable history events. In practice we may see
            // no pushState/replaceState/popstate for transitions that still require cleanup and
            // reinitialization. So we use event hooks first, with polling as a reliability backstop.
            let lastObservedHref = location.href;
            let isMonitoringBookingFlow = false;
            let historyMonitoringInstalled = false;
            let visibilityMonitoringInstalled = false;
            let backToHomeClickMonitoringInstalled = false;
            let bookingDomTasksScheduled = false;

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
                    if (!getBookingDomQueryService().isBackControlClickTarget(target)) return;

                    clearBookingStateAndUi();
                }, true);
            }

            // As a single page app, we get very few hints as to when user actions trigger what appears
            // to be a screen update. The URL rarely changes, and we often see few pushState/popstate
            // events. We keep this observer active only while we are in the booking flow.
            function startContainerChangeObserver() {
                ensureObserver(
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
                clearObserver(BOOKING_FLOW_CONTAINER_OBSERVER_KEY);
            }

            function startNavigationPoller() {
                lastObservedHref = location.href;
                // Poll quickly inside booking flow. The UI can move between booking sub-screens
                // without reliable history signals, and sometimes without a visible URL change
                // until after Angular has already swapped DOM.
                ensureInterval(
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
                clearIntervalByKey(BOOKING_FLOW_NAVIGATION_POLLER_KEY);
            }

            function startBootstrapPoller() {
                // Poll slowly outside booking flow to detect re-entry while avoiding always-on,
                // heavyweight monitoring on unrelated app pages.
                ensureInterval(
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
                clearIntervalByKey(BOOKING_FLOW_BOOTSTRAP_POLLER_KEY);
            }

            function startBookingFlowActiveWatchers() {
                startContainerChangeObserver();
                startNavigationPoller();
            }

            function stopBookingFlowActiveWatchers() {
                stopContainerChangeObserver();
                stopNavigationPoller();
            }

            function stopAllBookingFlowWatchersAndPollers() {
                stopBookingFlowActiveWatchers();
                stopBootstrapPoller();
            }

            function startBookingFlowMonitoring() {
                if (isMonitoringBookingFlow) return;
                isMonitoringBookingFlow = true;
                getDebugService().log('info', 'booking-flow-monitor-entered', { href: location.href });
                stopBootstrapPoller();
                if (document.visibilityState === 'hidden') return;
                startBookingFlowActiveWatchers();
                // Run once immediately so controls are auto-selected before the next mutation tick.
                runBookingDomTasks();
            }

            function stopBookingFlowMonitoring() {
                if (!isMonitoringBookingFlow) return;
                isMonitoringBookingFlow = false;
                getDebugService().log('info', 'booking-flow-monitor-exited', { href: location.href });
                stopBookingFlowActiveWatchers();
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
                // Only clear and stop when transitioning from active booking mode.
                if (!isMonitoringBookingFlow) return;
                getDebugService().log('info', 'booking-flow-transitioned-away', { href: location.href });
                clearBookingStateAndUi();
                stopBookingFlowMonitoring();
            }

            function installHistoryMonitoring() {
                if (historyMonitoringInstalled) return;
                historyMonitoringInstalled = true;

                const originalPushState = history.pushState;
                const originalReplaceState = history.replaceState;

                // We intentionally leave these wrappers installed for the page lifetime.
                // Restoring and reinstalling them around booking-flow transitions increases the
                // chance of missing SPA transitions that do not emit consistent navigation signals.
                // The wrapper cost is low, and heavyweight work remains gated by monitor state.
                history.pushState = function (...args) {
                    originalPushState.apply(this, args);
                    evaluateBookingFlowMonitoringState();
                };

                history.replaceState = function (...args) {
                    originalReplaceState.apply(this, args);
                    evaluateBookingFlowMonitoringState();
                };

                window.addEventListener('popstate', function () {
                    evaluateBookingFlowMonitoringState();
                });
            }

            // This SPA can navigate internally while a tab is backgrounded, and we do not need to
            // spend CPU tracking those transitions in real time while hidden. We pause all monitor
            // activity on hide, then perform an immediate state reconciliation on visibility return.
            function pauseBookingFlowMonitoringWhileHidden() {
                // Pause all monitoring work while the tab is hidden.
                getDebugService().log('info', 'booking-flow-monitor-paused-hidden-tab', null);
                stopAllBookingFlowWatchersAndPollers();
                bookingDomTasksScheduled = false;
            }

            function resumeBookingFlowMonitoringAfterVisible() {
                // Resume immediately when visible so we do not miss latent SPA transitions.
                getDebugService().log('info', 'booking-flow-monitor-resumed-visible-tab', null);
                if (isMonitoringBookingFlow) {
                    // If we were actively monitoring booking flow before hiding, restore the active
                    // observers and poller first, then immediately reconcile to catch latent changes.
                    startBookingFlowActiveWatchers();
                    evaluateBookingFlowMonitoringState();
                    if (isMonitoringBookingFlow) {
                        runBookingDomTasks();
                    }
                    return;
                }

                // If we were not in active booking mode, restart lightweight bootstrap detection
                // and evaluate immediately in case the app moved into booking flow while hidden.
                startBootstrapPoller();
                evaluateBookingFlowMonitoringState();
            }

            function installVisibilityMonitoring() {
                if (visibilityMonitoringInstalled) return;
                visibilityMonitoringInstalled = true;

                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'hidden') {
                        pauseBookingFlowMonitoringWhileHidden();
                        return;
                    }
                    resumeBookingFlowMonitoringAfterVisible();
                });
            }

            function initialize() {
                // Start in lightweight mode and let state evaluation upgrade to active mode if needed.
                installHistoryMonitoring();
                installVisibilityMonitoring();
                installBackToHomeClickMonitoring();
                startBootstrapPoller();
                evaluateBookingFlowMonitoringState();
                getDebugService().log('info', 'booking-flow-monitor-initialized', null);
            }

            initialize();
        };
    })();


    function removeOurContentAndUnhideNativeContent() {
        document.querySelectorAll('.all-clubs-availability').forEach(el => el.remove());
        document.querySelectorAll(`.bc-debug-panel[data-bc-debug-surface="${DEBUG_PANEL_SURFACE_DURATION}"]`).forEach(el => el.remove());
        document.querySelectorAll(`[${getBookingDomQueryService().NATIVE_HIDDEN_ATTR}="1"]`).forEach(child => {
            child.style.display = '';
            child.removeAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR);
        });
    }

    // Angular supports mobile and desktop views/containers, and renders them differently. We want
    // to make sure we can handle either.
    function injectIntoAllContainers() {
        const lastFetchState = getBookingStateService().getLastFetchState();
        if (!lastFetchState) return;
        const bookingDomQueryService = getBookingDomQueryService();

        document.querySelectorAll('app-court-select').forEach(el => {
            el.closest('.ng-star-inserted')
                ? el.closest('.ng-star-inserted').style.display = 'none'
                : el.style.display = 'none';
        });

        const hourViewBtn = bookingDomQueryService.findHourViewButton();
        if (hourViewBtn && !hourViewBtn.classList.contains('btn-selected') && !hourViewBtn.dataset.bcAutoSelected) {
            hourViewBtn.dataset.bcAutoSelected = 'true';
            hourViewBtn.click();
        }

        bookingDomQueryService.getTimeSlotHosts().forEach(host => {
            if (host.querySelector('.all-clubs-availability')) return;
            getAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, host, lastFetchState.params.date);
        });
    }
    // #endregion Booking flow monitor and DOM injection.

    // #region Cross-club fetch and weather enrichment.
    // Fetch availability info for all the clubs in parallel, and combine their results.
    async function fetchAllClubs(params) {
        getDebugService().log('info', 'cross-club-fetch-started', {
            date: params.date,
            categoryCode: params.categoryCode,
            timeSlotId: params.timeSlotId,
        });
        const signal = getBookingStateService().beginFetch();

        try {
            const settled = await Promise.all(Object.values(CLUBS).map(clubId => {
                const timeSlotId = CLUB_MAX_TIMESLOT[clubId] &&
                    params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : params.timeSlotId;
                return fetch(`https://connect-api.bayclubs.io/court-booking/api/1.0/availability?clubId=${clubId}&date=${params.date}&categoryCode=${params.categoryCode}&categoryOptionsId=${params.categoryOptionsId}&timeSlotId=${timeSlotId}`, {
                    signal,
                    headers: {
                        'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                        'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
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
                    getDebugService().log('warn', 'cross-club-fetch-failed-for-club', {
                        clubId: result.clubId,
                        error: result.error?.message || String(result.error),
                    });
                } else {
                    successfulResults.push(result.data);
                }
            });

            getDebugService().log('info', 'cross-club-fetch-finished', {
                successCount: successfulResults.length,
                failedCount: failedClubIds.length,
            });

            if (successfulResults.length === 0) {
                showHelperFailureBannerAndRestoreNative(
                    'cross-club-all-failed',
                    'The helper could not load court availability across clubs. This can happen if Bay Club changes their court APIs or there is a temporary network or server issue. Please use the native Hour View below for now.',
                    {
                        failedClubIds,
                        date: params.date,
                        categoryCode: params.categoryCode,
                        timeSlotId: params.timeSlotId,
                    }
                );
                return;
            }

            let transformed;
            try {
                transformed = transformAvailability(successfulResults);
            } catch (error) {
                getDebugService().log('error', 'availability-transform-failed', {
                    message: error?.message || String(error),
                });
                showHelperFailureBannerAndRestoreNative(
                    'availability-transform-failed',
                    'The helper could not understand the format of the court availability response. This usually means Bay Club changed how their availability API works.',
                    {
                        failedClubIds,
                        date: params.date,
                        categoryCode: params.categoryCode,
                        timeSlotId: params.timeSlotId,
                    }
                );
                return;
            }

            getBookingStateService().setLastFetchState({ transformed, params, failedClubIds });
            removeOurContentAndUnhideNativeContent();
            injectIntoAllContainers();
        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('[fetch] aborted');
                getDebugService().log('info', 'cross-club-fetch-aborted', null);
            } else {
                getDebugService().log('error', 'cross-club-fetch-threw', { message: e?.message || String(e) });
                showHelperFailureBannerAndRestoreNative(
                    'cross-club-fetch-threw',
                    'The helper hit an unexpected error while loading court availability. The native Hour View is available below.',
                    null
                );
            }
        }
    }

    const getWeatherService = (() => {
        let serviceInstance = null;

        return function getWeatherService() {
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
    // #endregion Cross-club fetch and weather enrichment.

    // #region Startup installers and bootstrap.
    const createCardSelectionStyleInstaller = (() => {
        let alreadyInstalled = false;

        return function createCardSelectionStyleInstaller() {
            if (alreadyInstalled) return;
            alreadyInstalled = true;
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
    .bc-debug-panel .btn.btn-outline-dark-grey {
        color: #e5e5e5;
        border-color: #a6aaae;
        background-color: rgba(255, 255, 255, 0.06);
        font-weight: 700;
    }
    .bc-debug-panel {
        position: relative;
        z-index: 2;
        pointer-events: auto;
    }
    .bc-debug-panel * {
        pointer-events: auto;
    }
    .bc-debug-panel .btn.btn-outline-dark-grey:hover {
        color: #fff;
        border-color: #2c9ab8;
        background-color: rgba(44, 154, 184, 0.2) !important;
    }
    .bc-debug-panel .btn.bc-debug-action:focus,
    .bc-debug-panel .btn.bc-debug-action:focus-visible {
        color: #e5e5e5;
        border-color: #a6aaae;
        background-color: rgba(255, 255, 255, 0.06) !important;
        box-shadow: none;
    }
    .bc-debug-panel .btn.btn-outline-dark-grey:active,
    .bc-debug-panel .btn.btn-outline-dark-grey.btn-selected {
        color: #e5e5e5;
        border-color: #a6aaae;
        background-color: rgba(255, 255, 255, 0.06) !important;
        font-weight: 700;
    }
    .bc-calendar-action {
        margin-top: 8px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }
    .bc-calendar-icon {
        font-size: 13px;
        line-height: 1;
    }
    .bc-calendar-add-link {
        color: rgb(0, 188, 212);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        text-decoration: none;
        letter-spacing: 0.02em;
    }
    .bc-calendar-add-link:hover,
    .bc-calendar-add-link:focus {
        color: rgb(102, 225, 241);
        text-decoration: underline;
    }
    .bc-calendar-ics-link {
        color: rgb(0, 188, 212);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        text-decoration: none;
    }
    .bc-calendar-ics-link:hover,
    .bc-calendar-ics-link:focus {
        color: rgb(102, 225, 241);
        text-decoration: underline;
    }
    @media (max-width: 768px) {
        .bc-tick-colon-zero { display: none; }
        .bc-tick-ampm { display: none; }
    }
`;
            document.head.appendChild(style);
        };
    })();


    // Start script services and monitoring.
    installXhrInterceptors();
    createCardSelectionStyleInstaller();
    createBookingsCalendarExportInstaller();
    createDashboardDebugActivationMonitor();
    createBookingFlowMonitor();
    getPreferenceSyncService().initializeOnPageLoad();
    getScheduledBookingService().initializeOnPageLoad();
    // #endregion Startup installers and bootstrap.
})();
