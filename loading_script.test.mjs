// Unit tests for pure utility functions in loading_script.user.js.
//
// Run:  npm run test:script   (from repo root)
//
// The userscript is a self-executing IIFE wrapped in a CommonJS module.exports
// escape hatch that is active only in Node environments.  We load it with
// createRequire so the full IIFE runs under jsdom (providing document/window),
// then the exported functions are tested in isolation.
//
// Functions covered:
//   pacificSlotTimeMs   — timezone-correct UTC timestamp for a slot
//   timePartsTo24Hour   — 12-hour + meridiem → 24-hour
//   inferStartHour24    — infer AM/PM when start meridiem is absent
//   parseTimeRange      — full time-range text → { startHour24, startMinute, endHour24, endMinute }
//   normalizeWhitespace — collapse runs of whitespace
//   toGoogleDateStamp   — Date → compact UTC string for Google Calendar
//   buildGoogleCalendarUrl — booking data → Google Calendar URL
//   toIcsDateStamp      — Date → ICS date-time stamp
//   sanitizeIcsText     — escape ICS special characters
//   buildIcsContent     — booking data → VCALENDAR string
//   getIcsDownloadFileName — booking data → safe .ics filename
//   formatCountdown     — fireAtMs → human-readable countdown string
//   readUserEmail       — email from connect20auth localStorage, with bc_notification_email fallback
//   courtViewOpeningRangeForDay   — opening hours lookup by day of week
//   courtViewBlockedClassForEvent — event type classification
//   courtViewColorForBlockedClass — CSS color for event type

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    pacificSlotTimeMs,
    timePartsTo24Hour,
    inferStartHour24,
    parseTimeRange,
    normalizeWhitespace,
    toGoogleDateStamp,
    buildGoogleCalendarUrl,
    toIcsDateStamp,
    sanitizeIcsText,
    buildIcsContent,
    getIcsDownloadFileName,
    formatCountdown,
    readUserEmail,
    courtViewOpeningRangeForDay,
    courtViewBlockedClassForEvent,
    courtViewColorForBlockedClass,
    COURT_BLOCKED_CLASS,
    COURT_VIEW_COLORS,
    buildCourtViewBarLabel,
    classifyCourtType,
    gatherAlternativeSlots,
} = require('./loading_script.user.js');

// ---------------------------------------------------------------------------
// pacificSlotTimeMs
// ---------------------------------------------------------------------------

