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
