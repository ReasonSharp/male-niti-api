const { getStripe } = require('./stripe');

// The Stripe Customer Portal configuration A-To-Do's "Manage billing" opens
// (POST /subscriptions/portal-session). Created through the API rather than
// relying on the Dashboard's default one, so what customers may do there is
// pinned down here:
//  - update their card -- yes;
//  - cancel -- yes, at the period's end only (same as our own cancel;
//    customer.subscription.updated mirrors it onto the account);
//  - switch plan -- no: switching monthly/annual would mean prorations, i.e.
//    credits and partial charges, none of which our fiscalization models;
//  - invoice history -- no: Stripe's invoices aren't the legal receipts
//    (those are the fiscalized ones we email), and showing both confuses;
//  - change their email/address -- no: the account's email is ours.
// Found again by its metadata on the next start rather than re-created;
// bump CONFIGURATION_VERSION after changing anything below and a new one
// is made (the old one just stays unused in Stripe).

const CONFIGURATION_VERSION = 'atodo-portal-v1';
let configurationId = null;

async function portalConfigurationId() {
 if (configurationId) return configurationId;
 const stripe = getStripe();
 for await (const configuration of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
  if (configuration.metadata && configuration.metadata.atodo === CONFIGURATION_VERSION) {
   configurationId = configuration.id;
   return configurationId;
  }
 }
 const base = (process.env.ATODO_FRONTEND_BASE_URL || '').replace(/\/+$/, '');
 const configuration = await stripe.billingPortal.configurations.create({
  name: 'A-To-Do',
  metadata: { atodo: CONFIGURATION_VERSION },
  ...(base ? { business_profile: { privacy_policy_url: `${base}/privacy.html`, terms_of_service_url: `${base}/terms.html` } } : {}),
  features: {
   payment_method_update: { enabled: true },
   subscription_cancel: { enabled: true, mode: 'at_period_end' },
   subscription_update: { enabled: false },
   invoice_history: { enabled: false },
   customer_update: { enabled: false },
  },
 });
 configurationId = configuration.id;
 return configurationId;
}

async function createPortalSession(customerId, returnUrl) {
 return getStripe().billingPortal.sessions.create({
  customer: customerId,
  return_url: returnUrl,
  configuration: await portalConfigurationId(),
 });
}

// Tests start from scratch.
function resetPortalConfiguration() {
 configurationId = null;
}

module.exports = { createPortalSession, resetPortalConfiguration };