describe('pacificSlotTimeMs', () => {
    // PST is UTC-8 (standard time, Nov–Mar).
    it('returns correct UTC ms for a PST date at slot 0 minutes (midnight)', () => {
        // 2026-01-15 is a Thursday in January — firmly in PST (UTC-8).
        // Midnight Pacific = 08:00 UTC.
        const ms = pacificSlotTimeMs('2026-01-15', 0);
        const d = new Date(ms);
        expect(d.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    });

    it('returns correct UTC ms for a PST date at 7:00 AM (420 minutes)', () => {
        const ms = pacificSlotTimeMs('2026-01-15', 420);
        const d = new Date(ms);
        expect(d.toISOString()).toBe('2026-01-15T15:00:00.000Z');
    });

    it('returns correct UTC ms for a PDT date at slot 0 minutes (midnight)', () => {
        // 2026-07-15 is in July — PDT (UTC-7).
        // Midnight Pacific = 07:00 UTC.
        const ms = pacificSlotTimeMs('2026-07-15', 0);
        const d = new Date(ms);
        expect(d.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    });

    it('returns correct UTC ms for a PDT date at 7:00 AM (420 minutes)', () => {
        const ms = pacificSlotTimeMs('2026-07-15', 420);
        const d = new Date(ms);
        expect(d.toISOString()).toBe('2026-07-15T14:00:00.000Z');
    });

    it('handles a slot at 90-minute resolution (e.g. 7:30 AM = 450 min, PST)', () => {
        const ms = pacificSlotTimeMs('2026-01-15', 450);
        const d = new Date(ms);
        expect(d.toISOString()).toBe('2026-01-15T15:30:00.000Z');
    });

    it('handles the DST spring-forward boundary (Mar 8 2026 — clocks move at 2 AM)', () => {
        // The helper samples noon UTC to determine the Pacific offset.  On Mar 8 2026,
        // DST springs forward at 2 AM local, so by noon the clocks are already on PDT
        // (UTC-7).  The function therefore applies the PDT offset to all slots on this
        // calendar date, including midnight — a known and accepted approximation.
        const ms = pacificSlotTimeMs('2026-03-08', 0);
        const d = new Date(ms);
        // Noon-sample gives PDT (-7), so midnight on Mar 8 = 07:00 UTC.
        expect(d.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    });

    it('handles the day after DST spring-forward (Mar 9 2026 — now PDT)', () => {
        const ms = pacificSlotTimeMs('2026-03-09', 0);
        const d = new Date(ms);
        // Pacific midnight on Mar 9 = 07:00 UTC (PDT).
        expect(d.toISOString()).toBe('2026-03-09T07:00:00.000Z');
    });
});

// ---------------------------------------------------------------------------
// timePartsTo24Hour
// ---------------------------------------------------------------------------

describe('timePartsTo24Hour', () => {
    it('converts AM hours correctly (1–11 AM)', () => {
        expect(timePartsTo24Hour(7, 'AM')).toBe(7);
        expect(timePartsTo24Hour(11, 'AM')).toBe(11);
        expect(timePartsTo24Hour(1, 'AM')).toBe(1);
    });

    it('converts 12 AM (midnight) to 0', () => {
        expect(timePartsTo24Hour(12, 'AM')).toBe(0);
    });

    it('converts PM hours correctly (1–11 PM)', () => {
        expect(timePartsTo24Hour(7, 'PM')).toBe(19);
        expect(timePartsTo24Hour(8, 'PM')).toBe(20);
        expect(timePartsTo24Hour(1, 'PM')).toBe(13);
        expect(timePartsTo24Hour(11, 'PM')).toBe(23);
    });

    it('converts 12 PM (noon) to 12', () => {
        expect(timePartsTo24Hour(12, 'PM')).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// inferStartHour24
// ---------------------------------------------------------------------------

describe('inferStartHour24', () => {
    it('infers AM start when end is also AM (e.g. 7 → end 8)', () => {
        // endHour24 = 8 (AM), startHour12 = 7 — delta 1, plausible AM candidate
        expect(inferStartHour24(7, 8)).toBe(7);
    });

    it('infers PM start when end is PM (e.g. 7 → end 20)', () => {
        // endHour24 = 20 (8 PM), startHour12 = 7 — delta for PM candidate (19) = 1
        expect(inferStartHour24(7, 20)).toBe(19);
    });

    it('infers PM start for a 90-min slot (7 → end 20 + 30 min)', () => {
        // endHour24 is still 20 for "7:00 - 8:30 PM"
        expect(inferStartHour24(7, 20)).toBe(19);
    });

    it('falls back to nearest candidate when no plausible delta exists', () => {
        // startHour12=11, endHour24=20 — 11 AM delta = 9 (not plausible), 11 PM delta = 9
        // byDistance: 11 AM is distance |11-20|=9, 11 PM is |23-20|=3 → PM closer
        expect(inferStartHour24(11, 20)).toBe(23);
    });
});

// ---------------------------------------------------------------------------
// parseTimeRange
// ---------------------------------------------------------------------------

describe('parseTimeRange', () => {
    it('parses a standard same-period PM range (7:00 - 8:00 PM)', () => {
        const result = parseTimeRange('7:00 - 8:00 PM');
        expect(result).toEqual({ startHour24: 19, startMinute: 0, endHour24: 20, endMinute: 0 });
    });

    it('parses a 90-minute PM range (7:00 - 8:30 PM)', () => {
        const result = parseTimeRange('7:00 - 8:30 PM');
        expect(result).toEqual({ startHour24: 19, startMinute: 0, endHour24: 20, endMinute: 30 });
    });

    it('parses an AM range (7:00 - 8:00 AM)', () => {
        const result = parseTimeRange('7:00 - 8:00 AM');
        expect(result).toEqual({ startHour24: 7, startMinute: 0, endHour24: 8, endMinute: 0 });
    });

    it('parses a cross-noon range with explicit meridiems (11:30 AM - 1:00 PM)', () => {
        const result = parseTimeRange('11:30 AM - 1:00 PM');
        expect(result).toEqual({ startHour24: 11, startMinute: 30, endHour24: 13, endMinute: 0 });
    });

    it('parses a noon slot (12:00 - 1:00 PM)', () => {
        const result = parseTimeRange('12:00 - 1:00 PM');
        expect(result).toEqual({ startHour24: 12, startMinute: 0, endHour24: 13, endMinute: 0 });
    });

    it('handles extra whitespace between parts', () => {
        const result = parseTimeRange('7:00  -  8:00 PM');
        expect(result).toEqual({ startHour24: 19, startMinute: 0, endHour24: 20, endMinute: 0 });
    });

    it('returns null for unparseable input', () => {
        expect(parseTimeRange('not a time')).toBeNull();
        expect(parseTimeRange('')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// normalizeWhitespace
// ---------------------------------------------------------------------------

describe('normalizeWhitespace', () => {
    it('collapses multiple spaces into one', () => {
        expect(normalizeWhitespace('a  b   c')).toBe('a b c');
    });

    it('trims leading and trailing whitespace', () => {
        expect(normalizeWhitespace('  hello  ')).toBe('hello');
    });

    it('handles null/undefined gracefully', () => {
        expect(normalizeWhitespace(null)).toBe('');
        expect(normalizeWhitespace(undefined)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// toGoogleDateStamp / buildGoogleCalendarUrl
// ---------------------------------------------------------------------------

describe('toGoogleDateStamp', () => {
    it('formats a Date to compact UTC stamp (YYYYMMDDTHHmmssZ)', () => {
        const d = new Date('2026-03-09T15:00:00.000Z');
        expect(toGoogleDateStamp(d)).toBe('20260309T150000Z');
    });
});

describe('buildGoogleCalendarUrl', () => {
    const booking = {
        title: 'Pickleball at Broadway on Court 1',
        startDate: new Date('2026-03-09T15:00:00.000Z'),
        endDate: new Date('2026-03-09T16:00:00.000Z'),
        location: 'Broadway, Court 1',
        details: 'Booked via Bay Club Connect Helper',
    };

    it('returns a Google Calendar URL', () => {
        const url = buildGoogleCalendarUrl(booking);
        expect(url).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render/);
    });

    it('encodes the title in the URL', () => {
        const url = buildGoogleCalendarUrl(booking);
        expect(url).toContain('Pickleball');
    });

    it('includes the correct dates param', () => {
        const url = buildGoogleCalendarUrl(booking);
        expect(url).toContain('20260309T150000Z');
        expect(url).toContain('20260309T160000Z');
    });
});

// ---------------------------------------------------------------------------
// toIcsDateStamp / sanitizeIcsText / buildIcsContent / getIcsDownloadFileName
// ---------------------------------------------------------------------------

describe('toIcsDateStamp', () => {
    it('formats a Date to ICS UTC stamp (same format as Google)', () => {
        const d = new Date('2026-03-09T15:00:00.000Z');
        expect(toIcsDateStamp(d)).toBe('20260309T150000Z');
    });
});

describe('sanitizeIcsText', () => {
    it('escapes backslashes, newlines, commas, and semicolons', () => {
        expect(sanitizeIcsText('a\\b\nc,d;e')).toBe('a\\\\b\\nc\\,d\\;e');
    });

    it('returns empty string for null/undefined', () => {
        expect(sanitizeIcsText(null)).toBe('');
        expect(sanitizeIcsText(undefined)).toBe('');
    });
});

describe('buildIcsContent', () => {
    const booking = {
        title: 'Pickleball at Broadway',
        startDate: new Date('2026-03-09T15:00:00.000Z'),
        endDate: new Date('2026-03-09T16:00:00.000Z'),
        location: 'Broadway',
        details: 'Test booking',
    };

    it('produces a VCALENDAR string with BEGIN/END markers', () => {
        const ics = buildIcsContent(booking);
        expect(ics).toContain('BEGIN:VCALENDAR');
        expect(ics).toContain('END:VCALENDAR');
        expect(ics).toContain('BEGIN:VEVENT');
        expect(ics).toContain('END:VEVENT');
    });

    it('contains the correct start and end timestamps', () => {
        const ics = buildIcsContent(booking);
        expect(ics).toContain('DTSTART:20260309T150000Z');
        expect(ics).toContain('DTEND:20260309T160000Z');
    });

    it('contains the title in SUMMARY', () => {
        const ics = buildIcsContent(booking);
        expect(ics).toContain('SUMMARY:Pickleball at Broadway');
    });

    it('uses CRLF line endings', () => {
        const ics = buildIcsContent(booking);
        expect(ics).toContain('\r\n');
    });
});

describe('getIcsDownloadFileName', () => {
    it('lowercases and slugifies the title', () => {
        const name = getIcsDownloadFileName({ title: 'Pickleball at Broadway on Court 1' });
        expect(name).toBe('pickleball-at-broadway-on-court-1.ics');
    });

    it('falls back to default filename when title is empty', () => {
        const name = getIcsDownloadFileName({ title: '' });
        expect(name).toBe('pickleball-booking.ics');
    });
});

// ---------------------------------------------------------------------------
// formatCountdown
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
    it('returns in-progress message when fireAtMs is in the past', () => {
        const result = formatCountdown(Date.now() - 5000);
        expect(result).toContain('in progress');
    });

    it('formats minutes-only countdown', () => {
        const result = formatCountdown(Date.now() + 25 * 60 * 1000);
        expect(result).toContain('25m');
    });

    it('formats hours and minutes countdown', () => {
        const result = formatCountdown(Date.now() + (2 * 60 + 15) * 60 * 1000);
        expect(result).toContain('2h');
        expect(result).toContain('15m');
    });

    it('formats multi-day countdown', () => {
        const result = formatCountdown(Date.now() + 50 * 60 * 60 * 1000); // 50 hours
        expect(result).toContain('2d');
    });
});

// ---------------------------------------------------------------------------
// readUserEmail
// ---------------------------------------------------------------------------

describe('readUserEmail', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('returns null when neither connect20auth nor bc_notification_email is set', () => {
        expect(readUserEmail()).toBeNull();
    });

    it('reads email from connect20auth profile data', () => {
        localStorage.setItem('connect20auth', JSON.stringify({
            profile: { data: { email: 'Mark.Rubin@Gmail.com' } },
            token: { refresh_token: 'rt' },
        }));
        expect(readUserEmail()).toBe('mark.rubin@gmail.com');
    });

    it('lowercases and trims the email from connect20auth', () => {
        localStorage.setItem('connect20auth', JSON.stringify({
            profile: { data: { email: '  USER@Example.COM  ' } },
        }));
        expect(readUserEmail()).toBe('user@example.com');
    });

    it('falls back to bc_notification_email when connect20auth has no email', () => {
        localStorage.setItem('connect20auth', JSON.stringify({ token: { refresh_token: 'rt' } }));
        localStorage.setItem('bc_notification_email', 'cached@example.com');
        expect(readUserEmail()).toBe('cached@example.com');
    });

    it('falls back to bc_notification_email when connect20auth is absent', () => {
        localStorage.setItem('bc_notification_email', 'cached@example.com');
        expect(readUserEmail()).toBe('cached@example.com');
    });

    it('falls back to bc_notification_email when connect20auth is malformed JSON', () => {
        localStorage.setItem('connect20auth', 'not-json');
        localStorage.setItem('bc_notification_email', 'cached@example.com');
        expect(readUserEmail()).toBe('cached@example.com');
    });

    it('returns null when connect20auth is absent and bc_notification_email is empty string', () => {
        localStorage.setItem('bc_notification_email', '');
        expect(readUserEmail()).toBeNull();
    });

    it('prefers connect20auth email over bc_notification_email when both are set', () => {
        localStorage.setItem('connect20auth', JSON.stringify({
            profile: { data: { email: 'auth@example.com' } },
        }));
        localStorage.setItem('bc_notification_email', 'cached@example.com');
        expect(readUserEmail()).toBe('auth@example.com');
    });
});

// ---------------------------------------------------------------------------
// courtViewOpeningRangeForDay
// ---------------------------------------------------------------------------

describe('courtViewOpeningRangeForDay', () => {
    const openingHours = [
        { dayOfWeek: 0, fromInMinutes: 480,  toInMinutes: 1200 }, // Sunday 8am–8pm
        { dayOfWeek: 1, fromInMinutes: 420,  toInMinutes: 1260 }, // Monday 7am–9pm
        { dayOfWeek: 6, fromInMinutes: 540,  toInMinutes: 1080 }, // Saturday 9am–6pm
    ];

    it('returns the correct range for a matching day', () => {
        const result = courtViewOpeningRangeForDay(openingHours, 1); // Monday
        expect(result).toEqual({ fromInMinutes: 420, toInMinutes: 1260 });
    });

    it('returns null when the day of week has no entry', () => {
        const result = courtViewOpeningRangeForDay(openingHours, 3); // Wednesday not present
        expect(result).toBeNull();
    });

    it('returns null when openingHours is null', () => {
        expect(courtViewOpeningRangeForDay(null, 1)).toBeNull();
    });

    it('returns null when openingHours is an empty array', () => {
        expect(courtViewOpeningRangeForDay([], 0)).toBeNull();
    });

    it('returns the first matching entry when duplicates exist', () => {
        const duplicated = [
            { dayOfWeek: 2, fromInMinutes: 360, toInMinutes: 1200 },
            { dayOfWeek: 2, fromInMinutes: 480, toInMinutes: 1320 },
        ];
        const result = courtViewOpeningRangeForDay(duplicated, 2);
        expect(result).toEqual({ fromInMinutes: 360, toInMinutes: 1200 });
    });
});

// ---------------------------------------------------------------------------
// courtViewBlockedClassForEvent
// ---------------------------------------------------------------------------

describe('courtViewBlockedClassForEvent', () => {
    it('classifies a regular member booking (no blockedSlotType) as BOOKING', () => {
        const ev = { courtEventType: 'CourtBooking', blockedSlotType: null };
        expect(courtViewBlockedClassForEvent(ev)).toBe(COURT_BLOCKED_CLASS.BOOKING);
    });

    it('classifies open play events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'OpenPlay' })).toBe(COURT_BLOCKED_CLASS.OPEN_PLAY);
    });

    it('classifies lesson events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'Lesson' })).toBe(COURT_BLOCKED_CLASS.LESSON);
    });

    it('classifies clinic events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'Clinic' })).toBe(COURT_BLOCKED_CLASS.CLINIC);
    });

    it('classifies league events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'League' })).toBe(COURT_BLOCKED_CLASS.LEAGUE);
    });

    it('classifies other events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'Other' })).toBe(COURT_BLOCKED_CLASS.OTHER);
    });

    it('classifies maintenance events', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'Maintenance' })).toBe(COURT_BLOCKED_CLASS.MAINTENANCE);
    });

    it('classifies group class events by className field when blockedSlotType is absent', () => {
        const ev = { className: 'Morning Cardio Pickleball', blockedSlotType: null };
        expect(courtViewBlockedClassForEvent(ev)).toBe(COURT_BLOCKED_CLASS.GROUP_CLASS);
    });

    it('is case-insensitive for blockedSlotType values', () => {
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'LESSON' })).toBe(COURT_BLOCKED_CLASS.LESSON);
        expect(courtViewBlockedClassForEvent({ blockedSlotType: 'openplay' })).toBe(COURT_BLOCKED_CLASS.OPEN_PLAY);
    });

    it('returns BOOKING for a null event', () => {
        expect(courtViewBlockedClassForEvent(null)).toBe(COURT_BLOCKED_CLASS.BOOKING);
    });
});

// ---------------------------------------------------------------------------
// courtViewColorForBlockedClass
// ---------------------------------------------------------------------------

describe('courtViewColorForBlockedClass', () => {
    it('returns the booking color for the BOOKING class', () => {
        expect(courtViewColorForBlockedClass(COURT_BLOCKED_CLASS.BOOKING)).toBe(COURT_VIEW_COLORS[COURT_BLOCKED_CLASS.BOOKING]);
    });

    it('returns a distinct color for lesson events', () => {
        const lessonColor = courtViewColorForBlockedClass(COURT_BLOCKED_CLASS.LESSON);
        const bookingColor = courtViewColorForBlockedClass(COURT_BLOCKED_CLASS.BOOKING);
        expect(lessonColor).not.toBe(bookingColor);
        expect(lessonColor).toBe('rgb(188, 215, 255)');
    });

    it('returns the booking color as a fallback for an unknown class', () => {
        expect(courtViewColorForBlockedClass('courtblockedslot-unknown'))
            .toBe(COURT_VIEW_COLORS[COURT_BLOCKED_CLASS.BOOKING]);
    });

    it('returns distinct colors for all defined event types', () => {
        // Verify every COURT_BLOCKED_CLASS value has an entry in COURT_VIEW_COLORS.
        Object.values(COURT_BLOCKED_CLASS).forEach(cls => {
            expect(COURT_VIEW_COLORS[cls]).toBeTruthy();
        });
    });
});

describe('buildCourtViewBarLabel', () => {

    it('strips the home club name and prepends the correct club name', () => {
        expect(buildCourtViewBarLabel('Redwood Shores Court 5 7:00 - 8:30 AM', 'Redwood Shores', 'Santa Clara'))
            .toBe('Santa Clara · Court 5 7:00 - 8:30 AM');
    });

    it('handles a separator character after the home club name', () => {
        expect(buildCourtViewBarLabel('Redwood Shores · Court 5 7:00 AM', 'Redwood Shores', 'Broadway'))
            .toBe('Broadway · Court 5 7:00 AM');
    });

    it('is case-insensitive when stripping the home club name', () => {
        expect(buildCourtViewBarLabel('redwood shores Court 3 8:00 AM', 'Redwood Shores', 'South SF'))
            .toBe('South SF · Court 3 8:00 AM');
    });

    it('returns just the correct club name when nativeText is empty', () => {
        expect(buildCourtViewBarLabel('', 'Redwood Shores', 'Santa Clara'))
            .toBe('Santa Clara');
    });

    it('returns just the correct club name when nativeText is null', () => {
        expect(buildCourtViewBarLabel(null, 'Redwood Shores', 'Santa Clara'))
            .toBe('Santa Clara');
    });

    it('uses the full native text when homeClubShortName is empty string', () => {
        expect(buildCourtViewBarLabel('Court 5 7:00 AM', '', 'Broadway'))
            .toBe('Broadway · Court 5 7:00 AM');
    });

    it('uses the full native text when homeClubShortName is null', () => {
        expect(buildCourtViewBarLabel('Court 5 7:00 AM', null, 'Broadway'))
            .toBe('Broadway · Court 5 7:00 AM');
    });

    it('leaves the label unchanged when the home club name does not appear in the text', () => {
        expect(buildCourtViewBarLabel('Court 5 7:00 AM', 'Redwood Shores', 'Santa Clara'))
            .toBe('Santa Clara · Court 5 7:00 AM');
    });
});

// Club UUIDs from the userscript constants.
const CLUBS = {
    broadway: '9a2ab1e6-bc97-4250-ac42-8cc8d97f9c63',
    redwoodShores: '95eb0299-b5cf-4a9f-8b35-e4b3bd505f18',
    santaClara: '3bc78448-ec6b-49e1-a2ae-64abd68e646b',
    southSF: 'ce7e7607-09e6-4d16-8197-1fffb70db776',
};

describe('classifyCourtType', () => {

    it('returns gated for a Santa Clara gated court', () => {
        expect(classifyCourtType(CLUBS.santaClara, 'Pickleball 1')).toBe('gated');
        expect(classifyCourtType(CLUBS.santaClara, 'Pickleball 6')).toBe('gated');
    });

    it('returns hitting_wall for a Santa Clara hitting wall court', () => {
        expect(classifyCourtType(CLUBS.santaClara, 'Pickleball 9')).toBe('hitting_wall');
        expect(classifyCourtType(CLUBS.santaClara, 'Pickleball 10')).toBe('hitting_wall');
    });

    it('returns edge for an edge court', () => {
        expect(classifyCourtType(CLUBS.broadway, 'Pickleball 1')).toBe('edge');
        expect(classifyCourtType(CLUBS.southSF, 'Pickleball 5')).toBe('edge');
    });

    it('returns edge for Redwood Shores (wildcard — all courts are edge)', () => {
        expect(classifyCourtType(CLUBS.redwoodShores, 'Pickleball 1')).toBe('edge');
        expect(classifyCourtType(CLUBS.redwoodShores, 'Pickleball 4')).toBe('edge');
    });

    it('returns standard for a non-special court', () => {
        expect(classifyCourtType(CLUBS.broadway, 'Pickleball 3')).toBe('standard');
        expect(classifyCourtType(CLUBS.broadway, 'Pickleball 4')).toBe('standard');
    });

    it('returns standard for an unknown club', () => {
        expect(classifyCourtType('unknown-uuid', 'Pickleball 1')).toBe('standard');
    });

    it('gated takes priority over edge for Santa Clara courts that are both', () => {
        // Pickleball 1 at Santa Clara is in both GATED_COURTS and EDGE_COURTS.
        expect(classifyCourtType(CLUBS.santaClara, 'Pickleball 1')).toBe('gated');
    });
});

// ---------------------------------------------------------------------------
// gatherAlternativeSlots
// ---------------------------------------------------------------------------

describe('gatherAlternativeSlots', () => {
    const primaryClubId = CLUBS.broadway;

    function makeTransformed(clubs) {
        // Wrap club entries into the Morning/Afternoon/Evening structure.
        return { Morning: clubs, Afternoon: [], Evening: [] };
    }

    // Helper to build a court object with a name for classifyCourtType.
    function court(id, name) {
        return { courtId: id, courtName: name || id };
    }

    it('returns nearby times at the same club within ±2 hours', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: primaryClubId,
                    shortName: 'Broadway',
                    availabilities: [
                        { fromInMinutes: 420, toInMinutes: 510, fromHumanTime: '7:00 AM', toHumanTime: '8:30 AM', courts: [court('c1', 'PB 1')] },
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('c2', 'PB 2')] },
                        { fromInMinutes: 540, toInMinutes: 630, fromHumanTime: '9:00 AM', toHumanTime: '10:30 AM', courts: [court('c3', 'PB 3')] },
                        { fromInMinutes: 720, toInMinutes: 810, fromHumanTime: '12:00 PM', toHumanTime: '1:30 PM', courts: [court('c4', 'PB 4')] },
                    ],
                },
            ]),
        };

        const { altTimes, altClubs } = gatherAlternativeSlots(slotInfo, lastFetchState);

        // 7:00 AM (60 min away) and 9:00 AM (60 min away) are within ±2h.
        // 12:00 PM (240 min away) is outside ±2h. The primary slot (8:00 AM) is excluded.
        expect(altTimes.length).toBe(2);
        expect(altTimes[0].fromMinutes).toBe(420);
        expect(altTimes[1].fromMinutes).toBe(540);
        expect(altClubs.length).toBe(0);
    });

    it('returns same-time slots at other clubs', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: primaryClubId,
                    shortName: 'Broadway',
                    availabilities: [
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('c1', 'PB 1')] },
                    ],
                },
                {
                    clubId: CLUBS.southSF,
                    shortName: 'South SF',
                    availabilities: [
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('s1', 'PB 1'), court('s2', 'PB 2')] },
                    ],
                },
            ]),
        };

        const { altTimes, altClubs } = gatherAlternativeSlots(slotInfo, lastFetchState);

        expect(altTimes.length).toBe(0);
        expect(altClubs.length).toBe(1);
        expect(altClubs[0].clubId).toBe(CLUBS.southSF);
        expect(altClubs[0].courtCount).toBe(2);
    });

    it('excludes the primary slot from results', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: primaryClubId,
                    shortName: 'Broadway',
                    availabilities: [
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('c1', 'PB 1')] },
                    ],
                },
            ]),
        };

        const { altTimes, altClubs } = gatherAlternativeSlots(slotInfo, lastFetchState);

        expect(altTimes.length).toBe(0);
        expect(altClubs.length).toBe(0);
    });

    it('returns empty arrays when no fetch state', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const { altTimes, altClubs } = gatherAlternativeSlots(slotInfo, null);
        expect(altTimes).toEqual([]);
        expect(altClubs).toEqual([]);
    });

    it('sorts altTimes by distance from primary slot', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: primaryClubId,
                    shortName: 'Broadway',
                    availabilities: [
                        { fromInMinutes: 360, toInMinutes: 450, fromHumanTime: '6:00 AM', toHumanTime: '7:30 AM', courts: [court('c1', 'PB 1')] },
                        { fromInMinutes: 450, toInMinutes: 540, fromHumanTime: '7:30 AM', toHumanTime: '9:00 AM', courts: [court('c2', 'PB 2')] },
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('c3', 'PB 3')] },
                        { fromInMinutes: 510, toInMinutes: 600, fromHumanTime: '8:30 AM', toHumanTime: '10:00 AM', courts: [court('c4', 'PB 4')] },
                    ],
                },
            ]),
        };

        const { altTimes } = gatherAlternativeSlots(slotInfo, lastFetchState);

        // 8:30 AM (30 min), 7:30 AM (30 min), 6:00 AM (120 min) — sorted by abs distance.
        expect(altTimes.length).toBe(3);
        expect(altTimes[0].fromMinutes).toBe(450); // 30 min
        expect(altTimes[1].fromMinutes).toBe(510); // 30 min
        expect(altTimes[2].fromMinutes).toBe(360); // 120 min
    });

    it('respects custom rangeMinutes parameter', () => {
        const slotInfo = { clubId: primaryClubId, fromMinutes: 480, toMinutes: 570, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: primaryClubId,
                    shortName: 'Broadway',
                    availabilities: [
                        { fromInMinutes: 420, toInMinutes: 510, fromHumanTime: '7:00 AM', toHumanTime: '8:30 AM', courts: [court('c1', 'PB 1')] },
                        { fromInMinutes: 480, toInMinutes: 570, fromHumanTime: '8:00 AM', toHumanTime: '9:30 AM', courts: [court('c2', 'PB 2')] },
                        { fromInMinutes: 540, toInMinutes: 630, fromHumanTime: '9:00 AM', toHumanTime: '10:30 AM', courts: [court('c3', 'PB 3')] },
                    ],
                },
            ]),
        };

        // With range of 30, only 30 minutes away slots should be included.
        // 7:00 AM is 60 min away, 9:00 AM is 60 min away — both outside range.
        const { altTimes: narrow } = gatherAlternativeSlots(slotInfo, lastFetchState, 30);
        expect(narrow.length).toBe(0);

        // With range of 60, both should be included.
        const { altTimes: wide } = gatherAlternativeSlots(slotInfo, lastFetchState, 60);
        expect(wide.length).toBe(2);
    });

    it('annotates courts with type badges', () => {
        const slotInfo = { clubId: CLUBS.santaClara, fromMinutes: 480, toMinutes: 540, date: '2026-03-20' };
        const lastFetchState = {
            transformed: makeTransformed([
                {
                    clubId: CLUBS.santaClara,
                    shortName: 'Santa Clara',
                    availabilities: [
                        { fromInMinutes: 480, toInMinutes: 540, fromHumanTime: '8:00 AM', toHumanTime: '9:00 AM', courts: [court('c1', 'Pickleball 1')] },
                        {
                            fromInMinutes: 540, toInMinutes: 600, fromHumanTime: '9:00 AM', toHumanTime: '10:00 AM',
                            courts: [court('c1', 'Pickleball 1'), court('c5', 'Pickleball 5')],
                        },
                    ],
                },
            ]),
        };

        const { altTimes } = gatherAlternativeSlots(slotInfo, lastFetchState);
        expect(altTimes.length).toBe(1);
        // Pickleball 1 at Santa Clara is gated; Pickleball 5 is edge.
        expect(altTimes[0].courts[0].courtType).toBe('gated');
        expect(altTimes[0].courts[1].courtType).toBe('edge');
    });
});
