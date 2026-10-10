const db = require('../../db');

// What happened to an A-To-Do account and when (atodo.account_events,
// migration 013), for the admin app's user administration: email and
// password changes, scheduled deletion, trials and subscription changes the
// account made, and support's own actions on it (with the admin key's
// label). Deleted with the account -- closing one keeps nothing but its
// email, password hash and trial status (Privacy Policy section 4).
//
// Recording never fails the action it records: an error is logged instead.
//
//   kind     e.g. 'email.changed' -- see EVENT_KINDS
//   details  a small object, e.g. { from, to }

const EVENT_KINDS = [
 'account.created',
 'account.reopened',
 'email.change_requested',
 'email.changed',
 'email.set_by_support',
 'password.changed',
 'password.reset',
 'password.reset_sent_by_support',
 'deletion.scheduled',
 'deletion.cancelled',
 'subscription.trial_started',
 'subscription.cancelled',
 'subscription.resumed',
];

async function recordAccountEvent(accountId, kind, details = {}, client = db) {
 try {
  await client.query('INSERT INTO atodo.account_events (account_id, kind, details) VALUES ($1, $2, $3)', [accountId, kind, JSON.stringify(details)]);
 } catch (err) {
  console.error(`[atodo] recording ${kind} for ${accountId} failed: ${err.message}`);
 }
}

module.exports = { recordAccountEvent, EVENT_KINDS };
