const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const rateLimiter = require('../../lib/rateLimiter');
const requireAtodoAuth = require('../../lib/atodo/authenticate');
const { hashPassword, verifyPassword } = require('../../lib/atodo/password');
const { toUser, issueToken, toPasswordVersion } = require('../../lib/atodo/token');
const { reopenAccount } = require('../../lib/atodo/closedAccounts');
const { enforceLifecycleDeletion } = require('../../lib/atodo/lifecycle');
const jwt = require('../../lib/atodo/jwt');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../../lib/atodo/accountEmails');
const { recordAccountEvent } = require('../../lib/atodo/accountEvents');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CHECKOUT_PLANS = ['monthly', 'annual'];

// register/login are public and credential-guessing/spam-sensitive, same
// spirit as POST /contact and POST /v1/quotable -- see lib/rateLimiter.js.
router.post('/register', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { email, password, checkoutPlan } = req.body || {};

 if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
  return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
 }
 // Anything else than a known plan is just an ordinary registration.
 const plan = CHECKOUT_PLANS.includes(checkoutPlan) ? checkoutPlan : null;
 if (typeof password !== 'string' || password.length < 8) {
  return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Password must be at least 8 characters.' });
 }

 const { rows: existing } = await db.query('SELECT id FROM atodo.accounts WHERE email = $1', [email]);
 if (existing.length > 0) {
  return res.status(409).json({ code: 'EMAIL_TAKEN', message: 'An account with that email already exists.' });
 }

 const token = crypto.randomBytes(32).toString('base64url');

 // Re-registering with an email that already has a pending registration
 // just overwrites it with a fresh token/password/expiry, rather than
 // erroring -- the first link may have gone missing or expired.
 await db.query(
  `INSERT INTO atodo.pending_registrations (email, password_hash, token, created_at, expires_at, checkout_plan)
   VALUES ($1, $2, $3, now(), now() + interval '6 hours', $4)
   ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    token = EXCLUDED.token,
    created_at = now(),
    expires_at = now() + interval '6 hours',
    checkout_plan = EXCLUDED.checkout_plan`,
  [email, hashPassword(password), token, plan]
 );

 sendVerificationEmail(email, token, plan);

 res.status(202).send();
}));

router.post('/verify-email', asyncHandler(async (req, res) => {
 const { token } = req.body || {};
 if (typeof token !== 'string' || !token) {
  return res.status(400).json({ code: 'INVALID_TOKEN', message: 'That verification link is invalid or has already been used.' });
 }

 // Single-use: consumed (deleted) as soon as it's looked up, whether or not
 // it's still within its validity window, so a second visit always reports
 // INVALID_TOKEN rather than re-verifying or re-expiring.
 const { rows } = await db.query(
  'DELETE FROM atodo.pending_registrations WHERE token = $1 RETURNING email, password_hash, expires_at',
  [token]
 );
 if (rows.length === 0) {
  return res.status(400).json({ code: 'INVALID_TOKEN', message: 'That verification link is invalid or has already been used.' });
 }

 const pending = rows[0];
 if (new Date(pending.expires_at).getTime() < Date.now()) {
  return res.status(410).json({ code: 'EXPIRED', message: 'That verification link has expired. Please register again.' });
 }

 // Verifying is also the account's first login: the link proves the
 // email, and the password was set moments before -- so a visitor who came
 // to subscribe goes straight on to checkout (the link carries the plan).
 // Only when this created the account: one that already existed (a race,
 // or the email taken meanwhile) never gets a session from a link.
 const { rows: created } = await db.query(
  `INSERT INTO atodo.accounts (email, password_hash, last_login_at, last_active_at) VALUES ($1, $2, now(), now())
   ON CONFLICT (email) DO NOTHING RETURNING *`,
  [pending.email, pending.password_hash]
 );
 if (created.length === 0) return res.status(200).json({ email: pending.email });
 await recordAccountEvent(created[0].id, 'account.created');

 res.status(200).json({ email: pending.email, token: issueToken(created[0]), user: toUser(created[0]) });
}));

// ---------------------------------------------------------------------------
// Login-email changes (started by POST /users/me/change-email) and password
// resets -- public, since each is reached from an emailed link rather than
// a session. (An email change can't be undone from a link -- that could be
// abused; whoever finds their email changed without them writes to
// support, which sets it back from the admin app.)
// ---------------------------------------------------------------------------

const invalidLink = (res) =>
 res.status(400).json({ code: 'INVALID_TOKEN', message: 'That link is invalid, has expired, or has already been used.' });
const emailTaken = (res) => res.status(409).json({ code: 'EMAIL_TAKEN', message: 'An account with that email already exists.' });
const clearPendingEmailChange = (accountId) =>
 db.query(
  'UPDATE atodo.accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL WHERE id = $1',
  [accountId]
 );

