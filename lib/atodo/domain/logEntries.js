// Activity log entries, for the client to show in the user's language.
//
// The server writes every entry's `message` as a fixed English sentence --
// the log's own record, compared against itself (see AccountState's
// logFocusToggle/takeBackResolutionLogEntry) -- some with a date in it.
// Older entries were written by the client before the rules moved here, a
// few in wordings nothing writes any more. describeLogEntry recognises all
// of them and names each with a translation key in the client's `app`
// bundle (`log.*`, see the translations in the maleniti schema) plus its
// parameters, so an entry reads in whatever language the user picks --
// including ones written long before. An entry it doesn't recognise has no
// key: the client shows its message as written.

const DATE = '(\\d{4}-\\d{2}-\\d{2})';

const PATTERNS = [
 ['Edited', 'log.edited'],
 ['Focused', 'log.focused'],
 ['Unfocused', 'log.unfocused'],
 ['Unfocused and marked done', 'log.unfocusedAndMarkedDone'],
 ['Marked done', 'log.markedDone'],
 ['Marked not done', 'log.markedNotDone'],
 ['Marked failed', 'log.markedFailed'],
 ['Marked not failed', 'log.markedNotFailed'],
 ['Timer set', 'log.timerSet'],
 ['Timer cancelled', 'log.timerCancelled'],
 ['Timer elapsed', 'log.timerElapsed'],
 ['Imported', 'log.imported'],
 ['Manual occurrence added', 'log.manualOccurrenceAdded'],
 ['Occurrence deleted', 'log.occurrenceDeleted'],
 ['Occurrence record deleted', 'log.occurrenceRecordDeleted'],
 ['Measured focus time deleted', 'log.measuredFocusTimeDeleted'],
 ['Stats reset', 'log.statsReset'],
 ['Recurrence pattern edited', 'log.recurrencePatternEdited'],
 ['Recurrence edited (only this occurrence)', 'log.recurrenceEditedThisOnly'],
 ['Recurrence edited (this and following occurrences)', 'log.recurrenceEditedFollowing'],
 [`Rescheduled to ${DATE}`, 'log.rescheduledTo', ['date']],
 [`Recurrence paused until ${DATE}`, 'log.recurrencePausedUntil', ['date']],
 [`Recurrence resumed \\(was paused until ${DATE}\\)`, 'log.recurrenceResumed', ['date']],
].map(([pattern, key, params = []]) => ({
 regex: new RegExp(`^${params.length ? pattern : pattern.replace(/[()]/g, '\\$&')}$`),
 key,
 params,
}));

// { key, params } for a message, or null.
function describeLogMessage(message) {
 if (typeof message !== 'string') return null;
 for (const { regex, key, params } of PATTERNS) {
  const match = regex.exec(message);
  if (!match) continue;
  return { key, params: Object.fromEntries(params.map((name, i) => [name, match[i + 1]])) };
 }
 return null;
}

// A log as sent to the client: each entry with its `key` and `params`
// (null when unrecognised) next to what's stored.
function describeLog(log) {
 return (log || []).map((entry) => {
  const described = entry && describeLogMessage(entry.message);
  return { ...entry, key: described ? described.key : null, params: described ? described.params : {} };
 });
}

module.exports = { describeLogMessage, describeLog };
