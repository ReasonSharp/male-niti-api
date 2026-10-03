// Running one A-To-Do request against the domain: open a transaction, lock
// and load the account (store.js), bring it up to date (maintenance --
// expired timers, stale carried-over occurrences, carried recur-until-
// completed chains), let the route read or act on it, write back what
// changed, commit. Every request locks the account's row: even a read can
// write (maintenance), and two requests changing the same account must not
// overwrite each other.

const db = require('../../../db');
const { makeClock } = require('./clock');
const { loadState, saveState } = require('./store');
const { DomainError } = require('./account');

// The user's clock: their time zone from X-Timezone (clock.js falls back to
// the default for a missing or unknown one).
const clockFor = (req) => makeClock(req.get('X-Timezone'));

// opts.fullTaskIds: taskIds whose notes and logs the route needs (or 'all').
// fn(state, ctx) returns the response body; ctx has the clock and account.
// The body gets `expiredTimers` (for the client's chime) when any ran out.
async function withState(req, res, opts, fn) {
 const client = await db.getClient();
 try {
  await client.query('BEGIN');
  const clock = clockFor(req);
  const loaded = await loadState(client, req.atodoAuth.id, { clock, fullTaskIds: opts.fullTaskIds || [], lock: true });
  if (!loaded) {
   await client.query('ROLLBACK');
   return res.status(410).json({ code: 'ACCOUNT_NOT_FOUND', message: 'This account no longer exists.' });
  }
  const { state, account, snapshot } = loaded;
  state.runMaintenance();
  const body = await fn(state, { clock, account, client });
  const touched = await saveState(client, req.atodoAuth.id, state, snapshot);
  await client.query('COMMIT');
  const result = body === undefined ? {} : body;
  if (state.expiredTimers.length && result && typeof result === 'object') result.expiredTimers = state.expiredTimers;
  if (opts.reportChanges && result && typeof result === 'object') {
   result.changed = { taskIds: [...touched].filter((id) => id !== '*'), all: touched.has('*') };
   result.active = activeOf(state);
  }
  return res.status(opts.status || 200).json(result);
 } catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  if (err instanceof DomainError) return res.status(err.status).json({ code: err.code, message: err.message });
  throw err;
 } finally {
  client.release();
 }
}

// The focused occurrence, as the client knows it (by taskId).
function activeOf(state) {
 const task = state.taskByRecordId(state.active.taskId);
 return task ? { taskId: task.taskId, occurrenceDate: state.active.occurrenceDate } : null;
}

module.exports = { withState, clockFor, activeOf };
