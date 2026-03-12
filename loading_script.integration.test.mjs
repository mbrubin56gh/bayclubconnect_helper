// Integration tests for loading_script.user.js.
//
// Run:  npm run test:script   (from repo root)
//
// These tests exercise larger slices of the userscript logic against synthetic
// fixture data that mirrors real Bay Club API response shapes.  They serve two
// purposes:
//
//   1. Regression guard — confirm that our data transformation and HTML
//      rendering do what we intend, so future changes don't silently break
//      them.
//
//   2. Fixture baseline — because the fixtures were constructed from the
//      documented API shape (not live traffic), any mismatch between a fixture
//      and the live API signals that Bay Club changed their contract.
//
// Functions covered:
//   transformAvailability   — raw API payload → internal { Morning, Afternoon, Evening }
//   buildPendingBookingRowHtml   — pending booking → HTML row string
//   buildFailedBookingRowHtml    — failed booking → HTML row string
//   buildCalendarDataForPendingBooking — booking record → calendar data object
//   isBookingRelevantToCurrentUser — scheduler/partner email matching
//   formatPendingBookingDayLabel — Today/Tomorrow/short date label in Pacific time

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    transformAvailability,
    buildPendingBookingRowHtml,
    buildFailedBookingRowHtml,
    buildCalendarDataForPendingBooking,
    isBookingRelevantToCurrentUser,
    formatPendingBookingDayLabel,
    SLOT_CHECK_STATUS,
} = require('./loading_script.user.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Club IDs as used by the live Bay Club API (from CLAUDE.md).
const BROADWAY_ID = '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63';
const REDWOOD_ID  = '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18';

// Constructs a minimal availability API result for a single club.
function makeResult({ clubId = BROADWAY_ID, shortName = 'Broadway', code = 'BRW', courts = [], slots = [] } = {}) {
    return {
        clubsAvailabilities: [{
            club: { id: clubId, shortName, code },
            courts,
            availableTimeSlots: slots,
        }],
    };
}

// A pair of courts used across multiple tests.
const COURT_1 = { courtId: 'court-1', courtSetupVersionId: 'vsn-1', courtName: 'Pickleball 1', order: 1 };
const COURT_2 = { courtId: 'court-2', courtSetupVersionId: 'vsn-2', courtName: 'Pickleball 2', order: 2 };

// A minimal pending booking record matching the shape persisted to Worker KV.
function makePendingBooking(overrides = {}) {
    return {
        id: 'booking-abc',
        slotLabel: 'Broadway \u00b7 Pickleball 1 \u00b7 7:00 am\u20138:00 am \u00b7 Thu Mar 6',
        partnerNames: ['Jane Doe'],
        fireAtMs: Date.now() + 2 * 60 * 60 * 1000,  // 2 hours from now
        slotCheckStatus: SLOT_CHECK_STATUS.UNKNOWN,
        bookingBody: {
            clubId: BROADWAY_ID,
            courtId: 'court-1',
            date: { value: '2026-03-06', date: '2026-03-06' },
            timeFromInMinutes: 420,
            timeToInMinutes: 480,
            categoryOptionsId: 'cat-uuid',
            timeSlotId: 'slot-uuid',
        },
        ...overrides,
    };
}

function makeFailedBooking(overrides = {}) {
    return {
        id: 'booking-xyz',
        slotLabel: 'Broadway \u00b7 Pickleball 2 \u00b7 8:00 am\u20139:00 am \u00b7 Fri Mar 7',
        failureReason: 'No courts available at booking time.',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// transformAvailability
// ---------------------------------------------------------------------------

describe('transformAvailability', () => {
    it('groups a single morning slot under Morning for its club', () => {
        const result = transformAvailability([makeResult({
            courts: [COURT_1],
            slots: [{
                fromInMinutes: 420,
                toInMinutes: 480,
                timeOfDay: 'Morning',
                courtId: 'court-1',
                courtsVersionsIds: ['vsn-1'],
                timeSlotId: 'ts-1',
            }],
        })]);

        expect(result.Morning).toHaveLength(1);
        expect(result.Morning[0].shortName).toBe('Broadway');
        expect(result.Morning[0].availabilities).toHaveLength(1);
        expect(result.Morning[0].availabilities[0].fromInMinutes).toBe(420);
        expect(result.Morning[0].availabilities[0].toInMinutes).toBe(480);
        expect(result.Morning[0].availabilities[0].fromHumanTime).toBe('7:00 am');
        expect(result.Morning[0].availabilities[0].toHumanTime).toBe('8:00 am');
        expect(result.Afternoon[0].availabilities).toHaveLength(0);
        expect(result.Evening[0].availabilities).toHaveLength(0);
    });

    it('produces one entry per time-of-day bucket even when a club has no slots', () => {
        const result = transformAvailability([makeResult({ courts: [COURT_1], slots: [] })]);

        expect(result.Morning).toHaveLength(1);
        expect(result.Afternoon).toHaveLength(1);
        expect(result.Evening).toHaveLength(1);
        expect(result.Morning[0].availabilities).toHaveLength(0);
    });

    it('merges two courts available at the same start time into one slot entry', () => {
        const result = transformAvailability([makeResult({
            courts: [COURT_1, COURT_2],
            slots: [
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-1' },
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-2', courtsVersionsIds: ['vsn-2'], timeSlotId: 'ts-2' },
            ],
        })]);

        const slots = result.Morning[0].availabilities;
        expect(slots).toHaveLength(1);
        expect(slots[0].courts).toHaveLength(2);
        expect(slots[0].courts[0].courtName).toBe('Pickleball 1');
        expect(slots[0].courts[1].courtName).toBe('Pickleball 2');
    });

    it('places courts in courtOrder order within a merged slot', () => {
        // Provide slots in reverse court order to confirm sorting.
        const result = transformAvailability([makeResult({
            courts: [COURT_1, COURT_2],
            slots: [
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-2', courtsVersionsIds: ['vsn-2'], timeSlotId: 'ts-2' },
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-1' },
            ],
        })]);

        const courts = result.Morning[0].availabilities[0].courts;
        expect(courts[0].courtName).toBe('Pickleball 1');
        expect(courts[1].courtName).toBe('Pickleball 2');
    });

    it('routes slots to the correct time-of-day bucket', () => {
        const result = transformAvailability([makeResult({
            courts: [COURT_1],
            slots: [
                { fromInMinutes: 420,  toInMinutes: 480,  timeOfDay: 'Morning',   courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-m' },
                { fromInMinutes: 780,  toInMinutes: 840,  timeOfDay: 'Afternoon',  courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-a' },
                { fromInMinutes: 1080, toInMinutes: 1140, timeOfDay: 'Evening',    courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-e' },
            ],
        })]);

        expect(result.Morning[0].availabilities).toHaveLength(1);
        expect(result.Afternoon[0].availabilities).toHaveLength(1);
        expect(result.Evening[0].availabilities).toHaveLength(1);
        expect(result.Afternoon[0].availabilities[0].fromInMinutes).toBe(780);
        expect(result.Evening[0].availabilities[0].fromInMinutes).toBe(1080);
    });

    it('handles two clubs from separate result objects', () => {
        const result = transformAvailability([
            makeResult({ clubId: BROADWAY_ID, shortName: 'Broadway', code: 'BRW', courts: [COURT_1], slots: [
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-1' },
            ] }),
            makeResult({ clubId: REDWOOD_ID, shortName: 'Redwood Shores', code: 'RWS', courts: [COURT_2], slots: [] }),
        ]);

        // Morning should have one entry per club.
        expect(result.Morning).toHaveLength(2);
        const names = result.Morning.map(c => c.shortName);
        expect(names).toContain('Broadway');
        expect(names).toContain('Redwood Shores');

        const broadway = result.Morning.find(c => c.clubId === BROADWAY_ID);
        expect(broadway.availabilities).toHaveLength(1);

        const redwood = result.Morning.find(c => c.clubId === REDWOOD_ID);
        expect(redwood.availabilities).toHaveLength(0);
    });

    it('trims trailing spaces from court names (Santa Clara server quirk)', () => {
        const quirkyCourt = { courtId: 'court-sc', courtSetupVersionId: 'vsn-sc', courtName: 'Pickleball 1 ', order: 1 };
        const result = transformAvailability([makeResult({
            courts: [quirkyCourt],
            slots: [{ fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-sc', courtsVersionsIds: ['vsn-sc'], timeSlotId: 'ts-1' }],
        })]);

        expect(result.Morning[0].availabilities[0].courts[0].courtName).toBe('Pickleball 1');
    });

    it('sorts slots within a bucket by start time', () => {
        const result = transformAvailability([makeResult({
            courts: [COURT_1],
            slots: [
                { fromInMinutes: 480, toInMinutes: 540, timeOfDay: 'Morning', courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-2' },
                { fromInMinutes: 420, toInMinutes: 480, timeOfDay: 'Morning', courtId: 'court-1', courtsVersionsIds: ['vsn-1'], timeSlotId: 'ts-1' },
            ],
        })]);

        const slots = result.Morning[0].availabilities;
        expect(slots[0].fromInMinutes).toBe(420);
        expect(slots[1].fromInMinutes).toBe(480);
    });
});

// ---------------------------------------------------------------------------
// buildPendingBookingRowHtml — upcoming scheduled bookings (status: pending)
// ---------------------------------------------------------------------------

describe('buildPendingBookingRowHtml', () => {
    it('includes the booking id in the data attribute', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking());
        expect(html).toContain('data-bc-pending-booking="booking-abc"');
    });

    it('includes the slot label', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking());
        expect(html).toContain('Broadway');
        expect(html).toContain('Pickleball 1');
    });

    it('includes partner names', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ partnerNames: ['Jane Doe', 'Bob Smith'] }));
        expect(html).toContain('Jane Doe');
        expect(html).toContain('Bob Smith');
    });

    it('shows "No partners" when partnerNames is empty', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ partnerNames: [] }));
        expect(html).toContain('No partners');
    });

    it('includes a cancel button with the booking id when the viewer is the scheduler', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking(), true);
        expect(html).toContain('data-bc-cancel-booking="booking-abc"');
    });

    it('omits the cancel button when the viewer is a partner, not the scheduler', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking(), false);
        expect(html).not.toContain('data-bc-cancel-booking');
    });

    it('shows "Scheduled by" attribution when the viewer is a partner', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ userName: 'Mark Rubin' }), false);
        expect(html).toContain('Scheduled by Mark Rubin');
    });

    it('omits "Scheduled by" attribution when the viewer is the scheduler', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ userName: 'Mark Rubin' }), true);
        expect(html).not.toContain('Scheduled by');
    });

    it('includes a countdown element', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking());
        expect(html).toContain('data-bc-countdown');
    });

    it('hides the "court taken" warning when slotCheckStatus is not TAKEN', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ slotCheckStatus: SLOT_CHECK_STATUS.UNKNOWN }));
        // The warning div should be present but hidden via inline display:none.
        expect(html).toContain('data-bc-slot-warning');
        expect(html).toContain('display: none');
    });

    it('shows the "court taken" warning when slotCheckStatus is TAKEN', () => {
        const html = buildPendingBookingRowHtml(makePendingBooking({ slotCheckStatus: SLOT_CHECK_STATUS.TAKEN }));
        // Warning present and NOT hidden (no display:none on that element).
        expect(html).toContain('data-bc-slot-warning');
        // When the court is taken the warning is visible: display:none must be absent.
        const warningMatch = html.match(/data-bc-slot-warning[^>]*/);
        expect(warningMatch).not.toBeNull();
        expect(warningMatch[0]).not.toContain('display: none');
    });
});

