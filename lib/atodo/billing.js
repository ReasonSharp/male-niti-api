const db = require('../../db');
const { getStripe } = require('./stripe');
const { getFiscalConfig } = require('./payments');
const { issueReceipt } = require('./fiscal/receipts');

// Keeping atodo.accounts in step with Stripe, and fiscalizing every payment.
// Driven by the webhook (routes/atodo/stripeWebhook.js) and, as a fallback
// for a webhook that hasn't arrived yet (or local development without one),
// by a returning checkout's status poll (confirmCheckoutSession). Every
// handler is idempotent -- Stripe re-delivers events, and the two paths can
// report the same payment.
//
// Field locations follow Stripe API 2026-08-26 (the stripe package's
// default): the billing period lives on subscription items, and an invoice's
// subscription under parent.subscription_details. Older locations are read as
// fallbacks.

const INTERVALS = { month: 'monthly', year: 'annual' };
const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

const firstItem = (sub) => (sub.items && sub.items.data && sub.items.data[0]) || null;
const periodEnd = (sub) => (firstItem(sub) && firstItem(sub).current_period_end) || sub.current_period_end;
const billingInterval = (sub) => {
 const price = firstItem(sub) && firstItem(sub).price;
 return INTERVALS[price && price.recurring && price.recurring.interval] || null;
};
const invoiceSubscriptionId = (invoice) =>
 idOf(invoice.subscription) || idOf(invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);

async function findAccount({ accountId, customerId }) {
 if (accountId) {
  const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE id = $1', [accountId]);
  if (rows.length) return rows[0];
 }
 if (customerId) {
  const { rows } = await db.query('SELECT * FROM atodo.accounts WHERE stripe_customer_id = $1', [customerId]);
  if (rows.length) return rows[0];
 }
 return null;
}

// Mirrors a Stripe subscription onto its account. An 'incomplete'
// subscription (first payment not through yet) changes nothing.
async function syncSubscription(sub) {
 const account = await findAccount({ accountId: sub.metadata && sub.metadata.accountId, customerId: idOf(sub.customer) });
 if (!account) {
  console.error(`[atodo billing] no account for Stripe subscription ${sub.id}`);
  return null;
 }
 if (['active', 'trialing', 'past_due'].includes(sub.status)) {
  const { rows } = await db.query(
   `UPDATE atodo.accounts SET
     subscription_id = CASE WHEN stripe_subscription_id = $1 AND subscription_id IS NOT NULL THEN subscription_id ELSE gen_random_uuid() END,
     stripe_subscription_id = $1,
     stripe_customer_id = $2,
     subscription_plan = 'pro',
     subscription_billing_interval = $3,
     subscription_started_at = to_timestamp($4),
     subscription_expires_at = to_timestamp($5),
     subscription_cancel_at_period_end = $6
    WHERE id = $7 RETURNING *`,
   [sub.id, idOf(sub.customer), billingInterval(sub) || 'monthly', sub.start_date, periodEnd(sub), !!(sub.cancel_at_period_end || sub.cancel_at), account.id]
  );
  return rows[0];
 }
 if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status) && account.stripe_subscription_id === sub.id) {
  const endedAt = sub.ended_at || Math.floor(Date.now() / 1000);
  const { rows } = await db.query(
   `UPDATE atodo.accounts SET
     subscription_expires_at = LEAST(subscription_expires_at, to_timestamp($1)),
     subscription_cancel_at_period_end = false
    WHERE id = $2 RETURNING *`,
   [endedAt, account.id]
  );
  return rows[0];
 }
 return account;
}

const formatDate = (unixSeconds) =>
 new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(unixSeconds * 1000));

// A paid invoice -- the first payment or any renewal: extends the
// subscription, then issues (and fiscalizes, and emails) its receipt. Throws
// if fiscalization isn't configured, so the webhook answers 5xx and Stripe
// re-delivers the event later rather than it being lost.
async function handleInvoicePaid(invoice) {
 const subscriptionId = invoiceSubscriptionId(invoice);
 if (!subscriptionId) return;
 const sub = await getStripe().subscriptions.retrieve(subscriptionId);
 const account = await syncSubscription(sub);
 if (!invoice.amount_paid) return; // nothing was charged (e.g. a 100% discount) -- nothing to fiscalize
 if (invoice.currency !== 'eur') throw new Error(`invoice ${invoice.id} is in ${invoice.currency}, not EUR -- can't be fiscalized`);
 const config = getFiscalConfig();
 if (!config) throw new Error(`invoice ${invoice.id} paid, but fiscalization isn't configured -- will be retried`);

 const line = invoice.lines && invoice.lines.data && invoice.lines.data[0];
 const interval = billingInterval(sub);
 const period = line && line.period ? ` (${formatDate(line.period.start)} – ${formatDate(line.period.end)})` : '';
 await issueReceipt(config, {
  accountId: account ? account.id : null,
  customerEmail: (account && account.email) || invoice.customer_email,
  stripeInvoiceId: invoice.id,
  description: `A-To-Do Pro, ${interval === 'annual' ? 'godišnja' : 'mjesečna'} pretplata${period}`,
  totalCents: invoice.amount_paid,
 });
}

// A completed Checkout: marks our checkout session paid and links the
// customer/subscription to the account.
async function handleCheckoutCompleted(session) {
 if (!['paid', 'no_payment_required'].includes(session.payment_status)) return;
 const accountId = session.client_reference_id;
 if (accountId && idOf(session.customer)) {
  await db.query('UPDATE atodo.accounts SET stripe_customer_id = $1 WHERE id = $2', [idOf(session.customer), accountId]);
 }
 if (session.subscription) {
  const sub = typeof session.subscription === 'object' ? session.subscription : await getStripe().subscriptions.retrieve(session.subscription);
  await syncSubscription(sub);
 }
 await db.query("UPDATE atodo.checkout_sessions SET status = 'paid' WHERE id = $1", [session.id]);
}

async function handleCheckoutExpired(session) {
 await db.query("UPDATE atodo.checkout_sessions SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [session.id]);
}

// The status poll's fallback: asks Stripe directly about a checkout session
// the webhook hasn't settled yet. Fiscalization failures here are only
// logged -- the webhook's own retries cover them -- so the customer still
// lands on "success" once the payment itself has gone through.
async function confirmCheckoutSession(sessionId) {
 const stripe = getStripe();
 const session = await stripe.checkout.sessions.retrieve(sessionId);
 if (session.status === 'expired') return handleCheckoutExpired(session);
 if (session.status !== 'complete') return;
 await handleCheckoutCompleted(session);
 const invoiceId = idOf(session.invoice) || (session.subscription && idOf((await stripe.subscriptions.retrieve(idOf(session.subscription))).latest_invoice));
 if (!invoiceId) return;
 const invoice = await stripe.invoices.retrieve(invoiceId);
 if (invoice.status !== 'paid') return;
 await handleInvoicePaid(invoice).catch((err) => console.error(`[atodo billing] ${err.message}`));
}

module.exports = { syncSubscription, handleInvoicePaid, handleCheckoutCompleted, handleCheckoutExpired, confirmCheckoutSession };
