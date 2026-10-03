const assert = require('node:assert');
const R = require('../../lib/atodo/domain/recurrence');

// -- occursOn --------------------------------------------------------------
const once = { dueDate: '2026-03-10', frequency: { type: 'once' } };
assert.ok(R.occursOn(once, '2026-03-10'));
assert.ok(!R.occursOn(once, '2026-03-11'));
assert.ok(!R.occursOn(once, '2026-03-09'), 'no occurrence before the due date');

const daily = { dueDate: '2026-03-10', frequency: { type: 'days', interval: 1 } };
assert.ok(R.occursOn(daily, '2026-03-10'));
assert.ok(R.occursOn(daily, '2026-03-15'));
assert.ok(!R.occursOn(daily, '2026-03-09'));

const everyThreeDays = { dueDate: '2026-03-10', frequency: { type: 'days', interval: 3 } };
assert.ok(R.occursOn(everyThreeDays, '2026-03-13'));
assert.ok(!R.occursOn(everyThreeDays, '2026-03-12'));

const weekly = { dueDate: '2026-03-10', frequency: { type: 'weeks', interval: 1 } };
assert.ok(R.occursOn(weekly, '2026-03-17'));
assert.ok(!R.occursOn(weekly, '2026-03-16'));

const monthly = { dueDate: '2026-01-31', frequency: { type: 'months', interval: 1 } };
assert.ok(R.occursOn(monthly, '2026-01-31'));
assert.ok(R.occursOn(monthly, '2026-02-28'), 'Feb has no 31st, clamps to the last day');
assert.ok(R.occursOn(monthly, '2026-03-31'));
assert.ok(!R.occursOn(monthly, '2026-03-30'));

const everyTwoMonths = { dueDate: '2026-01-15', frequency: { type: 'months', interval: 2 } };
assert.ok(R.occursOn(everyTwoMonths, '2026-03-15'));
assert.ok(!R.occursOn(everyTwoMonths, '2026-02-15'));

// -- weekly on specific weekdays ---------------------------------------
// dueDate 2026-07-01 is a Wednesday; the anchor week runs Sun 2026-06-28
// through Sat 2026-07-04.
const weeklySpecificDays = { dueDate: '2026-07-01', frequency: { type: 'weeks', interval: 1, weekdays: [1, 3, 5] } }; // Mon/Wed/Fri
assert.ok(R.occursOn(weeklySpecificDays, '2026-07-01'), 'Wed, dueDate itself');
assert.ok(R.occursOn(weeklySpecificDays, '2026-07-03'), 'Fri, same anchor week');
assert.ok(!R.occursOn(weeklySpecificDays, '2026-06-29'), "Mon before dueDate doesn't count, even same week");
assert.ok(!R.occursOn(weeklySpecificDays, '2026-07-02'), 'Thu is not a selected weekday');
assert.ok(R.occursOn(weeklySpecificDays, '2026-07-06'), 'Mon of the following week');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(weeklySpecificDays, '2026-07-04'), '2026-07-03', 'most recent is Fri, not Sat itself');
assert.strictEqual(R.nextOccurrenceAfter(weeklySpecificDays, '2026-07-03'), '2026-07-06', 'next after Fri is the following Mon, not Wed of the same week (already passed)');

const biweeklySpecificDays = {
  dueDate: '2026-07-01',
  frequency: { type: 'weeks', interval: 2, weekdays: [1, 3, 5] },
};
assert.ok(R.occursOn(biweeklySpecificDays, '2026-07-01'), 'anchor week (week 0) counts');
assert.ok(!R.occursOn(biweeklySpecificDays, '2026-07-06'), 'week 1 is skipped on a biweekly cadence');
assert.ok(R.occursOn(biweeklySpecificDays, '2026-07-13'), 'week 2 counts again');

// Omitting weekdays entirely still falls back to the original single-day
// behavior (backward compatible with already-saved tasks).
assert.deepStrictEqual(weekly.frequency.weekdays, undefined);
assert.ok(R.occursOn(weekly, '2026-03-17'));

// -- monthly: last day of month / N days before last --------------------
const monthlyLastDay = { dueDate: '2026-01-15', frequency: { type: 'months', interval: 1, dayMode: 'last' } };
assert.ok(R.occursOn(monthlyLastDay, '2026-01-31'));
assert.ok(R.occursOn(monthlyLastDay, '2026-02-28'));
assert.ok(!R.occursOn(monthlyLastDay, '2026-01-30'));
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(monthlyLastDay, '2026-02-15'), '2026-01-31');
assert.strictEqual(R.nextOccurrenceAfter(monthlyLastDay, '2026-01-31'), '2026-02-28');

