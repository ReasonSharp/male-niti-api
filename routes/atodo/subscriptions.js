const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { toUser, issueToken } = require('../../lib/atodo/token');
const { getStripe } = require('../../lib/atodo/stripe');
const { brandPricesAt, brandIdFor, pointOfSaleIdFor } = require('../../lib/maleniti/prices');
const { paymentsStatus } = require('../../lib/atodo/payments');
const { confirmCheckoutSession } = require('../../lib/atodo/billing');
const { createPortalSession } = require('../../lib/atodo/portal');

const router = express.Router();

// Mounted at /atodo/v1/subscriptions behind requireAtodoAuth (see routes/atodo/index.js).

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

// What checkout sells for a billing interval: the subscription product of
// the brand ATODO_BRAND names (maleniti.brand.code; the product whose
// billing_interval matches, with its stripe_product_id) at its price right
// now at the point of sale FISCAL_PREMISES names, from the published price
// list -- the same price the website shows (lib/maleniti/prices.js). Null
// with a reason when something's missing, which refuses checkout.
const STRIPE_INTERVAL = { monthly: 'month', annual: 'year' };

async function checkoutOffer(billingInterval) {
 const brandId = await brandIdFor(process.env.ATODO_BRAND || '');
 if (brandId === null) return { reason: `no brand '${process.env.ATODO_BRAND || ''}' (ATODO_BRAND)` };
 const pointOfSaleId = await pointOfSaleIdFor(process.env.FISCAL_PREMISES || '');
 if (pointOfSaleId === null) return { reason: `no point of sale '${process.env.FISCAL_PREMISES || ''}' (FISCAL_PREMISES)` };
 const { products } = await brandPricesAt({ brandId, pointOfSaleId });
 const product = products.find((p) => p.billing_interval === STRIPE_INTERVAL[billingInterval]);
 if (!product) return { reason: `no ${billingInterval} product with a price at ${process.env.FISCAL_PREMISES}` };
 if (!product.stripe_product_id) return { reason: `product ${product.code} has no stripe_product_id` };
 if (!(product.price_eur > 0)) return { reason: `product ${product.code} has no price to charge` };
 return { product };
}

// Croatian law (Odluka o isticanju dodatne cijene, NN 101/2026) wants every
// price shown to consumers accompanied by its anchor price (the client's
// anchor-prices.js shows it on its own pages). Stripe's Checkout page shows
// the price too, so the anchor goes into its custom text above the Pay
// button -- in both languages, since Checkout picks its own from the
// browser.
function anchorPriceText({ anchor_eur: anchor, billing_interval: interval }) {
 const hr = `${anchor.toFixed(2).replace('.', ',')} € ${interval === 'year' ? 'godišnje' : 'mjesečno'}`;
 const en = `€${anchor.toFixed(2)} per ${interval}`;
 return `Sidrena cijena / Anchor price: ${hr} / ${en}. Istaknuta u skladu s hrvatskim zakonom. / Shown in accordance with Croatian law.`;
}

