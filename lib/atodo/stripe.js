const Stripe = require('stripe');

// The Stripe client, from the environment:
//   STRIPE_SECRET_KEY      sk_test_... / sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_... -- verifies POST /atodo/v1/stripe/webhook
//   STRIPE_PRICE_MONTHLY   price_... -- a recurring monthly EUR price
//   STRIPE_PRICE_ANNUAL    price_... -- a recurring yearly EUR price
// getStripe() is null until all of them are set (see stripeStatus).

const REQUIRED = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL'];

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

const priceFor = (billingInterval) => (billingInterval === 'annual' ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY);

module.exports = { getStripe, setStripeClient, stripeStatus, priceFor };
