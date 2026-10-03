// Recurrence + overdue math for A-To-Do's tasks. Pure functions over plain
// task objects (test/domain/recurrence.test.js). Moved here from the client,
// which no longer evaluates patterns itself.
//
// Dates are 'YYYY-MM-DD' strings; JavaScript's "local" time is used as a
// plain wall clock, which is why the API runs with TZ=UTC (no daylight-
// saving jumps) and each request's own time zone is applied by clock.js.

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateToISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00');
  const b = new Date(isoB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// For each of `weekdays`, its own `ordinal`-th occurrence in the month (the
// ordinal-th Monday, the ordinal-th Wednesday, etc., independently) -- the
// "earliest Nth occurrence of any of the selected days" is whichever of
// those candidate dates comes first. NOT the ordinal-th date in the combined
// stream of every selected weekday's occurrences: e.g. weekdays [Mon, Wed,
// Fri] with ordinal 2, in a month starting on a Wednesday, is the earliest
// of {2nd Monday, 2nd Wednesday, 2nd Friday} -- the 2nd Wednesday (the 8th),
// not the 2nd selected-day date overall (which would be that first Friday,
// the 3rd). Returns null if none of the selected weekdays occur that many
// times in the month (e.g. ordinal 5 with a weekday that only occurs 4
// times).
function earliestNthSelectedWeekdayOfMonth(year, monthIndex, weekdays, ordinal) {
  const totalDays = daysInMonth(year, monthIndex);
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  let earliest = null;
  for (const weekday of weekdays) {
    const dayOfFirstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
    const day = dayOfFirstOccurrence + (ordinal - 1) * 7;
    if (day > totalDays) continue; // this weekday doesn't occur that many times this month
    const candidate = new Date(year, monthIndex, day);
    if (!earliest || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

function monthsBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00');
  const b = new Date(isoB + 'T00:00:00');
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const totalDays = daysInMonth(year, monthIndex);
  const lastDate = new Date(year, monthIndex, totalDays);
  const diff = (lastDate.getDay() - weekday + 7) % 7;
  return new Date(year, monthIndex, totalDays - diff);
}

// The date `task`'s monthly pattern would land on in the given month, judged
// only against that month in isolation (no interval/dueDate check) -- used
// solely to figure out, for a single month, whether it's early or late
// relative to dueDate. Not meaningful as "the" occurrence for dayModes whose
// real occurrence can land in an adjacent month (multi-weekday-offset) --
// see monthlyRecurrenceAnchorMonth, its only caller, for why that's fine.
function monthlyPatternDateInMonth(task, year, monthIndex) {
  const dayMode = task.frequency.dayMode || 'day';
  switch (dayMode) {
    case 'last':
      return new Date(year, monthIndex, daysInMonth(year, monthIndex));
    case 'before-last': {
      const offset = Math.min(3, Math.max(0, task.frequency.offset || 0));
      return new Date(year, monthIndex, daysInMonth(year, monthIndex) - offset);
    }
    case 'weekday': {
      const { weekday, ordinal } = task.frequency;
      return ordinal === 'last'
        ? lastWeekdayOfMonth(year, monthIndex, weekday)
        : earliestNthSelectedWeekdayOfMonth(year, monthIndex, [weekday], ordinal);
    }
    case 'multi-weekday':
      return earliestNthSelectedWeekdayOfMonth(year, monthIndex, task.frequency.weekdays, task.frequency.ordinal);
    case 'multi-weekday-offset': {
      const anchor = earliestNthSelectedWeekdayOfMonth(year, monthIndex, task.frequency.weekdays, task.frequency.ordinal);
      if (!anchor) return null;
      const sign = task.frequency.offsetDirection === 'after' ? 1 : -1;
      return addDays(anchor, sign * task.frequency.offsetDays);
    }
    case 'multi-day': {
      const days = task.frequency.days;
      return days && days.length ? new Date(year, monthIndex, Math.max(...days)) : null;
    }
    default: {
      const due = new Date(task.dueDate + 'T00:00:00');
      return new Date(year, monthIndex, Math.min(due.getDate(), daysInMonth(year, monthIndex)));
    }
  }
}

// The month `interval`-stepping should count from -- normally dueDate's own
// month, EXCEPT that several dayModes' pattern doesn't necessarily land on or
// after dueDate within dueDate's own month (e.g. "3 days before the first
// Monday" when dueDate falls after that month's computed date). Treating
// dueDate's month as month zero in that case would make the true first
// occurrence -- whichever month's pattern date is actually the first one
// on/after dueDate -- wrongly skipped, jumping `interval` months past dueDate
// instead of landing on the very next candidate. So: if dueDate's own month's
// pattern date hasn't happened yet as of dueDate, the following month is
// month zero instead, and interval-stepping (in occursOn) counts from there.
function monthlyRecurrenceAnchorMonth(task) {
  const due = new Date(task.dueDate + 'T00:00:00');
  const candidate = monthlyPatternDateInMonth(task, due.getFullYear(), due.getMonth());
  if (candidate && candidate >= due) return new Date(due.getFullYear(), due.getMonth(), 1);
  return new Date(due.getFullYear(), due.getMonth() + 1, 1);
}

// Does `task` have an occurrence exactly on `dateISO`?
//
// task.frequency shapes:
//   { type: 'once' }
//   { type: 'days', interval }
//   { type: 'weeks', interval, weekdays?: number[] }  -- weekdays: 0(Sun)-6(Sat).
//     If given (non-empty), occurs on those weekdays every `interval` weeks,
//     counted from the Sunday of dueDate's own week (dueDate need not itself
//     fall on one of the selected weekdays -- it's just the anchor for week
//     boundaries and the interval count). If omitted, falls back to the
//     original single-day-of-week behavior anchored to dueDate's own
//     weekday, for backward compatibility with already-saved tasks.
//   { type: 'months', interval, dayMode?, offset?, weekday?, ordinal?,
//     weekdays?, offsetDirection?, offsetDays? }
//     dayMode 'day' (default/omitted): anchor to dueDate's day-of-month,
//       clamped to the last day of shorter months (e.g. the 31st -> Feb 28).
//     dayMode 'last': always the last day of the month.
//     dayMode 'before-last': `offset` (0-3) days before the last day.
//     dayMode 'weekday': the `ordinal`-th occurrence of `weekday` (0-6) in
//       the month, where ordinal is 1-5, or the string 'last' for the final
//       occurrence of that weekday in the month (some months have 4 of a
//       given weekday, some have 5, so "last" isn't just ordinal 5).
//     dayMode 'multi-weekday': whichever of `weekdays` (number[], 0-6) has
//       its own `ordinal`-th occurrence (1+, not capped at 5) earliest in
//       the month -- e.g. weekdays [Mon, Wed, Fri] with ordinal 2 is the
//       earliest of that month's 2nd Monday/2nd Wednesday/2nd Friday, NOT
//       the 2nd date overall among every selected weekday's occurrences.
//       See earliestNthSelectedWeekdayOfMonth.
//     dayMode 'multi-weekday-offset': same anchor as 'multi-weekday', then
//       shifted `offsetDays` (0-6) days `offsetDirection` ('before'/'after')
//       -- deliberately allowed to land in the adjacent month.
//
// frequency.startsOn (optional, any type): the pattern produces nothing
// before this date, while still anchored on dueDate for all the phase math
// above (week/month interval counting, day-of-month, every-N-days). Set when
// a task's pattern is changed or re-cut after it's already been running
// (see app.js's rollPatternForward): every earlier date it produced is
// saved as an Occurrence row by then, so the current pattern must only
// cover what comes after -- without moving dueDate itself, which would
// silently shift the phase of every anchored pattern.
//
// frequency.skipDates (optional, any type): individual dates the pattern
// would land on but no longer produces -- an occurrence the user deleted
// (see app.js's deleteOccurrence). Cheaper than re-cutting the pattern
// around a single date.
//
// task.recurUntilCompleted short-circuits all of the above: its current
// occurrence isn't at a date `frequency` computes, it's wherever
// advanceRecurUntilCompletedChain (below) last pushed it, so occursOn just
// checks membership in that chain -- task.dueDate itself (the chain's own
// anchor -- see resolveRecurUntilCompletedOccurrence) plus every date it's
// been pushed to since (task.pendingReschedules). `frequency` still matters
// for this kind of task, just not here -- see
// nextRecurUntilCompletedDueDate, which uses it to find the occurrence
// *after* this one once it's finally completed.
function occursOn(task, dateISO) {
  if (task.recurUntilCompleted) {
    return dateISO === task.dueDate || (task.pendingReschedules || []).includes(dateISO);
  }
  if (task.endDate && dateISO > task.endDate) return false;
  if (task.frequency.startsOn && dateISO < task.frequency.startsOn) return false;
  if (task.frequency.skipDates && task.frequency.skipDates.includes(dateISO)) return false;
  const diffDays = daysBetween(task.dueDate, dateISO);
  if (diffDays < 0) return false;
  const interval = Math.max(1, task.frequency.interval || 1);
  const target = new Date(dateISO + 'T00:00:00');

  switch (task.frequency.type) {
    case 'once':
      return diffDays === 0;

    case 'days':
      return diffDays % interval === 0;

    case 'weeks': {
      const weekdays = task.frequency.weekdays;
      if (weekdays && weekdays.length > 0) {
        const due = new Date(task.dueDate + 'T00:00:00');
        const dueWeekStart = addDays(due, -due.getDay());
        const weekIndex = Math.floor(daysBetween(dateToISO(dueWeekStart), dateISO) / 7);
        if (weekIndex < 0 || weekIndex % interval !== 0) return false;
        return weekdays.includes(target.getDay());
      }
      return diffDays % (interval * 7) === 0;
    }

    case 'months': {
      const dayMode = task.frequency.dayMode || 'day';

      // The offset can push the actual occurrence into the month before or
      // after the one its "earliest Nth selected weekday" is anchored to
      // (deliberately -- see earliestNthSelectedWeekdayOfMonth), so which
      // month governs the interval/dueDate check isn't necessarily target's
      // own month. Checked separately from every other dayMode below (which
      // all anchor within target's own month), by instead checking each
      // month whose anchor could plausibly land on `target` -- its own
      // month, and the one before/after it (offsetDays is capped at 6, so
      // nothing further away can ever reach `target`).
      const recurrenceAnchorMonthISO = dateToISO(monthlyRecurrenceAnchorMonth(task));

      if (dayMode === 'multi-weekday-offset') {
        const { weekdays, ordinal, offsetDirection, offsetDays } = task.frequency;
        const sign = offsetDirection === 'after' ? 1 : -1;
        for (const monthDelta of [0, -1, 1]) {
          const anchorMonth = new Date(target.getFullYear(), target.getMonth() + monthDelta, 1);
          const anchorDiffMonths = monthsBetween(recurrenceAnchorMonthISO, dateToISO(anchorMonth));
          if (anchorDiffMonths < 0 || anchorDiffMonths % interval !== 0) continue;
          const anchor = earliestNthSelectedWeekdayOfMonth(anchorMonth.getFullYear(), anchorMonth.getMonth(), weekdays, ordinal);
          if (!anchor) continue;
          if (dateToISO(addDays(anchor, sign * offsetDays)) === dateISO) return true;
        }
        return false;
      }

      const diffMonths = monthsBetween(recurrenceAnchorMonthISO, dateISO);
      if (diffMonths < 0 || diffMonths % interval !== 0) return false;
      const due = new Date(task.dueDate + 'T00:00:00');

      if (dayMode === 'last') {
        return target.getDate() === daysInMonth(target.getFullYear(), target.getMonth());
      }
      if (dayMode === 'before-last') {
        const offset = Math.min(3, Math.max(0, task.frequency.offset || 0));
        return target.getDate() === daysInMonth(target.getFullYear(), target.getMonth()) - offset;
      }
      if (dayMode === 'weekday') {
        const { weekday, ordinal } = task.frequency;
        if (target.getDay() !== weekday) return false;
        if (ordinal === 'last') return addDays(target, 7).getMonth() !== target.getMonth();
        const nth = Math.floor((target.getDate() - 1) / 7) + 1;
        return nth === ordinal;
      }
      if (dayMode === 'multi-weekday') {
        const anchor = earliestNthSelectedWeekdayOfMonth(target.getFullYear(), target.getMonth(), task.frequency.weekdays, task.frequency.ordinal);
        return !!anchor && dateToISO(anchor) === dateISO;
      }
      if (dayMode === 'multi-day') {
        // Every selected day (1-28, see the form) exists in every month, so
        // unlike the other dayModes above there's no clamping/anchor logic
        // needed here -- just a direct membership check.
        return task.frequency.days.includes(target.getDate());
      }
      const expectedDay = Math.min(due.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
      return target.getDate() === expectedDay;
    }

    default:
      return false;
  }
}

// Generous bound (~10 years of days) for the scans below -- not a real-world
// limit, just a safety net against a pathological/corrupt task never
// matching and looping forever.
const MAX_SCAN_DAYS = 3660;

// The most recent occurrence date <= todayISO, or null if the task's anchor
// due date hasn't arrived yet. For 'once' tasks this is just the due date
// itself (for any today on or after it) -- a missed one-off doesn't vanish,
// it stays "pending" until completed, same as any other frequency.
//
// task.endDate (optional) stops the series on or before that date -- if it's
// earlier than todayISO, the search is clamped to endDate instead, same as
// if "today" were endDate, so a recurring task doesn't keep surfacing missed
// occurrences past the date its recurrences were meant to stop.
//
// Implemented as a bounded backward scan via occursOn() rather than a
// closed-form step calculation per frequency type: the weekday-of-month and
// multi-weekday-per-week patterns don't reduce to simple arithmetic the way
// "every N days" does, so one shared, easier-to-verify mechanism beats a
// different formula for every case. Cheap enough for a to-do list's needs --
// occursOn() is O(1), and real gaps between occurrences are at most a few
// months even for exotic patterns (e.g. a 5th-weekday-of-month that skips
// short months).
function mostRecentOccurrenceOnOrBefore(task, todayISO) {
  const searchISO = task.endDate && task.endDate < todayISO ? task.endDate : todayISO;
  if (daysBetween(task.dueDate, searchISO) < 0) return null;
  if (task.frequency.type === 'once') return occursOn(task, task.dueDate) ? task.dueDate : null; // occursOn: startsOn can rule it out

  // Nothing before startsOn can match (see occursOn) -- stop there rather
  // than scanning all the way back to dueDate for nothing.
  const floorISO = task.frequency.startsOn && task.frequency.startsOn > task.dueDate ? task.frequency.startsOn : task.dueDate;
  let cursor = searchISO;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (occursOn(task, cursor)) return cursor;
    if (cursor <= floorISO) return null;
    cursor = dateToISO(addDays(new Date(cursor + 'T00:00:00'), -1));
  }
  return null;
}

// The next occurrence strictly after afterISO, or null if there isn't one
// (a 'once' task's single occurrence is already on/before afterISO, or
// task.endDate has been reached). Complements
// mostRecentOccurrenceOnOrBefore -- used by the to-do list's "next
// recurrence" view to show what's coming up once the current one is done,
// rather than only what's due now or overdue. Same bounded-scan approach.
function nextOccurrenceAfter(task, afterISO) {
  if (task.frequency.type === 'once') {
    // Its one occurrence is dueDate itself -- next if that's still ahead of
    // afterISO, otherwise there's nothing left.
    return daysBetween(task.dueDate, afterISO) < 0 && occursOn(task, task.dueDate) ? task.dueDate : null;
  }

  // Hasn't started yet -- scan starts AT dueDate itself (inclusive), not
  // blindly assumed to already be a valid occurrence: dueDate is just the
  // pattern's anchor point (for month/week interval counting), not
  // necessarily a date the pattern itself lands on -- e.g. a weekly task
  // with specific weekdays selected that don't include dueDate's own
  // weekday, or any of the multi-weekday-of-month patterns where the entered
  // due date doesn't happen to be that computed day.
  let cursor =
    daysBetween(task.dueDate, afterISO) < 0 ? task.dueDate : dateToISO(addDays(new Date(afterISO + 'T00:00:00'), 1));
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (task.endDate && cursor > task.endDate) return null;
    if (occursOn(task, cursor)) return cursor;
    cursor = dateToISO(addDays(new Date(cursor + 'T00:00:00'), 1));
  }
  return null;
}

// The occurrence immediately before dateISO (dateISO is assumed to itself be
// a valid occurrence of task), or null if there isn't one -- dateISO is the
// task's very first occurrence. Complements nextOccurrenceAfter; used by the
// to-do list's "edit this occurrence" / "edit this and following" split to
// know where the historical portion of the series should end.
function previousOccurrenceBefore(task, dateISO) {
  const dayBefore = dateToISO(addDays(new Date(dateISO + 'T00:00:00'), -1));
  return mostRecentOccurrenceOnOrBefore(task, dayBefore);
}

// Whether occurrenceDateISO's window -- its due time, or end of day for an
// all-day task -- has already passed as of `now`. The shared threshold
// behind isOverdue() below.
function hasOccurrenceEnded(task, occurrenceDateISO, now) {
  const [h, m] = (task.dueTime || '23:59').split(':').map(Number);
  const dueDateTime = new Date(occurrenceDateISO + 'T00:00:00');
  dueDateTime.setHours(h, m, 0, 0);
  return now.getTime() > dueDateTime.getTime();
}

// An all-day task has no dueTime -- falling back to 23:59 in
// hasOccurrenceEnded already gives the right "overdue only once the day
// itself has passed" behavior on its own. The one exception is a
// daily-recurring (every 1 day) all-day task: that's not a string of
// independent daily occurrences, it's one continuous task spanning from its
// due date to its end date (e.g. "multi-day project"), so it's only
// overdue once truly past that end date -- or never, if there isn't one.
function isOverdue(task, occurrenceDateISO, now) {
  if (task.allDay && task.frequency.type === 'days' && (task.frequency.interval || 1) === 1) {
    return !!task.endDate && dateToISO(now) > task.endDate;
  }
  return hasOccurrenceEnded(task, occurrenceDateISO, now);
}

// task.recurUntilCompleted's own reschedule chain: the current (not yet
// completed) occurrence's own due date, plus every date it's been pushed to
// since -- see occursOn's own comment on the field. Returns the chain's
// *current* pendingReschedules array, unchanged (a new array only when it
// actually needed to grow), backfilling one entry per day between the
// chain's last date and todayISO rather than jumping straight to todayISO --
// the app isn't running in the background, so a gap here (the app wasn't
// open for a few days) is caught up in one pass the next time it is, same
// as if each day had ticked over one at a time while it was.
function advanceRecurUntilCompletedChain(task, todayISO) {
  const pendingReschedules = task.pendingReschedules || [];
  let cursor = pendingReschedules.length ? pendingReschedules[pendingReschedules.length - 1] : task.dueDate;
  if (cursor >= todayISO) return pendingReschedules; // not overdue (yet) -- nothing to push
  const grown = pendingReschedules.slice();
  while (cursor < todayISO) {
    cursor = dateToISO(addDays(new Date(cursor + 'T00:00:00'), 1));
    grown.push(cursor);
  }
  return grown;
}

// The occurrence a task.recurUntilCompleted task's *next* recurrence lands
// on, given completedDateISO -- the date whichever instance of the current
// occurrence was actually checked off (not necessarily task.dueDate itself;
// see occursOn's own comment on the field, and the chain it describes).
// Re-anchors `frequency` at completedDateISO rather than task.dueDate, so a
// late completion shifts every future occurrence with it instead of
// snapping back to the original schedule -- e.g. a weekly task due Monday,
// completed the following Thursday instead, recurs from *that* Thursday
// (next Thursday), not the following Monday. null for a 'once' task (no
// next occurrence) or once task.endDate is behind completedDateISO.
//
// recurUntilCompleted: false on the pseudo-task below is deliberate, not a
// copy-paste slip -- occursOn (which nextOccurrenceAfter's own scan calls)
// special-cases a real recurUntilCompleted task to just check chain
// membership (see its own comment), never falling through to the plain
// `frequency` math this function actually needs. Without turning that back
// off here, the scan below would only ever match completedDateISO itself
// (already excluded, being the search's own starting point) and never find
// a next occurrence at all.
function nextRecurUntilCompletedDueDate(task, completedDateISO) {
  return nextOccurrenceAfter({ ...task, dueDate: completedDateISO, recurUntilCompleted: false }, completedDateISO);
}

// Snaps a brand-new task.recurUntilCompleted task's raw, user-picked
// dueDate forward to the first date `frequency` actually lands on (task
// itself, unchanged, if dueDate already is one) -- e.g. "1st Monday of the
// month" with a due date that isn't itself a Monday. A non-recurUntilCompleted
// task never needs this: occursOn recomputes each month/week's own pattern
// date fresh for every candidate (see monthlyRecurrenceAnchorMonth), so an
// "off" dueDate self-corrects at display time regardless. A
// recurUntilCompleted task can't rely on that -- once saved, occursOn just
// checks chain membership against dueDate literally (see its own comment) --
// so this has to run once, up front, instead. recurUntilCompleted: false on
// the pseudo-task for the same reason as nextRecurUntilCompletedDueDate:
// occursOn would otherwise just check membership against dueDate itself,
// never falling through to the real frequency math this needs. Call this
// whenever a task is newly becoming recurUntilCompleted (fresh creation, or
// an edit that turns the flag on) -- not on every edit of an
// already-recurUntilCompleted task, whose dueDate by then represents
// wherever its own reschedule chain has actually gotten to, not the
// original pattern anymore.
function firstRecurUntilCompletedDueDate(task) {
  if (task.frequency.type === 'once') return task.dueDate;
  const dayBefore = dateToISO(addDays(new Date(task.dueDate + 'T00:00:00'), -1));
  return nextOccurrenceAfter({ ...task, recurUntilCompleted: false }, dayBefore);
}

const api = {
  dateToISO,
  addDays,
  daysBetween,
  daysInMonth,
  monthsBetween,
  occursOn,
  mostRecentOccurrenceOnOrBefore,
  nextOccurrenceAfter,
  previousOccurrenceBefore,
  isOverdue,
  hasOccurrenceEnded,
  advanceRecurUntilCompletedChain,
  nextRecurUntilCompletedDueDate,
  firstRecurUntilCompletedDueDate,
};

module.exports = api;