const monthlyBeforeLast = {
  dueDate: '2026-01-15',
  frequency: { type: 'months', interval: 1, dayMode: 'before-last', offset: 2 },
};
assert.ok(R.occursOn(monthlyBeforeLast, '2026-01-29'), 'Jan has 31 days, 2 before last is the 29th');
assert.ok(R.occursOn(monthlyBeforeLast, '2026-02-26'), 'Feb has 28 days, 2 before last is the 26th');
assert.ok(!R.occursOn(monthlyBeforeLast, '2026-01-31'), 'offset 2 is not the last day itself');
assert.strictEqual(R.nextOccurrenceAfter(monthlyBeforeLast, '2026-01-29'), '2026-02-26');

// -- monthly: nth/last weekday of month -----------------------------------
// January 2026's Tuesdays fall on the 6th, 13th, 20th, 27th (4 of them, no
// 5th); March 2026 has 5 Tuesdays (3rd, 10th, 17th, 24th, 31st).
const firstTuesday = {
  dueDate: '2026-01-01',
  frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 2, ordinal: 1 },
};
assert.ok(R.occursOn(firstTuesday, '2026-01-06'));
assert.ok(!R.occursOn(firstTuesday, '2026-01-13'), 'the 2nd Tuesday, not the 1st');

const lastTuesday = {
  dueDate: '2026-01-01',
  frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 2, ordinal: 'last' },
};
assert.ok(R.occursOn(lastTuesday, '2026-01-27'), 'last Tuesday in a 4-Tuesday January');
assert.ok(!R.occursOn(lastTuesday, '2026-01-20'), 'the 3rd Tuesday is not the last one');
assert.ok(R.occursOn(lastTuesday, '2026-03-31'), 'last Tuesday in a 5-Tuesday March');
assert.ok(!R.occursOn(lastTuesday, '2026-03-24'), '4th Tuesday is not last when March has a 5th');

const fifthTuesday = {
  dueDate: '2026-01-01',
  frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 2, ordinal: 5 },
};
assert.ok(!R.occursOn(fifthTuesday, '2026-01-27'), 'January has no 5th Tuesday');
assert.ok(R.occursOn(fifthTuesday, '2026-03-31'), "March's 5th Tuesday");
assert.strictEqual(
  R.nextOccurrenceAfter(fifthTuesday, '2026-01-01'),
  '2026-03-31',
  'correctly skips January and February, which have no 5th Tuesday'
);
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(fifthTuesday, '2026-03-31'), '2026-03-31');

// -- monthly: earliest Nth occurrence of any of the selected weekdays --------
// "Earliest 2nd of Mon/Wed/Fri" is NOT the 2nd date overall among every
// selected weekday's occurrences (that would be the first Friday) -- it's
// whichever of {2nd Monday, 2nd Wednesday, 2nd Friday} comes first.
// April 2026 starts on a Wednesday: 2nd Monday the 13th, 2nd Wednesday the
// 8th, 2nd Friday the 10th -- earliest is the 8th.
const multiWeekday2nd = {
  dueDate: '2026-01-01',
  frequency: { type: 'months', interval: 1, dayMode: 'multi-weekday', weekdays: [1, 3, 5], ordinal: 2 },
};
assert.ok(R.occursOn(multiWeekday2nd, '2026-04-08'), 'April starts on Wednesday -- earliest 2nd is that 2nd Wednesday, the 8th');
assert.ok(!R.occursOn(multiWeekday2nd, '2026-04-10'), 'the 2nd Friday, not the earliest of the three');
assert.ok(!R.occursOn(multiWeekday2nd, '2026-04-13'), 'the 2nd Monday, not the earliest of the three');
// January 2026 starts on a Thursday: 2nd Monday the 12th, 2nd Wednesday the
// 14th, 2nd Friday the 9th -- earliest is the 9th.
assert.ok(R.occursOn(multiWeekday2nd, '2026-01-09'), 'January starts on Thursday -- earliest 2nd is that 2nd Friday, the 9th');
assert.strictEqual(R.nextOccurrenceAfter(multiWeekday2nd, '2026-01-09'), '2026-02-09', "February starts on Sunday -- earliest 2nd is also the 2nd Friday, the 9th");
assert.strictEqual(R.nextOccurrenceAfter(multiWeekday2nd, '2026-02-09'), '2026-03-09', "March starts on Sunday too -- same as February");
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(multiWeekday2nd, '2026-04-08'), '2026-04-08');

