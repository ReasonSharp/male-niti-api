const Stripe = require('stripe');

// The Stripe client, from the environment:
//   STRIPE_SECRET_KEY      sk_test_... / sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_... -- verifies POST /atodo/v1/stripe/webhook
// plus what checkout sells, from the database rather than fixed Stripe
// Prices (see routes/atodo/subscriptions.js's checkoutOffer):
//   ATODO_BRAND            the maleniti.brand code whose products are sold
//                          (each subscription product's stripe_product_id
//                          and price come from there)
// getStripe() is null until all of them are set (see stripeStatus).

const REQUIRED = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ATODO_BRAND'];

let client;
function getStripe() {
 if (client === undefined) client = REQUIRED.every((k) => process.env[k]) ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
 return client;
}

// Tests swap in a fake.
function setStripeClient(fake) {
 client = fake;
}

function stripeStatus() {
 const missing = REQUIRED.filter((k) => !process.env[k]);
 return missing.length ? { ok: false, reason: `Stripe not configured (missing ${missing.join(', ')})` } : { ok: true };
}

module.exports = { getStripe, setStripeClient, stripeStatus };
