/*jslint esversion: 11 */
// ==UserScript==
// @name         Bay Club Connect Pickleball Court Reservation Helper
// @namespace    https://github.com/mbrubin56gh
// @version      0.4
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

    // Gated single courts, such as those surrounded by fences, are the most prized of all.
    const GATED_COURTS = {
        [CLUBS.santaClara]: ['Pickleball 1', 'Pickleball 6'],
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

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string' && url.includes(AVAILABILITY_API_PATH)) {
                this.addEventListener('load', function () {
                    maybePatchAvailabilityResponseForAngular(this);
                });
            }
            setRequestInfo(this, method, url);
            return originalXhrOpen.apply(this, [method, url, ...rest]);
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

    // #region DOM query and preference services.
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

    // #region Bookings page calendar export.
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

            function scheduleReconcile() {
                if (reconcileScheduled) return;
                reconcileScheduled = true;
                requestAnimationFrame(() => {
                    reconcileScheduled = false;
                    injectButtonsForBookingsPage();
                    injectButtonsForBookingDetailsPage();
                });
            }

            const observer = new MutationObserver(() => {
                scheduleReconcile();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            scheduleReconcile();
        };
    })();
    // #endregion Bookings page calendar export.

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
                        } else if (labels.includes('30 minutes')) {
                            getLocalStorageService().setString(DURATION_KEY, btn.textContent.trim());
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
    // #endregion DOM query and preference services.

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

    function computeSlotLockState(slot, fetchDate, limitDate) {
        const slotDate = new Date(fetchDate + 'T00:00:00');
        slotDate.setMinutes(slotDate.getMinutes() + slot.fromInMinutes);
        const slotLocked = slotDate > limitDate;
        const lockIcon = slotLocked
            ? `<div class="i-lock-blue position-absolute-top position-absolute-right icon-size-16 time-slot-icon"></div>`
            : '';
        const disabledStyle = slotLocked
            ? 'opacity: 0.35; background-color: rgba(255,255,255,0.05);'
            : '';
        return { slotLocked, lockIcon, disabledStyle };
    }

    function buildSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        return slot.courts.length === 1
            ? buildSingleCourtSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode)
            : buildMultiCourtGroupHtml(slot, fetchDate, limitDate, meta, clubId, labelMode);
    }

    function buildSingleCourtSlotHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        const { slotLocked, lockIcon, disabledStyle } = computeSlotLockState(slot, fetchDate, limitDate);
        const court = slot.courts[0];
        const gated = isCourtGated(court.courtName, clubId);
        const edge = isCourtEdge(court.courtName, clubId);
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
           ${dataAttrs} style="${disabledStyle}${gated ? ' border: 2px solid rgba(255,215,0,1);' : edge ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${court.courtName}</div>
        ${gated ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 11px; font-weight: bold; color: rgba(255,215,0,1);">G</div>' : edge ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 11px; font-weight: bold; color: rgba(255,200,50,0.9);">E</div>' : ''}
        ${lockIcon}
      </div>
    </div>`;
    }

    function buildMultiCourtGroupHtml(slot, fetchDate, limitDate, meta, clubId, labelMode) {
        const { slotLocked, lockIcon, disabledStyle } = computeSlotLockState(slot, fetchDate, limitDate);
        const hasGatedCourt = slot.courts.some(c => isCourtGated(c.courtName, clubId));
        const hasEdgeCourt = slot.courts.some(c => isCourtEdge(c.courtName, clubId));

        const courtNumbers = slot.courts.map(c => c.courtName?.replace(/\D+/g, '')).filter(Boolean);
        const courtSummary = courtNumbers.length > 0
            ? `Pickleball ${courtNumbers.join(', ')}`
            : 'Courts available';

        const expandedCourts = slotLocked ? '' : slot.courts.map(court => {
            const gated = isCourtGated(court.courtName, clubId);
            const edge = isCourtEdge(court.courtName, clubId);
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
            ${gated ? '<span style="color: rgba(255,215,0,1); font-size: 10px; font-weight: bold;">Gated</span>' : edge ? '<span style="color: rgba(255,200,50,0.9); font-size: 10px; font-weight: bold;">Edge</span>' : ''}
        </div>`;
        }).join('');

        return `
    <div data-slot-wrapper data-from-minutes="${slot.fromInMinutes}">
      <div class="bc-slot-card border-radius-4 border-dark-gray w-100 text-center size-12 time-slot py-2 position-relative overflow-visible${slotLocked ? ' time-slot-disabled' : ' clickable'}"
           style="${disabledStyle}${hasGatedCourt ? ' border: 2px solid rgba(255,215,0,1);' : hasEdgeCourt ? ' border: 1px solid rgba(255,200,50,0.7);' : ''} padding: 10px 14px;">
        <div class="${labelMode === LABEL_MODE_TIME ? 'text-lowercase' : ''}" style="font-weight: 500;">${labelMode === LABEL_MODE_CLUB ? CLUB_SHORT_NAMES[clubId] : `${slot.fromHumanTime} - ${slot.toHumanTime}`}</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px;">${courtSummary}</div>
        ${hasGatedCourt ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 11px; font-weight: bold; color: rgba(255,215,0,1);">G</div>' : hasEdgeCourt ? '<div style="position: absolute; top: 2px; right: 4px; font-size: 11px; font-weight: bold; color: rgba(255,200,50,0.9);">E</div>' : ''}
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

                const bottomBar = document.querySelector('.white-bg.p-2 .container');
                if (!bottomBar) return;
                const selectedBookingInfoHolder = getOrCreateSelectedBookingInfoHolder(bottomBar);

                // The native booking flow expects a specific time slot to have been selected in
                // the Hour View before allowing the Next button to advance. We keep that state
                // machine happy by clicking the first visible native slot here. If Bay Club ever
                // removes or renames these native slot elements, the helper will fall back to the
                // native UI via our error banner rather than silently breaking the flow.
                const nativeSlot = document.querySelector('app-court-time-slot-item div.time-slot');
                if (nativeSlot) {
                    nativeSlot.click();
                    const nativeInfo = document.querySelector('.white-bg.p-2 .container .row .col-12.col-md-auto:not(.bc-injected-info)');
                    if (nativeInfo) nativeInfo.style.display = 'none';
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
            }

            function bindCourtOptionSelection(anchorElement) {
                // Select a specific court when an expanded court option or single-court card is clicked.
                anchorElement.querySelectorAll('.bc-court-option').forEach(el => {
                    el.addEventListener('click', () => {
                        selectCourtOption(anchorElement, el);
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

                window.addEventListener('popstate', evaluateBookingFlowMonitoringState);
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
    // #endregion Startup installers and bootstrap.
})();
