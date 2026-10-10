const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const { adminHandler, HttpError } = require('../../lib/maleniti/adminResource');
const { sendVerificationEmail, sendPasswordResetEmail, sendEmailSetBySupportNotices } = require('../../lib/atodo/accountEmails');
const { recordAccountEvent } = require('../../lib/atodo/accountEvents');

// /maleniti/v1/admin/atodo -- A-To-Do's user administration, for the admin
// app's "A-To-Do users" tab (super admin only, like the rest of /admin).
//
//   GET  /accounts?q=&status=&plan=&subscription=&paid=&deletion=&sort=&limit=&offset=
//        every account -- open, closed, and registrations not verified yet
//        -- searched and filtered, newest first (or by last login)
//   GET  /accounts/:id                         one account in full: its
//        subscription, payments, recent events, Stripe links
//   POST /registrations/resend-activation      { email } -- a fresh
//        activation link (6 hours) to a registration not verified yet
//   POST /accounts/:id/password-reset          a password-reset link (30
//        minutes, once), as "Forgot password?" sends
//   POST /accounts/:id/email                   { email } -- sets the login
//        email at once (for someone support verified another way, e.g. whose
//        email was changed without them); both addresses are told
//
// Support's actions are recorded on the account (atodo.account_events) with
// the admin key's label.

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_MAX = 200;

// Where an account's customer and subscription are in the Stripe
// Dashboard -- test or live, as the API's own key is.
function stripeDashboardBase() {
 const key = process.env.STRIPE_SECRET_KEY || '';
 if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'https://dashboard.stripe.com';
 if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'https://dashboard.stripe.com/test';
 return null;
}

// Accounts and pending registrations as one list. A sale receipt that isn't
// a storno and charged something counts as a payment.
const PEOPLE = `
 SELECT a.id::text AS id, 'account' AS kind, a.email, a.nickname,
        CASE WHEN a.closed_at IS NULL THEN 'active' ELSE 'closed' END AS status,
        a.created_at, a.last_login_at, a.last_active_at, a.closed_at, a.pending_email,
        a.subscription_plan, a.subscription_billing_interval, a.subscription_expires_at,
        a.subscription_cancel_at_period_end, a.subscription_scheduled_deletion,
        (a.trial_ineligible OR a.subscription_plan IS NOT NULL) AS trial_used,
        (SELECT count(*)::int FROM atodo.fiscal_receipts r
         WHERE r.account_id = a.id AND r.original_receipt_id IS NULL AND r.total_cents > 0) AS payments,
        NULL::timestamptz AS activation_expires_at
 FROM atodo.accounts a
 UNION ALL
 SELECT p.email, 'registration', p.email, '', 'unverified',
        p.created_at, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL,
        NULL, 0,
        p.expires_at
 FROM atodo.pending_registrations p`;

const SORTS = {
 created: 'created_at DESC',
 login: 'last_login_at DESC NULLS LAST, created_at DESC',
 email: 'email ASC',
};

