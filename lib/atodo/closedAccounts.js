const db = require('../../db');

// Deleting an account closes it rather than removing every trace -- matches
// the Privacy Policy (section 4). A closed account keeps exactly three
// things for a year: its email, its password hash, and whether it ever had
// a trial or subscription (trial_ineligible). Everything else is gone
// immediately:
//  - the row is deleted and a fresh "closed" row inserted in its place, so
//    tasks, occurrences, checkout sessions (ON DELETE CASCADE), every
//    profile/subscription/Stripe column -- and any column added later --
//    go with it, fiscal receipts are detached (ON DELETE SET NULL), and
//    every outstanding token dies with the old id;
//  - the email stays taken: registering or changing a login email to it is
//    refused like any existing account's (EMAIL_TAKEN);
//  - logging in with it (right password) within the year reopens the
//    account, empty -- see POST /auth/login -- and it can't get another
//    free trial if it had one;
//  - after the year, startPurging deletes the closed row for good.

const CLOSED_RETENTION = "interval '1 year'";

// Also covers fiscal receipts (Privacy Policy section 4): accounting law
// requires keeping them, intact, for 11 years from the end of the year
// they were issued in -- then they're deleted. A storno outliving the
// receipt it cancels just loses the link (original_receipt_id SET NULL).
const RECEIPT_RETENTION_YEARS = 11;

async function closeAccount(accountId) {
 const client = await db.getClient();
 try {
  await client.query('BEGIN');
  const { rows } = await client.query(
   'DELETE FROM atodo.accounts WHERE id = $1 AND closed_at IS NULL RETURNING email, password_hash, subscription_plan, trial_ineligible',
   [accountId]
  );
  if (rows.length) {
   const gone = rows[0];
   await client.query(
    'INSERT INTO atodo.accounts (email, password_hash, trial_ineligible, closed_at) VALUES ($1, $2, $3, now())',
    [gone.email, gone.password_hash, gone.trial_ineligible || gone.subscription_plan != null]
   );
  }
  await client.query('COMMIT');
 } catch (err) {
  await client.query('ROLLBACK');
  throw err;
 } finally {
  client.release();
 }
}

// A closed account whose owner logged in again: open, empty, as if new --
// apart from its trial status.
async function reopenAccount(accountId) {
 const { rows } = await db.query(
  'UPDATE atodo.accounts SET closed_at = NULL, created_at = now(), last_login_at = now(), last_active_at = now() WHERE id = $1 RETURNING *',
  [accountId]
 );
 return rows[0];
}

async function purgeExpired() {
 const { rowCount: accounts } = await db.query(`DELETE FROM atodo.accounts WHERE closed_at <= now() - ${CLOSED_RETENTION}`);
 const { rowCount: receipts } = await db.query(
  "DELETE FROM atodo.fiscal_receipts WHERE year < EXTRACT(YEAR FROM now() AT TIME ZONE 'Europe/Zagreb') - $1",
  [RECEIPT_RETENTION_YEARS]
 );
 return { accounts, receipts };
}

function startPurging(intervalMs = 24 * 60 * 60 * 1000) {
 const run = () => purgeExpired().catch((err) => console.error(`[atodo] purging closed accounts / expired receipts failed: ${err.message}`));
 run();
 return setInterval(run, intervalMs).unref();
}

module.exports = { closeAccount, reopenAccount, purgeExpired, startPurging };