const multiWeekdayNoMatch = {
  dueDate: '2026-01-01',
  frequency: { type: 'months', interval: 1, dayMode: 'multi-weekday', weekdays: [2], ordinal: 5 },
};
assert.ok(!R.occursOn(multiWeekdayNoMatch, '2026-01-27'), 'a single selected weekday with no 5th occurrence that month has nothing to be earliest among');

// -- monthly: multiple fixed days of the month (1-28) ------------------------
// Repeats on the 15th, 16th, and 17th of every month -- a plain membership
// check against target's day-of-month, no anchor/clamping logic needed since
// every day 1-28 exists in every month.
const multiDay = {
  dueDate: '2026-01-15',
  frequency: { type: 'months', interval: 1, dayMode: 'multi-day', days: [15, 16, 17] },
};
assert.ok(R.occursOn(multiDay, '2026-01-15'), 'the 15th is one of the selected days');
assert.ok(R.occursOn(multiDay, '2026-01-16'), 'so is the 16th');
assert.ok(R.occursOn(multiDay, '2026-01-17'), 'so is the 17th');
assert.ok(!R.occursOn(multiDay, '2026-01-14'), 'the 14th is not selected');
assert.ok(!R.occursOn(multiDay, '2026-01-18'), 'nor the 18th');
assert.ok(R.occursOn(multiDay, '2026-02-15'), 'the pattern repeats identically in February');
assert.ok(R.occursOn(multiDay, '2026-02-17'), 'every day in the shorter month of February still exists (capped at 28)');
assert.strictEqual(R.nextOccurrenceAfter(multiDay, '2026-01-15'), '2026-01-16', 'next after the 15th is the 16th, same month');
assert.strictEqual(R.nextOccurrenceAfter(multiDay, '2026-01-17'), '2026-02-15', 'next after the last selected day of the month rolls over to next month');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(multiDay, '2026-01-16'), '2026-01-16');
assert.strictEqual(R.previousOccurrenceBefore(multiDay, '2026-01-16'), '2026-01-15');
assert.strictEqual(R.previousOccurrenceBefore(multiDay, '2026-02-15'), '2026-01-17', 'the occurrence right before the 15th of the next month is the previous month\'s last selected day, the 17th');

// -- monthly: N days before/after the earliest Nth occurrence ---------------
// Same April-2026 anchor (the 8th, its earliest 2nd of Mon/Wed/Fri) shifted
// 6 days before -- crosses into March, which is fine (see occursOn's
// dedicated multi-weekday-offset branch: the interval/dueDate check is
// re-evaluated per candidate anchor month, not just the target date's own).
const multiWeekdayOffsetBefore = {
  dueDate: '2026-01-01',
  frequency: {
    type: 'months',
    interval: 1,
    dayMode: 'multi-weekday-offset',
    weekdays: [1, 3, 5],
    ordinal: 1,
    offsetDirection: 'before',
    offsetDays: 6,
  },
};
// April's earliest 1st of Mon/Wed/Fri is Wed the 1st itself (day 1 is a
// Wednesday); 6 days before that is March 26.
assert.ok(R.occursOn(multiWeekdayOffsetBefore, '2026-03-26'), '6 days before April\'s anchor lands in March, which is allowed');
assert.ok(!R.occursOn(multiWeekdayOffsetBefore, '2026-04-01'), 'the anchor itself is not the occurrence once an offset applies');

// April's 5th Wednesday (the 29th, its only weekday selected here) shifted
// 6 days after crosses into May.
const multiWeekdayOffsetAfter = {
  dueDate: '2026-01-01',
  frequency: {
    type: 'months',
    interval: 1,
    dayMode: 'multi-weekday-offset',
    weekdays: [3],
    ordinal: 5,
    offsetDirection: 'after',
    offsetDays: 6,
  },
};
assert.ok(R.occursOn(multiWeekdayOffsetAfter, '2026-05-05'), '6 days after April\'s 5th Wednesday (the 29th) lands in May');

