const { loadFiscalConfig } = require('./fiscal/config');
const { stripeStatus } = require('./stripe');

// Whether taking payments is possible at all: only with Stripe configured
// AND a usable fiscalization certificate. Every paid invoice has to be
// fiscalized, so without a certificate no payment may be taken in the first
// place -- checkout refuses before creating anything in Stripe (see
// routes/atodo/subscriptions.js).
//
// The fiscal configuration (certificate included) is read once, at startup;
// changing it means restarting the api -- same as every other setting here.

let fiscal = loadFiscalConfig();

function paymentsStatus() {
 const stripe = stripeStatus();
 if (!stripe.ok) return stripe;
 if (!fiscal.ok) return { ok: false, reason: `fiscalization ${fiscal.reason}` };
 return { ok: true };
}

const getFiscalConfig = () => (fiscal.ok ? fiscal : null);

// Tests swap in their own configuration.
function setFiscalConfig(config) {
 fiscal = config;
}

module.exports = { paymentsStatus, getFiscalConfig, setFiscalConfig };
