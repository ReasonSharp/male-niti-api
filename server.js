const path = require('path');
require('dotenv').config({
 path: path.resolve('.', './.env')
});

const express = require('express');
const { registerFont } = require('canvas');

registerFont('DejaVuSerif.ttf', { family: 'DejaVu Serif' });
registerFont('NotoSerif-Light.ttf', { family: 'Noto Serif Light' });

const requestLogger = require('./lib/requestLogger');
const authenticate = require('./lib/authenticate');
const { checkBanned } = require('./lib/ipBan');
const rateLimiter = require('./lib/rateLimiter');
const servicesRouter = require('./routes/services');
const pricingRouter = require('./routes/pricing');
const workRouter = require('./routes/work');
const blogRouter = require('./routes/blog');
const contactRouter = require('./routes/contact');
const quotableRouter = require('./routes/quotable');
const docsRouter = require('./routes/docs');
const apiKeysRouter = require('./routes/apiKeys');
const imprintRouter = require('./routes/imprint');
const feedRouter = require('./routes/feed');
const atodoRouter = require('./routes/atodo');
const atodoDocsRouter = require('./routes/atodo/docs');
const atodoCors = require('./lib/atodo/cors');
const atodoStripeWebhook = require('./routes/atodo/stripeWebhook');
const { paymentsStatus, getFiscalConfig } = require('./lib/atodo/payments');
const { startReceiptRetries } = require('./lib/atodo/fiscal/receipts');
const { startPurging } = require('./lib/atodo/closedAccounts');

const app = express();
const port = 50000;

// Requests normally arrive via a reverse proxy (e.g. nginx) in production;
// trusting one hop lets req.ip reflect the real client for rate limiting/bans.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

app.use(requestLogger);
app.use(checkBanned);
// Before express.json(): Stripe's signature check needs the raw body.
app.post('/atodo/v1/stripe/webhook', atodoCors, express.raw({ type: 'application/json' }), atodoStripeWebhook);
app.use(express.json());
app.use(authenticate);
app.use(rateLimiter.general);

app.use('/services', servicesRouter);
app.use('/pricing', pricingRouter);
app.use('/work', workRouter);
app.use('/blog', blogRouter);
app.use('/contact', contactRouter);
app.use('/v1/quotable', quotableRouter);
app.use('/v1/api-docs', docsRouter);
app.use('/api-keys', apiKeysRouter);
app.use('/imprint', imprintRouter);
app.use('/feed.xml', feedRouter);
app.use('/atodo/v1/api-docs', atodoCors, atodoDocsRouter);
app.use('/atodo/v1', atodoCors, atodoRouter);

// Payments need Stripe AND fiscalization -- say plainly at startup whether
// they're on, and keep re-sending any receipt still waiting for its JIR.
const payments = paymentsStatus();
console.log(payments.ok
 ? `[atodo billing] payments enabled${payments.reason ? ` (${payments.reason})` : ''}`
 : `[atodo billing] payments DISABLED: ${payments.reason}`);
if (getFiscalConfig()) startReceiptRetries(getFiscalConfig());
startPurging();

app.listen(port, () => {
 console.log(`Server is running on port ${port}`);
});