// Every-2-months interval counts from the true first occurrence's month, not
// blindly from dueDate's own month: January 1's own earliest 1st-of-Mon/Wed/Fri
// is Jan 2 (a Friday), and 6 days before that (Dec 27, 2025) is before
// dueDate -- so January doesn't count as month zero. February becomes month
// zero instead (its anchor, Feb 2, minus 6 days is Jan 27, which IS on/after
// dueDate), and the interval steps from there: Feb, Apr, Jun, ... -- so
// March's anchor-minus-6 (Feb 24) is NOT a valid occurrence (odd number of
// months after Feb), but April's (Mar 26) is.
const multiWeekdayOffsetEveryTwoMonths = {
  dueDate: '2026-01-01',
  frequency: {
    type: 'months',
    interval: 2,
    dayMode: 'multi-weekday-offset',
    weekdays: [1, 3, 5],
    ordinal: 1,
    offsetDirection: 'before',
    offsetDays: 6,
  },
};
assert.ok(R.occursOn(multiWeekdayOffsetEveryTwoMonths, '2026-01-27'), "February's anchor (the 2nd) minus 6 days lands on Jan 27 -- this is the true first occurrence, since January itself doesn't qualify as month zero");
assert.ok(!R.occursOn(multiWeekdayOffsetEveryTwoMonths, '2026-02-24'), "March's anchor minus 6 days (Feb 24) is skipped -- March is 1 month after the true anchor month (February), not a multiple of the 2-month interval");
assert.ok(R.occursOn(multiWeekdayOffsetEveryTwoMonths, '2026-03-26'), "April's anchor minus 6 days (Mar 26) -- April is 2 months after February, the true anchor month");
assert.strictEqual(R.nextOccurrenceAfter(multiWeekdayOffsetEveryTwoMonths, '2026-01-27'), '2026-03-26');

// Regression test: a monthly-interval task whose pattern's dueDate-month
// candidate falls BEFORE dueDate must not skip an extra `interval` months --
// the first real occurrence should be the very next candidate on/after
// dueDate, and later occurrences step `interval` months from THAT one, not
// from dueDate's own calendar month. dueDate Sep 9, 2026 recurring every 3
// months "3 days before the first Monday": September's first Monday is the
// 7th, 3 days before is Sep 4 -- before dueDate, so September isn't month
// zero. October's first Monday is the 5th, 3 days before is Oct 2 -- the
// true first occurrence, with October as month zero (not December, 3 months
// after September, which is what a dueDate-month-anchored count would wrongly
// produce).
const monthlyOffsetFirstOccurrenceAfterDueDate = {
  dueDate: '2026-09-09',
  frequency: {
    type: 'months',
    interval: 3,
    dayMode: 'multi-weekday-offset',
    weekdays: [1],
    ordinal: 1,
    offsetDirection: 'before',
    offsetDays: 3,
  },
};
assert.ok(R.occursOn(monthlyOffsetFirstOccurrenceAfterDueDate, '2026-10-02'), "October's first Monday (the 5th) minus 3 days is the true first occurrence");
assert.ok(!R.occursOn(monthlyOffsetFirstOccurrenceAfterDueDate, '2026-12-04'), "December's first Monday minus 3 days must NOT occur -- that would be 3 months after September, but September was never a valid anchor month");
assert.strictEqual(R.nextOccurrenceAfter(monthlyOffsetFirstOccurrenceAfterDueDate, '2026-09-09'), '2026-10-02');
assert.strictEqual(R.nextOccurrenceAfter(monthlyOffsetFirstOccurrenceAfterDueDate, '2026-10-02'), '2027-01-01', 'the next occurrence is 3 months after October, the true anchor month -- January\'s first Monday (the 4th) minus 3 days');

// -- nextOccurrenceAfter when dueDate itself isn't a valid occurrence -------
// dueDate is just the pattern's anchor for interval counting -- nothing
// guarantees the literal entered date itself satisfies the pattern (a task
// due on a Monday but recurring only on Tue/Wed/Thu/Fri, say). Regression
// test for a bug where nextOccurrenceAfter, when called with a date before
// dueDate, blindly returned dueDate itself without checking it actually
// occurs there.
const dueDateNotItselfValid = {
  dueDate: '2026-09-07', // a Monday
  frequency: { type: 'months', interval: 1, dayMode: 'multi-weekday-offset', weekdays: [2, 3, 4, 5], ordinal: 1, offsetDirection: 'before', offsetDays: 1 },
};
assert.ok(!R.occursOn(dueDateNotItselfValid, '2026-09-07'), "due date itself (a Monday) isn't a valid occurrence of this Tue-Fri-anchored pattern");
assert.strictEqual(
  R.nextOccurrenceAfter(dueDateNotItselfValid, '2026-09-06'),
  '2026-09-30',
  "must not blindly return dueDate itself just because it's the first date on/after afterISO -- September's earliest 1st of Tue-Fri is the 1st itself, one day before is Aug 31 (before dueDate, so not eligible); the next valid one after dueDate is October's anchor (the 1st) minus 1, landing on Sep 30"
);
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(dueDateNotItselfValid, '2026-09-07'), null, 'dueDate has no valid occurrence on or before it yet');

