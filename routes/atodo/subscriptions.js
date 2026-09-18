const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { toUser, issueToken } = require('../../lib/atodo/token');
const createMockCheckoutSession = require('../../lib/atodo/stripe');

const router = express.Router();

// Mounted at /atodo/v1/subscriptions behind requireAtodoAuth (see routes/atodo/index.js).

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const BILLING_DURATION_MS = { monthly: 30 * 24 * 60 * 60 * 1000, annual: 365 * 24 * 60 * 60 * 1000 };

async function activateProSubscription(accountId, billingInterval) {
 const now = new Date();
 const expiresAt = new Date(now.getTime() + BILLING_DURATION_MS[billingInterval]);

 const { rows } = await db.query(
  `UPDATE atodo.accounts SET
    subscription_id = $1, subscription_plan = 'pro', subscription_billing_interval = $2,
    subscription_started_at = $3, subscription_expires_at = $4,
    subscription_cancel_at_period_end = false, subscription_scheduled_deletion = false
   WHERE id = $5 RETURNING *`,
  [crypto.randomUUID(), billingInterval, now, expiresAt, accountId]
 );
 return rows[0];
}

router.post('/trial', asyncHandler(async (req, res) => {
 // Currently allows repeat trials (useful for testing) -- see api-spec.yaml.
 const now = new Date();
 const expiresAt = new Date(now.getTime() + TRIAL_DURATION_MS);

 const { rows } = await db.query(
  `UPDATE atodo.accounts SET
    subscription_id = $1, subscription_plan = 'trial', subscription_billing_interval = NULL,
    subscription_started_at = $2, subscription_expires_at = $3,
    subscription_cancel_at_period_end = false, subscription_scheduled_deletion = false
   WHERE id = $4 RETURNING *`,
  [crypto.randomUUID(), now, expiresAt, req.atodoAuth.id]
 );
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });

 res.json({ token: issueToken(rows[0]), user: toUser(rows[0]) });
}));

router.post('/checkout-sessions', asyncHandler(async (req, res) => {
 const { billingInterval, successUrl, cancelUrl } = req.body || {};
 if (!['monthly', 'annual'].includes(billingInterval) || typeof successUrl !== 'string' || typeof cancelUrl !== 'string') {
  return res.status(400).send('billingInterval, successUrl and cancelUrl are required');
 }

 const session = await createMockCheckoutSession({ successUrl });

 await db.query(
  `INSERT INTO atodo.checkout_sessions (id, account_id, billing_interval, status, success_url, cancel_url)
   VALUES ($1, $2, $3, 'paid', $4, $5)`,
  [session.sessionId, req.atodoAuth.id, billingInterval, successUrl, cancelUrl]
 );

 // Mock Stripe: payment always "succeeds", so the subscription is activated
 // right away instead of waiting on a webhook that will never arrive.
 await activateProSubscription(req.atodoAuth.id, billingInterval);

 res.json({ sessionId: session.sessionId, checkoutUrl: session.checkoutUrl });
}));

router.get('/checkout-sessions/:sessionId', asyncHandler(async (req, res) => {
 const { rows } = await db.query(
  'SELECT * FROM atodo.checkout_sessions WHERE id = $1 AND account_id = $2',
  [req.params.sessionId, req.atodoAuth.id]
 );
 if (rows.length === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such checkout session.' });

 const session = rows[0];
 const body = { status: session.status };

 if (session.status === 'paid') {
  const { rows: accountRows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
  if (accountRows.length > 0) {
   body.token = issueToken(accountRows[0]);
   body.user = toUser(accountRows[0]);
  }
 }

 res.json(body);
}));

router.post('/cancel', asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });

 const account = rows[0];
 const hasActiveSubscription = account.subscription_plan
  && account.subscription_expires_at
  && new Date(account.subscription_expires_at).getTime() > Date.now();

 if (!hasActiveSubscription) {
  return res.status(409).json({ code: 'NO_ACTIVE_SUBSCRIPTION', message: "There's no active subscription to cancel." });
 }

 const { rows: updated } = await db.query(
  'UPDATE atodo.accounts SET subscription_cancel_at_period_end = true WHERE id = $1 RETURNING *',
  [account.id]
 );

 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
}));

module.exports = router;
