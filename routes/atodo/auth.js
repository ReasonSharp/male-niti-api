const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const rateLimiter = require('../../lib/rateLimiter');
const requireAtodoAuth = require('../../lib/atodo/authenticate');
const { hashPassword, verifyPassword } = require('../../lib/atodo/password');
const { toUser, issueToken, toPasswordVersion } = require('../../lib/atodo/token');
const { enforceLifecycleDeletion } = require('../../lib/atodo/lifecycle');
const sendEmail = require('../../lib/atodo/mailer');
const jwt = require('../../lib/atodo/jwt');
const { buildFrontendLink } = require('../../lib/atodo/links');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// handleEmailVerificationLink() in the atodo client reads this `verify`
// param -- see lib/atodo/links.js.
function buildVerificationLink(token) {
 return buildFrontendLink('verify', token);
}

// register/login are public and credential-guessing/spam-sensitive, same
// spirit as POST /contact and POST /v1/quotable -- see lib/rateLimiter.js.
router.post('/register', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { email, password } = req.body || {};

 if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
  return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
 }
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
  `INSERT INTO atodo.pending_registrations (email, password_hash, token, created_at, expires_at)
   VALUES ($1, $2, $3, now(), now() + interval '6 hours')
   ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    token = EXCLUDED.token,
    created_at = now(),
    expires_at = now() + interval '6 hours'`,
  [email, hashPassword(password), token]
 );

 const verificationLink = buildVerificationLink(token);
 sendEmail(
  email,
  'Verify your A-To-Do account',
  `Welcome! Confirm your email to activate your A-To-Do account.\n\n`
  + `Open this link within 6 hours:\n${verificationLink}\n\n`
  + `If your email client doesn't show clickable links, copy and paste the URL above into your browser.`,
  `<p>Welcome! Confirm your email to activate your A-To-Do account.</p>`
  + `<p><a href="${verificationLink}">Verify your email</a></p>`
  + `<p>If the button above doesn't work, copy and paste this URL into your browser:</p>`
  + `<p>${verificationLink}</p>`
 );

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

 await db.query(
  'INSERT INTO atodo.accounts (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
  [pending.email, pending.password_hash]
 );

 res.status(200).json({ email: pending.email });
}));

// ---------------------------------------------------------------------------
// Login-email changes (started by POST /users/me/change-email) -- all three
// public, since each is reached from an emailed link rather than a session.
// ---------------------------------------------------------------------------

const PASSWORD_RESET_TTL_SECONDS = 60 * 60;
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

 res.json({ email: newEmail });
}));

// The link emailed to the OLD address. See atodo-api-spec.yaml: restores it,
// cancels any pending change, ends every session, and hands back a
// short-lived password-reset token (bound to the new password version, so
// single-use).
router.post('/undo-email-change', rateLimiter.strict, asyncHandler(async (req, res) => {
 const payload = jwt.verify((req.body || {}).token);
 if (!payload || payload.purpose !== 'email-change-undo' || !payload.acct) return invalidLink(res);

 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [payload.acct]);
 if (rows.length === 0) return invalidLink(res);
 const account = rows[0];
 // Only the latest change request's link, and only once -- an undo (or a
 // newer request) moves email_change_requested_at on.
 const requestedAt = account.email_change_requested_at ? new Date(account.email_change_requested_at).getTime() : null;
 if (requestedAt !== payload.req) return invalidLink(res);

 if (account.email !== payload.oldEmail) {
  const { rows: taken } = await db.query('SELECT 1 FROM atodo.accounts WHERE email = $1 AND id <> $2', [payload.oldEmail, account.id]);
  if (taken.length > 0) return emailTaken(res);
 }
 let restored;
 try {
  ({ rows: [restored] } = await db.query(
   `UPDATE atodo.accounts SET
     email = $1,
     pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL,
     email_change_requested_at = NULL,
     password_changed_at = now()
    WHERE id = $2 RETURNING *`,
   [payload.oldEmail, account.id]
  ));
 } catch (err) {
  if (err.code === '23505') return emailTaken(res);
  throw err;
 }

 const resetToken = jwt.sign({ purpose: 'password-reset', acct: account.id, pwv: toPasswordVersion(restored) }, PASSWORD_RESET_TTL_SECONDS);
 sendEmail(
  payload.oldEmail,
  'Your A-To-Do login email change was undone',
  `Your A-To-Do login email is ${payload.oldEmail} again, and every session has been signed out.\n\n`
  + `If you didn't finish setting a new password right after undoing the change, do it now -- `
  + `whoever changed your email may know your current one.`,
  `<p>Your A-To-Do login email is ${payload.oldEmail} again, and every session has been signed out.</p>`
  + `<p>If you didn't finish setting a new password right after undoing the change, do it now -- `
  + `whoever changed your email may know your current one.</p>`
 );

 res.json({ email: payload.oldEmail, resetToken });
}));

// Sets a new password with the reset token /undo-email-change handed out --
// no current password needed, which is the point. Logs this session in.
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

 const { rows: updated } = await db.query(
  `UPDATE atodo.accounts SET password_hash = $1, password_changed_at = now(), last_login_at = now(), last_active_at = now()
   WHERE id = $2 RETURNING *`,
  [hashPassword(newPassword), payload.acct]
 );
 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
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
