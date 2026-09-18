const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const rateLimiter = require('../../lib/rateLimiter');
const requireAtodoAuth = require('../../lib/atodo/authenticate');
const { hashPassword, verifyPassword } = require('../../lib/atodo/password');
const { toUser, issueToken } = require('../../lib/atodo/token');
const { enforceLifecycleDeletion } = require('../../lib/atodo/lifecycle');
const sendEmail = require('../../lib/atodo/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The frontend's own reachable base URL (see platform-integration/
// config.template) -- deployment-configured, not client-supplied, so a
// registration request can't point the emailed link at an arbitrary
// attacker-controlled domain. handleEmailVerificationLink() in the atodo
// client reads a `verify` query param off exactly this URL.
function buildVerificationLink(token) {
 const link = new URL(process.env.ATODO_FRONTEND_BASE_URL);
 link.searchParams.set('verify', token);
 return link.toString();
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