// ---------------------------------------------------------------------------
// buildFailedBookingRowHtml — bookings the Worker attempted but could not complete
// ---------------------------------------------------------------------------

describe('buildFailedBookingRowHtml', () => {
    it('includes the booking id in the data attribute', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking());
        expect(html).toContain('data-bc-failed-booking="booking-xyz"');
    });

    it('includes the slot label', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking());
        expect(html).toContain('Broadway');
        expect(html).toContain('Pickleball 2');
    });

    it('includes the failure reason when provided', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking());
        expect(html).toContain('No courts available at booking time.');
    });

    it('falls back to a default message when failureReason is absent', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking({ failureReason: undefined }));
        expect(html).toContain('The booking attempt was unsuccessful.');
    });

    it('includes a dismiss button with the booking id when the viewer is the scheduler', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking(), true);
        expect(html).toContain('data-bc-dismiss-booking="booking-xyz"');
    });

    it('omits the dismiss button when the viewer is a partner, not the scheduler', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking(), false);
        expect(html).not.toContain('data-bc-dismiss-booking');
    });

    it('shows "Scheduled by" attribution on failed rows for partner viewers', () => {
        const html = buildFailedBookingRowHtml(makeFailedBooking({ userName: 'Mark Rubin' }), false);
        expect(html).toContain('Scheduled by Mark Rubin');
    });

    it('uses red-tinted styling to distinguish failed rows from pending rows', () => {
        const pendingHtml = buildPendingBookingRowHtml(makePendingBooking(), true);
        const failedHtml  = buildFailedBookingRowHtml(makeFailedBooking(), true);
        // Pending rows use a cyan tint; failed rows use a red tint.
        expect(pendingHtml).toContain('rgba(0,188,212');
        expect(failedHtml).toContain('rgba(239,83,80');
    });
});