// The link emailed to the NEW address: makes it the login email right away.
router.post('/verify-email-change', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { token } = req.body || {};
 if (typeof token !== 'string' || !token) {
  return res.status(400).json({ code: 'INVALID_TOKEN', message: 'That verification link is invalid or has already been used.' });
 }
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE pending_email_token = $1', [token]);
 if (rows.length === 0) {
  return res.status(400).json({ code: 'INVALID_TOKEN', message: 'That verification link is invalid or has already been used.' });
 }
 const account = rows[0];
 if (new Date(account.pending_email_expires_at).getTime() < Date.now()) {
  await clearPendingEmailChange(account.id);
  return res.status(410).json({ code: 'EXPIRED', message: 'That verification link has expired. Please request the change again.' });
 }

 const newEmail = account.pending_email;
 const { rows: taken } = await db.query('SELECT 1 FROM atodo.accounts WHERE email = $1 AND id <> $2', [newEmail, account.id]);
 if (taken.length > 0) {
  await clearPendingEmailChange(account.id);
  return emailTaken(res);
 }
 try {
  await db.query(
   `UPDATE atodo.accounts SET email = pending_email, pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
    WHERE id = $1`,
   [account.id]
  );
 } catch (err) {
  if (err.code === '23505') return emailTaken(res); // unique email -- taken between the check above and here
  throw err;
 }
 // Whoever just proved they own this inbox wins it over a stale, unverified
 // registration of the same address.
 await db.query('DELETE FROM atodo.pending_registrations WHERE email = $1', [newEmail]);
 await recordAccountEvent(account.id, 'email.changed', { from: account.email, to: newEmail });

 res.json({ email: newEmail });
}));

// "Forgot password?": emails a link to set a new password without the
// current one (lib/atodo/accountEmails.js: valid for 30 minutes, once).
// Always the same 202, whether or not the email has an account (open or
// closed), so this can't be used to find out which ones do.
router.post('/forgot-password', rateLimiter.strict, asyncHandler(async (req, res) => {
 const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim() : '';
 if (!EMAIL_RE.test(email)) {
  return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
 }
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE email = $1', [email]);
 if (rows.length > 0) sendPasswordResetEmail(rows[0]);
 res.status(202).send();
}));

// Sets a new password with a reset token -- from a "Forgot password?" link
// (POST /auth/forgot-password, or one support sent from the admin app); no
// current password needed, which is the point. Logs this session in. A
// closed (deleted) account is reopened, empty, the same way logging in to
// it does (`restored: true`); one that's due for automatic deletion is
// deleted instead, the same way a login would find it.
router.post('/reset-password', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { resetToken, newPassword } = req.body || {};
 const payload = jwt.verify(resetToken);
 if (!payload || payload.purpose !== 'password-reset' || !payload.acct) return invalidLink(res);
 if (typeof newPassword !== 'string' || newPassword.length < 8) {
  return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Password must be at least 8 characters.' });
 }
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [payload.acct]);
 // Bound to the password version it was issued for -- used once, it no
 // longer matches.
 if (rows.length === 0 || toPasswordVersion(rows[0]) !== payload.pwv) return invalidLink(res);

 let restored = false;
 if (rows[0].closed_at) {
  await reopenAccount(payload.acct);
  restored = true;
 } else {
  const deletion = await enforceLifecycleDeletion(rows[0]);
  if (deletion) return res.status(410).json(deletion);
 }

 const { rows: updated } = await db.query(
  `UPDATE atodo.accounts SET password_hash = $1, password_changed_at = now(), last_login_at = now(), last_active_at = now()
   WHERE id = $2 RETURNING *`,
  [hashPassword(newPassword), payload.acct]
 );
 if (restored) await recordAccountEvent(payload.acct, 'account.reopened', { via: 'password reset' });
 await recordAccountEvent(payload.acct, 'password.reset');
 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]), ...(restored ? { restored: true } : {}) });
}));

router.post('/login', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { email, password } = req.body || {};
 const invalidCredentials = () => res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });

 if (typeof email !== 'string' || typeof password !== 'string') return invalidCredentials();

 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE email = $1', [email]);

 if (rows.length === 0) {
  // Never reveals whether an email is registered-but-unverified vs. never
  // registered at all: only a correct password against a pending
  // registration's hash earns the more specific EMAIL_NOT_VERIFIED code.
  const { rows: pending } = await db.query('SELECT password_hash FROM atodo.pending_registrations WHERE email = $1', [email]);
  if (pending.length > 0 && verifyPassword(password, pending[0].password_hash)) {
   return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', message: "That email hasn't been verified yet." });
  }
  return invalidCredentials();
 }

 const account = rows[0];
 if (!verifyPassword(password, account.password_hash)) return invalidCredentials();

 // A closed (deleted) account, within its year: logging in reopens it,
 // empty -- see lib/atodo/closedAccounts.js. `restored` tells the client
 // to say so.
 if (account.closed_at) {
  const reopened = await reopenAccount(account.id);
  await recordAccountEvent(reopened.id, 'account.reopened', { via: 'login' });
  return res.json({ token: issueToken(reopened), user: toUser(reopened), restored: true });
 }

 const deletion = await enforceLifecycleDeletion(account);
 if (deletion) return res.status(410).json(deletion);

 await db.query('UPDATE atodo.accounts SET last_login_at = now(), last_active_at = now() WHERE id = $1', [account.id]);

 res.json({ token: issueToken(account), user: toUser(account) });
}));

router.get('/me', requireAtodoAuth, asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) {
  return res.status(410).json({ code: 'ACCOUNT_NOT_FOUND', message: 'This account no longer exists.' });
 }

 const account = rows[0];
 const deletion = await enforceLifecycleDeletion(account);
 if (deletion) return res.status(410).json(deletion);

 await db.query('UPDATE atodo.accounts SET last_active_at = now() WHERE id = $1', [account.id]);

 res.json(toUser(account));
}));

module.exports = router;
