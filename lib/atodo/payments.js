const { loadFiscalConfig } = require('./fiscal/config');
const { stripeStatus } = require('./stripe');

// Whether taking payments is possible, and whether they get fiscalized --
// decided by which Stripe keys are in use:
//
//  - Live keys (real money): only with a usable certificate talking to the
//    PRODUCTION fiscalization service. Every paid invoice has to be
//    fiscalized for real, so otherwise no payment may be taken in the first
//    place -- checkout refuses before creating anything in Stripe (see
//    routes/atodo/subscriptions.js). A demo certificate / the test service
//    isn't enough: its receipts aren't legally fiscalized.
//  - Test keys (sk_test_/rk_test_, no real money): always allowed, so the
//    payment flow can be tested before any certificate exists. Receipts are
//    fiscalized against the TEST service when a certificate is configured
//    for it, and skipped (logged) otherwise -- test payments must never
//    reach the production service, so a production configuration is
//    skipped too.
//
// The fiscal configuration (certificate included) is read once, at startup;
// changing it means restarting the api -- same as every other setting here.

let fiscal = loadFiscalConfig();

const stripeTestMode = () => /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || '');

function paymentsStatus() {
 const stripe = stripeStatus();
 if (!stripe.ok) return stripe;
 if (stripeTestMode()) {
  if (!fiscal.ok) return { ok: true, fiscalize: false, reason: `Stripe test mode; receipts not fiscalized (fiscalization ${fiscal.reason})` };
  if (fiscal.production) return { ok: true, fiscalize: false, reason: 'Stripe test mode; receipts not fiscalized (FISCAL_CIS_URL is the production service -- test payments never go there)' };
  return { ok: true, fiscalize: true, reason: 'Stripe test mode; receipts fiscalized against the test service' };
 }
 if (!fiscal.ok) return { ok: false, reason: `fiscalization ${fiscal.reason}` };
 if (!fiscal.production) return { ok: false, reason: 'live Stripe keys, but FISCAL_CIS_URL is not the production service' };
 return { ok: true, fiscalize: true };
}

// The configuration receipts are fiscalized with -- null when they aren't
// (see paymentsStatus; skippingReceipts tells "not now" from "never here").
const getFiscalConfig = () => (paymentsStatus().fiscalize ? fiscal : null);

// True when a paid invoice / refund legitimately gets no receipt: Stripe
// test mode without a usable test-service configuration. Otherwise a missing
// configuration is an error the webhook reports (so Stripe re-delivers).
const skippingReceipts = () => stripeTestMode() && !paymentsStatus().fiscalize;

// Tests swap in their own configuration.
function setFiscalConfig(config) {
 fiscal = config;
}

module.exports = { paymentsStatus, getFiscalConfig, skippingReceipts, setFiscalConfig };
