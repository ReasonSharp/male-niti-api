const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { toUser, issueToken } = require('../../lib/atodo/token');
const { hashPassword, verifyPassword } = require('../../lib/atodo/password');
const crypto = require('crypto');
const rateLimiter = require('../../lib/rateLimiter');
const jwt = require('../../lib/atodo/jwt');
const sendEmail = require('../../lib/atodo/mailer');
const { buildFrontendLink } = require('../../lib/atodo/links');

// Same check as routes/atodo/auth.js's registration.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNDO_EMAIL_CHANGE_TTL_SECONDS = 30 * 24 * 60 * 60;

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

// Starts a login-email change -- see atodo-api-spec.yaml. Nothing about the
// login email itself changes here: the new address has to be verified first
// (POST /auth/verify-email-change), and the old one gets an undo link (POST
// /auth/undo-email-change) whose signed token pins exactly this request via
// email_change_requested_at.
router.post('/me/change-email', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { newEmail, currentPassword } = req.body || {};
 const email = typeof newEmail === 'string' ? newEmail.trim() : '';
 if (!EMAIL_RE.test(email)) {
  return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
 }

 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 const account = rows[0];
 if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, account.password_hash)) {
  return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Incorrect current password.' });
 }
 if (email === account.email) {
  return res.status(400).json({ code: 'SAME_EMAIL', message: 'That is already your login email.' });
 }
 const { rows: taken } = await db.query(
  `SELECT 1 FROM atodo.accounts WHERE email = $1 AND id <> $2
   UNION ALL SELECT 1 FROM atodo.pending_registrations WHERE email = $1`,
  [email, account.id]
 );
 if (taken.length > 0) {
  return res.status(409).json({ code: 'EMAIL_TAKEN', message: 'An account with that email already exists.' });
 }

 const verifyToken = crypto.randomBytes(32).toString('base64url');
 const requestedAt = new Date();
 const { rows: updated } = await db.query(
  `UPDATE atodo.accounts SET
    pending_email = $1,
    pending_email_token = $2,
    pending_email_expires_at = now() + interval '6 hours',
    email_change_requested_at = $3
   WHERE id = $4 RETURNING *`,
  [email, verifyToken, requestedAt, account.id]
 );

 // Signed, not stored: everything the undo needs travels in the token
 // itself. `purpose` (and no `sub`) keeps it from ever passing as a session
 // token -- see lib/atodo/authenticate.js.
 const undoToken = jwt.sign(
  { purpose: 'email-change-undo', acct: account.id, oldEmail: account.email, newEmail: email, req: requestedAt.getTime() },
  UNDO_EMAIL_CHANGE_TTL_SECONDS
 );
 const verifyLink = buildFrontendLink('verifyEmailChange', verifyToken);
 const undoLink = buildFrontendLink('undoEmailChange', undoToken);

 sendEmail(
  email,
  'Confirm your new A-To-Do login email',
  `Your A-To-Do login email is being changed to this address.\n\n`
  + `Open this link within 6 hours to confirm it -- from then on, log in with this address:\n${verifyLink}\n\n`
  + `If you didn't ask for this, just ignore this email.`,
  `<p>Your A-To-Do login email is being changed to this address.</p>`
  + `<p><a href="${verifyLink}">Confirm this email</a> (within 6 hours) -- from then on, log in with this address.</p>`
  + `<p>If you didn't ask for this, just ignore this email.</p><p>${verifyLink}</p>`
 );
 sendEmail(
  account.email,
  'Your A-To-Do login email is being changed',
  `Someone asked to change your A-To-Do login email from ${account.email} to ${email}.\n\n`
  + `If that was you, there's nothing to do. If it wasn't, undo the change right away with this link `
  + `(valid for 30 days) -- it restores this address and has you set a new password:\n${undoLink}`,
  `<p>Someone asked to change your A-To-Do login email from ${account.email} to ${email}.</p>`
  + `<p>If that was you, there's nothing to do. If it wasn't, <a href="${undoLink}">undo the change</a> right away `
  + `(valid for 30 days) -- it restores this address and has you set a new password.</p><p>${undoLink}</p>`
 );

 res.json(toUser(updated[0]));
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