// Same bug, simpler pattern: a weekly task whose selected weekdays don't
// include dueDate's own weekday.
const weeklyDueDateMismatch = {
  dueDate: '2026-09-07', // a Monday
  frequency: { type: 'weeks', interval: 1, weekdays: [2, 4] }, // Tue/Thu only
};
assert.ok(!R.occursOn(weeklyDueDateMismatch, '2026-09-07'), "due date (Monday) isn't one of the selected weekdays");
assert.strictEqual(R.nextOccurrenceAfter(weeklyDueDateMismatch, '2026-09-06'), '2026-09-08', 'the first real occurrence is that Tuesday, not dueDate itself');

// -- endDate ------------------------------------------------------------
const dailyWithEnd = { dueDate: '2026-03-10', frequency: { type: 'days', interval: 1 }, endDate: '2026-03-20' };
assert.ok(R.occursOn(dailyWithEnd, '2026-03-20'), 'occurs on the end date itself');
assert.ok(!R.occursOn(dailyWithEnd, '2026-03-21'), 'no occurrence after the end date');
assert.strictEqual(
  R.mostRecentOccurrenceOnOrBefore(dailyWithEnd, '2026-03-25'),
  '2026-03-20',
  'a today past the end date clamps to the last occurrence on/before endDate, not endDate + drift'
);
assert.strictEqual(
  R.mostRecentOccurrenceOnOrBefore(dailyWithEnd, '2026-03-15'),
  '2026-03-15',
  'today before the end date is unaffected'
);

const monthlyWithEnd = { dueDate: '2026-01-31', frequency: { type: 'months', interval: 1 }, endDate: '2026-02-28' };
assert.ok(R.occursOn(monthlyWithEnd, '2026-02-28'));
assert.ok(!R.occursOn(monthlyWithEnd, '2026-03-31'), 'the 3rd occurrence would be after endDate');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(monthlyWithEnd, '2026-06-01'), '2026-02-28');

// -- mostRecentOccurrenceOnOrBefore -----------------------------------------
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(once, '2026-03-15'), '2026-03-10', 'a missed one-off stays pending, doesn\'t vanish');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(once, '2026-03-01'), null, 'not due yet');

assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(daily, '2026-03-15'), '2026-03-15');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(everyThreeDays, '2026-03-15'), '2026-03-13', 'most recent 3-day step on/before the 15th');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(weekly, '2026-03-20'), '2026-03-17');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(monthly, '2026-02-27'), '2026-01-31', 'Feb 27 is before Feb\'s clamped 28th occurrence');
assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(monthly, '2026-02-28'), '2026-02-28');

// -- nextOccurrenceAfter ------------------------------------------------
assert.strictEqual(R.nextOccurrenceAfter(once, '2026-03-10'), null, 'a once task has no occurrence after its due date');
assert.strictEqual(R.nextOccurrenceAfter(once, '2026-01-01'), '2026-03-10', "hasn't started yet -- its first occurrence is next");

assert.strictEqual(R.nextOccurrenceAfter(daily, '2026-03-15'), '2026-03-16');
assert.strictEqual(R.nextOccurrenceAfter(everyThreeDays, '2026-03-13'), '2026-03-16', 'next 3-day step strictly after the 13th');
assert.strictEqual(R.nextOccurrenceAfter(weekly, '2026-03-17'), '2026-03-24');

assert.strictEqual(R.nextOccurrenceAfter(monthly, '2026-01-31'), '2026-02-28', 'Feb clamps to the 28th');
assert.strictEqual(R.nextOccurrenceAfter(monthly, '2026-02-28'), '2026-03-31', 'back to the 31st once March allows it');
assert.strictEqual(R.nextOccurrenceAfter(monthly, '2026-02-01'), '2026-02-28', 'the very next occurrence, not skipped over');

assert.strictEqual(R.nextOccurrenceAfter(dailyWithEnd, '2026-03-19'), '2026-03-20', 'the last occurrence, right at the end date');
assert.strictEqual(R.nextOccurrenceAfter(dailyWithEnd, '2026-03-20'), null, 'nothing after the end date');

// -- previousOccurrenceBefore ------------------------------------------------
assert.strictEqual(R.previousOccurrenceBefore(once, '2026-03-10'), null, "a once task's due date is its only occurrence");
assert.strictEqual(R.previousOccurrenceBefore(daily, '2026-03-10'), null, 'the very first occurrence has nothing before it');
assert.strictEqual(R.previousOccurrenceBefore(daily, '2026-03-15'), '2026-03-14');
assert.strictEqual(R.previousOccurrenceBefore(everyThreeDays, '2026-03-13'), '2026-03-10', 'previous 3-day step is the due date itself');
assert.strictEqual(R.previousOccurrenceBefore(weekly, '2026-03-17'), '2026-03-10');
assert.strictEqual(R.previousOccurrenceBefore(monthly, '2026-02-28'), '2026-01-31', 'Feb clamped occurrence, previous is Jan 31st');
assert.strictEqual(R.previousOccurrenceBefore(monthly, '2026-03-31'), '2026-02-28');