router.get('/accounts', adminHandler(async (req, res) => {
 const where = [];
 const params = [];
 const param = (value) => {
  params.push(value);
  return `$${params.length}`;
 };
 const q = String(req.query.q || '').trim();
 if (q) {
  const like = param(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  where.push(`(email ILIKE ${like} OR nickname ILIKE ${like} OR pending_email ILIKE ${like} OR id = ${param(q)})`);
 }
 const { status, plan, subscription } = req.query;
 if (['active', 'closed', 'unverified'].includes(status)) where.push(`status = ${param(status)}`);
 if (plan === 'free') where.push("kind = 'account' AND subscription_plan IS NULL");
 else if (['trial', 'pro'].includes(plan)) where.push(`subscription_plan = ${param(plan)}`);
 if (subscription === 'active') where.push('subscription_expires_at > now() AND NOT subscription_cancel_at_period_end');
 else if (subscription === 'cancelling') where.push('subscription_expires_at > now() AND subscription_cancel_at_period_end');
 else if (subscription === 'lapsed') where.push('subscription_expires_at <= now()');
 if (req.query.paid === '1') where.push('payments > 0');
 if (req.query.deletion === '1') where.push('subscription_scheduled_deletion');
 const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || 50));
 const offset = Math.max(0, Number(req.query.offset) || 0);
 const order = SORTS[req.query.sort] || SORTS.created;
 const { rows } = await db.query(
  `SELECT people.*, count(*) OVER ()::int AS total FROM (${PEOPLE}) people
   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
   ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
  params
 );
 res.json({
  total: rows.length ? rows[0].total : 0,
  accounts: rows.map(({ total, ...row }) => row),
  stripeDashboard: stripeDashboardBase(),
 });
}));

const ACCOUNT_COLUMNS = `id, email, nickname, language, created_at, last_login_at, last_active_at, closed_at,
 password_changed_at, pending_email, pending_email_expires_at, email_change_requested_at,
 stripe_customer_id, stripe_subscription_id,
 subscription_plan, subscription_billing_interval, subscription_started_at, subscription_expires_at,
 subscription_cancel_at_period_end, subscription_scheduled_deletion, trial_ineligible`;

async function findAccount(id) {
 if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'No such account.');
 const { rows: [account] } = await db.query(`SELECT ${ACCOUNT_COLUMNS} FROM atodo.accounts WHERE id = $1`, [id]);
 if (!account) throw new HttpError(404, 'No such account.');
 return account;
}

router.get('/accounts/:id', adminHandler(async (req, res) => {
 const account = await findAccount(req.params.id);
 const [{ rows: events }, { rows: receipts }, { rows: [counts] }] = await Promise.all([
  db.query('SELECT at, kind, details FROM atodo.account_events WHERE account_id = $1 ORDER BY at DESC, event_id DESC LIMIT 200', [account.id]),
  db.query(
   `SELECT issued_at, year, number, premises, device, description, total_cents, status, original_receipt_id IS NOT NULL AS storno
    FROM atodo.fiscal_receipts WHERE account_id = $1 ORDER BY issued_at DESC`,
   [account.id]
  ),
  db.query(
   `SELECT (SELECT count(*)::int FROM atodo.tasks WHERE account_id = $1) AS tasks,
           (SELECT count(*)::int FROM atodo.occurrences WHERE account_id = $1) AS occurrences`,
   [account.id]
  ),
 ]);
 const base = stripeDashboardBase();
 const pendingEmailValid = account.pending_email && account.pending_email_expires_at && new Date(account.pending_email_expires_at) > new Date();
 res.json({
  ...account,
  pending_email: pendingEmailValid ? account.pending_email : null,
  trial_used: account.trial_ineligible || account.subscription_plan != null,
  payments: receipts.filter((r) => !r.storno && r.total_cents > 0).length,
  receipts,
  events,
  counts,
  stripe: {
   customerUrl: base && account.stripe_customer_id ? `${base}/customers/${account.stripe_customer_id}` : null,
   subscriptionUrl: base && account.stripe_subscription_id ? `${base}/subscriptions/${account.stripe_subscription_id}` : null,
  },
 });
}));

router.post('/registrations/resend-activation', adminHandler(async (req, res) => {
 const email = String((req.body || {}).email || '').trim();
 const token = crypto.randomBytes(32).toString('base64url');
 const { rows: [pending] } = await db.query(
  `UPDATE atodo.pending_registrations SET token = $2, expires_at = now() + interval '6 hours'
   WHERE email = $1 RETURNING email, checkout_plan, expires_at`,
  [email, token]
 );
 if (!pending) throw new HttpError(404, 'No registration waiting for activation with that email.');
 sendVerificationEmail(pending.email, token, pending.checkout_plan);
 res.json({ email: pending.email, expires_at: pending.expires_at });
}));

router.post('/accounts/:id/password-reset', adminHandler(async (req, res) => {
 const account = await findAccount(req.params.id);
 const { rows: [full] } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [account.id]);
 sendPasswordResetEmail(full);
 await recordAccountEvent(account.id, 'password.reset_sent_by_support', { by: req.auth && req.auth.label });
 res.json({ email: account.email });
}));

router.post('/accounts/:id/email', adminHandler(async (req, res) => {
 const account = await findAccount(req.params.id);
 if (account.closed_at) throw new HttpError(409, "A closed account's email can't be changed (logging in reopens it).");
 const email = String((req.body || {}).email || '').trim();
 if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
 if (email === account.email) throw new HttpError(400, 'That is already its login email.');
 const { rows: taken } = await db.query(
  `SELECT 'account' AS what FROM atodo.accounts WHERE lower(email) = lower($1) AND id <> $2
   UNION ALL SELECT 'registration' FROM atodo.pending_registrations WHERE lower(email) = lower($1)`,
  [email, account.id]
 );
 if (taken.length) {
  throw new HttpError(409, taken[0].what === 'account'
   ? 'Another account (open or closed) already has that email.'
   : 'A registration waiting for activation already has that email.');
 }
 try {
  await db.query(
   `UPDATE atodo.accounts SET email = $1, pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
    WHERE id = $2`,
   [email, account.id]
  );
 } catch (err) {
  if (err.code === '23505') throw new HttpError(409, 'Another account already has that email.');
  throw err;
 }
 await recordAccountEvent(account.id, 'email.set_by_support', { from: account.email, to: email, by: req.auth && req.auth.label });
 sendEmailSetBySupportNotices(account.email, email);
 res.json({ email });
}));

module.exports = router;
