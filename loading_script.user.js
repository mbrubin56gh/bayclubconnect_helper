/*jslint esversion: 11 */
// ==UserScript==
// @name         Bay Club Connect Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      1.04
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

    // Angular's native Court View grid for Bay Club pickleball starts at 5:00 AM.
    // Slot indices within a column are multiplied by 30 minutes and added to this
    // base to derive the fromMinutes for a clicked slot.
    const COURT_VIEW_GRID_START_MINUTES = 300;

    const TIME_OF_DAYS = ['Morning', 'Afternoon', 'Evening'];

    // Edge courts are preferable because you have fewer courts potentially hitting balls onto your court, and
    // it makes you less likely to spray balls onto another court, especially when using a pickleball machine.
    const EDGE_COURTS = {
        [CLUBS.broadway]: ['Pickleball 1', 'Pickleball 2', 'Pickleball 5', 'Pickleball 6'],
        [CLUBS.redwoodShores]: ['*'], // all courts are edge courts; '*' matches any name
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

    // Centralized localStorage keys used across services.
    const STORAGE_KEYS = Object.freeze({
        CLUB_ORDER: 'bc_club_order',
        VIEW_MODE: 'bc_view_mode',
        INDOOR_ONLY: 'bc_indoor_only',
        TIME_RANGE: 'bc_time_range',
        PLAYERS: 'bc_players',
        DURATION: 'bc_duration',
        DEBUG_ENABLED: 'bc_debug_enabled',
        DEBUG_ENTRIES: 'bc_debug_entries',
        POSSIBLE_PLAYERS: 'bc_possible_players',
        PLAYER_PHOTOS: 'bc_player_photos',
        NOTIFICATION_EMAIL: 'bc_notification_email',
        SELF_PROFILE: 'bc_self_profile',
        POD_MEMBER_IDS: 'bc_pod_member_ids',
        COURT_VIEW_CLUB: 'bc_court_view_club',
        BOOKING_VIEW: 'bc_booking_view',
    });
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
            let rawFetchResults = null;
            let mergedCourtsOrder = null;

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

            function setMergedCourtsOrder(order) {
                mergedCourtsOrder = order;
            }

            function getMergedCourtsOrder() {
                return mergedCourtsOrder;
            }

            function setRawFetchResults(results) {
                rawFetchResults = results;
            }

            function getRawFetchResults() {
                return rawFetchResults;
            }

            function clearRawFetchState() {
                rawFetchResults = null;
                mergedCourtsOrder = null;
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
                setMergedCourtsOrder,
                getMergedCourtsOrder,
                setRawFetchResults,
                getRawFetchResults,
                clearRawFetchState,
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

        // Build a merged availability payload from one raw API result (the native home-club
        // response) and our parallel-fetched raw results for all clubs.  All clubs' courts
        // and availableTimeSlots are merged into the first clubsAvailabilities entry so Angular
        // renders every court as a native column in the Court View.  Each court object is
        // annotated with a bc_clubId property so we can tag the rendered DOM columns later.
        function buildMergedAvailabilityPayload(nativeData, rawResults) {
            // Deep-clone to avoid mutating objects Angular may still hold references to.
            const merged = JSON.parse(JSON.stringify(nativeData));
            const target = merged.clubsAvailabilities[0];

            // Index courts and slots already present (from the native home-club response).
            const seenCourtIds = new Set((target.courts || []).map(c => c.courtId));

            // Annotate the home club's courts with their club ID.
            const homeClubId = target.club?.id;
            for (const court of (target.courts || [])) {
                court.bc_clubId = homeClubId;
            }
            for (const slot of (target.availableTimeSlots || [])) {
                slot.bc_clubId = homeClubId;
            }

            // Merge courts and slots from all other clubs' responses.
            for (const result of rawResults) {
                for (const clubAvail of (result.clubsAvailabilities || [])) {
                    const clubId = clubAvail.club?.id;
                    // Skip the home club — its data is already in the target entry.
                    if (clubId === homeClubId) continue;

                    for (const court of (clubAvail.courts || [])) {
                        if (!seenCourtIds.has(court.courtId)) {
                            seenCourtIds.add(court.courtId);
                            // Override any clubId field on the court object to match the
                            // home club so Angular does not filter it out when rendering
                            // columns.  bc_clubId preserves the real club for our tagging.
                            target.courts.push({ ...court, clubId: homeClubId, bc_clubId: clubId });
                        }
                    }
                    for (const slot of (clubAvail.availableTimeSlots || [])) {
                        target.availableTimeSlots.push({ ...slot, bc_clubId: clubId });
                    }
                }
            }

            // Ensure at least one slot exists so Angular renders a clickable native slot
            // for the state machine, even if all clubs have zero availability.
            if (target.availableTimeSlots.length === 0 && target.courts.length > 0) {
                const court = target.courts[0];
                target.availableTimeSlots.push({
                    timeOfDay: 'Morning',
                    fromInMinutes: 420,
                    toInMinutes: 450,
                    courtId: court.courtId,
                    courtsVersionsIds: [court.courtSetupVersionId || court.courtId],
                    bc_clubId: court.bc_clubId,
                });
            }

            // Sort merged courts by the user's preferred club order, then by courtOrder
            // within each club, so Angular renders columns in preference order.
            const clubOrderPreference = getClubOrder();
            target.courts.sort(function (a, b) {
                const aClubRank = clubOrderPreference.indexOf(a.bc_clubId);
                const bClubRank = clubOrderPreference.indexOf(b.bc_clubId);
                const clubDiff = (aClubRank === -1 ? 999 : aClubRank) - (bClubRank === -1 ? 999 : bClubRank);
                if (clubDiff !== 0) return clubDiff;
                return (a.order ?? 999) - (b.order ?? 999);
            });

            // Capture the ordered court→club mapping so the native column tagger can
            // assign data-bc-club-id to Angular-rendered app-booking-calendar-column
            // elements by their position in the rendered column list.
            getBookingStateService().setMergedCourtsOrder(
                target.courts.map(c => ({
                    courtId: c.courtId,
                    clubId: c.bc_clubId,
                    courtName: (c.courtName || c.name || '').trim(),
                    courtOrder: c.order ?? 0,
                }))
            );

            // Diagnostic: per-club breakdown of courts and slots actually merged in.
            // This shows whether each club contributed data and how much, so we can
            // see whether the merge is incomplete or the fetch results are missing data.
            const perClub = Object.entries(CLUBS).map(([name, id]) => {
                const courts = target.courts.filter(c => c.bc_clubId === id);
                const slots = target.availableTimeSlots.filter(s => s.bc_clubId === id);
                const sampleCourt = courts[0];
                const sampleSlot = slots[0];
                return {
                    name,
                    clubId: id,
                    isHomeClub: id === homeClubId,
                    courtCount: courts.length,
                    slotCount: slots.length,
                    courtFields: sampleCourt ? Object.keys(sampleCourt) : '(no courts)',
                    slotFields: sampleSlot ? Object.keys(sampleSlot) : '(no slots)',
                    sampleCourtId: sampleCourt?.courtId,
                    sampleSlotCourtId: sampleSlot?.courtId,
                    sampleSlotVersionIds: sampleSlot?.courtsVersionsIds,
                };
            });
            console.log('[bc] buildMergedAvailabilityPayload diagnostic:', {
                totalCourts: target.courts.length,
                totalSlots: target.availableTimeSlots.length,
                homeClubId,
                rawResultsLength: rawResults.length,
                perClub,
            });

            return merged;
        }

        function applyMergedPayloadToXhr(xhr, mergedData) {
            const json = JSON.stringify(mergedData);
            Object.defineProperty(xhr, 'response', { get: () => json, configurable: true });
            Object.defineProperty(xhr, 'responseText', { get: () => json, configurable: true });
        }

        function maybePatchAvailabilityResponseForAngular(_xhr) {
            // The availability XHR is now fully intercepted in send() — we never call
            // originalXhrSend for it.  By the time this load listener fires (triggered by
            // interceptAvailabilityXhr after all parallel fetches complete), the merged
            // payload is already set on the XHR via applyMergedPayloadToXhr.  Nothing more
            // needs to be done here — the response Angular reads is already correct.
            // We keep this function as a no-op so the open() listener wiring is unchanged.
        }

        // Parses the URL query params from a native availability request URL into the
        // shape expected by fetchAllClubs.
        function parseAvailabilityParams(requestUrl) {
            const parsedUrl = new URL(requestUrl);
            return {
                date: parsedUrl.searchParams.get('date'),
                categoryCode: parsedUrl.searchParams.get('categoryCode'),
                categoryOptionsId: parsedUrl.searchParams.get('categoryOptionsId'),
                timeSlotId: parsedUrl.searchParams.get('timeSlotId'),
                nativeClubId: parsedUrl.searchParams.get('clubId'),
            };
        }

        // Intercepts the native availability XHR entirely: never calls originalXhrSend.
        // Instead, fetches all four clubs in parallel, builds the merged payload, and
        // delivers it to Angular by populating the XHR's response properties and
        // dispatching the standard XHR completion event sequence.  Angular's load handler
        // fires exactly once — after all club data is ready — and sees every club's courts.
        async function interceptAvailabilityXhr(xhr, requestUrl) {
            const params = parseAvailabilityParams(requestUrl);

            // Kick off both the parallel fetch (for our own UI) and the UI injection
            // together.  fetchAllClubs handles abort, error banners, transform, and inject.
            // We await it here so the merged payload is ready before we trigger Angular's
            // load handlers on the XHR.
            await fetchAllClubs(params);

            // fetchAllClubs calls setRawFetchResults which populates getMergedCourtsOrder.
            // Build the merged payload from the raw results and deliver it to Angular.
            const rawResults = getBookingStateService().getRawFetchResults();
            if (!rawResults || rawResults.length === 0) {
                // All fetches failed — showHelperFailureBannerAndRestoreNative was already
                // called by fetchAllClubs.  Don't fire a load event; leave Angular without
                // a response so it falls back to its own error state.
                return;
            }

            // Use the first successful result as the "native" base for the merge so the
            // home-club structure (club metadata, etc.) is preserved in the merged response.
            const baseData = rawResults[0];
            let mergedData;
            try {
                mergedData = buildMergedAvailabilityPayload(baseData, rawResults);
            } catch (e) {
                console.log('[bc] merge error in interceptAvailabilityXhr:', e);
                return;
            }

            // Populate the XHR response properties so Angular reads the merged payload.
            applyMergedPayloadToXhr(xhr, mergedData);

            // Simulate the standard XHR completion sequence.  Angular's load handler
            // registered via open() will run maybePatchAvailabilityResponseForAngular
            // (now a no-op) then Angular's own handler which reads xhr.response.
            try {
                Object.defineProperty(xhr, 'readyState', { get: () => 4, configurable: true });
                Object.defineProperty(xhr, 'status', { get: () => 200, configurable: true });
                Object.defineProperty(xhr, 'statusText', { get: () => 'OK', configurable: true });
            } catch (_e) { /* already defined — values already set, proceed */ }
            xhr.dispatchEvent(new ProgressEvent('readystatechange'));
            xhr.dispatchEvent(new ProgressEvent('load'));
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }


        // Fetches /courtsheet/{clubId} (booking events) for a single club.
        // Used to populate the availability blocks Angular renders in Court View columns.
        async function fetchCourtSheetEventsForOneClub(clubId, date) {
            const r = await fetch(
                `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${clubId}?date=${date}`,
                {
                    headers: {
                        'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                        'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    },
                }
            );
            if (!r.ok) throw new Error(`courtsheet HTTP ${r.status} for ${clubId}`);
            return r.json();
        }

        // Fetches /courtsheet/{clubId}/courts for a single club using captured auth headers.
        // Mirrors the params from the native request so the response shape is comparable.
        async function fetchCourtsForOneClub(clubId, params) {
            const timeSlotId = CLUB_MAX_TIMESLOT[clubId] && params.timeSlotId === TIMESLOTS.min90
                ? CLUB_MAX_TIMESLOT[clubId]
                : (params.timeSlotId || '');
            const qs = new URLSearchParams({
                date: params.date,
                categoryCode: params.categoryCode || 'pickleball',
                categoryOptionsId: params.categoryOptionsId || '',
                timeSlotId,
            }).toString();
            const r = await fetch(
                `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${clubId}/courts?${qs}`,
                {
                    headers: {
                        'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                        'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                        'Request-Id': crypto.randomUUID(),
                        'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                        'Accept': 'application/json',
                    },
                }
            );
            if (!r.ok) throw new Error(`courts HTTP ${r.status} for ${clubId}`);
            return r.json();
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

        // Rewrites a courtbookings POST that originated from a native Court View column click.
        // Angular assembles the POST body using the merged availability payload we injected, so
        // courtId, date, and time fields are already correct.  The only wrong field is clubId,
        // which Angular always sets to the home club.  We look up the correct clubId from
        // mergedCourtsOrder and replace it.  Also applies the Santa Clara 60-minute cap the
        // same way the Hour View path does.  Returns { handled: false } when mergedCourtsOrder
        // is absent, the courtId is unrecognised, or the clubId is already correct (home club
        // court — no rewrite needed).
        function maybeRewriteCourtViewBooking(xhr, requestUrl, requestMethod, originalArgs) {
            if (!requestUrl || !requestUrl.match(/courtbookings$/) || requestMethod !== 'POST') {
                return { handled: false };
            }
            const mergedCourtsOrder = getBookingStateService().getMergedCourtsOrder();
            if (!mergedCourtsOrder || mergedCourtsOrder.length === 0) {
                return { handled: false };
            }
            let nativeBody;
            try { nativeBody = JSON.parse(originalArgs[0]); } catch (_e) { return { handled: false }; }
            if (!nativeBody || !nativeBody.courtId) { return { handled: false }; }

            const courtEntry = mergedCourtsOrder.find(function (c) { return c.courtId === nativeBody.courtId; });
            if (!courtEntry || courtEntry.clubId === nativeBody.clubId) {
                return { handled: false };
            }

            const requestId = getRequestId(xhr);
            if (requestId && requestId === lastBookingRequestId) {
                return { handled: true, value: undefined };
            }
            if (requestId) { lastBookingRequestId = requestId; }

            const lastFetchState = getBookingStateService().getLastFetchState();
            const timeSlotId = lastFetchState && CLUB_MAX_TIMESLOT[courtEntry.clubId] &&
                lastFetchState.params.timeSlotId === TIMESLOTS.min90
                ? CLUB_MAX_TIMESLOT[courtEntry.clubId]
                : (nativeBody.timeSlotId || (lastFetchState && lastFetchState.params.timeSlotId));

            const rewrittenBody = JSON.stringify(Object.assign({}, nativeBody, {
                clubId: courtEntry.clubId,
                timeSlotId: timeSlotId,
            }));
            return { handled: true, value: originalXhrSend.call(xhr, rewrittenBody) };
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
                    const userId = getLocalStorageService().getString(STORAGE_KEYS.NOTIFICATION_EMAIL);
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
            // Step 1 of methodical courts interception: register a load listener before
            // Angular's so we fire first.  Use stopImmediatePropagation() to block Angular,
            // then re-dispatch the native response completely unmodified.  If Angular still
            // renders 8 RS columns normally after this, the stop+re-dispatch mechanism is
            // confirmed safe and we can add merging in a subsequent step.
            // Match /courtsheet/{id}/courts?... but NOT /courtsheet/{id}?...
            // url.includes('/courts') alone also matches /courtsheet/ since it starts with that substring.
            if (typeof url === 'string' && /\/courtsheet\/[^/]+\/courts(\?|$)/.test(url)) {
                let passThrough = false;
                const capturedXhrRef = this;
                this.addEventListener('load', function (event) {
                    if (passThrough) return;
                    passThrough = true;
                    event.stopImmediatePropagation();

                    const nativeText = capturedXhrRef.responseText;
                    let nativeData;
                    try { nativeData = JSON.parse(nativeText); } catch (_e) {
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                        return;
                    }

                    console.log('[bc] courts intercepted: nativeItems', nativeData.items?.length, '| url', url);

                    // Step 3: fetch all other clubs in parallel and merge their full items arrays.
                    const parsedUrl = new URL(url);
                    const nativeClubId = /\/courtsheet\/([^/]+)\/courts/.exec(url)?.[1];
                    const params = {
                        date: parsedUrl.searchParams.get('date'),
                        categoryCode: parsedUrl.searchParams.get('categoryCode'),
                        categoryOptionsId: parsedUrl.searchParams.get('categoryOptionsId'),
                        timeSlotId: parsedUrl.searchParams.get('timeSlotId'),
                    };
                    const otherClubIds = Object.values(CLUBS).filter(id => id !== nativeClubId);
                    Promise.allSettled(
                        otherClubIds.map(id => fetchCourtsForOneClub(id, params))
                    ).then(function (results) {
                        try {
                            if (!Array.isArray(nativeData.items)) nativeData.items = [];
                            // Stamp the native club's courts with their clubId so we can
                            // build the mergedCourtsOrder mapping below.
                            nativeData.items.forEach(function (court) { court.bc_clubId = nativeClubId; });
                            const seenCourtIds = new Set(nativeData.items.map(c => c.courtId));
                            results.forEach(function (r, idx) {
                                if (r.status !== 'fulfilled') return;
                                const fetchedClubId = otherClubIds[idx];
                                (r.value.items || []).forEach(function (court) {
                                    if (!seenCourtIds.has(court.courtId)) {
                                        seenCourtIds.add(court.courtId);
                                        // Tag with the clubId that fetched this court so
                                        // tagColumns() can assign data-bc-club-id correctly.
                                        court.bc_clubId = fetchedClubId;
                                        nativeData.items.push(court);
                                    }
                                });
                            });
                            // Persist the ordered court→club mapping so tagColumns() can
                            // stamp data-bc-club-id on each app-booking-calendar-column by
                            // index position.
                            getBookingStateService().setMergedCourtsOrder(
                                nativeData.items.map(function (c) {
                                    return {
                                        courtId: c.courtId,
                                        clubId: c.bc_clubId,
                                        courtName: (c.courtName || c.name || '').trim(),
                                        courtOrder: c.order != null ? c.order : 0,
                                    };
                                })
                            );
                            applyMergedPayloadToXhr(capturedXhrRef, nativeData);
                        } catch (_e) { /* pass through unmodified on merge error */ }
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                    });
                });
            }

            // Intercept /courtsheet/{clubId}?date=... (booking events — no /courts suffix).
            // Angular reads this to fill the availability blocks in each column.  We fetch
            // the same endpoint for all other clubs and merge their events arrays so Angular
            // sees booking data for every injected court column, not just the home club.
            if (typeof url === 'string' && /\/courtsheet\/[^/]+(\?|$)/.test(url) &&
                    !/\/courtsheet\/[^/]+\//.test(url)) {
                let passThrough = false;
                const capturedXhrRef = this;
                this.addEventListener('load', function (event) {
                    if (passThrough) return;
                    passThrough = true;
                    event.stopImmediatePropagation();

                    const nativeText = capturedXhrRef.responseText;
                    let nativeData;
                    try { nativeData = JSON.parse(nativeText); } catch (_e) {
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                        return;
                    }

                    let date;
                    let nativeClubId;
                    try {
                        const parsedUrl = new URL(url);
                        date = parsedUrl.searchParams.get('date');
                        nativeClubId = /\/courtsheet\/([^/?]+)/.exec(url)?.[1];
                    } catch (_e) {
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                        return;
                    }

                    if (!date || !nativeClubId) {
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                        return;
                    }

                    const otherClubIds = Object.values(CLUBS).filter(id => id !== nativeClubId);
                    Promise.allSettled(
                        otherClubIds.map(id => fetchCourtSheetEventsForOneClub(id, date))
                    ).then(function (results) {
                        try {
                            if (!Array.isArray(nativeData.events)) nativeData.events = [];
                            results.forEach(function (r) {
                                if (r.status !== 'fulfilled') return;
                                (r.value.events || []).forEach(function (ev) {
                                    nativeData.events.push(ev);
                                });
                            });
                            applyMergedPayloadToXhr(capturedXhrRef, nativeData);
                        } catch (_e) { /* pass through unmodified on merge error */ }
                        capturedXhrRef.dispatchEvent(new ProgressEvent('load'));
                    });
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

            // For availability requests, take over the XHR entirely: fetch all clubs in
            // parallel, deliver the merged response to Angular, then return.  Angular
            // never sees the native single-club response, and originalXhrSend is not called.
            if (typeof requestUrl === 'string' && requestUrl.includes(AVAILABILITY_API_PATH)) {
                interceptAvailabilityXhr(this, requestUrl);
                return;
            }


            const rewrittenSendResult = maybeRewriteBookingRequestToPendingSelection(this, requestUrl, requestMethod, arguments);
            if (rewrittenSendResult.handled) return rewrittenSendResult.value;

            const courtViewRewriteResult = maybeRewriteCourtViewBooking(this, requestUrl, requestMethod, arguments);
            if (courtViewRewriteResult.handled) return courtViewRewriteResult.value;

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

    // Returns the UTC timestamp (ms) corresponding to a given time in Pacific time
    // (America/Los_Angeles). dateStr is 'YYYY-MM-DD'; fromMinutes is minutes from
    // Pacific midnight. Uses noon UTC as a DST-safe reference to determine the
    // Pacific UTC offset for the given date, avoiding ambiguity at DST transitions.
    // All four Bay Area clubs are in this timezone, so all booking window calculations
    // use this function rather than the user's local clock timezone.
    function pacificSlotTimeMs(dateStr, fromMinutes) {
        const [y, mo, d] = dateStr.split('-').map(Number);
        const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
        const pacificNoonHour = parseInt(
            new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Los_Angeles',
                hour: 'numeric',
                hour12: false,
            }).format(noonUtc),
            10
        );
        // pacificNoonHour is 4 for PST (UTC−8) or 5 for PDT (UTC−7).
        // offsetHours is the number of hours after UTC midnight that Pacific midnight falls.
        const offsetHours = 12 - pacificNoonHour;
        return Date.UTC(y, mo - 1, d, offsetHours, 0, 0) + fromMinutes * 60 * 1000;
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

            function findCourtViewButton() {
                return Array.from(document.querySelectorAll(HOUR_VIEW_BUTTON_SELECTOR))
                    .find(btn => btn.textContent.trim().startsWith('COURT VIEW'));
            }

            function isCourtViewActive() {
                // Only true when the user has explicitly selected the COURT VIEW tab.
                // We do not infer from the absence of btn-selected on HOUR VIEW because
                // that state occurs transiently before our auto-click fires.
                const courtBtn = findCourtViewButton();
                if (!courtBtn) return false;
                return courtBtn.classList.contains('btn-selected');
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
                findCourtViewButton,
                isCourtViewActive,
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

    // Keeps Worker endpoint and secret private while exposing only minimal helpers.
    const getWorkerApiConfigService = (() => {
        let serviceInstance = null;

        return function getWorkerApiConfigService() {
            if (serviceInstance) return serviceInstance;

            const WORKER_URL = 'https://bayclubconnect-bookings.mark-rubin.workers.dev';
            const WORKER_SECRET = '724468735aec045b6ec464fce6dce1133142bb3a8fcc2cfd68dc0abdebbd0c3d';

            function buildUrl(path) {
                return `${WORKER_URL}${path}`;
            }

            function getSecretHeaderValue() {
                return WORKER_SECRET;
            }

            serviceInstance = {
                buildUrl,
                getSecretHeaderValue,
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

            const PREF_KEYS = [
                STORAGE_KEYS.CLUB_ORDER, STORAGE_KEYS.VIEW_MODE, STORAGE_KEYS.INDOOR_ONLY,
                STORAGE_KEYS.TIME_RANGE, STORAGE_KEYS.PLAYERS, STORAGE_KEYS.DURATION,
                STORAGE_KEYS.BOOKING_VIEW,
            ];

            let debounceTimer = null;

            function getUserId() {
                return getLocalStorageService().getString(STORAGE_KEYS.NOTIFICATION_EMAIL);
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
                    const response = await fetch(getWorkerApiConfigService().buildUrl('/prefs'), {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Worker-Secret': getWorkerApiConfigService().getSecretHeaderValue(),
                        },
                        body: JSON.stringify({ userId, prefs }),
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                } catch (e) {
                    getDebugService().log('warn', 'prefs-push-failed', { error: e.message });
                }
            }

            async function pullFromWorker() {
                const userId = getUserId();
                if (!userId) return;
                try {
                    const response = await fetch(getWorkerApiConfigService().buildUrl('/prefs'), {
                        headers: {
                            'X-Worker-Secret': getWorkerApiConfigService().getSecretHeaderValue(),
                            'X-User-Id': userId,
                        },
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

            const DEBUG_ENABLED_KEY = STORAGE_KEYS.DEBUG_ENABLED;
            const DEBUG_ENTRIES_KEY = STORAGE_KEYS.DEBUG_ENTRIES;
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
            const POSSIBLE_PLAYERS_KEY = STORAGE_KEYS.POSSIBLE_PLAYERS;
            const PLAYER_PHOTOS_KEY = STORAGE_KEYS.PLAYER_PHOTOS;
            const NOTIFICATION_EMAIL_KEY = STORAGE_KEYS.NOTIFICATION_EMAIL;
            const SELF_PROFILE_KEY = STORAGE_KEYS.SELF_PROFILE;
            const PHOTOS_API_BASE = 'https://connect-api.bayclubs.io/checkin/api/1.0';
            const PHOTO_CDN_BASE = 'https://photomanagement-cdn.bayclubs.io/api/1.0/pub/photos';
            const SUBSCRIPTION_KEY = 'bac44a2d04b04413b6aea6d4e3aad294';

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
                return { 'X-Worker-Secret': getWorkerApiConfigService().getSecretHeaderValue() };
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
                    const response = await fetch(getWorkerApiConfigService().buildUrl('/bookings'), { headers: workerHeaders() });
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
                fetch(getWorkerApiConfigService().buildUrl(`/bookings/${id}`), {
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
                        email: m.email || null,
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
                                email: buddy.email || null,
                            });
                        }
                    });

                const mergedPlayers = Array.from(byPersonId.values());

                // Include the primary (logged-in) user's memberIdentifier so their photo is
                // fetched together with the rest, avoiding a separate request later.
                const primaryMemberIdentifier = householdData.primary && householdData.primary.memberIdentifier;
                const allMemberIdentifiers = mergedPlayers.map(p => p.memberIdentifier).filter(Boolean);
                if (primaryMemberIdentifier) allMemberIdentifiers.push(primaryMemberIdentifier);

                // Cache pod member personIds (household addOns only — not buddies) so the
                // availability renderer can detect same-day same-club conflicts.
                const podMemberIds = (householdData.addOns || [])
                    .filter(m => m.status === 'Active')
                    .map(m => String(m.personId));
                getLocalStorageService().setJson(STORAGE_KEYS.POD_MEMBER_IDS, podMemberIds);

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
            // Uses Pacific time because all clubs are in the Bay Area — using local time
            // would give the wrong fire timestamp for users outside the Pacific timezone.
            function computeFireAtMs(date, fromMinutes) {
                return pacificSlotTimeMs(date, fromMinutes) - SCHEDULED_BOOKING_ADVANCE_DAYS * 24 * 60 * 60 * 1000;
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

                // Look up partner emails from the cached player list by personId.
                // Coerce personId to string so the Map lookup matches card.dataset.personId,
                // which is always a string, even when the JSON cache stores personId as a number.
                // Players without a cached email are silently skipped.
                const cachedPlayers = getLocalStorageService().getJson(POSSIBLE_PLAYERS_KEY, '[bc] failed to parse cached players for partner emails') || [];
                const emailByPersonId = new Map(
                    cachedPlayers.filter(p => p.email).map(p => [String(p.personId), p.email])
                );
                const partnerEmails = selectedPartners.map(p => emailByPersonId.get(String(p.personId))).filter(Boolean);

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
                    // The original court name is stored separately so the Worker can mention
                    // it in the email if a fallback court is used instead.
                    originalCourtName: slotInfo.courtName || null,
                    // Courts sorted by preference (gated > edge > neither), excluding the
                    // primary. The Worker tries them in order if the primary POST fails.
                    fallbackCourts: (slotInfo.allCourts || [])
                        .filter(c => c.courtId !== slotInfo.courtId)
                        .map(c => ({ courtId: c.courtId, courtName: c.courtName || null })),
                    partnerNames: selectedPartners.map(p => `${p.firstName} ${p.lastName}`),
                    partnerEmails,
                    notificationEmail: await fetchNotificationEmail(),
                    userName: (() => {
                        const p = getLocalStorageService().getJson(SELF_PROFILE_KEY, '[bc] failed to parse self profile')
                            || readProfileFromAppStorage();
                        return (p && p.firstName && p.lastName) ? `${p.firstName} ${p.lastName}` : '';
                    })(),
                    status: SCHEDULED_STATUS_PENDING,
                    slotCheckStatus: SLOT_CHECK_STATUS.UNKNOWN,
                    failureReason: null,
                    createdAtMs: Date.now(),
                };

                cachedBookings = [...cachedBookings, booking];
                try {
                    const response = await fetch(getWorkerApiConfigService().buildUrl('/bookings'), {
                        method: 'POST',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, workerHeaders()),
                        body: JSON.stringify(booking),
                    });
                    if (!response.ok) {
                        throw new Error(`Worker rejected booking: HTTP ${response.status}`);
                    }
                } catch (e) {
                    cachedBookings = cachedBookings.filter(b => b.id !== booking.id);
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
                fetch(getWorkerApiConfigService().buildUrl(`/bookings/${id}`), {
                    method: 'DELETE',
                    headers: workerHeaders(),
                }).catch(e => getDebugService().log('warn', 'worker-delete-booking-failed', { error: e.message }));
                getDebugService().log('info', 'scheduled-booking-cancelled', { id });
            }

            // Fetches the logged-in user's email from the Bay Club profile API,
            // caching the result in localStorage so only one API call is ever made
            // per device. Returns null if auth headers are unavailable or the call
            // fails — in which case the Worker will simply skip the email notification.
            // Reads the profile fields Angular persists to localStorage.connect20auth.
            // Returns { email, firstName, lastName } with any absent fields as null.
            function readProfileFromAppStorage() {
                try {
                    const raw = localStorage.getItem('connect20auth');
                    if (!raw) return {};
                    const state = JSON.parse(raw);
                    const data = state && state.profile && state.profile.data;
                    if (!data) return {};
                    return {
                        email: data.email || null,
                        firstName: data.firstName || null,
                        lastName: data.lastName || null,
                    };
                } catch (_e) {
                    return {};
                }
            }

            async function fetchNotificationEmail() {
                const cached = getLocalStorageService().getString(NOTIFICATION_EMAIL_KEY);
                if (cached) return cached;
                // connect20auth is written by Angular before our script runs, so this is
                // synchronous and avoids an API round-trip on first use.
                const appEmail = readProfileFromAppStorage().email;
                if (appEmail) {
                    getLocalStorageService().setString(NOTIFICATION_EMAIL_KEY, appEmail);
                    return appEmail;
                }
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
                fetch(getWorkerApiConfigService().buildUrl('/token'), {
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
                    if (userId) {
                        getLocalStorageService().setString(NOTIFICATION_EMAIL_KEY, userId);
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

            // Bay Club has used different list containers over time; support both.
            const EVENTS_LIST_SELECTOR = 'app-paged-list app-racquet-sports-booking-calendar-event, app-calendar-events-list app-racquet-sports-booking-calendar-event';
            const DESKTOP_TILE_SELECTOR = '.item-tile.d-none.d-md-flex';
            const BOOKING_DETAILS_HEADER_SELECTOR = '.image-background .px-4.pb-4';
            const RESERVATION_MADE_BY_ROW_SELECTOR = '.row.mt-2.size-14';

            function isOnBookingsPage() {
                return location.pathname === '/bookings';
            }

            function isOnBookingDetailsPage() {
                return /^\/racquet-sports\/booking\/[0-9a-f-]+$/i.test(location.pathname);
            }

            function isOnDashboardPage() {
                return location.pathname.startsWith('/home');
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
                isOnDashboardPage,
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

            function timePartsTo24Hour(hour12, meridiem) {
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
                // Match both "H:MM - H:MM AM/PM" (same period) and
                // "H:MM AM - H:MM PM" (slot crosses noon boundary).
                const match = normalizeWhitespace(timeText).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
                if (!match) {
                    getDebugService().log('warn', 'bookings-parse-time-range-failed', {
                        rawTimeText: timeText,
                    });
                    return null;
                }
                const startHour12 = parseInt(match[1], 10);
                const startMinute = parseInt(match[2], 10);
                const startMeridiem = match[3] ? match[3].toUpperCase() : null;
                const endHour12 = parseInt(match[4], 10);
                const endMinute = parseInt(match[5], 10);
                const endMeridiem = match[6].toUpperCase();

                const endHour24 = timePartsTo24Hour(endHour12, endMeridiem);
                const startHour24 = startMeridiem
                    ? timePartsTo24Hour(startHour12, startMeridiem)
                    : inferStartHour24(startHour12, endHour24);
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

                // All Bay Area clubs operate on Pacific time. Build the event timestamps
                // as correct UTC moments by interpreting the day and the hour/minute values
                // in America/Los_Angeles, not in the viewer's local timezone. en-CA locale
                // with the Pacific timezone reliably yields a YYYY-MM-DD string.
                const pacificDateStr = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Los_Angeles',
                }).format(bookingDate);
                const startDate = new Date(pacificSlotTimeMs(pacificDateStr, timeRange.startHour24 * 60 + timeRange.startMinute));
                const endDate = new Date(pacificSlotTimeMs(pacificDateStr, timeRange.endHour24 * 60 + timeRange.endMinute));
                if (endDate <= startDate) {
                    endDate.setTime(endDate.getTime() + 24 * 60 * 60 * 1000);
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

            function extractBookingDataFromDashboardCard(card) {
                // Only process pickleball booking cards.
                const title = normalizeWhitespace(card.querySelector('.dashboard-card__title')?.textContent || '');
                if (!title.toLowerCase().includes('pickleball')) return null;

                const contentEl = card.querySelector('.dashboard-card__content');
                if (!contentEl) return null;

                // The first text node contains "DayLabel, H:MM [AM/PM] - H:MM AM/PM".
                // Locate the time range by regex so date labels with commas (e.g. "Mar 07, 2026")
                // are handled correctly.
                const rawText = normalizeWhitespace(contentEl.firstChild?.textContent || '');
                const timeRangeMatch = rawText.match(/(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i);
                if (!timeRangeMatch) return null;
                const timeRangeText = timeRangeMatch[1];
                const dayLabel = rawText.slice(0, rawText.indexOf(timeRangeText)).replace(/[,\s]+$/, '').trim();

                // The location span contains "Club Name, Court Name".
                const locationText = normalizeWhitespace(contentEl.querySelector('span')?.textContent || '');
                const locationCommaIdx = locationText.indexOf(',');
                const club = locationCommaIdx !== -1 ? locationText.slice(0, locationCommaIdx).trim() : locationText;
                const court = locationCommaIdx !== -1 ? locationText.slice(locationCommaIdx + 1).trim() : '';

                const participantNames = Array.from(card.querySelectorAll('app-racquet-sports-dashboard-player'))
                    .map(p => normalizeWhitespace(p.textContent))
                    .filter(Boolean)
                    .filter(name => name.toLowerCase() !== 'you');

                return buildBookingDataFromFields({ dayLabel, timeRangeText, club, court, participantNames, playersLine: '' });
            }

            function injectButtonsForDashboardPage() {
                if (!getBookingsDomQueryService().isOnDashboardPage()) return;
                document.querySelectorAll('app-dashboard-card').forEach(card => {
                    const body = card.querySelector('.dashboard-card__body');
                    if (!body || body.querySelector('.bc-calendar-action')) return;
                    const booking = extractBookingDataFromDashboardCard(card);
                    if (!booking) return;
                    const calendarUrl = buildGoogleCalendarUrl(booking);
                    appendCalendarActions(body, booking, calendarUrl);
                });
            }

            // Formats a booking date string ("2026-03-12") as "Today", "Tomorrow", or
            // a short date like "Wed Mar 12", using Pacific time for today/tomorrow
            // comparison so the label is correct regardless of the viewer's locale.
            function formatPendingBookingDayLabel(dateStr) {
                const nowMs = Date.now();
                // Use noon of the slot date to avoid DST boundary edge cases.
                const slotNoonMs = pacificSlotTimeMs(dateStr, 12 * 60);
                const todayPacific = new Date(nowMs)
                    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
                const slotPacific = new Date(slotNoonMs)
                    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
                const tomorrowPacific = new Date(nowMs + 24 * 60 * 60 * 1000)
                    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
                if (slotPacific === todayPacific) return 'Today';
                if (slotPacific === tomorrowPacific) return 'Tomorrow';
                return new Date(slotNoonMs)
                    .toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
            }

            Object.assign(_bcTestExports, { formatPendingBookingDayLabel });

            // Builds a dashboard carousel tile element for a pending scheduled booking.
            // Matches the native card dimensions and CSS classes so it slots naturally
            // into the carousel alongside confirmed bookings.
            function buildPendingDashboardCard(booking) {
                const body = booking.bookingBody;
                const dateStr = body && body.date && body.date.value;
                const slotParts = (booking.slotLabel || '').split(' \u00b7 ');
                const clubName = slotParts[0] || 'Bay Club';
                const courtName = slotParts[1] || 'Court';
                const partnerList = (booking.partnerNames || []).join(', ') || 'No partners';

                const timeText = (dateStr && body.timeFromInMinutes != null && body.timeToInMinutes != null)
                    ? `${minutesToHumanTime(body.timeFromInMinutes)} \u2013 ${minutesToHumanTime(body.timeToInMinutes)}`
                    : (slotParts[2] || '');
                const dayLabel = dateStr ? formatPendingBookingDayLabel(dateStr) : (slotParts[3] || '');

                const PICKLEBALL_IMAGE = 'https://connect-assets-cdn.bayclubs.io/rwd_mobile/racquet-sports/details_pickleball.png';

                const wrapper = document.createElement('div');
                wrapper.setAttribute('data-bc-dashboard-pending', booking.id);
                wrapper.style.cssText = 'min-width: 205px; max-width: 205px; margin-right: 12px; flex-shrink: 0;';

                wrapper.innerHTML = `
                    <div style="cursor: pointer; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; background: #1f4366;">
                        <div style="height: 125px; background-image: url('${PICKLEBALL_IMAGE}'); background-size: cover; background-position: center; position: relative; flex-shrink: 0;">
                            <div style="position: absolute; top: 6px; right: 8px; background: rgba(0,0,0,0.55); border-radius: 4px; padding: 2px 6px; font-size: 11px; color: #ffe082; font-weight: 700; letter-spacing: 0.03em;">\u23f3 PENDING</div>
                        </div>
                        <div data-bc-card-body style="padding: 8px; flex: 1; display: flex; flex-direction: column; gap: 4px; color: #fff;">
                            <strong style="font-size: 14px; font-weight: 700; display: block;">Pickleball BOOKING</strong>
                            <div style="font-size: 13px; opacity: 0.85; display: flex; flex-direction: column; gap: 2px;">
                                <div>${dayLabel}, ${timeText}</div>
                                <div>${clubName}, ${courtName}</div>
                                <div>Partners: ${partnerList}</div>
                            </div>
                        </div>
                    </div>`;

                // Clicking anywhere on the card navigates to /bookings where the
                // pending section shows the full details and cancel option.
                wrapper.querySelector('div').addEventListener('click', () => {
                    location.href = '/bookings';
                });

                // Append calendar export links to the card body and prevent their
                // clicks from also triggering the card navigation.
                const calendarData = buildCalendarDataForPendingBooking(booking);
                if (calendarData) {
                    const cardBody = wrapper.querySelector('[data-bc-card-body]');
                    const calendarUrl = buildGoogleCalendarUrl(calendarData);
                    appendCalendarActions(cardBody, calendarData, calendarUrl);
                }

                return wrapper;
            }

            // Synchronises pending scheduled booking cards in the dashboard carousel.
            // Adds cards for newly relevant bookings and removes cards whose bookings
            // are no longer active. Runs on every reconcile pass; the data-bc-dashboard-pending
            // attribute prevents duplicate injection.
            function injectPendingCardsForDashboardPage() {
                if (!getBookingsDomQueryService().isOnDashboardPage()) return;

                // Target the Upcoming Activities carousel specifically by scoping to
                // app-dashboard-events. The Favorites carousel lives in app-dashboard-favorites
                // and also contains app-dashboard-card / .book-more, so searching all
                // .responsive-carousel elements picks the wrong one when it renders first.
                const eventsHost = document.querySelector('app-dashboard-events');
                let carousel = eventsHost && eventsHost.querySelector('.responsive-carousel');

                // When the user has no upcoming bookings, Angular renders a "Book an
                // Activity" placeholder instead of app-responsive-carousel, so there is
                // no .responsive-carousel in the DOM. In that case synthesize a flex
                // container with the same class and insert it before the placeholder so
                // our pending cards have somewhere to live. On subsequent reconcile passes
                // querySelector finds the synthetic element and the rest of the function
                // proceeds without change.
                if (!carousel && eventsHost) {
                    const bookMoreEl = eventsHost.querySelector('.book-more');
                    if (bookMoreEl) {
                        const syntheticCarousel = document.createElement('div');
                        syntheticCarousel.className = 'd-flex flex-shrink-0 responsive-carousel rounded';
                        syntheticCarousel.style.cssText = 'flex-wrap: wrap; gap: 0; margin-bottom: 16px;';
                        bookMoreEl.parentElement.insertBefore(syntheticCarousel, bookMoreEl);
                        carousel = syntheticCarousel;
                    }
                }

                if (!carousel) return;

                const currentEmail = getLocalStorageService().getString(
                    STORAGE_KEYS.NOTIFICATION_EMAIL, '[bc] failed to read notification email for dashboard'
                );
                const relevantBookings = getScheduledBookingService().getActiveBookings()
                    .filter(b => isBookingRelevantToCurrentUser(b, currentEmail));

                // Remove stale cards from anywhere in the document — the target
                // carousel can shift between reconcile passes on Firefox mobile, so
                // scoping cleanup to the current carousel would leave orphans behind.
                const relevantIds = new Set(relevantBookings.map(b => b.id));
                document.querySelectorAll('[data-bc-dashboard-pending]').forEach(card => {
                    if (!relevantIds.has(card.dataset.bcDashboardPending)) {
                        card.remove();
                    }
                });

                if (relevantBookings.length === 0) return;

                // Insert new cards before the "Book an Activity" tile, or append to
                // the end of the carousel if that tile is absent.
                const bookMoreTile = Array.from(carousel.children).find(
                    el => el.querySelector('.book-more')
                );

                relevantBookings.forEach(booking => {
                    if (document.querySelector(`[data-bc-dashboard-pending="${booking.id}"]`)) return;
                    const card = buildPendingDashboardCard(booking);
                    if (bookMoreTile) {
                        carousel.insertBefore(card, bookMoreTile);
                    } else {
                        carousel.appendChild(card);
                    }
                });
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

            // Populate the test-export accumulator with the pure utility functions defined
            // in this installer. Called once during IIFE startup; used by module.exports at
            // the end of the script for Vitest access. Has no effect in the browser.
            Object.assign(_bcTestExports, {
                normalizeWhitespace,
                timePartsTo24Hour,
                inferStartHour24,
                parseTimeRange,
                toGoogleDateStamp,
                buildGoogleCalendarUrl,
                toIcsDateStamp,
                sanitizeIcsText,
                buildIcsContent,
                getIcsDownloadFileName,
                formatCountdown,
            });

            function buildPendingBookingRowHtml(booking, isScheduler) {
                const partnerList = (booking.partnerNames || []).join(', ') || 'No partners';
                const isTaken = booking.slotCheckStatus === getScheduledBookingService().SLOT_CHECK_STATUS.TAKEN;
                const warningStyle = isTaken ? '' : 'display: none;';
                const scheduledBy = isScheduler ? '' : `<div style="font-size: 12px; color: rgba(255,255,255,0.45); margin-top: 4px;">Scheduled by ${booking.userName || 'a partner'}</div>`;
                const cancelButton = isScheduler
                    ? `<button data-bc-cancel-booking="${booking.id}" style="background: none; border: 1px solid rgba(239,83,80,0.5); color: #ef5350; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;">Cancel</button>`
                    : '';
                return `<div data-bc-pending-booking="${booking.id}" style="background: rgba(0,188,212,0.08); border: 1px solid rgba(0,188,212,0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: white;">${booking.slotLabel}</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 4px;">Partners: ${partnerList}</div>
                        ${scheduledBy}
                        <div data-bc-slot-warning style="font-size: 12px; color: #ffb74d; margin-top: 4px; ${warningStyle}">\u26a0\ufe0f The court was booked by someone else</div>
                        <div data-bc-countdown style="font-size: 12px; color: rgb(0,188,212); margin-top: 4px;">${formatCountdown(booking.fireAtMs)}</div>
                    </div>
                    ${cancelButton}
                </div>`;
            }

            function buildFailedBookingRowHtml(booking, isScheduler) {
                const reason = booking.failureReason || 'The booking attempt was unsuccessful.';
                const scheduledBy = isScheduler ? '' : `<div style="font-size: 12px; color: rgba(255,255,255,0.45); margin-top: 2px;">Scheduled by ${booking.userName || 'a partner'}</div>`;
                const dismissButton = isScheduler
                    ? `<button data-bc-dismiss-booking="${booking.id}" style="background: none; border: 1px solid rgba(255,255,255,0.3); color: rgba(255,255,255,0.7); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer;">Dismiss</button>`
                    : '';
                return `<div data-bc-failed-booking="${booking.id}" style="background: rgba(239,83,80,0.08); border: 1px solid rgba(239,83,80,0.35); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: white;">${booking.slotLabel}</div>
                        <div style="font-size: 12px; color: #ef5350; margin-top: 4px;">Booking unsuccessful</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 2px;">${reason}</div>
                        ${scheduledBy}
                    </div>
                    ${dismissButton}
                </div>`;
            }

            // Builds a calendar data object for a pending scheduled booking so the user
            // can add a tentative calendar entry before the booking is confirmed.
            // Uses pacificSlotTimeMs so the timestamps are correct regardless of locale.
            // The court name is extracted from slotLabel ("Club · Court · Time · Date").
            function buildCalendarDataForPendingBooking(booking) {
                const body = booking.bookingBody;
                const dateStr = body && body.date && body.date.value;
                if (!dateStr || body.timeFromInMinutes == null || body.timeToInMinutes == null) return null;
                const startDate = new Date(pacificSlotTimeMs(dateStr, body.timeFromInMinutes));
                const endDate = new Date(pacificSlotTimeMs(dateStr, body.timeToInMinutes));
                const clubShortName = CLUB_SHORT_NAMES[body.clubId] || 'Bay Club';
                // slotLabel format: "Club · Court · Time · Date"
                const slotParts = (booking.slotLabel || '').split(' \u00b7 ');
                const court = slotParts[1] || 'Court';
                const partnerSuffix = (booking.partnerNames || []).length > 0
                    ? ` with ${booking.partnerNames.join(', ')}`
                    : '';
                const openLabel = new Date(booking.fireAtMs).toLocaleString('en-US', {
                    timeZone: 'America/Los_Angeles',
                    weekday: 'short', month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                });
                return {
                    title: `Possible: Pickleball at ${clubShortName}${partnerSuffix} on ${court}`,
                    startDate,
                    endDate,
                    location: `${clubShortName}, ${court}`,
                    details: `Scheduled booking — will be confirmed automatically when the booking window opens on ${openLabel} PT.`,
                };
            }

            // Returns true if the current user is the scheduler or an invited partner
            // for the given booking. Used to filter which pending bookings are shown.
            // When the current user's email is unknown we return false — showing
            // nothing is safer than leaking another user's pending bookings.
            // Email comparison is case-insensitive because the Bay Club API and the
            // local cache may differ in case.
            function isBookingRelevantToCurrentUser(booking, currentEmail) {
                if (!currentEmail) return false;
                const normalizedCurrent = currentEmail.toLowerCase();
                if (booking.notificationEmail && booking.notificationEmail.toLowerCase() === normalizedCurrent) return true;
                return Array.isArray(booking.partnerEmails) &&
                    booking.partnerEmails.some(e => e && e.toLowerCase() === normalizedCurrent);
            }

            Object.assign(_bcTestExports, {
                buildPendingBookingRowHtml,
                buildFailedBookingRowHtml,
                buildCalendarDataForPendingBooking,
                isBookingRelevantToCurrentUser,
                SLOT_CHECK_STATUS: getScheduledBookingService().SLOT_CHECK_STATUS,
            });

            function injectPendingBookingsSection() {
                if (!getBookingsDomQueryService().isOnBookingsPage()) return;

                const currentEmail = getLocalStorageService().getString(STORAGE_KEYS.NOTIFICATION_EMAIL, '[bc] failed to read notification email');
                const allActiveBookings = getScheduledBookingService().getActiveBookings();
                const allFailedBookings = getScheduledBookingService().getFailedBookings();
                const activeBookings = allActiveBookings.filter(b => isBookingRelevantToCurrentUser(b, currentEmail));
                const failedBookings = allFailedBookings.filter(b => isBookingRelevantToCurrentUser(b, currentEmail));
                const existingSection = document.querySelector('[data-bc-pending-section]');

                if (activeBookings.length === 0 && failedBookings.length === 0) {
                    if (existingSection) existingSection.remove();
                    return;
                }

                // Insert before app-calendar-cancelled-by-me-list so the pending section
                // appears above the cancelled bookings area. Fall back through progressively
                // broader elements when earlier selectors are absent.
                const cancelledList = document.querySelector('app-calendar-cancelled-by-me-list');
                const insertionPoint =
                    cancelledList ||
                    document.querySelector('app-calendar-events-list') ||
                    document.querySelector('app-paged-list') ||
                    document.querySelector('app-calendar');
                if (!insertionPoint || !insertionPoint.parentElement) return;

                // Section already present — countdowns are updated by the dedicated interval
                // in startPendingCountdownUpdates(). Updating textContent here would re-trigger
                // the MutationObserver, causing scheduleReconcile to loop at requestAnimationFrame
                // speed. However, if the section was placed before a fallback element because the
                // cancelled list had not yet rendered, relocate it now. Moving a node is a one-shot
                // structural change that does not loop.
                if (existingSection) {
                    if (cancelledList && existingSection.nextElementSibling !== cancelledList) {
                        cancelledList.parentElement.insertBefore(existingSection, cancelledList);
                    }
                    return;
                }

                const section = document.createElement('div');
                section.setAttribute('data-bc-pending-section', '');
                section.style.cssText = 'margin: 16px 0 24px; padding: 0;';
                section.innerHTML = `
                    <div style="font-size: 16px; font-weight: 600; color: white; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                        <span>\u23f3</span> Pending Bookings
                    </div>
                    ${activeBookings.map(b => buildPendingBookingRowHtml(b, b.notificationEmail === currentEmail)).join('')}
                    ${failedBookings.map(b => buildFailedBookingRowHtml(b, b.notificationEmail === currentEmail)).join('')}
                `;

                // Removes the section if no relevant rows remain after a cancel or dismiss.
                function removeSectionIfEmpty() {
                    const remainingActive = getScheduledBookingService().getActiveBookings()
                        .filter(b => isBookingRelevantToCurrentUser(b, currentEmail));
                    const remainingFailed = getScheduledBookingService().getFailedBookings()
                        .filter(b => isBookingRelevantToCurrentUser(b, currentEmail));
                    if (remainingActive.length === 0 && remainingFailed.length === 0) {
                        section.remove();
                    }
                }

                // Bind cancel buttons for pending bookings.
                section.querySelectorAll('[data-bc-cancel-booking]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const bookingId = btn.dataset.bcCancelBooking;
                        getScheduledBookingService().cancelBooking(bookingId);
                        const row = section.querySelector(`[data-bc-pending-booking="${bookingId}"]`);
                        if (row) row.remove();
                        removeSectionIfEmpty();
                    });
                });

                // Bind dismiss buttons for failed bookings.
                section.querySelectorAll('[data-bc-dismiss-booking]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const bookingId = btn.dataset.bcDismissBooking;
                        getScheduledBookingService().dismissBooking(bookingId);
                        const row = section.querySelector(`[data-bc-failed-booking="${bookingId}"]`);
                        if (row) row.remove();
                        removeSectionIfEmpty();
                    });
                });

                // Bind calendar action buttons for each active (pending/firing) booking row.
                activeBookings.forEach(booking => {
                    const row = section.querySelector(`[data-bc-pending-booking="${booking.id}"]`);
                    if (!row) return;
                    const infoDiv = row.firstElementChild;
                    if (!infoDiv || infoDiv.querySelector('.bc-calendar-action')) return;
                    const calendarData = buildCalendarDataForPendingBooking(booking);
                    if (!calendarData) return;
                    const calendarUrl = buildGoogleCalendarUrl(calendarData);
                    appendCalendarActions(infoDiv, calendarData, calendarUrl);
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
                    injectButtonsForDashboardPage();
                    injectPendingCardsForDashboardPage();
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
            // Also reconcile on every SPA navigation so dashboard cards are injected
            // after navigating back to /home/dashboard without a full page reload.
            document.addEventListener('bc-navigated', () => scheduleReconcile());
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
            const PLAYERS_KEY = STORAGE_KEYS.PLAYERS;
            const DURATION_KEY = STORAGE_KEYS.DURATION;
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

    // Accent colors for each club's court column headers and key, chosen to contrast
    // well against the native calendar's dark teal background and support white text.
    const CLUB_COLUMN_COLORS = {
        [CLUBS.redwoodShores]: '#74b8ff',
        [CLUBS.broadway]:      '#ffaa66',
        [CLUBS.southSF]:       '#5de8a8',
        [CLUBS.santaClara]:    '#d99fff',
    };

    // #region Court view pure helpers.

    // CSS class suffixes used by the native court view to color-code event blocks.
    // Each suffix maps to a distinct background color defined in COURT_VIEW_COLORS.
    const COURT_BLOCKED_CLASS = Object.freeze({
        BOOKING:     'courtblockedslot-',
        OPEN_PLAY:   'courtblockedslot-openplay',
        LESSON:      'courtblockedslot-lesson',
        CLINIC:      'courtblockedslot-clinic',
        GROUP_CLASS: 'court-sheet-event-group-class',
        LEAGUE:      'courtblockedslot-league',
        OTHER:       'courtblockedslot-other',
        MAINTENANCE: 'courtblockedslot-maintenance',
    });

    // Background color values matching the native court view CSS for each event type.
    const COURT_VIEW_COLORS = Object.freeze({
        [COURT_BLOCKED_CLASS.BOOKING]:     'rgb(234, 252, 248)',
        [COURT_BLOCKED_CLASS.OPEN_PLAY]:   'rgb(234, 252, 248)',
        [COURT_BLOCKED_CLASS.LESSON]:      'rgb(188, 215, 255)',
        [COURT_BLOCKED_CLASS.CLINIC]:      'rgb(197, 225, 164)',
        [COURT_BLOCKED_CLASS.GROUP_CLASS]: 'rgb(251, 225, 255)',
        [COURT_BLOCKED_CLASS.LEAGUE]:      'rgb(255, 218, 174)',
        [COURT_BLOCKED_CLASS.OTHER]:       'rgb(255, 249, 228)',
        [COURT_BLOCKED_CLASS.MAINTENANCE]: 'rgb(206, 212, 218)',
    });

    // Returns the opening window (fromInMinutes, toInMinutes) for a court on the given
    // ISO day-of-week index (0 = Sunday, 6 = Saturday), or null if no hours are defined.
    // openingHours is the array from the /courts API response for a single court.
    function courtViewOpeningRangeForDay(openingHours, dayOfWeek) {
        if (!Array.isArray(openingHours)) return null;
        const entry = openingHours.find(h => h.dayOfWeek === dayOfWeek);
        if (!entry) return null;
        return { fromInMinutes: entry.fromInMinutes, toInMinutes: entry.toInMinutes };
    }

    // Derives the COURT_BLOCKED_CLASS constant for a courtsheet event object.
    // Uses blockedSlotType, className, and isCurrentMemberPlayer to classify each event.
    function courtViewBlockedClassForEvent(event) {
        if (!event) return COURT_BLOCKED_CLASS.BOOKING;
        const bst = event.blockedSlotType;
        if (bst && typeof bst === 'string') {
            const lower = bst.toLowerCase();
            if (lower === 'openplay')    return COURT_BLOCKED_CLASS.OPEN_PLAY;
            if (lower === 'lesson')      return COURT_BLOCKED_CLASS.LESSON;
            if (lower === 'clinic')      return COURT_BLOCKED_CLASS.CLINIC;
            if (lower === 'league')      return COURT_BLOCKED_CLASS.LEAGUE;
            if (lower === 'other')       return COURT_BLOCKED_CLASS.OTHER;
            if (lower === 'maintenance') return COURT_BLOCKED_CLASS.MAINTENANCE;
        }
        // Group class events carry a distinct CSS class rather than a blockedSlotType suffix.
        if (event.className && (!bst || typeof bst !== 'string')) return COURT_BLOCKED_CLASS.GROUP_CLASS;
        return COURT_BLOCKED_CLASS.BOOKING;
    }

    // Returns the background color string for a given COURT_BLOCKED_CLASS value.
    function courtViewColorForBlockedClass(blockedClass) {
        return COURT_VIEW_COLORS[blockedClass] || COURT_VIEW_COLORS[COURT_BLOCKED_CLASS.BOOKING];
    }

    // #endregion Court view pure helpers.

    // Stores the club ordering selected by the user for future sessions.
    const CLUB_ORDER_KEY = STORAGE_KEYS.CLUB_ORDER;

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

    const VIEW_MODE_KEY = STORAGE_KEYS.VIEW_MODE;

    const BOOKING_VIEW_HOUR = 'hour-view';
    const BOOKING_VIEW_COURT = 'court-view';

    function getBookingViewPreference() {
        const stored = getLocalStorageService().getString(STORAGE_KEYS.BOOKING_VIEW);
        return stored === BOOKING_VIEW_COURT ? BOOKING_VIEW_COURT : BOOKING_VIEW_HOUR;
    }

    function saveBookingViewPreference(view) {
        getLocalStorageService().setString(STORAGE_KEYS.BOOKING_VIEW, view);
        getPreferenceSyncService().notifyPreferenceChanged();
    }

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

    const INDOOR_ONLY_KEY = STORAGE_KEYS.INDOOR_ONLY;

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

    const TIME_RANGE_KEY = STORAGE_KEYS.TIME_RANGE;

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
        const list = EDGE_COURTS[clubId] || [];
        // '*' is a sentinel meaning every court at this club is an edge court.
        return list.includes('*') || list.includes(courtName);
    }

    function courtHasHittingWall(courtName, clubId) {
        return (HITTING_WALL_COURTS[clubId] || []).includes(courtName);
    }

    function computeSlotLockState(slot, fetchDate, limitDate) {
        const slotTimeMs = pacificSlotTimeMs(fetchDate, slot.fromInMinutes);
        const slotLocked = slotTimeMs > limitDate.getTime();

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
        // Display date in Pacific time so it matches the actual window-open moment
        // regardless of the viewer's local timezone.
        let openDateLabel = '';
        if (slotLocked) {
            const openDate = new Date(slotTimeMs - 3 * 24 * 60 * 60 * 1000);
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Los_Angeles',
                weekday: 'short',
                month: 'numeric',
                day: 'numeric',
            }).formatToParts(openDate);
            const byType = {};
            parts.forEach(p => { byType[p.type] = p.value; });
            openDateLabel = `Opens ${byType.weekday} ${byType.month}/${byType.day}`;
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

    // Computes pod conflicts for the current fetch date by cross-referencing courtsheet
    // booking events against cached pod member personIds.  Also checks active scheduled
    // bookings (pending/firing) for pod member email conflicts.
    // Returns a plain object keyed by clubId with shape { type: 'confirmed'|'pending', memberName }.
    // A club is absent from the result when no conflict is detected or data is unavailable.
    function computePodConflicts(fetchDate, lastFetchState) {
        const podIds = getLocalStorageService().getJson(STORAGE_KEYS.POD_MEMBER_IDS, '[bc] failed to parse pod member ids') || [];
        if (podIds.length === 0) return {};

        const podIdSet = new Set(podIds.map(String));
        const conflicts = {};

        // Check confirmed/checked-in pickleball bookings from courtsheet events.
        const eventsByClub = (lastFetchState && lastFetchState.courtsheetEventsByClubId) || {};
        Object.entries(eventsByClub).forEach(([clubId, events]) => {
            if (conflicts[clubId]) return;
            const hit = events.find(ev =>
                (ev.status && (ev.status.code === 'confirmed' || ev.status.code === 'checkedin')) &&
                ev.court && ev.court.category && ev.court.category.code === 'pickleball' &&
                ev.reservedFor && podIdSet.has(String(ev.reservedFor.personId))
            );
            if (hit) {
                conflicts[clubId] = { type: 'confirmed', memberName: hit.reservedFor.displayName || 'A pod member' };
            }
        });

        // Check active scheduled bookings where a pod member (matched by email) is involved.
        const allPlayers = getLocalStorageService().getJson(STORAGE_KEYS.POSSIBLE_PLAYERS, '[bc] failed to parse cached players for pod conflict') || [];
        const podEmails = new Set(
            allPlayers.filter(p => podIdSet.has(String(p.personId)) && p.email).map(p => p.email.toLowerCase())
        );
        const selfEmail = getLocalStorageService().getString(STORAGE_KEYS.NOTIFICATION_EMAIL);
        if (selfEmail) podEmails.add(selfEmail.toLowerCase());

        if (podEmails.size > 0) {
            getScheduledBookingService().getActiveBookings().forEach(booking => {
                if (conflicts[booking.clubId]) return;
                if (booking.date !== fetchDate) return;
                const bookerEmail = (booking.notificationEmail || '').toLowerCase();
                const partnerEmails = (booking.partnerEmails || []).map(e => e.toLowerCase());
                const involved = [bookerEmail, ...partnerEmails].some(e => e && podEmails.has(e));
                if (involved) {
                    // Identify whose booking it is for the warning label.
                    const schedulerName = booking.userName || booking.notificationEmail || 'A pod member';
                    conflicts[booking.clubId] = { type: 'pending', memberName: schedulerName };
                }
            });
        }

        return conflicts;
    }

    function buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet, podConflict) {
        const meta = clubMeta[clubId];
        const fetchFailed = failedClubIdsSet.has(clubId);
        const hasAnySlots = TIME_OF_DAYS.some(tod => ((byClubAndTod[clubId] || {})[tod] || []).length > 0);

        // A pending conflict disables slot selection so the user cannot accidentally
        // schedule a booking that would collide with a pod member's scheduled booking
        // when the booking window opens.
        const pendingConflict = podConflict && podConflict.type === 'pending';

        let html = `
        <div data-club-id="${clubId}"${pendingConflict ? ' data-pod-pending-conflict="true"' : ''} style="margin-bottom: 24px;">
        <div style="font-size: 20px; font-weight: bold; color: white; margin-bottom: 12px; padding: 8px 0;">
            ${meta.shortName}
        </div>
        <div class="row bc-filter-message" style="display: none;">
            <div class="col text-center" style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">There are available slots at this location, but none match your time range filter.</div>
        </div>`;

        if (podConflict) {
            const warningText = podConflict.type === 'pending'
                ? `${podConflict.memberName} has a scheduled booking pending for this date at this club. Booking here would conflict when the window opens.`
                : `${podConflict.memberName} (pod) already has a pickleball booking here today. Your pod can only have one booking per club per day.`;
            html += `
      <div class="row">
        <div class="col" style="padding: 0 4px 8px;">
          <div style="padding: 8px 12px; border-radius: 4px; border: 1px solid rgba(255,200,80,0.7); background: rgba(255,200,80,0.1); color: rgba(255,225,140,0.98); font-size: 12px;">
            ⚠️ ${warningText}
          </div>
        </div>
      </div>`;
        }

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

    function buildByTimeHtml(allClubIds, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet, podConflictsByClubId) {
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

        // Show a summary banner for any clubs where a pod conflict exists so the user
        // knows before scanning the time groups which locations to avoid.
        const conflictEntries = Object.entries(podConflictsByClubId || {})
            .filter(([clubId]) => allClubIds.includes(clubId));
        let html = '';
        if (conflictEntries.length > 0) {
            const items = conflictEntries.map(([clubId, conflict]) => {
                const clubName = (clubMeta[clubId] && clubMeta[clubId].shortName) || clubId;
                const detail = conflict.type === 'pending'
                    ? `${conflict.memberName} has a pending scheduled booking`
                    : `${conflict.memberName} (pod) already has a booking`;
                return `<div style="margin-bottom: 4px;">⚠️ <strong>${clubName}</strong>: ${detail} here on this date.</div>`;
            }).join('');
            html += `
        <div style="margin-bottom: 16px; padding: 8px 12px; border-radius: 4px; border: 1px solid rgba(255,200,80,0.7); background: rgba(255,200,80,0.1); color: rgba(255,225,140,0.98); font-size: 12px;">
            ${items}
        </div>`;
        }

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
        // Cancels any in-flight bottom-bar-update loop from a previous bookFromCourtView call.
        let cancelBarUpdate = null;
        // Capture-phase listener wired on the Next button after a court-view slot is selected.
        // Removed after it fires once (or when a new slot is selected).
        let nextButtonInterceptor = null;
        // True only while the Angular state machine hack is running (Hour View switch → native
        // slot click → Next re-click).  Suppresses setVisible(false) and all-clubs-availability
        // rendering so the court view overlay stays on top during that brief window.
        let courtViewBookingInFlight = false;

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
                const playersPref = getLocalStorageService().getString(STORAGE_KEYS.PLAYERS);
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

                const selfProfile = getLocalStorageService().getJson(STORAGE_KEYS.SELF_PROFILE, '[bc] failed to parse self profile');
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

            function bindSchedulePanelInteractions(panel, _anchorElement, slotInfo, onReturnExtra) {
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
                    // Court View callers pass a callback to restore any Court-View-specific
                    // content they hid before showing the panel.
                    if (onReturnExtra) onReturnExtra();
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
                const fromMinutes = parseInt(el.dataset.fromMinutes);
                const toMinutes = parseInt(el.dataset.toMinutes);
                const slotClubId = el.dataset.clubId;

                // Build an ordered fallback court list (gated > edge > neither, then by
                // courtOrder within each tier) so the Worker can retry on other courts if
                // the primary court is snagged first.
                const allCourts = (() => {
                    const transformed = lastFetchState && lastFetchState.transformed;
                    if (!transformed) return [];
                    for (const todSlots of Object.values(transformed)) {
                        for (const clubEntry of todSlots) {
                            if (clubEntry.clubId !== slotClubId) continue;
                            for (const slot of (clubEntry.availabilities || [])) {
                                if (slot.fromInMinutes === fromMinutes && slot.toInMinutes === toMinutes) {
                                    return slot.courts.slice().sort((a, b) => {
                                        const score = c => {
                                            if ((GATED_COURTS[slotClubId] || []).includes(c.courtName)) return 0;
                                            if ((EDGE_COURTS[slotClubId] || []).includes(c.courtName)) return 1;
                                            return 2;
                                        };
                                        return score(a) - score(b) || a.courtOrder - b.courtOrder;
                                    });
                                }
                            }
                        }
                    }
                    return [];
                })();

                const slotInfo = {
                    clubId: slotClubId,
                    courtId: el.dataset.courtId,
                    courtName: el.dataset.court,
                    clubName: el.dataset.clubName,
                    date: lastFetchState?.params?.date,
                    fromMinutes,
                    toMinutes,
                    fromTime: el.dataset.from,
                    toTime: el.dataset.to,
                    dateLabel: lastFetchState?.params?.date
                        ? new Date(lastFetchState.params.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        : '',
                    allCourts,
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
                const selfProfileForPhoto = getLocalStorageService().getJson(STORAGE_KEYS.SELF_PROFILE, '[bc] failed to parse self profile');
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
                // Compute the booking window cutoff in Pacific time. Adding days as ms
                // is timezone-independent; flooring to the 30-minute boundary uses
                // Pacific minutes so the cutoff aligns with the actual window the
                // Bay Club server enforces, regardless of the user's local timezone.
                const candidateMs = Date.now() + BOOKING_ADVANCE_DAYS * 24 * 60 * 60 * 1000;
                const pacificMinute = parseInt(
                    new Intl.DateTimeFormat('en-US', {
                        timeZone: 'America/Los_Angeles',
                        minute: 'numeric',
                    }).format(new Date(candidateMs)),
                    10
                );
                const limitDate = new Date(candidateMs - (pacificMinute % 30) * 60 * 1000 - (candidateMs % 60000));

                const lastFetchState = getBookingStateService().getLastFetchState();
                if (!lastFetchState) return;
                const failedClubIdsSet = new Set(lastFetchState.failedClubIds || []);
                const { allClubIds, clubMeta, byClubAndTod } = buildClubIndex(transformed, failedClubIdsSet);

                const { startMinutes, endMinutes } = getTimeRange();
                const podConflictsByClubId = computePodConflicts(fetchDate, lastFetchState);

                let html = `<div class="all-clubs-availability" style="margin-top: 12px; padding-bottom: 200px;">`;
                html += buildShowIndoorCourtsOnlyToggleHtml();
                html += buildTimeRangeSliderHtml(startMinutes, endMinutes);
                html += buildViewToggleHtml();
                html += buildDebugPanelHtml(DEBUG_PANEL_SURFACE_AVAILABILITY);
                html += buildFailedClubsWarningHtml(failedClubIdsSet);

                // Render the time slots in the selected layout mode.
                if (getViewMode() === VIEW_MODE_BY_TIME) {
                    html += buildByTimeHtml(allClubIds, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet, podConflictsByClubId);
                } else {
                    for (const clubId of allClubIds) {
                        html += buildClubHtml(clubId, clubMeta, byClubAndTod, fetchDate, limitDate, failedClubIdsSet, podConflictsByClubId[clubId] || null);
                    }
                }

                html += `</div>`;

                hideNativeAvailabilityContent(anchorElement);
                appendRenderedAvailabilityHtml(anchorElement, html);
                wirePostRenderInteractions(anchorElement, startMinutes, endMinutes, fetchDate);
            }

            // Initiates a booking originating from the court view grid.
            // Phase 1 (this function): records the pending slot, updates the bottom bar,
            // Selector for an available (not blocked) time slot inside the native Court View
            // calendar.  Angular renders these inside app-booking-calendar regardless of
            // whether that element is visible.
            const COURT_VIEW_AVAILABLE_SLOT =
                'app-booking-calendar div.booking-calendar-column-time-slot:not(.booking-calendar-column-time-slot-unavailable)';

            // Initiates a booking originating from the court view grid.
            // Clicks a hidden native Court View slot immediately to advance Angular's state
            // machine (enabling Next), then updates the bottom bar label.  The real Next
            // button click is NOT intercepted — Angular handles navigation on its own trusted
            // click once its state is already advanced.
            function bookFromCourtView(slotInfo, slotLabel) {
                if (cancelBarUpdate) { cancelBarUpdate(); cancelBarUpdate = null; }
                if (nextButtonInterceptor) {
                    document.removeEventListener('click', nextButtonInterceptor, true);
                    nextButtonInterceptor = null;
                }

                getBookingStateService().setPendingSlotBooking(slotInfo);

                // Wire a capture-phase listener on the Next button.  When the user
                // clicks Next (a real trusted click), we advance Angular's state machine
                // synchronously by clicking a hidden Court View slot while still inside
                // Angular's zone (zone.js patched addEventListener, so the capture handler
                // runs in-zone).  We do NOT call stopPropagation or preventDefault, so the
                // original trusted click continues through Angular's target/bubble phase
                // and navigates normally.
                nextButtonInterceptor = function onNextClick(event) {
                    const btn = event.target.closest('button');
                    if (!btn || !btn.textContent.trim().includes('NEXT')) return;

                    document.removeEventListener('click', nextButtonInterceptor, true);
                    nextButtonInterceptor = null;

                    // Click a Court View slot while Angular's calendar is temporarily
                    // visible so Angular's change detection processes the selection.
                    const cal = document.querySelector('app-booking-calendar');
                    const slot = document.querySelector(COURT_VIEW_AVAILABLE_SLOT);
                    if (slot) {
                        if (cal) {
                            cal.style.display = '';
                            cal.style.visibility = 'hidden';
                            cal.style.position = 'fixed';
                            cal.style.top = '-9999px';
                            cal.style.left = '-9999px';
                        }
                        slot.click();
                        if (cal) {
                            cal.style.display = 'none';
                            cal.style.visibility = '';
                            cal.style.position = '';
                            cal.style.top = '';
                            cal.style.left = '';
                        }
                    }
                    // Fall through — the original trusted Next click propagates to Angular.
                };
                document.addEventListener('click', nextButtonInterceptor, true);

                // Update the bottom bar with our slot label, overriding Angular's native
                // label (which reflects the wrong court).  Poll until the bar appears —
                // Firefox renders it asynchronously after the slot click.
                const barDeadline = Date.now() + 6000;
                const barInterval = setInterval(() => {
                    const bottomBar = document.querySelector('.white-bg.p-2 .container');
                    if (!bottomBar) { if (Date.now() > barDeadline) clearInterval(barInterval); return; }

                    const infoHolder = getOrCreateSelectedBookingInfoHolder(bottomBar);
                    const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                    if (nativeInfo) nativeInfo.style.display = 'none';
                    infoHolder.textContent = slotLabel;

                    clearInterval(barInterval);
                    if (Date.now() > barDeadline) clearInterval(barInterval);
                }, 150);
                cancelBarUpdate = () => clearInterval(barInterval);
            }

            // Handles a click on a locked (outside-booking-window) slot in the native
            // Court View grid.  Derives the slot time from its DOM position, checks that
            // no existing event occupies the slot, then shows the partner picker / schedule
            // panel using the same panel builder and interaction wiring used by Hour View.
            async function handleCourtViewLockedSlotClick(slot) {
                const column = slot.closest('app-booking-calendar-column[data-bc-club-id]');
                if (!column) return;

                const clubId = column.getAttribute('data-bc-club-id');
                const courtId = column.getAttribute('data-bc-court-id');
                if (!clubId || !courtId) return;

                const lastFetchState = getBookingStateService().getLastFetchState();
                if (!lastFetchState) return;
                const slotDate = lastFetchState.params && lastFetchState.params.date;
                if (!slotDate) return;

                // Derive fromMinutes from the slot's index within the column's slot list.
                // The grid always starts at COURT_VIEW_GRID_START_MINUTES (7:00 AM).
                const allSlots = Array.from(
                    column.querySelectorAll('.booking-calendar-column-time-slot')
                );
                const slotIndex = allSlots.indexOf(slot);
                if (slotIndex < 0) return;
                const fromMinutes = COURT_VIEW_GRID_START_MINUTES + slotIndex * 30;

                // Skip slots that already have a booking or lesson event.
                const clubEvents = lastFetchState.courtsheetEventsByClubId &&
                    lastFetchState.courtsheetEventsByClubId[clubId];
                if (clubEvents && clubEvents.some(function (ev) {
                    return ev.court && ev.court.courtId === courtId &&
                        ev.timeFromInMinutes < fromMinutes + 30 &&
                        ev.timeToInMinutes > fromMinutes;
                })) { return; }

                // Derive booking duration from the current session's timeSlotId param,
                // capping at 60 minutes for Santa Clara.
                const rawTimeSlotId = lastFetchState.params.timeSlotId;
                const effectiveTimeSlotId = CLUB_MAX_TIMESLOT[clubId] && rawTimeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : rawTimeSlotId;
                const durationMinutes = effectiveTimeSlotId === TIMESLOTS.min90 ? 90 : 60;
                const toMinutes = fromMinutes + durationMinutes;

                const courtsOrder = getBookingStateService().getMergedCourtsOrder() || [];
                const courtEntry = courtsOrder.find(function (c) { return c.courtId === courtId; });
                const courtName = (courtEntry && courtEntry.courtName) || 'Court';
                const clubName = CLUB_SHORT_NAMES[clubId] || clubId;

                // Build a quality-ordered fallback court list for the Worker's retry logic.
                // Gated courts are most prized, then edge courts, then the rest.
                const allCourts = courtsOrder
                    .filter(function (c) { return c.clubId === clubId; })
                    .sort(function (a, b) {
                        const score = function (c) {
                            if ((GATED_COURTS[clubId] || []).includes(c.courtName)) return 0;
                            if ((EDGE_COURTS[clubId] || []).includes(c.courtName)) return 1;
                            return 2;
                        };
                        return score(a) - score(b) || a.courtOrder - b.courtOrder;
                    })
                    .map(function (c) {
                        return { courtId: c.courtId, courtName: c.courtName, courtOrder: c.courtOrder };
                    });

                const slotInfo = {
                    clubId,
                    courtId,
                    courtName,
                    clubName,
                    date: slotDate,
                    fromMinutes,
                    toMinutes,
                    fromTime: minutesToHumanTime(fromMinutes),
                    toTime: minutesToHumanTime(toMinutes),
                    dateLabel: new Date(slotDate + 'T00:00:00').toLocaleDateString('en-US', {
                        weekday: 'short', month: 'short', day: 'numeric',
                    }),
                    allCourts,
                };

                let players, photosByMemberId;
                try {
                    ({ players, photosByMemberId } = await getScheduledBookingService().fetchPossiblePlayers());
                } catch (error) {
                    console.log('[bc] court view locked slot: failed to load partner picker:', error);
                    return;
                }

                // Inject the schedule panel as a fixed full-viewport overlay on body so
                // we never touch app-booking-calendar's display — hiding it would fire the
                // MutationObserver reconcile and immediately clear our content.
                const panelHtml = buildSchedulePanelHtml(slotInfo, players, photosByMemberId);
                const overlay = document.createElement('div');
                overlay.setAttribute('data-bc-cv-schedule-overlay', '1');
                overlay.style.cssText = [
                    'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;',
                    'overflow-y:auto;background:#1a2f3c;box-sizing:border-box;',
                    'padding:72px 16px 40px;',
                ].join('');
                const wrapper = document.createElement('div');
                wrapper.innerHTML = panelHtml;
                overlay.appendChild(wrapper.firstElementChild);
                document.body.appendChild(overlay);

                const hostPanel = overlay.querySelector('[data-bc-schedule-panel]');
                if (hostPanel) {
                    // onReturnExtra removes the overlay wrapper after the standard panel
                    // cleanup removes the inner [data-bc-schedule-panel] node.
                    bindSchedulePanelInteractions(hostPanel, null, slotInfo, function () {
                        document.querySelectorAll('[data-bc-cv-schedule-overlay]').forEach(function (el) {
                            el.remove();
                        });
                    });
                }

                // Fetch any missing photos using the same post-injection logic as Hour View.
                const selfProfileForPhoto = getLocalStorageService().getJson(
                    STORAGE_KEYS.SELF_PROFILE, '[bc] failed to parse self profile'
                );
                const selfMemberId = selfProfileForPhoto && selfProfileForPhoto.memberId;
                const selfPhotoMissing = selfMemberId && !photosByMemberId[selfMemberId];
                const hasCachedPhotosForPlayers = Object.keys(photosByMemberId).length > 0;

                let freshPhotos = null;
                if (!hasCachedPhotosForPlayers) {
                    const playersForPhotos = selfMemberId
                        ? players.concat([{ memberId: selfMemberId }])
                        : players;
                    freshPhotos = await getScheduledBookingService().fetchPhotos(playersForPhotos);
                } else if (selfPhotoMissing) {
                    freshPhotos = await getScheduledBookingService().fetchPhotos([{ memberId: selfMemberId }]);
                }

                if (freshPhotos) {
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

            serviceInstance = {
                applyFilters,
                renderAllClubsAvailability,
                bookFromCourtView,
                handleCourtViewLockedSlotClick,
                isCourtViewBookingInFlight: () => courtViewBookingInFlight,
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
        getBookingStateService().clearRawFetchState();
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
                    document.dispatchEvent(new CustomEvent('bc-navigated'));
                };

                history.replaceState = function (...args) {
                    originalReplaceState.apply(this, args);
                    evaluateBookingFlowMonitoringState();
                    document.dispatchEvent(new CustomEvent('bc-navigated'));
                };

                window.addEventListener('popstate', function () {
                    evaluateBookingFlowMonitoringState();
                    document.dispatchEvent(new CustomEvent('bc-navigated'));
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


    // #region Court view service and grid renderer.

    // Row height in pixels for each 30-minute time band in the court grid, matching the native DOM.
    const COURT_VIEW_ROW_HEIGHT_PX = 64;
    // Column width in pixels for each court column in the grid, matching the native DOM.
    const COURT_VIEW_COLUMN_WIDTH_PX = 140;
    // Attribute placed on the injected court view root so cleanup can find it unambiguously.
    const COURT_VIEW_CONTAINER_ATTR = 'data-bc-court-view';

    const getCourtViewService = (() => {
        let serviceInstance = null;

        return function getCourtViewService() {
            if (serviceInstance) return serviceInstance;

            // Per-club cache: { [clubId]: { date, courtSheetData, courtsData } }
            const clubDataCache = {};
            let injectedContainer = null;
            // Tracks the selectedOverlay currently shown so it can be cleared when the
            // user clicks a different slot (possibly in a different court column).
            let activeSelectionOverlay = null;

            // --- Storage helpers ---

            function loadSelectedClub() {
                const stored = getLocalStorageService().getString(STORAGE_KEYS.COURT_VIEW_CLUB);
                if (stored && Object.values(CLUBS).includes(stored)) return stored;
                // Default to the user's first preferred club, which is their home club.
                const order = getLocalStorageService().getJson(STORAGE_KEYS.CLUB_ORDER);
                if (Array.isArray(order) && order.length > 0) return order[0];
                return CLUBS.broadway;
            }

            function saveSelectedClub(clubId) {
                getLocalStorageService().setString(STORAGE_KEYS.COURT_VIEW_CLUB, clubId);
            }

            // --- Fetch helpers ---

            async function fetchCourtSheet(clubId, date) {
                const r = await fetch(
                    `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${clubId}?date=${date}`,
                    {
                        headers: {
                            'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                            'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                            'Request-Id': crypto.randomUUID(),
                            'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                            'Accept': 'application/json',
                        },
                    }
                );
                if (!r.ok) throw new Error(`courtsheet HTTP ${r.status}`);
                return r.json();
            }

            async function fetchCourtsForClub(clubId, date, params) {
                // params provides categoryCode, categoryOptionsId, and timeSlotId captured from the
                // native availability request; without them the /courts endpoint returns no availability.
                // Santa Clara only supports 60-minute slots, so cap the timeSlotId the same way
                // fetchAllClubs does to avoid receiving empty availability from the /courts endpoint.
                const timeSlotId = CLUB_MAX_TIMESLOT[clubId] && params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : (params.timeSlotId || '');
                const qs = new URLSearchParams({
                    date,
                    categoryCode: params.categoryCode || 'pickleball',
                    categoryOptionsId: params.categoryOptionsId || '',
                    timeSlotId,
                }).toString();
                const r = await fetch(
                    `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${clubId}/courts?${qs}`,
                    {
                        headers: {
                            'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                            'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                            'Request-Id': crypto.randomUUID(),
                            'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                            'Accept': 'application/json',
                        },
                    }
                );
                if (!r.ok) throw new Error(`courts HTTP ${r.status}`);
                return r.json();
            }

            async function fetchAvailabilityForClub(clubId, date, params) {
                const timeSlotId = CLUB_MAX_TIMESLOT[clubId] && params.timeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : (params.timeSlotId || '');
                const qs = new URLSearchParams({
                    clubId,
                    date,
                    categoryCode: params.categoryCode || 'pickleball',
                    categoryOptionsId: params.categoryOptionsId || '',
                    timeSlotId,
                }).toString();
                const r = await fetch(
                    `https://connect-api.bayclubs.io/court-booking/api/1.0/availability?${qs}`,
                    {
                        headers: {
                            'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                            'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                            'Request-Id': crypto.randomUUID(),
                            'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                            'Accept': 'application/json',
                        },
                    }
                );
                if (!r.ok) throw new Error(`availability HTTP ${r.status}`);
                return r.json();
            }

            async function fetchClubData(clubId, date, params) {
                if (clubDataCache[clubId] && clubDataCache[clubId].date === date) {
                    return clubDataCache[clubId];
                }
                const [courtSheetData, courtsData, availabilityData] = await Promise.all([
                    fetchCourtSheet(clubId, date),
                    fetchCourtsForClub(clubId, date, params),
                    fetchAvailabilityForClub(clubId, date, params),
                ]);
                const entry = { date, courtSheetData, courtsData, availabilityData };
                clubDataCache[clubId] = entry;
                return entry;
            }

            // --- Grid rendering ---

            // Derives the visible time range for the grid from the union of available slot
            // times and event times.  Floors at 6 am and ceils at 10 pm so the grid always
            // spans a useful day range even when availability is sparse.
            function deriveVisibleTimeRange(availableTimeSlots, allEvents) {
                let earliest = 22 * 60; // 10 pm — will be pushed earlier by real data
                let latest   = 6 * 60;  // 6 am  — will be pushed later  by real data
                availableTimeSlots.forEach(s => {
                    if (s.fromInMinutes < earliest) earliest = s.fromInMinutes;
                    if (s.toInMinutes   > latest)   latest   = s.toInMinutes;
                });
                allEvents.forEach(ev => {
                    if (ev.timeFromInMinutes < earliest) earliest = ev.timeFromInMinutes;
                    if (ev.timeToInMinutes   > latest)   latest   = ev.timeToInMinutes;
                });
                // Clamp to a 6 am–10 pm window.
                earliest = Math.min(earliest, 6 * 60);
                latest   = Math.max(latest,   22 * 60);
                return { fromMinutes: earliest, toMinutes: latest };
            }

            function buildOutsideHoursStyle() {
                // Diagonal stripe pattern matching the native court view outside-hours background.
                return [
                    'background: linear-gradient(135deg,',
                    ' rgb(67,104,139) 25%, rgb(82,116,148) 25%,',
                    ' rgb(82,116,148) 50%, rgb(67,104,139) 50%,',
                    ' rgb(67,104,139) 75%, rgb(82,116,148) 75%,',
                    ' rgb(82,116,148) 100%);',
                    ' background-size: 21.3px 21.3px;',
                ].join('');
            }

            // Builds a single court column as a DOM element.
            // availableMinutes: Set of fromInMinutes values for bookable slots on this court.
            // Bands in availableMinutes are plain (clickable); all others get the stripe pattern.
            // bookingContext: { clubId, date, params } — used to wire available slot clicks.
            function buildCourtColumn(court, events, availableMinutes, visibleFrom, visibleTo, bookingContext) {
                const totalMinutes = visibleTo - visibleFrom;
                const totalPx = Math.round((totalMinutes / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                const col = document.createElement('div');
                col.className = 'bc-cv-court-col';
                col.style.cssText = `position:relative; width:${COURT_VIEW_COLUMN_WIDTH_PX}px; height:${totalPx}px; flex-shrink:0; border-left:1px solid rgba(255,255,255,0.1);`;

                // Derive the booking duration: cap at 60 for Santa Clara, otherwise use
                // the user's selected slot duration from the params.
                const durationMinutes =
                    (bookingContext && CLUB_MAX_TIMESLOT[bookingContext.clubId]) ? 60 :
                    (bookingContext && bookingContext.params.timeSlotId === TIMESLOTS.min90) ? 90 :
                    (bookingContext && bookingContext.params.timeSlotId === TIMESLOTS.min30) ? 30 : 60;

                // Two overlays per column, both pointer-events:none so clicks pass through.
                // hoverOverlay: visible only while mouse is over the column.
                // selectedOverlay: persists after a click until a new slot is selected.
                function makeOverlay(zIndex) {
                    const el = document.createElement('div');
                    el.style.cssText = [
                        'position:absolute; left:1px; right:1px;',
                        'pointer-events:none; box-sizing:border-box;',
                        'background:rgba(0,176,199,0.18); border:2px solid rgb(0,176,199);',
                        `border-radius:3px; display:none; z-index:${zIndex};`,
                    ].join('');
                    col.appendChild(el);
                    return el;
                }
                const selectedOverlay = makeOverlay(2);
                const hoverOverlay    = makeOverlay(3);

                // Given the 30-min band the mouse is over, compute the booking window.
                // Extends forward from m up to durationMinutes.  If there is not enough
                // consecutive available room forward, shifts the window start backward to
                // fill the duration — so hovering near the end of a block still highlights
                // the whole available slot.  Returns { windowStart, windowEnd }.
                function computeWindow(m) {
                    // Forward limit: first unavailable band or event start after m.
                    let blockEnd = visibleTo;
                    for (let t = m + 30; t <= visibleTo; t += 30) {
                        if (!availableMinutes.has(t - 30) && t > m + 30) { blockEnd = t - 30; break; }
                        if (t < visibleTo && !availableMinutes.has(t)) { blockEnd = t; break; }
                    }
                    events.forEach(ev => {
                        if (ev.timeFromInMinutes > m && ev.timeFromInMinutes < blockEnd) {
                            blockEnd = ev.timeFromInMinutes;
                        }
                    });
                    blockEnd = Math.min(blockEnd, visibleTo);

                    // Backward limit: first unavailable band or event end before/at m.
                    let blockStart = m;
                    for (let t = m - 30; t >= visibleFrom; t -= 30) {
                        if (!availableMinutes.has(t)) break;
                        blockStart = t;
                    }
                    events.forEach(ev => {
                        if (ev.timeToInMinutes > blockStart && ev.timeToInMinutes <= m) {
                            blockStart = ev.timeToInMinutes;
                        }
                    });

                    // Prefer window starting at m; shift backward if not enough room forward.
                    let windowStart = m;
                    let windowEnd   = Math.min(m + durationMinutes, blockEnd);
                    if (windowEnd - windowStart < durationMinutes) {
                        windowStart = Math.max(blockStart, blockEnd - durationMinutes);
                    }
                    return { windowStart, windowEnd };
                }

                function positionOverlay(overlay, windowStart, windowEnd) {
                    const top = Math.round(((windowStart - visibleFrom) / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                    const h   = Math.round(((windowEnd - windowStart) / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                    overlay.style.top     = `${top}px`;
                    overlay.style.height  = `${h}px`;
                    overlay.style.display = 'block';
                }

                // Lay down one cell per 30-minute band across the full visible range.
                // Available bands are plain (cursor:pointer); unavailable bands get stripes.
                for (let m = visibleFrom; m < visibleTo; m += 30) {
                    const isAvailable = availableMinutes.has(m);
                    const top = Math.round(((m - visibleFrom) / 30) * COURT_VIEW_ROW_HEIGHT_PX);

                    if (!isAvailable) {
                        // Unavailable / outside-hours band: diagonal stripe, not clickable.
                        const stripe = document.createElement('div');
                        stripe.style.cssText = `position:absolute; left:0; right:0; top:${top}px; height:${COURT_VIEW_ROW_HEIGHT_PX}px; ${buildOutsideHoursStyle()}`;
                        col.appendChild(stripe);
                        continue;
                    }

                    // Available band: plain background, clickable.
                    const cell = document.createElement('div');
                    cell.setAttribute('data-bc-cv-slot', String(m));
                    cell.style.cssText = [
                        `position:absolute; left:0; right:0; top:${top}px;`,
                        `height:${COURT_VIEW_ROW_HEIGHT_PX}px;`,
                        `cursor:pointer; box-sizing:border-box;`,
                        `border-top:1px solid rgba(255,255,255,0.06);`,
                    ].join('');

                    cell.addEventListener('mouseenter', () => {
                        const { windowStart, windowEnd } = computeWindow(m);
                        positionOverlay(hoverOverlay, windowStart, windowEnd);
                        cell.dataset.bcCvWindowStart = String(windowStart);
                        cell.dataset.bcCvWindowEnd   = String(windowEnd);
                    });
                    cell.addEventListener('mouseleave', () => {
                        hoverOverlay.style.display = 'none';
                    });
                    cell.addEventListener('click', () => {
                        const fromMinutes = parseInt(cell.dataset.bcCvWindowStart || String(m), 10);
                        const toMinutes   = parseInt(cell.dataset.bcCvWindowEnd   || String(m + durationMinutes), 10);
                        // Clear the previous selection overlay from whichever column owns it.
                        if (activeSelectionOverlay && activeSelectionOverlay !== selectedOverlay) {
                            activeSelectionOverlay.style.display = 'none';
                        }
                        activeSelectionOverlay = selectedOverlay;
                        positionOverlay(selectedOverlay, fromMinutes, toMinutes);
                        const clubShortName = CLUB_SHORT_NAMES[bookingContext.clubId] || 'Court';
                        const courtLabel = court.courtName || court.name || court.shortName || court.courtShortName || 'Court';
                        const slotLabel = `${clubShortName} \u00b7 ${courtLabel} @ ${minutesToHumanTime(fromMinutes)}\u2013${minutesToHumanTime(toMinutes)}`;
                        getAvailabilityRenderPipeline().bookFromCourtView(
                            {
                                clubId: bookingContext.clubId,
                                courtId: court.courtId,
                                date: bookingContext.date,
                                fromMinutes,
                                toMinutes,
                            },
                            slotLabel
                        );
                    });
                    col.appendChild(cell);
                }

                // Event blocks.
                events.forEach(ev => {
                    const evFrom = ev.timeFromInMinutes;
                    const evTo   = ev.timeToInMinutes;
                    if (evTo <= visibleFrom || evFrom >= visibleTo) return;
                    // Skip cancelled events — they should not appear on the grid.
                    if (ev.status && ev.status.code === 'cancelled') return;

                    const clampedFrom = Math.max(evFrom, visibleFrom);
                    const clampedTo   = Math.min(evTo, visibleTo);
                    const top  = Math.round(((clampedFrom - visibleFrom) / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                    const h    = Math.round(((clampedTo - clampedFrom) / 30) * COURT_VIEW_ROW_HEIGHT_PX);

                    const blockedClass = courtViewBlockedClassForEvent(ev);
                    const bg = ev.isCurrentMemberPlayer
                        ? 'rgb(0, 176, 199)'
                        : courtViewColorForBlockedClass(blockedClass);

                    const block = document.createElement('div');
                    block.style.cssText = [
                        `position:absolute; left:1px; right:1px;`,
                        `top:${top}px; height:${h}px;`,
                        `background:${bg};`,
                        `border-radius:3px; overflow:hidden;`,
                        `font-size:11px; line-height:1.3; color:#1a2a3a;`,
                        `padding:2px 4px; box-sizing:border-box;`,
                    ].join('');

                    const label = buildEventLabel(ev, blockedClass);
                    if (label) {
                        const span = document.createElement('span');
                        span.style.cssText = 'display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
                        span.textContent = label;
                        block.appendChild(span);
                    }
                    col.appendChild(block);
                });

                return col;
            }

            function buildEventLabel(ev, blockedClass) {
                if (blockedClass === COURT_BLOCKED_CLASS.LESSON && ev.instructorName) {
                    return `Lesson: ${ev.instructorName}`;
                }
                if (blockedClass === COURT_BLOCKED_CLASS.CLINIC) {
                    return ev.className || 'Clinic';
                }
                if (blockedClass === COURT_BLOCKED_CLASS.GROUP_CLASS) {
                    return ev.className || 'Group class';
                }
                if (blockedClass === COURT_BLOCKED_CLASS.LEAGUE) {
                    return ev.className || 'League';
                }
                if (blockedClass === COURT_BLOCKED_CLASS.MAINTENANCE) {
                    return 'Maintenance';
                }
                if (blockedClass === COURT_BLOCKED_CLASS.OPEN_PLAY) {
                    return 'Open play';
                }
                // Regular member booking: show name if it's the logged-in member's booking.
                if (ev.isCurrentMemberPlayer && ev.reservedFor && ev.reservedFor.displayName) {
                    return ev.reservedFor.displayName;
                }
                const category = ev.categoryOptions && ev.categoryOptions.name;
                return category || null;
            }

            // Builds the time label column that runs down the left side of the grid.
            function buildTimeAxisColumn(visibleFrom, visibleTo) {
                const col = document.createElement('div');
                col.className = 'bc-cv-time-col';
                col.style.cssText = `position:relative; width:56px; flex-shrink:0;`;

                const totalMinutes = visibleTo - visibleFrom;
                const totalPx = Math.round((totalMinutes / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                col.style.height = `${totalPx}px`;

                for (let m = visibleFrom; m < visibleTo; m += 30) {
                    const top = Math.round(((m - visibleFrom) / 30) * COURT_VIEW_ROW_HEIGHT_PX);
                    const label = document.createElement('div');
                    label.style.cssText = [
                        `position:absolute; left:0; right:0; top:${top}px;`,
                        `height:${COURT_VIEW_ROW_HEIGHT_PX}px;`,
                        `font-size:11px; color:rgba(255,255,255,0.6);`,
                        `padding:2px 4px; box-sizing:border-box;`,
                        `border-top:1px solid rgba(255,255,255,0.08);`,
                    ].join('');
                    // Only label the top of each hour (on-the-hour slots).
                    if (m % 60 === 0) {
                        label.textContent = minutesToHumanTime(m);
                    }
                    col.appendChild(label);
                }
                return col;
            }

            // Builds the row of column headers (court short names) above the grid body.
            function buildHeaderRow(courtsItems) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; flex-direction:row; position:sticky; top:0; z-index:2; background:#1a2a3a;';

                // Spacer for the time axis column.
                const spacer = document.createElement('div');
                spacer.style.cssText = `width:56px; flex-shrink:0;`;
                row.appendChild(spacer);

                courtsItems.forEach(court => {
                    const cell = document.createElement('div');
                    cell.style.cssText = [
                        `width:${COURT_VIEW_COLUMN_WIDTH_PX}px; flex-shrink:0;`,
                        `border-left:1px solid rgba(255,255,255,0.1);`,
                        `padding:6px 4px; text-align:center;`,
                        `font-size:12px; font-weight:bold; color:rgba(255,255,255,0.9);`,
                        `box-sizing:border-box;`,
                    ].join('');
                    cell.textContent = court.shortName || court.name || '';
                    row.appendChild(cell);
                });

                return row;
            }

            // Renders the full court grid for the given data and appends it to container.
            function renderCourtGrid(container, courtsData, courtSheetData, availabilityData, date, clubId, params) {
                const courtsItems        = (courtsData.items || []);
                const allEvents          = (courtSheetData.events || []);
                // availableTimeSlots from the availability endpoint: each entry has courtId,
                // fromInMinutes, and toInMinutes for a bookable slot.
                const availableTimeSlots = (
                    availabilityData &&
                    availabilityData.clubsAvailabilities &&
                    availabilityData.clubsAvailabilities[0] &&
                    availabilityData.clubsAvailabilities[0].availableTimeSlots
                ) || [];

                // Compute the visible time span from the union of available and event times.
                const { fromMinutes: visibleFrom, toMinutes: visibleTo } =
                    deriveVisibleTimeRange(availableTimeSlots, allEvents);

                // Build a lookup from courtSetupVersionId → courtId using the courts list
                // inside the availability response, since those version IDs are guaranteed to
                // match the courtsVersionsIds values in availableTimeSlots (same response).
                const availabilityCourts = (
                    availabilityData &&
                    availabilityData.clubsAvailabilities &&
                    availabilityData.clubsAvailabilities[0] &&
                    availabilityData.clubsAvailabilities[0].courts
                ) || [];
                const versionToCourtId = {};
                availabilityCourts.forEach(court => {
                    if (court.courtSetupVersionId && court.courtId) {
                        versionToCourtId[court.courtSetupVersionId] = court.courtId;
                    }
                });

                // Build a per-court Set of available start-minutes for O(1) lookup in buildCourtColumn.
                // courtsVersionsIds lists every court that can satisfy the slot — not just the
                // primary courtId field — so we index by all of them.
                const availableByCourtId = {};
                availableTimeSlots.forEach(s => {
                    const versionIds = Array.isArray(s.courtsVersionsIds) ? s.courtsVersionsIds : [];
                    versionIds.forEach(vId => {
                        const cId = versionToCourtId[vId];
                        if (!cId) return;
                        if (!availableByCourtId[cId]) availableByCourtId[cId] = new Set();
                        availableByCourtId[cId].add(s.fromInMinutes);
                    });
                });

                // Build the scrollable grid body.
                const gridBody = document.createElement('div');
                gridBody.style.cssText = 'display:flex; flex-direction:row; overflow-x:auto;';

                gridBody.appendChild(buildTimeAxisColumn(visibleFrom, visibleTo));

                courtsItems.forEach(court => {
                    const courtEvents     = allEvents.filter(ev =>
                        ev.court && ev.court.courtId === court.courtId
                    );
                    const availableMinutes = availableByCourtId[court.courtId] || new Set();
                    gridBody.appendChild(buildCourtColumn(
                        court, courtEvents, availableMinutes, visibleFrom, visibleTo,
                        { clubId, date, params }
                    ));
                });

                container.appendChild(buildHeaderRow(courtsItems));
                container.appendChild(gridBody);
            }

            // Builds the four-button club selector strip and appends it to container.
            function renderClubSelector(container, selectedClub, onSelect) {
                const strip = document.createElement('div');
                strip.setAttribute('data-bc-cv-club-selector', '1');
                strip.style.cssText = [
                    'display:flex; flex-direction:row; flex-wrap:wrap; gap:6px;',
                    'padding:8px 0 12px 0;',
                ].join('');

                const clubOrder = (() => {
                    const stored = getLocalStorageService().getJson(STORAGE_KEYS.CLUB_ORDER);
                    return (Array.isArray(stored) && stored.length > 0)
                        ? stored
                        : Object.values(CLUBS);
                })();

                clubOrder.forEach(clubId => {
                    const btn = document.createElement('button');
                    btn.setAttribute('data-bc-cv-club-btn', clubId);
                    btn.textContent = CLUB_SHORT_NAMES[clubId] || clubId;
                    btn.style.cssText = [
                        'padding:5px 12px; border-radius:16px; border:none; cursor:pointer;',
                        'font-size:13px; font-weight:600;',
                        clubId === selectedClub
                            ? 'background:rgb(0,176,199); color:#fff;'
                            : 'background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.75);',
                    ].join('');
                    btn.addEventListener('click', () => onSelect(clubId));
                    strip.appendChild(btn);
                });

                container.appendChild(strip);
            }

            // Updates button highlight state within an already-rendered club selector strip
            // without rebuilding the full strip.
            function updateClubSelectorHighlight(container, selectedClub) {
                container.querySelectorAll('[data-bc-cv-club-btn]').forEach(btn => {
                    const isSelected = btn.getAttribute('data-bc-cv-club-btn') === selectedClub;
                    btn.style.background = isSelected
                        ? 'rgb(0,176,199)'
                        : 'rgba(255,255,255,0.12)';
                    btn.style.color = isSelected
                        ? '#fff'
                        : 'rgba(255,255,255,0.75)';
                });
            }

            // Shows a loading spinner overlay inside container.
            function showLoadingState(container) {
                let spinner = container.querySelector('[data-bc-cv-spinner]');
                if (!spinner) {
                    spinner = document.createElement('div');
                    spinner.setAttribute('data-bc-cv-spinner', '1');
                    spinner.style.cssText = [
                        'padding:32px; text-align:center;',
                        'color:rgba(255,255,255,0.6); font-size:14px;',
                    ].join('');
                    spinner.textContent = 'Loading court schedule…';
                    container.appendChild(spinner);
                }
            }

            // Removes the loading spinner and any previously rendered grid from container.
            function clearGridContent(container) {
                container.querySelectorAll('[data-bc-cv-spinner], [data-bc-cv-grid]').forEach(el => el.remove());
            }

            // Finds the app-booking-calendar element and moves it off-screen using
            // position:fixed so it is invisible to the user but remains live for Angular's
            // change detection (display:none would detach it from Angular's rendering tree,
            // preventing slot clicks from advancing the booking state machine).
            function hideNativeCourtCalendar() {
                const cal = document.querySelector('app-booking-calendar');
                if (!cal) return;
                if (cal.getAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR)) return;
                cal.style.display = 'none';
                cal.setAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR, '1');
            }

            // Finds a suitable host element adjacent to app-booking-calendar and injects
            // our court view container as a sibling.
            function ensureContainerInjected() {
                if (injectedContainer && document.contains(injectedContainer)) return injectedContainer;

                const cal = document.querySelector('app-booking-calendar');
                if (!cal) return null;

                const host = cal.parentElement;
                if (!host) return null;

                const div = document.createElement('div');
                div.setAttribute(COURT_VIEW_CONTAINER_ATTR, '1');
                div.style.cssText = 'padding:8px 12px; box-sizing:border-box;';
                host.insertBefore(div, cal);
                injectedContainer = div;
                return div;
            }

            // Fetches data for the given club and date then re-renders the grid section.
            async function loadAndRenderGrid(container, clubId, date, params) {
                clearGridContent(container);
                showLoadingState(container);

                let entry;
                try {
                    entry = await fetchClubData(clubId, date, params);
                } catch (err) {
                    getDebugService().log('warn', 'court-view-fetch-failed', { clubId, error: String(err) });
                    clearGridContent(container);
                    const errMsg = document.createElement('div');
                    errMsg.style.cssText = 'padding:16px; color:rgba(255,100,100,0.9); font-size:13px;';
                    errMsg.textContent = 'Could not load court schedule. Please try again later.';
                    container.appendChild(errMsg);
                    return;
                }

                clearGridContent(container);
                const grid = document.createElement('div');
                grid.setAttribute('data-bc-cv-grid', '1');
                grid.dataset.bcCvClub = clubId;
                grid.dataset.bcCvDate = date;
                grid.style.cssText = 'overflow-x:auto;';
                renderCourtGrid(grid, entry.courtsData, entry.courtSheetData, entry.availabilityData, date, clubId, params);
                container.appendChild(grid);
            }

            // Polls for app-booking-calendar up to maxWaitMs then resolves to the
            // ensureContainerInjected result (or null if the element never appeared).
            async function waitForCalendarAndInjectContainer(maxWaitMs) {
                const POLL_INTERVAL_MS = 100;
                const deadline = Date.now() + maxWaitMs;
                while (Date.now() < deadline) {
                    const container = ensureContainerInjected();
                    if (container) return container;
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
                }
                return ensureContainerInjected();
            }

            // Public entry point: inject the court view for the given date and params.
            // Idempotent — calling again on an already-injected view updates the club/date.
            async function injectCourtView(date, params) {
                hideNativeCourtCalendar();
                // Angular renders app-booking-calendar asynchronously after the COURT VIEW
                // tab is clicked.  Poll briefly so we don't give up on the first pass.
                const container = await waitForCalendarAndInjectContainer(2000);
                if (!container) return;

                let selectedClub = loadSelectedClub();

                // Render or update the club selector.
                const existingSelector = container.querySelector('[data-bc-cv-club-selector]');
                if (!existingSelector) {
                    renderClubSelector(container, selectedClub, clubId => {
                        selectedClub = clubId;
                        saveSelectedClub(clubId);
                        updateClubSelectorHighlight(container, clubId);
                        loadAndRenderGrid(container, clubId, date, params);
                    });
                } else {
                    updateClubSelectorHighlight(container, selectedClub);
                }

                // Skip the re-render if the grid is already present for the same club and date.
                // injectCourtView is called on every reconcile pass (MutationObserver + RAF), so
                // without this guard the grid is torn down and rebuilt on every DOM mutation,
                // destroying event listeners before the user can interact.
                const existingGrid = container.querySelector('[data-bc-cv-grid]');
                if (existingGrid &&
                    existingGrid.dataset.bcCvClub === selectedClub &&
                    existingGrid.dataset.bcCvDate === date) {
                    return;
                }

                await loadAndRenderGrid(container, selectedClub, date, params);
            }

            // Hides or shows the injected container.
            // Used when the user toggles between COURT VIEW and HOUR VIEW tabs without
            // leaving the booking flow — keeps the rendered grid alive so it doesn't need
            // to be re-fetched when the user switches back.
            // We do NOT touch app-booking-calendar here: Angular manages its own tab
            // visibility and restoring its display when switching to Hour View can overlap
            // Angular content and interfere with the booking state machine.
            // The full native-content restore happens only in removeOurContentAndUnhideNativeContent.
            function setVisible(visible) {
                if (injectedContainer) {
                    injectedContainer.style.display = visible ? '' : 'none';
                }
                if (visible) {
                    // Court view becoming visible: hide the native calendar so our grid
                    // takes its place without the two overlapping.
                    hideNativeCourtCalendar();
                }
            }

            // Removes the injected container and reference so the next call to injectCourtView
            // starts fresh.  Called only on full booking-flow exit.
            function clearInjectedContent() {
                if (injectedContainer) {
                    injectedContainer.remove();
                    injectedContainer = null;
                }
                document.querySelectorAll(`[${COURT_VIEW_CONTAINER_ATTR}]`).forEach(el => el.remove());
            }

            serviceInstance = { injectCourtView, setVisible, clearInjectedContent };
            return serviceInstance;
        };
    })();

    // #endregion Court view service and grid renderer.

    // #region Native court column tagging service.
    // This service implements the new Court View booking approach: instead of rendering
    // our own custom grid, we inject all clubs' court data into Angular's native
    // availability response so Angular renders every court as a native column.  We then
    // tag each rendered column with data-bc-club-id and show/hide by selected club.
    // Because users click real Angular-rendered slots, the Next button routing works
    // without any state machine hacking.

    // Builds the corrected bottom bar label for a native Court View slot click.
    // Angular's native label has the correct court and time but wrong club name.
    // We strip the home club's short name (if present) and prepend the correct one.
    function buildCourtViewBarLabel(nativeText, homeClubShortName, correctClubShortName) {
        const stripped = homeClubShortName
            ? (nativeText || '').replace(new RegExp(homeClubShortName + '[\\s·•,]*', 'i'), '').trim()
            : (nativeText || '').trim();
        return stripped ? correctClubShortName + ' · ' + stripped : correctClubShortName;
    }

    const getNativeCourtColumnsService = (() => {
        let serviceInstance = null;

        return function getNativeCourtColumnsService() {
            if (serviceInstance) return serviceInstance;

            // Expands abbreviated Court View court names to their canonical form so
            // badge lookup tables (which use full names) match correctly.
            // Angular renders "PB1" for Santa Clara and bare "1" for Redwood Shores
            // while the availability API and lookup tables use "Pickleball 1".
            function normalizeCourtViewName(name) {
                const pbMatch = name.match(/^PB(\d+)$/i);
                if (pbMatch) return 'Pickleball ' + pbMatch[1];
                if (/^\d+$/.test(name)) return 'Pickleball ' + name;
                return name;
            }

            // Tags each app-booking-calendar-column with data-bc-club-id and
            // data-bc-court-id using the merged courts order recorded when the XHR
            // payload was built.  Angular renders columns in the same order courts
            // appear in the response, so index-based mapping is reliable.
            // Also stamps data-bc-pod-conflict on columns belonging to a club where
            // a pod member has an existing reservation, so CSS can dim those columns.
            function tagColumns() {
                const courtsOrder = getBookingStateService().getMergedCourtsOrder();
                if (!courtsOrder || courtsOrder.length === 0) return;
                const columns = document.querySelectorAll('app-booking-calendar-column');

                // Derive pod conflicts once per tag pass so we don't repeat the work
                // per column.  Returns {} when no pod members are configured.
                const lastFetchState = getBookingStateService().getLastFetchState();
                const podConflicts = lastFetchState
                    ? computePodConflicts(lastFetchState.params.date, lastFetchState)
                    : {};

                columns.forEach((col, i) => {
                    if (i >= courtsOrder.length) return;
                    const clubId = courtsOrder[i].clubId;
                    // Prefer the court name Angular has already rendered into the DOM;
                    // the availability API courts often lack human-readable names.
                    const courtName = (
                        col.querySelector('div.court-name')?.textContent?.trim() ||
                        courtsOrder[i].courtName || ''
                    );
                    col.setAttribute('data-bc-club-id', clubId);
                    col.setAttribute('data-bc-court-id', courtsOrder[i].courtId);

                    // Build the E/G/H badge string for this court and stamp it so CSS
                    // can append it to the court name via ::after without touching the DOM.
                    // Court View renders abbreviated names ("PB1", "2"), so normalize
                    // before checking the lookup tables which use full names ("Pickleball 1").
                    const canonicalName = normalizeCourtViewName(courtName);
                    const badges = [];
                    if (isCourtGated(canonicalName, clubId))      badges.push('G');
                    if (isCourtEdge(canonicalName, clubId))       badges.push('E');
                    if (courtHasHittingWall(canonicalName, clubId)) badges.push('H');
                    // Stamp data-bc-badges on div.court-name itself so CSS attr() in
                    // the ::after pseudo-element can read it — attr() resolves on the
                    // element the pseudo-element belongs to, not on an ancestor.
                    const courtNameEl = col.querySelector('div.court-name');
                    if (courtNameEl) {
                        if (badges.length > 0) {
                            courtNameEl.setAttribute('data-bc-badges', badges.join(' '));
                        } else {
                            courtNameEl.removeAttribute('data-bc-badges');
                        }
                    }
                    // Also stamp on the column element for CSS selectors (pod conflict, etc.).
                    if (badges.length > 0) {
                        col.setAttribute('data-bc-badges', badges.join(' '));
                    } else {
                        col.removeAttribute('data-bc-badges');
                    }

                    if (podConflicts[clubId]) {
                        col.setAttribute('data-bc-pod-conflict', podConflicts[clubId].type);
                    } else {
                        col.removeAttribute('data-bc-pod-conflict');
                    }
                });
            }

            // When a non-home-club native slot is clicked, Angular's bottom bar will render
            // with the home club's name.  This listener detects the click, waits for the bar,
            // reads Angular's native text (which has correct court and time), strips the home
            // club name, prepends the correct club name, and replaces the bar text.
            let cancelBarUpdate = null;
            function onCalendarSlotClick(event) {
                // Intercept clicks on locked (outside-window) slots that have no existing
                // event, and open the schedule panel instead of doing nothing.
                const lockedSlot = event.target.closest(
                    '.booking-calendar-column-time-slot.booking-calendar-column-time-slot-unavailable'
                );
                if (lockedSlot) {
                    // Stop propagation in capture phase so Angular's slot-level listener
                    // never fires and never shows its native "slot unavailable" error.
                    event.stopPropagation();
                    getAvailabilityRenderPipeline().handleCourtViewLockedSlotClick(lockedSlot);
                    return;
                }

                const slot = event.target.closest(
                    '.booking-calendar-column-time-slot:not(.booking-calendar-column-time-slot-unavailable)'
                );
                if (!slot) return;

                const col = slot.closest('app-booking-calendar-column[data-bc-club-id]');
                if (!col) return;

                const clubId = col.getAttribute('data-bc-club-id');
                const clubShortName = CLUB_SHORT_NAMES[clubId];
                if (!clubShortName) return;

                // Determine the home club name so we can strip it from Angular's label.
                const lastFetchState = getBookingStateService().getLastFetchState();
                const homeClubId = lastFetchState && lastFetchState.params && lastFetchState.params.nativeClubId;
                const homeClubShortName = (homeClubId && CLUB_SHORT_NAMES[homeClubId]) || '';

                if (cancelBarUpdate) { cancelBarUpdate(); cancelBarUpdate = null; }
                const barDeadline = Date.now() + 6000;
                const barInterval = setInterval(function () {
                    const bottomBar = document.querySelector('.white-bg.p-2 .container');
                    if (!bottomBar) {
                        if (Date.now() > barDeadline) { clearInterval(barInterval); }
                        return;
                    }
                    const nativeInfo = bottomBar.querySelector('.row .col-12.col-md-auto:not(.bc-injected-info)');
                    if (!nativeInfo) {
                        if (Date.now() > barDeadline) { clearInterval(barInterval); }
                        return;
                    }

                    // Read Angular's native label text, strip the home club name, and
                    // prepend the correct club name so users see the right club.
                    const correctedLabel = buildCourtViewBarLabel(
                        nativeInfo.textContent, homeClubShortName, clubShortName
                    );

                    nativeInfo.style.display = 'none';
                    const infoHolder = getOrCreateSelectedBookingInfoHolder(bottomBar);
                    infoHolder.textContent = correctedLabel;

                    clearInterval(barInterval);
                }, 150);
                cancelBarUpdate = function () { clearInterval(barInterval); };
            }

            // Injects a <style> tag with border-top rules so each club's columns get
            // a colored top edge.  Uses data-bc-club-id attribute selectors so no DOM
            // nodes are added inside the columns — Angular's layout is unaffected.
            function injectColumnColorStyles() {
                if (document.querySelector('style[data-bc-col-colors]')) return;
                const rules = Object.entries(CLUB_COLUMN_COLORS).map(function (entry) {
                    const clubId = entry[0];
                    const color = entry[1];
                    const name = CLUB_SHORT_NAMES[clubId] || '';
                    const sel = 'app-booking-calendar-column[data-bc-club-id="' + clubId + '"]';
                    // Colored band at the top of each column header.
                    const bandRule = sel + ' div.booking-calendar-column-header' +
                        '{border-top:4px solid ' + color + ' !important;}';
                    // Club name shown above the court number via ::before on div.court-name.
                    // Purely in-flow — no absolute positioning, no layout disruption.
                    const nameRule = sel + ' div.court-name::before{' +
                        'content:"' + name + '";display:block;font-size:9px;font-weight:600;' +
                        'color:' + color + ';letter-spacing:0.03em;line-height:1.2;margin-bottom:1px;}';
                    return bandRule + nameRule;
                }).join('');
                // Locked slots in tagged columns show a pointer cursor so users know
                // they are clickable.  Hover highlighting is driven by JS (see
                // onCalendarMouseOver) to span the full booking duration as a single
                // unified block.  Each highlighted slot is tagged with its position
                // (first/middle/last/only) so CSS adds top/bottom edges only on the
                // outer slots, suppressing interior horizontal lines between 30-min
                // sub-slots.  Inset shadows stay inside each element's bounds and are
                // not clipped by ancestor overflow:hidden.
                // Columns for a club where a pod member already has a reservation are
                // dimmed so the user can see at a glance that the slot is "claimed"
                // within the pod.  Slots remain clickable — the conflict is a visual
                // cue only.  opacity affects the entire column including the color band.
                const podConflictRule =
                    'app-booking-calendar-column[data-bc-pod-conflict]{opacity:0.45;}';

                // E/G/H badges appended to the court name via ::after using the
                // data-bc-badges attribute value set by tagColumns().  Rendered in the
                // same gold used by Hour View badge indicators, in a slightly smaller
                // font so it tucks neatly after the court number.
                const badgeRule =
                    'div.court-name[data-bc-badges]::after{' +
                    'content:"  " attr(data-bc-badges);' +
                    'font-size:10px;font-weight:700;color:rgba(255,210,80,0.95);' +
                    'letter-spacing:0.04em;}';

                const T = 'rgb(0,188,212)';
                const LR = 'inset 3px 0 0 ' + T + ',inset -3px 0 0 ' + T;
                const TOP = 'inset 0 3px 0 ' + T;
                const BOT = 'inset 0 -3px 0 ' + T;
                const hoverSel = 'app-booking-calendar-column[data-bc-club-id]';
                const lockedHoverRule =
                    hoverSel + ' .booking-calendar-column-time-slot-unavailable{cursor:pointer;}' +
                    hoverSel + ' [data-bc-hover-highlight]' +
                        '{background:rgba(0,188,212,0.22) !important;box-shadow:' + LR + ';}' +
                    hoverSel + ' [data-bc-hover-highlight="first"]{box-shadow:' + LR + ',' + TOP + ';}' +
                    hoverSel + ' [data-bc-hover-highlight="last"]{box-shadow:' + LR + ',' + BOT + ';}' +
                    hoverSel + ' [data-bc-hover-highlight="only"]{box-shadow:' + LR + ',' + TOP + ',' + BOT + ';}';

                const style = document.createElement('style');
                style.setAttribute('data-bc-col-colors', '1');
                style.textContent = rules + podConflictRule + badgeRule + lockedHoverRule;
                document.head.appendChild(style);
            }

            // Clears all hover-highlight attributes set by onCalendarMouseOver.
            function clearLockedSlotHover() {
                document.querySelectorAll('[data-bc-hover-highlight]').forEach(function (el) {
                    el.removeAttribute('data-bc-hover-highlight');
                });
            }

            // Highlights a duration-length window of locked slots around the hovered
            // slot, respecting already-booked events as hard boundaries.
            // Strategy: extend downward (later in time) first; if a booked slot blocks
            // the full duration, fill the shortfall by extending upward (earlier in
            // time) from the hover point; cap at the first booked slot in each direction
            // and at the column bounds.
            function onCalendarMouseOver(event) {
                const lockedSlot = event.target.closest(
                    '.booking-calendar-column-time-slot.booking-calendar-column-time-slot-unavailable'
                );
                clearLockedSlotHover();
                if (!lockedSlot) return;

                const column = lockedSlot.closest('app-booking-calendar-column[data-bc-club-id]');
                if (!column) return;

                const clubId = column.getAttribute('data-bc-club-id');
                const courtId = column.getAttribute('data-bc-court-id');
                const lastFetchState = getBookingStateService().getLastFetchState();
                const rawTimeSlotId = lastFetchState && lastFetchState.params && lastFetchState.params.timeSlotId;
                const effectiveTimeSlotId = CLUB_MAX_TIMESLOT[clubId] && rawTimeSlotId === TIMESLOTS.min90
                    ? CLUB_MAX_TIMESLOT[clubId]
                    : rawTimeSlotId;
                const durationMinutes = effectiveTimeSlotId === TIMESLOTS.min90 ? 90 : 60;
                const durationSlots = durationMinutes / 30;

                const allSlots = Array.from(column.querySelectorAll('.booking-calendar-column-time-slot'));
                const hoverIndex = allSlots.indexOf(lockedSlot);
                if (hoverIndex < 0) return;
                const lastIndex = allSlots.length - 1;

                // Build a set of slot indices that overlap a booked or blocked event.
                const bookedIndices = new Set();
                const clubEvents = lastFetchState && lastFetchState.courtsheetEventsByClubId &&
                    lastFetchState.courtsheetEventsByClubId[clubId];
                if (clubEvents && courtId) {
                    clubEvents.forEach(function (ev) {
                        if (!ev.court || ev.court.courtId !== courtId) return;
                        for (let i = 0; i <= lastIndex; i++) {
                            const slotFrom = COURT_VIEW_GRID_START_MINUTES + i * 30;
                            if (ev.timeFromInMinutes < slotFrom + 30 && ev.timeToInMinutes > slotFrom) {
                                bookedIndices.add(i);
                            }
                        }
                    });
                }

                // Phase 1: extend downward from hover until duration is filled, a booked
                // slot is hit, or the column ends.
                let endIndex = hoverIndex;
                while (
                    endIndex < lastIndex &&
                    endIndex - hoverIndex + 1 < durationSlots &&
                    !bookedIndices.has(endIndex + 1)
                ) {
                    endIndex++;
                }

                // Phase 2: if the downward window is shorter than the full duration,
                // extend upward to fill the shortfall.
                let startIndex = hoverIndex;
                const remaining = durationSlots - (endIndex - hoverIndex + 1);
                for (let filled = 0; filled < remaining; filled++) {
                    if (startIndex <= 0 || bookedIndices.has(startIndex - 1)) break;
                    startIndex--;
                }

                for (let i = startIndex; i <= endIndex; i++) {
                    let position;
                    if (startIndex === endIndex) {
                        position = 'only';
                    } else if (i === startIndex) {
                        position = 'first';
                    } else if (i === endIndex) {
                        position = 'last';
                    } else {
                        position = 'middle';
                    }
                    allSlots[i].setAttribute('data-bc-hover-highlight', position);
                }
            }

            // Injects a small fixed-position legend in the bottom-left corner explaining
            // the E/G/H court badges.  Idempotent — does nothing if already present.
            // The legend is removed in clear() on flow exit.
            function injectBadgeLegend() {
                if (document.querySelector('[data-bc-badge-legend]')) return;
                const legend = document.createElement('div');
                legend.setAttribute('data-bc-badge-legend', '1');
                legend.style.cssText = [
                    'display:flex;gap:12px;align-items:center;',
                    'background:rgba(20,40,55,0.88);border:1px solid rgba(255,255,255,0.15);',
                    'border-radius:6px;padding:6px 12px;font-size:11px;',
                    'color:rgba(255,255,255,0.75);margin-bottom:8px;',
                ].join('');
                legend.innerHTML =
                    '<span style="color:rgba(255,210,80,0.95);font-weight:700;">G</span> Gated &nbsp; ' +
                    '<span style="color:rgba(255,210,80,0.95);font-weight:700;">E</span> Edge &nbsp; ' +
                    '<span style="color:rgba(255,210,80,0.95);font-weight:700;">H</span> Hitting wall';
                // Inject as a static sibling immediately before the calendar so it
                // appears at the top of the court view rather than as a floating overlay.
                const cal = document.querySelector('app-booking-calendar');
                if (cal && cal.parentNode) {
                    cal.parentNode.insertBefore(legend, cal);
                } else {
                    document.body.appendChild(legend);
                }
            }

            // Un-hides the native calendar and wires a MutationObserver to re-tag
            // columns whenever Angular re-renders them (e.g. on date change).
            // Safe to call on every reconcile pass — the observer and click listener
            // are only wired once.
            let columnObserver = null;
            let calendarClickTarget = null;
            function install() {
                const cal = document.querySelector('app-booking-calendar');
                if (!cal) return;
                if (cal.getAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR)) {
                    cal.style.display = '';
                    cal.removeAttribute(getBookingDomQueryService().NATIVE_HIDDEN_ATTR);
                }
                injectColumnColorStyles();
                injectBadgeLegend();
                if (!columnObserver) {
                    columnObserver = new MutationObserver(tagColumns);
                    columnObserver.observe(cal, { childList: true, subtree: true });
                }
                if (!calendarClickTarget) {
                    calendarClickTarget = cal;
                    // Use capture phase so we intercept locked-slot clicks before
                    // Angular's bubble-phase listener on the slot element can fire.
                    cal.addEventListener('click', onCalendarSlotClick, true);
                    cal.addEventListener('mouseover', onCalendarMouseOver);
                    cal.addEventListener('mouseleave', clearLockedSlotHover);
                }
                tagColumns();
            }

            // Removes the color style tag, column tags, disconnects the observer,
            // and removes the click listener.  Called on flow exit.
            function clear() {
                if (cancelBarUpdate) { cancelBarUpdate(); cancelBarUpdate = null; }
                if (columnObserver) {
                    columnObserver.disconnect();
                    columnObserver = null;
                }
                if (calendarClickTarget) {
                    calendarClickTarget.removeEventListener('click', onCalendarSlotClick, true);
                    calendarClickTarget.removeEventListener('mouseover', onCalendarMouseOver);
                    calendarClickTarget.removeEventListener('mouseleave', clearLockedSlotHover);
                    calendarClickTarget = null;
                }
                clearLockedSlotHover();
                document.querySelectorAll('[data-bc-badge-legend]').forEach(el => el.remove());
                document.querySelectorAll('style[data-bc-col-colors]').forEach(el => el.remove());
                document.querySelectorAll('app-booking-calendar-column[data-bc-club-id]').forEach(col => {
                    col.removeAttribute('data-bc-club-id');
                    col.removeAttribute('data-bc-court-id');
                    col.removeAttribute('data-bc-pod-conflict');
                    col.removeAttribute('data-bc-badges');
                    const courtNameEl = col.querySelector('div.court-name');
                    if (courtNameEl) courtNameEl.removeAttribute('data-bc-badges');
                });
            }

            serviceInstance = { install, clear };
            return serviceInstance;
        };
    })();

    // #endregion Native court column tagging service.

    function removeOurContentAndUnhideNativeContent() {
        document.querySelectorAll('.all-clubs-availability').forEach(el => el.remove());
        document.querySelectorAll(`.bc-debug-panel[data-bc-debug-surface="${DEBUG_PANEL_SURFACE_DURATION}"]`).forEach(el => el.remove());
        getCourtViewService().clearInjectedContent();
        getNativeCourtColumnsService().clear();
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

        // On the very first render pass, click whichever tab matches the stored preference
        // (default: hour view).  The native app starts on COURT VIEW, so we must assert our
        // own default.  The data-bc-auto-selected stamp prevents re-firing on subsequent passes.
        if (hourViewBtn && !hourViewBtn.dataset.bcAutoSelected) {
            hourViewBtn.dataset.bcAutoSelected = 'true';
            const preferredView = getBookingViewPreference();
            if (preferredView === BOOKING_VIEW_COURT) {
                // Court view is preferred — only click if it is not already active.
                if (!bookingDomQueryService.isCourtViewActive()) {
                    const courtViewBtn = Array.from(document.querySelectorAll('button'))
                        .find(btn => btn.textContent.trim().startsWith('COURT VIEW'));
                    if (courtViewBtn) { courtViewBtn.click(); return; }
                }
            } else {
                // Hour view is preferred (default) — only click if not already active.
                if (!hourViewBtn.classList.contains('btn-selected')) {
                    hourViewBtn.click();
                    return;
                }
            }
        }

        // After the initial auto-selection, respect the user's explicit tab choice.
        // When the active tab diverges from the stored preference, update the preference
        // so it is remembered for the next session.
        // Court view and hour view are mutually exclusive from this point onward.
        // Rather than destroying and rebuilding, we hide/show each view's DOM so the
        // rendered grid survives tab toggling without a full re-fetch.
        if (bookingDomQueryService.isCourtViewActive()) {
            // Only persist the preference for explicit user tab selections, not for
            // programmatic switches made by the Angular state machine hack.
            if (!getAvailabilityRenderPipeline().isCourtViewBookingInFlight() &&
                    getBookingViewPreference() !== BOOKING_VIEW_COURT) {
                saveBookingViewPreference(BOOKING_VIEW_COURT);
            }
            // Use the native column approach: Angular has already rendered all clubs'
            // courts from the merged payload injected into the XHR response.  Install
            // the column tagger so columns are tagged by club and filtered to the
            // selected club.  The old custom grid service is no longer called here.
            getNativeCourtColumnsService().install();
            return;
        }

        if (!getAvailabilityRenderPipeline().isCourtViewBookingInFlight() &&
                getBookingViewPreference() !== BOOKING_VIEW_HOUR) {
            saveBookingViewPreference(BOOKING_VIEW_HOUR);
        }

        // Hour view is active — hide the court view container (keeps its DOM intact),
        // but only when no court-view booking is in progress.  If pendingSlotBooking is
        // set the user clicked a court-view slot and bookFromCourtView switched to Hour
        // View underneath; the court view UI should stay visible so the user never sees
        // the tab switch and the bottom bar can update normally.
        // While a court-view booking is in flight, bookFromCourtView has switched Hour View
        // on underneath our still-visible court view container.  Skip both the hide and the
        // all-clubs-availability render so no extra content appears above the court grid.
        if (getAvailabilityRenderPipeline().isCourtViewBookingInFlight()) return;

        // Hour View is active — clear the native column tagging so columns are
        // not filtered when the user switches back to Court View later.
        getNativeCourtColumnsService().clear();

        bookingDomQueryService.getTimeSlotHosts().forEach(host => {
            if (host.querySelector('.all-clubs-availability')) return;
            getAvailabilityRenderPipeline().renderAllClubsAvailability(lastFetchState.transformed, host, lastFetchState.params.date);
        });
    }
    // #endregion Booking flow monitor and DOM injection.

    // #region Cross-club fetch and weather enrichment.
    // Fetches the courtsheet booking events for one club on a given date.  Used to
    // detect pod conflicts (same club, same date, confirmed pickleball booking by a
    // pod member) before rendering the availability UI.  Failures are soft — a missing
    // result just means no conflict detection for that club.
    async function fetchCourtSheetEventsForOneClub(clubId, date, signal) {
        const r = await fetch(
            `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${clubId}?date=${date}`,
            {
                signal,
                headers: {
                    'Authorization': getBookingStateService().getCapturedHeader('Authorization'),
                    'X-SessionId': getBookingStateService().getCapturedHeader('X-SessionId'),
                    'Request-Id': crypto.randomUUID(),
                    'Ocp-Apim-Subscription-Key': 'bac44a2d04b04413b6aea6d4e3aad294',
                    'Accept': 'application/json',
                },
            }
        );
        if (!r.ok) throw new Error(`courtsheet HTTP ${r.status} for ${clubId}`);
        return r.json();
    }

    // Fetch availability info for all the clubs in parallel, and combine their results.
    async function fetchAllClubs(params) {
        getDebugService().log('info', 'cross-club-fetch-started', {
            date: params.date,
            categoryCode: params.categoryCode,
            timeSlotId: params.timeSlotId,
        });
        // Clear stale raw results and any deferred patch from a previous date/fetch cycle
        // so the new fetch starts clean.
        getBookingStateService().clearRawFetchState();
        const signal = getBookingStateService().beginFetch();

        try {
            const [settled, courtsheetSettled] = await Promise.all([
                Promise.all(Object.values(CLUBS).map(clubId => {
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
                })),
                // Courtsheet events are fetched in parallel as a soft-fail batch.  Failures
                // are silently ignored — they only affect pod conflict detection, not core UI.
                Promise.allSettled(Object.values(CLUBS).map(clubId =>
                    fetchCourtSheetEventsForOneClub(clubId, params.date, signal)
                        .then(data => ({ clubId, events: data.events || [] }))
                )),
            ]);

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

            const courtsheetEventsByClubId = {};
            courtsheetSettled.forEach(r => {
                if (r.status === 'fulfilled') {
                    courtsheetEventsByClubId[r.value.clubId] = r.value.events;
                }
            });
            getBookingStateService().setLastFetchState({ transformed, params, failedClubIds, courtsheetEventsByClubId });
            // Store raw results so the XHR response patcher can merge all clubs' court data
            // into Angular's native availability response for Court View column rendering.
            // setRawFetchResults also fires any pending deferred patch if the native XHR
            // already fired before our parallel fetches completed.
            getBookingStateService().setRawFetchResults(successfulResults);
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
    /* Disable slot clicks in clubs where a pod member has a pending scheduled booking. */
    [data-pod-pending-conflict="true"] [data-slot-wrapper] {
        pointer-events: none;
        opacity: 0.45;
    }
`;
            document.head.appendChild(style);
        };
    })();


    // Accumulator for pure utility functions that the Vitest test suite imports.
    // Populated by createBookingsCalendarExportInstaller() during startup.
    // Has no effect in the browser — module is undefined there.
    const _bcTestExports = {};

    // Reads the user's email address from the Angular app's persisted auth state in
    // localStorage, falling back to the bc_notification_email cache.  Angular writes
    // connect20auth before our script runs, so this is synchronous and reliable on
    // every normal page load.  Returns null only if the user is not yet logged in.
    function readUserEmail() {
        try {
            const raw = localStorage.getItem('connect20auth');
            if (raw) {
                const state = JSON.parse(raw);
                const email = state && state.profile && state.profile.data && state.profile.data.email;
                if (email) return email.trim().toLowerCase();
            }
        } catch (_e) {
            // Ignore parse errors — fall through to cached value.
        }
        return (getLocalStorageService().getString(STORAGE_KEYS.NOTIFICATION_EMAIL) || '').trim().toLowerCase() || null;
    }

    // Checks whether the user's email is on the Worker allow-list.  Fails open on
    // any error (network failure, worker down) so infrastructure issues never lock
    // out legitimate users.  Returns a promise resolving to boolean.
    async function checkAllowList(email) {
        try {
            const response = await fetch(getWorkerApiConfigService().buildUrl('/allowed'), {
                headers: {
                    'X-Worker-Secret': getWorkerApiConfigService().getSecretHeaderValue(),
                    'X-User-Id': email,
                },
            });
            if (!response.ok) return true; // fail open on HTTP error
            const data = await response.json();
            return data.allowed !== false;
        } catch (_e) {
            return true; // fail open on network error
        }
    }

    // XHR interceptors run unconditionally — they capture auth headers and push the
    // refresh token to the Worker, both of which are invisible and harmless.
    installXhrInterceptors();

    // Gate all visible features on the allow-list check.  The email is read from
    // the Angular app's own localStorage state (connect20auth), which is populated
    // before our script runs on every authenticated page load.  If the email is not
    // available (unauthenticated state), no features are started — the user needs
    // to be logged in to use Bay Club anyway.
    const userEmail = readUserEmail();
    if (userEmail) {
        checkAllowList(userEmail).then(allowed => {
            if (!allowed) return;
            createCardSelectionStyleInstaller();
            createBookingsCalendarExportInstaller();
            createDashboardDebugActivationMonitor();
            createBookingFlowMonitor();
            getScheduledBookingService().initializeOnPageLoad();
            getPreferenceSyncService().initializeOnPageLoad();
        });
    }
    // #endregion Startup installers and bootstrap.

    // Test exports — active only in CommonJS/Node environments (Vitest), never in the browser.
    // pacificSlotTimeMs is at IIFE top-level scope; the rest are collected via _bcTestExports.
    // createBookingsCalendarExportInstaller is idempotent; calling it here ensures its
    // Object.assign(_bcTestExports, ...) calls run synchronously before module.exports is set,
    // since the normal startup path calls it inside a Promise callback which resolves too late.
    if (typeof module !== 'undefined') {
        createBookingsCalendarExportInstaller();
        _bcTestExports.pacificSlotTimeMs = pacificSlotTimeMs;
        _bcTestExports.transformAvailability = transformAvailability;
        _bcTestExports.readUserEmail = readUserEmail;
        _bcTestExports.courtViewOpeningRangeForDay = courtViewOpeningRangeForDay;
        _bcTestExports.courtViewBlockedClassForEvent = courtViewBlockedClassForEvent;
        _bcTestExports.courtViewColorForBlockedClass = courtViewColorForBlockedClass;
        _bcTestExports.COURT_BLOCKED_CLASS = COURT_BLOCKED_CLASS;
        _bcTestExports.COURT_VIEW_COLORS = COURT_VIEW_COLORS;
        _bcTestExports.buildCourtViewBarLabel = buildCourtViewBarLabel;
        // eslint-disable-next-line no-undef
        module.exports = _bcTestExports;
    }
})();
