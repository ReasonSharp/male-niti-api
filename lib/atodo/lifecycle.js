const db = require('../../db');

// Matches this app's Privacy Policy: an account untouched for 12 months is
// deleted automatically, same as one whose scheduled deletion (see
// POST /atodo/v1/users/me/schedule-deletion) has come due. Neither is
// enforced by a background job -- both are checked lazily, right here,
// wherever an account is actually used (POST /auth/login, GET /auth/me),
// per api-spec.yaml's own notes on those endpoints.
const INACTIVITY_MS = 365 * 24 * 60 * 60 * 1000;

// Deletes `account` and returns an Error-schema body describing why, if
// either deletion condition has come due -- otherwise returns null and
// leaves the account untouched.
async function enforceLifecycleDeletion(account) {
 const lastActive = account.last_active_at || account.created_at;
 const inactiveTooLong = Date.now() - new Date(lastActive).getTime() > INACTIVITY_MS;

 const scheduledDue = Boolean(
  account.subscription_scheduled_deletion &&
  account.subscription_expires_at &&
  new Date(account.subscription_expires_at).getTime() <= Date.now()
 );

 if (!inactiveTooLong && !scheduledDue) return null;

 await db.query('DELETE FROM atodo.accounts WHERE id = $1', [account.id]);

 // Scheduled deletion takes precedence in the message if both happen to be true.
 if (scheduledDue) {
  return { code: 'ACCOUNT_DELETED_SCHEDULED', message: 'This account was deleted, as scheduled, once its subscription ended.' };
 }
 return { code: 'ACCOUNT_EXPIRED_INACTIVITY', message: 'This account was automatically deleted after 12 months of inactivity.' };
}

module.exports = { enforceLifecycleDeletion };
