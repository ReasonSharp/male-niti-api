const crypto = require('crypto');

// Mock Stripe integration: no real Stripe API call is made and payment
// always "succeeds" immediately, so there's no pending state to wait on --
// the returned checkoutUrl redirects straight to successUrl with a
// session_id param, the same way Stripe's own hosted checkout page would on
// a genuinely completed payment. See CLAUDE.md.
module.exports = async function createMockCheckoutSession({ successUrl }) {
 const sessionId = `cs_mock_${crypto.randomBytes(16).toString('hex')}`;
 const separator = successUrl.includes('?') ? '&' : '?';
 const checkoutUrl = `${successUrl}${separator}session_id=${sessionId}`;
 return { sessionId, checkoutUrl };
};