// One trial per account, and only for an account that has never had any
// plan: not after a trial (running or lapsed), and not after a paid
// subscription, even a cancelled/expired one -- those subscribe again
// through checkout. subscription_plan is never reset to NULL once set, so
// "still NULL" is exactly "never had one"; checked in the UPDATE itself so
// concurrent requests can't both start a trial. trial_ineligible extends
// that across closing (deleting) and reopening the account (see
// lib/atodo/closedAccounts.js).
router.post('/trial', asyncHandler(async (req, res) => {
 const now = new Date();
 const expiresAt = new Date(now.getTime() + TRIAL_DURATION_MS);

 const { rows } = await db.query(
  `UPDATE atodo.accounts SET
    subscription_id = $1, subscription_plan = 'trial', subscription_billing_interval = NULL,
    subscription_started_at = $2, subscription_expires_at = $3,
    subscription_cancel_at_period_end = false, subscription_scheduled_deletion = false
   WHERE id = $4 AND subscription_plan IS NULL AND NOT trial_ineligible RETURNING *`,
  [crypto.randomUUID(), now, expiresAt, req.atodoAuth.id]
 );
 if (rows.length === 0) {
  const { rows: existing } = await db.query('SELECT 1 FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
  if (existing.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
  return res.status(409).json({ code: 'TRIAL_UNAVAILABLE', message: 'This account has already had a trial or a subscription.' });
 }

 res.json({ token: issueToken(rows[0]), user: toUser(rows[0]) });
}));

// A real Stripe Checkout Session in subscription mode (recurring monthly or
// yearly price). Nothing is activated here: the subscription starts when
// Stripe reports the payment (webhook, or the status poll's fallback -- see
// lib/atodo/billing.js), which is also when its receipt gets fiscalized.
//
// Refused outright -- before anything is created in Stripe -- unless payments
// are possible at all, i.e. Stripe is configured AND fiscalization has a
// usable certificate: no payment may be taken that can't be fiscalized.
router.post('/checkout-sessions', asyncHandler(async (req, res) => {
 const { billingInterval, successUrl, cancelUrl } = req.body || {};
 if (!['monthly', 'annual'].includes(billingInterval) || typeof successUrl !== 'string' || typeof cancelUrl !== 'string') {
  return res.status(400).send('billingInterval, successUrl and cancelUrl are required');
 }
 const status = paymentsStatus();
 if (!status.ok) {
  console.error(`[atodo billing] checkout refused: ${status.reason}`);
  return res.status(503).json({ code: 'PAYMENTS_UNAVAILABLE', message: 'Payments are temporarily unavailable.' });
 }

 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 const account = rows[0];
 // A paid-up subscription, cancelled or not, refuses a second one: it would
 // charge again for time already paid for. A cancelled one is resumed
 // instead (POST /subscriptions/resume), which charges nothing until its
 // period ends.
 const hasActivePro = account.subscription_plan === 'pro'
  && account.stripe_subscription_id
  && new Date(account.subscription_expires_at).getTime() > Date.now();
 if (hasActivePro && account.subscription_cancel_at_period_end) {
  return res.status(409).json({ code: 'SUBSCRIPTION_CANCELLING', message: 'This account has a cancelled subscription that is still active - resume it instead.' });
 }
 if (hasActivePro) {
  return res.status(409).json({ code: 'ALREADY_SUBSCRIBED', message: 'This account already has an active subscription.' });
 }

 const offer = await checkoutOffer(billingInterval);
 if (!offer.product) {
  console.error(`[atodo billing] checkout refused: ${offer.reason}`);
  return res.status(503).json({ code: 'PAYMENTS_UNAVAILABLE', message: 'Payments are temporarily unavailable.' });
 }
 const { product } = offer;

 const stripe = getStripe();
 let customerId = account.stripe_customer_id;
 if (!customerId) {
  const customer = await stripe.customers.create({ email: account.email, metadata: { accountId: account.id } });
  customerId = customer.id;
  await db.query('UPDATE atodo.accounts SET stripe_customer_id = $1 WHERE id = $2', [customerId, account.id]);
 }

 const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: customerId,
  client_reference_id: account.id,
  // The price list's price, not a fixed Stripe Price: a price change in
  // the admin app reaches new subscriptions from the moment it takes
  // effect. (Existing subscriptions keep the price they were sold at.)
  line_items: [{
   price_data: {
    currency: 'eur',
    product: product.stripe_product_id,
    unit_amount: Math.round(product.price_eur * 100),
    recurring: { interval: product.billing_interval },
   },
   quantity: 1,
  }],
  // We are the seller (B2C only, outside the VAT system, fiscalizing every
  // payment ourselves) -- so none of the account-level defaults that would
  // change that apply, whatever the Dashboard says:
  //  - no Managed Payments (Stripe as merchant of record, collecting VAT);
  //  - no automatic tax: prices are final, VAT isn't charged;
  //  - no tax ID collection -- that's Checkout's "I'm purchasing as a
  //    business" checkbox; selling to businesses would mean e-invoices;
  //  - no adaptive pricing: charged in EUR, as the receipts are;
  //  - cards only, since receipts state card payment (NacinPlac K).
  managed_payments: { enabled: false },
  automatic_tax: { enabled: false },
  tax_id_collection: { enabled: false },
  adaptive_pricing: { enabled: false },
  payment_method_types: ['card'],
  subscription_data: {
   metadata: { accountId: account.id },
   // Stripe's recommended mode for new subscriptions: accurate prorations
   // and billing-period handling (not that the plan can be switched -- see
   // the portal configuration in lib/atodo/portal.js).
   billing_mode: { type: 'flexible' },
  },
  custom_text: { submit: { message: anchorPriceText(product.anchor_eur === null ? { ...product, anchor_eur: product.price_eur } : product) } },
  // successUrl carries Stripe's own {CHECKOUT_SESSION_ID} placeholder (see
  // the client's checkout.js), which it fills in on the way back.
  success_url: successUrl,
  cancel_url: cancelUrl,
 });

 await db.query(
  `INSERT INTO atodo.checkout_sessions (id, account_id, billing_interval, status, success_url, cancel_url)
   VALUES ($1, $2, $3, 'pending', $4, $5)`,
  [session.id, account.id, billingInterval, successUrl, cancelUrl]
 );

 res.json({ sessionId: session.id, checkoutUrl: session.url });
}));