// -- isOverdue ---------------------------------------------------------------
const t = { dueTime: '18:00', frequency: { type: 'once' } };
assert.ok(R.isOverdue(t, '2026-03-10', new Date('2026-03-10T18:01:00')));
assert.ok(!R.isOverdue(t, '2026-03-10', new Date('2026-03-10T17:59:00')));
assert.ok(R.isOverdue(t, '2026-03-10', new Date('2026-03-11T00:00:00')), 'any later day is overdue regardless of time');

// -- isOverdue: all-day tasks --------------------------------------------
const allDayOnce = { allDay: true, frequency: { type: 'once' } };
assert.ok(!R.isOverdue(allDayOnce, '2026-03-10', new Date('2026-03-10T23:00:00')), "not overdue during its own day, no matter the time");
assert.ok(R.isOverdue(allDayOnce, '2026-03-10', new Date('2026-03-11T00:00:01')), 'overdue as soon as the day itself has passed');

// every-3-days all-day: independent occurrences, same "overdue once the day
// has passed" rule per occurrence -- NOT the continuous-task special case
// (that's daily/interval-1 only).
const allDayEveryThreeDays = { allDay: true, endDate: null, frequency: { type: 'days', interval: 3 } };
assert.ok(!R.isOverdue(allDayEveryThreeDays, '2026-03-10', new Date('2026-03-10T23:00:00')));
assert.ok(R.isOverdue(allDayEveryThreeDays, '2026-03-10', new Date('2026-03-11T00:00:01')));

// daily (interval 1) all-day: one continuous task -- never overdue without
// an end date, and not overdue on/before the end date even long after the
// due date; only overdue once actually past the end date.
const allDayDailyNoEnd = { allDay: true, endDate: null, frequency: { type: 'days', interval: 1 } };
assert.ok(!R.isOverdue(allDayDailyNoEnd, '2026-03-10', new Date('2026-03-10T23:00:00')));
assert.ok(!R.isOverdue(allDayDailyNoEnd, '2026-03-10', new Date('2027-01-01T00:00:00')), 'no end date -- never overdue, however long it runs');

const allDayDailyWithEnd = { allDay: true, endDate: '2026-03-20', frequency: { type: 'days', interval: 1 } };
assert.ok(!R.isOverdue(allDayDailyWithEnd, '2026-03-15', new Date('2026-03-20T23:59:00')), 'still on/before its end date');
assert.ok(R.isOverdue(allDayDailyWithEnd, '2026-03-15', new Date('2026-03-21T00:00:01')), 'overdue once truly past the end date');

// -- recurUntilCompleted: occursOn chain membership -----------------------
// dueDate/frequency are irrelevant to occursOn here -- only dueDate itself
// and pendingReschedules matter (see occursOn's own comment on the field).
const recurUntilCompletedTask = {
  dueDate: '2026-03-10',
  pendingReschedules: ['2026-03-11', '2026-03-12'],
  recurUntilCompleted: true,
  frequency: { type: 'days', interval: 1 },
};
assert.ok(R.occursOn(recurUntilCompletedTask, '2026-03-10'), 'the chain\'s own anchor (dueDate)');
assert.ok(R.occursOn(recurUntilCompletedTask, '2026-03-11'), 'first reschedule');
assert.ok(R.occursOn(recurUntilCompletedTask, '2026-03-12'), 'second reschedule');
assert.ok(!R.occursOn(recurUntilCompletedTask, '2026-03-13'), 'not (yet) pushed this far');
assert.ok(!R.occursOn(recurUntilCompletedTask, '2026-03-09'), 'before the chain even started');

// endDate is deliberately ignored for a recurUntilCompleted task -- occursOn
// never even reaches that check for one (see occursOn's own comment).
const recurUntilCompletedPastEndDate = { ...recurUntilCompletedTask, endDate: '2026-03-10' };
assert.ok(R.occursOn(recurUntilCompletedPastEndDate, '2026-03-12'), 'endDate is ignored for this kind of task');