// ---------------------------------------------------------------------------
// isBookingRelevantToCurrentUser
// ---------------------------------------------------------------------------

describe('isBookingRelevantToCurrentUser', () => {
    const booking = {
        notificationEmail: 'scheduler@example.com',
        partnerEmails: ['partner1@example.com', 'partner2@example.com'],
    };

    it('returns true when currentEmail matches the scheduler', () => {
        expect(isBookingRelevantToCurrentUser(booking, 'scheduler@example.com')).toBe(true);
    });

    it('returns true when currentEmail matches a partner email', () => {
        expect(isBookingRelevantToCurrentUser(booking, 'partner1@example.com')).toBe(true);
        expect(isBookingRelevantToCurrentUser(booking, 'partner2@example.com')).toBe(true);
    });

    it('returns false when currentEmail is not the scheduler or any partner', () => {
        expect(isBookingRelevantToCurrentUser(booking, 'stranger@example.com')).toBe(false);
    });

    it('returns false when partnerEmails is absent and email does not match scheduler', () => {
        const noPartners = { notificationEmail: 'scheduler@example.com' };
        expect(isBookingRelevantToCurrentUser(noPartners, 'stranger@example.com')).toBe(false);
    });

    it('returns false when currentEmail is null or empty', () => {
        expect(isBookingRelevantToCurrentUser(booking, null)).toBe(false);
        expect(isBookingRelevantToCurrentUser(booking, '')).toBe(false);
    });

    it('returns false when currentEmail is null even if booking has no notificationEmail', () => {
        // Old booking records may lack notificationEmail entirely.  We must not
        // show them to unidentified users — returning false is the safe behaviour.
        const oldBooking = { partnerEmails: [] };
        expect(isBookingRelevantToCurrentUser(oldBooking, null)).toBe(false);
        expect(isBookingRelevantToCurrentUser(oldBooking, '')).toBe(false);
    });

    it('matches scheduler email case-insensitively', () => {
        expect(isBookingRelevantToCurrentUser(booking, 'SCHEDULER@EXAMPLE.COM')).toBe(true);
        expect(isBookingRelevantToCurrentUser(booking, 'Scheduler@Example.Com')).toBe(true);
    });

    it('matches partner email case-insensitively', () => {
        expect(isBookingRelevantToCurrentUser(booking, 'PARTNER1@EXAMPLE.COM')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildCalendarDataForPendingBooking
// ---------------------------------------------------------------------------

describe('buildCalendarDataForPendingBooking', () => {
    it('returns a calendar data object with correct title for a single-partner booking', () => {
        const data = buildCalendarDataForPendingBooking(makePendingBooking());
        expect(data).not.toBeNull();
        expect(data.title).toContain('Pickleball at Broadway');
        expect(data.title).toContain('Jane Doe');
        expect(data.title).toContain('Pickleball 1');
    });

    it('returns correct UTC start and end dates (Mar 6 2026 is PST = UTC-8)', () => {
        const data = buildCalendarDataForPendingBooking(makePendingBooking());
        // 7:00 AM Pacific Standard Time = 15:00 UTC.
        expect(data.startDate.toISOString()).toBe('2026-03-06T15:00:00.000Z');
        // 8:00 AM PST = 16:00 UTC.
        expect(data.endDate.toISOString()).toBe('2026-03-06T16:00:00.000Z');
    });

    it('includes club short name in location', () => {
        const data = buildCalendarDataForPendingBooking(makePendingBooking());
        expect(data.location).toContain('Broadway');
    });

    it('omits partner suffix in title when partnerNames is empty', () => {
        const data = buildCalendarDataForPendingBooking(makePendingBooking({ partnerNames: [] }));
        expect(data.title).not.toContain('with');
    });

    it('lists multiple partners in the title', () => {
        const data = buildCalendarDataForPendingBooking(makePendingBooking({ partnerNames: ['Jane Doe', 'Bob Smith'] }));
        expect(data.title).toContain('Jane Doe');
        expect(data.title).toContain('Bob Smith');
    });

    it('returns null when bookingBody.date is missing', () => {
        const booking = makePendingBooking();
        delete booking.bookingBody.date;
        expect(buildCalendarDataForPendingBooking(booking)).toBeNull();
    });

    it('returns null when timeFromInMinutes is missing', () => {
        const booking = makePendingBooking();
        delete booking.bookingBody.timeFromInMinutes;
        expect(buildCalendarDataForPendingBooking(booking)).toBeNull();
    });

    it('returns null when timeToInMinutes is missing', () => {
        const booking = makePendingBooking();
        delete booking.bookingBody.timeToInMinutes;
        expect(buildCalendarDataForPendingBooking(booking)).toBeNull();
    });

    it('falls back to "Bay Club" for an unrecognised clubId', () => {
        const booking = makePendingBooking();
        booking.bookingBody.clubId = 'unknown-club-id';
        const data = buildCalendarDataForPendingBooking(booking);
        expect(data.title).toContain('Bay Club');
        expect(data.location).toContain('Bay Club');
    });
});

// ---------------------------------------------------------------------------
// formatPendingBookingDayLabel
// ---------------------------------------------------------------------------

describe('formatPendingBookingDayLabel', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    // Pin Date.now() to a known Pacific time: 2026-03-10 at noon PT (UTC-7 in March).
    // 2026-03-10T19:00:00Z = 2026-03-10T12:00:00 PT.
    const MARCH_10_NOON_PT_MS = Date.UTC(2026, 2, 10, 19, 0, 0);

    it('returns "Today" when the date string matches today in Pacific time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(MARCH_10_NOON_PT_MS);
        expect(formatPendingBookingDayLabel('2026-03-10')).toBe('Today');
    });

    it('returns "Tomorrow" when the date string is one day ahead in Pacific time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(MARCH_10_NOON_PT_MS);
        expect(formatPendingBookingDayLabel('2026-03-11')).toBe('Tomorrow');
    });

    it('returns a short date label for dates beyond tomorrow', () => {
        vi.useFakeTimers();
        vi.setSystemTime(MARCH_10_NOON_PT_MS);
        const label = formatPendingBookingDayLabel('2026-03-15');
        expect(label).not.toBe('Today');
        expect(label).not.toBe('Tomorrow');
        // Should contain the day-of-week and day number.
        expect(label).toMatch(/Sun/);
        expect(label).toMatch(/15/);
    });

    it('returns "Today" for a date that is today even when called late in the evening PT', () => {
        // 2026-03-10T06:55:00Z = 2026-03-09T23:55:00 PT — technically yesterday in PT,
        // but 2026-03-10T05:00:00Z = 2026-03-10T00:00:00 PT (midnight).
        // Use 2026-03-10T23:55:00 PT = 2026-03-11T06:55:00Z.
        const MARCH_10_LATE_NIGHT_PT_MS = Date.UTC(2026, 2, 11, 6, 55, 0);
        vi.useFakeTimers();
        vi.setSystemTime(MARCH_10_LATE_NIGHT_PT_MS);
        expect(formatPendingBookingDayLabel('2026-03-10')).toBe('Today');
    });

    it('handles a date in the past without throwing', () => {
        vi.useFakeTimers();
        vi.setSystemTime(MARCH_10_NOON_PT_MS);
        const label = formatPendingBookingDayLabel('2026-03-01');
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
    });
});