router.get('/checkout-sessions/:sessionId', asyncHandler(async (req, res) => {
 const load = async () =>
  (await db.query('SELECT * FROM atodo.checkout_sessions WHERE id = $1 AND account_id = $2', [req.params.sessionId, req.atodoAuth.id])).rows[0];
 let session = await load();
 if (!session) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such checkout session.' });

 // Webhook not here yet? Ask Stripe directly (see confirmCheckoutSession).
 if (session.status === 'pending' && getStripe()) {
  try {
   await confirmCheckoutSession(session.id);
   session = await load();
  } catch (err) {
   console.error(`[atodo billing] checking checkout session ${session.id} failed: ${err.message}`);
  }
 }

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

// A Stripe Customer Portal session ("Manage billing"): the customer's card,
// and cancelling -- see lib/atodo/portal.js for what else is (not) allowed
// there. Only for an account that has ever been through Checkout (i.e. has a
// Stripe customer), and only while payments are possible at all -- a new
// card can settle an overdue renewal on the spot, and that payment has to be
// fiscalizable like any other.
router.post('/portal-session', asyncHandler(async (req, res) => {
 const { returnUrl } = req.body || {};
 if (typeof returnUrl !== 'string') return res.status(400).send('returnUrl is required');
 const status = paymentsStatus();
 if (!status.ok) {
  console.error(`[atodo billing] billing portal refused: ${status.reason}`);
  return res.status(503).json({ code: 'PAYMENTS_UNAVAILABLE', message: 'Payments are temporarily unavailable.' });
 }
 const { rows } = await db.query('SELECT stripe_customer_id FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 if (!rows[0].stripe_customer_id) {
  return res.status(409).json({ code: 'NO_BILLING_ACCOUNT', message: 'This account has never subscribed, so there is no billing to manage.' });
 }
 const session = await createPortalSession(rows[0].stripe_customer_id, returnUrl);
 res.json({ url: session.url });
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

 // A paid subscription stops renewing in Stripe itself -- the account keeps
 // Pro until the period it already paid for ends.
 if (account.stripe_subscription_id && getStripe()) {
  await getStripe().subscriptions.update(account.stripe_subscription_id, { cancel_at_period_end: true });
 }

 const { rows: updated } = await db.query(
  'UPDATE atodo.accounts SET subscription_cancel_at_period_end = true WHERE id = $1 RETURNING *',
  [account.id]
 );

 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
}));

// Undoes a cancellation while the paid period is still running: the
// subscription renews again at its end, as if never cancelled -- nothing is
// charged now. Resuming also keeps the account (a scheduled deletion,
// which cancelled the subscription in the first place, is called off), since
// renewing an account due for deletion makes no sense.
router.post('/resume', asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [req.atodoAuth.id]);
 if (rows.length === 0) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 const account = rows[0];
 const resumable = account.subscription_plan === 'pro'
  && account.stripe_subscription_id
  && account.subscription_cancel_at_period_end
  && new Date(account.subscription_expires_at).getTime() > Date.now();
 if (!resumable) {
  return res.status(409).json({ code: 'NO_CANCELLED_SUBSCRIPTION', message: "There's no cancelled, still-active subscription to resume." });
 }
 const stripe = getStripe();
 if (!stripe) return res.status(503).json({ code: 'PAYMENTS_UNAVAILABLE', message: 'Payments are temporarily unavailable.' });

 // Cancelled either way Stripe knows: at the period end (our own cancel,
 // the Customer Portal) or at a set moment (cancel_at) -- each undone its
 // own way.
 const sub = await stripe.subscriptions.retrieve(account.stripe_subscription_id);
 if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
  return res.status(409).json({ code: 'NO_CANCELLED_SUBSCRIPTION', message: 'This subscription has already ended.' });
 }
 if (sub.cancel_at_period_end) await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
 else if (sub.cancel_at) await stripe.subscriptions.update(sub.id, { cancel_at: '' });

 const { rows: updated } = await db.query(
  `UPDATE atodo.accounts SET subscription_cancel_at_period_end = false, subscription_scheduled_deletion = false
   WHERE id = $1 RETURNING *`,
  [account.id]
 );
 res.json({ token: issueToken(updated[0]), user: toUser(updated[0]) });
}));

module.exports = router;