// -- recurUntilCompleted: advanceRecurUntilCompletedChain -----------------
const freshTask = { dueDate: '2026-03-10', pendingReschedules: [] };
assert.deepStrictEqual(R.advanceRecurUntilCompletedChain(freshTask, '2026-03-10'), [], 'not overdue yet -- nothing to push');
assert.deepStrictEqual(R.advanceRecurUntilCompletedChain(freshTask, '2026-03-11'), ['2026-03-11'], 'one day overdue -- push tomorrow');
assert.deepStrictEqual(
  R.advanceRecurUntilCompletedChain(freshTask, '2026-03-13'),
  ['2026-03-11', '2026-03-12', '2026-03-13'],
  'several days unattended -- every missed day is backfilled, not just today'
);
const midChainTask = { dueDate: '2026-03-10', pendingReschedules: ['2026-03-11'] };
assert.deepStrictEqual(
  R.advanceRecurUntilCompletedChain(midChainTask, '2026-03-12'),
  ['2026-03-11', '2026-03-12'],
  'continues from the chain\'s own last entry, not dueDate'
);
assert.deepStrictEqual(
  R.advanceRecurUntilCompletedChain(midChainTask, '2026-03-11'),
  midChainTask.pendingReschedules,
  "already caught up to today -- doesn't duplicate it"
);

// -- recurUntilCompleted: nextRecurUntilCompletedDueDate -------------------
// recurUntilCompleted: true + a non-empty pendingReschedules on every
// fixture here, deliberately -- exactly the shape a real task has when this
// actually gets called (see resolveRecurUntilCompletedOccurrence, app.js).
// Omitting them let a real bug slip through once already: occursOn short-
// circuits to chain-membership for a recurUntilCompleted task (see its own
// comment), which nextOccurrenceAfter's scan (used internally here) needs
// to NOT do -- these fixtures make sure that's actually exercised.
assert.strictEqual(
  R.nextRecurUntilCompletedDueDate(
    { dueDate: '2026-03-10', pendingReschedules: ['2026-03-11', '2026-03-12', '2026-03-13'], recurUntilCompleted: true, frequency: { type: 'once' } },
    '2026-03-13'
  ),
  null,
  "a 'once' task has no next occurrence, however late it was completed"
);
assert.strictEqual(
  R.nextRecurUntilCompletedDueDate(
    { dueDate: '2026-03-10', pendingReschedules: ['2026-03-11', '2026-03-12', '2026-03-13'], recurUntilCompleted: true, frequency: { type: 'days', interval: 1 } },
    '2026-03-13'
  ),
  '2026-03-14',
  'daily: next occurrence is the day after completion, not the day after the original due date'
);
assert.strictEqual(
  R.nextRecurUntilCompletedDueDate(
    { dueDate: '2026-03-10', pendingReschedules: ['2026-03-11', '2026-03-12', '2026-03-13'], recurUntilCompleted: true, frequency: { type: 'days', interval: 3 } },
    '2026-03-13'
  ),
  '2026-03-16',
  'every-3-days: re-anchored at the completion date, so 3 days after *that*'
);
// Weekly due Monday 2026-07-06, completed the following Thursday (2026-07-16,
// after slipping through two reschedules) instead -- next occurrence is a
// week after the actual completion (2026-07-23), not the following Monday.
assert.strictEqual(
  R.nextRecurUntilCompletedDueDate(
    {
      dueDate: '2026-07-06',
      pendingReschedules: ['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'],
      recurUntilCompleted: true,
      frequency: { type: 'weeks', interval: 1 },
    },
    '2026-07-16'
  ),
  '2026-07-23',
  'weekly: re-anchors the whole weekly pattern to the completion date'
);
assert.strictEqual(
  R.nextRecurUntilCompletedDueDate(
    {
      dueDate: '2026-03-10',
      pendingReschedules: ['2026-03-11', '2026-03-12', '2026-03-13'],
      recurUntilCompleted: true,
      endDate: '2026-03-13',
      frequency: { type: 'days', interval: 1 },
    },
    '2026-03-13'
  ),
  null,
  'still bounded by endDate -- no next occurrence once past it'
);

