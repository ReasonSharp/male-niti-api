const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { toUser, issueToken } = require('../../lib/atodo/token');
const { hashPassword, verifyPassword } = require('../../lib/atodo/password');

const router = express.Router();

// Mounted at /atodo/v1/users behind requireAtodoAuth (see routes/atodo/index.js).

// camelCase request field -> snake_case column. background is JSONB and
// needs explicit JSON encoding, same reason routes/blog.js encodes body_hr/body_en.
const FIELD_COLUMNS = {
 nickname: 'nickname',
 avatar: 'avatar',
 timeFormat: 'time_format',
 background: 'background',
 language: 'language',
 theme: 'theme',
 weekStart: 'week_start',
 activeTaskId: 'active_task_id',
 activeOccurrenceDate: 'active_occurrence_date',
 todoViewMode: 'todo_view_mode',
};

router.patch('/me', asyncHandler(async (req, res) => {
 const body = req.body || {};
 const cols = [];
 const values = [];

 for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
  if (body[field] === undefined) continue;
  cols.push(column);
  values.push(column === 'background' ? JSON.stringify(body[field]) : body[field]);
 }

 const { rows } = cols.length === 0
  ? await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id])
  : await db.query(
     `UPDATE atodo.accounts SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
      WHERE id = $${cols.length + 1} RETURNING *`,
     [...values, req.atodoAuth.id]
    );

 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 res.json(toUser(rows[0]));
}));

router.post('/me/change-password', asyncHandler(async (req, res) => {
 const { currentPassword, newPassword } = req.body || {};

 if (typeof newPassword !== 'string' || newPassword.length < 8) {
  return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Password must be at least 8 characters.' });
 }

 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });

 const account = rows[0];
 // Requires the current password, not just a valid bearer token -- a
 // stolen/leaked token alone shouldn't be enough to lock the real account
 // holder out by silently swapping their password (see api-spec.yaml).
 if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, account.password_hash)) {
  return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Incorrect current password.' });
 }

 // password_changed_at is embedded in every token as `pwv` (see
 // lib/atodo/token.js) and checked on every request (lib/atodo/authenticate.js)
 // -- bumping it here invalidates every token issued before this moment,
 // including whichever one is authenticating this very request; the one
 // returned below carries the new pwv, so only this session survives.
 const { rows: updated } = await db.query(
  'UPDATE atodo.accounts SET password_hash = $1, password_changed_at = now() WHERE id = $2 RETURNING *',
  [hashPassword(newPassword), account.id]
 );

 res.json({ token: issueToken(updated[0]) });
}));

router.delete('/me', asyncHandler(async (req, res) => {
 await db.query('DELETE FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 res.status(204).send();
}));

router.post('/me/schedule-deletion', asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });

 const account = rows[0];
 const hasActiveSubscription = account.subscription_plan
  && account.subscription_expires_at
  && new Date(account.subscription_expires_at).getTime() > Date.now();

 if (!hasActiveSubscription) {
  return res.status(409).json({ code: 'NO_ACTIVE_SUBSCRIPTION', message: "There's no active subscription to schedule deletion for." });
 }

 const { rows: updated } = await db.query(
  `UPDATE atodo.accounts SET subscription_cancel_at_period_end = true, subscription_scheduled_deletion = true
   WHERE id = $1 RETURNING *`,
  [account.id]
 );

 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
}));

router.delete('/me/schedule-deletion', asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });

 const account = rows[0];
 if (!account.subscription_plan) {
  return res.status(409).json({ code: 'NO_SUBSCRIPTION', message: "There's no subscription to cancel deletion for." });
 }

 // Deliberately leaves cancel_at_period_end alone -- "cancel the deletion"
 // only promises to keep the account around, not to silently resume billing.
 const { rows: updated } = await db.query(
  'UPDATE atodo.accounts SET subscription_scheduled_deletion = false WHERE id = $1 RETURNING *',
  [account.id]
 );

 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
}));

module.exports = router;
