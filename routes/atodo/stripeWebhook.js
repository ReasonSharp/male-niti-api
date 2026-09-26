const asyncHandler = require('../../lib/asyncHandler');
const { getStripe } = require('../../lib/atodo/stripe');
const billing = require('../../lib/atodo/billing');

// POST /atodo/v1/stripe/webhook -- Stripe's event deliveries. Mounted in
// server.js with express.raw() BEFORE the global express.json(): the
// signature check needs the exact raw body. Anything that throws answers 500,
// which makes Stripe re-deliver the event (with backoff, for days) -- e.g. a
// payment arriving while fiscalization is unavailable. Every handler is
// idempotent (see lib/atodo/billing.js).
module.exports = asyncHandler(async (req, res) => {
 const stripe = getStripe();
 if (!stripe) return res.status(503).json({ code: 'PAYMENTS_UNAVAILABLE', message: 'Stripe is not configured.' });

 let event;
 try {
  event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
 } catch (err) {
  return res.status(400).json({ code: 'INVALID_SIGNATURE', message: err.message });
 }

 const object = event.data.object;
 switch (event.type) {
  case 'checkout.session.completed':
  case 'checkout.session.async_payment_succeeded':
   await billing.handleCheckoutCompleted(object);
   break;
  case 'checkout.session.expired':
   await billing.handleCheckoutExpired(object);
   break;
  case 'invoice.paid':
   await billing.handleInvoicePaid(object);
   break;
  case 'customer.subscription.updated':
  case 'customer.subscription.deleted':
   await billing.syncSubscription(object);
   break;
  case 'refund.created':
  case 'refund.updated':
   await billing.handleRefund(object);
   break;
  case 'charge.dispute.created':
   await billing.handleDisputeCreated(object);
   break;
  default:
   break; // not one we act on -- acknowledged so Stripe doesn't keep retrying
 }
 res.json({ received: true });
});