// -- recurUntilCompleted: firstRecurUntilCompletedDueDate -------------------
assert.strictEqual(
  R.firstRecurUntilCompletedDueDate({ dueDate: '2026-09-20', frequency: { type: 'once' } }),
  '2026-09-20',
  "a 'once' task has no pattern to snap to -- dueDate is the occurrence, whatever it is"
);
// 2026-09-20 is a Sunday, not itself a Monday -- and September's own 1st
// Monday (2026-09-07) is already behind it, so the snap has to land in
// October, not just the nearest Monday.
assert.strictEqual(
  R.firstRecurUntilCompletedDueDate({
    dueDate: '2026-09-20',
    frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 1, ordinal: 1 },
  }),
  '2026-10-05',
  '1st-Monday-of-month: snaps past a due date entered after that month\'s own occurrence, not just to the nearest Monday'
);
// A due date that already IS a valid occurrence stays put.
assert.strictEqual(
  R.firstRecurUntilCompletedDueDate({
    dueDate: '2026-10-05',
    frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 1, ordinal: 1 },
  }),
  '2026-10-05',
  'already a valid occurrence -- left unchanged, not bumped to the next one'
);
// Weekly Mon/Wed/Fri from a Sunday -- snaps to the very next selected
// weekday, not the following week.
assert.strictEqual(
  R.firstRecurUntilCompletedDueDate({
    dueDate: '2026-09-20',
    frequency: { type: 'weeks', interval: 1, weekdays: [1, 3, 5] },
  }),
  '2026-09-21',
  'weekly with specific weekdays: snaps to the next selected weekday, still within the same week'
);

// -- frequency.startsOn -----------------------------------------------------
{
  // Every 3 days from Sep 1 (1, 4, 7, 10, 13, ...), but only from the 8th on.
  const t = { dueDate: '2026-09-01', frequency: { type: 'days', interval: 3, startsOn: '2026-09-08' } };
  assert.strictEqual(R.occursOn(t, '2026-09-07'), false, 'startsOn: a pattern date before startsOn is not produced');
  assert.strictEqual(R.occursOn(t, '2026-09-10'), true, 'startsOn: phase still anchored on dueDate (1, 4, 7, 10 ...), not on startsOn');
  assert.strictEqual(R.occursOn(t, '2026-09-08'), false, 'startsOn: startsOn itself is not an occurrence unless the pattern lands there');
  assert.strictEqual(R.nextOccurrenceAfter(t, '2026-09-01'), '2026-09-10', 'startsOn: next occurrence skips the dates before startsOn');
  assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(t, '2026-09-09'), null, 'startsOn: nothing before startsOn to find');
  assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(t, '2026-09-12'), '2026-09-10', 'startsOn: most recent on/after startsOn');
  assert.strictEqual(R.previousOccurrenceBefore(t, '2026-09-10'), null, 'startsOn: the first date from startsOn has no previous one');

  // Monthly on the 31st (clamped), started on Jan 31 -- startsOn must not re-anchor the day of month.
  const m = { dueDate: '2026-01-31', frequency: { type: 'months', interval: 1, startsOn: '2026-04-01' } };
  assert.strictEqual(R.nextOccurrenceAfter(m, '2026-03-31'), '2026-04-30', 'startsOn: monthly day-of-month still comes from dueDate');
  assert.strictEqual(R.occursOn(m, '2026-03-31'), false, 'startsOn: monthly occurrence before startsOn not produced');

  // A one-off before startsOn doesn't occur at all.
  const once = { dueDate: '2026-09-05', frequency: { type: 'once', startsOn: '2026-09-06' } };
  assert.strictEqual(R.occursOn(once, '2026-09-05'), false, 'startsOn: a once task dated before startsOn does not occur');
  assert.strictEqual(R.mostRecentOccurrenceOnOrBefore(once, '2026-09-30'), null, 'startsOn: once task before startsOn has no most recent occurrence');
  assert.strictEqual(R.nextOccurrenceAfter(once, '2026-09-01'), null, 'startsOn: once task before startsOn has no next occurrence');
}

// -- frequency.skipDates ----------------------------------------------------
{
  const t = { dueDate: '2026-09-01', frequency: { type: 'days', interval: 1, skipDates: ['2026-09-03'] } };
  assert.strictEqual(R.occursOn(t, '2026-09-03'), false, 'skipDates: a skipped date is not produced');
  assert.strictEqual(R.occursOn(t, '2026-09-04'), true, 'skipDates: the rest of the pattern is untouched');
  assert.strictEqual(R.nextOccurrenceAfter(t, '2026-09-02'), '2026-09-04', 'skipDates: next occurrence steps over a skipped date');
  assert.strictEqual(R.previousOccurrenceBefore(t, '2026-09-04'), '2026-09-02', 'skipDates: previous occurrence steps over a skipped date');
  const once = { dueDate: '2026-09-05', frequency: { type: 'once', skipDates: ['2026-09-05'] } };
  assert.strictEqual(R.nextOccurrenceAfter(once, '2026-09-01'), null, 'skipDates: a skipped one-off has no occurrence left');
}

console.log('recurrence.test.js: all assertions passed');
