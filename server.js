// A-To-Do's domain rules use JavaScript's "local" time as a plain wall clock
// and apply each request's own time zone themselves (lib/atodo/domain/
// clock.js) -- so the process itself runs on UTC, whatever the host says.
process.env.TZ = 'UTC';

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
const priceListsRouter = require('./routes/priceLists');
const malenitiAdminRouter = require('./routes/maleniti/admin');
const requireSuperAdmin = require('./lib/requireSuperAdmin');
const atodoRouter = require('./routes/atodo');
const atodoDocsRouter = require('./routes/atodo/docs');
const atodoCors = require('./lib/atodo/cors');
const atodoStripeWebhook = require('./routes/atodo/stripeWebhook');
const { paymentsStatus, getFiscalConfig } = require('./lib/atodo/payments');
const { startReceiptRetries } = require('./lib/atodo/fiscal/receipts');
const { startPurging } = require('./lib/atodo/closedAccounts');
const { startDbVersionChecks, requireDbInSync, onDbInSync, health } = require('./lib/dbVersion');

const app = express();
const port = 50000;

// Requests normally arrive via a reverse proxy (e.g. nginx) in production;
// trusting one hop lets req.ip reflect the real client for rate limiting/bans.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

app.use(requestLogger);
// Answers even while the database isn't usable -- that's what it reports.
app.get('/health', health);
// CORS for /atodo/v1 up front, so preflights and the 503 MAINTENANCE below
// are readable from the client's origin too (a cross-origin page can't
// read an error without these headers -- it'd look like a network failure).
app.use('/atodo/v1', atodoCors);
// Nothing past here runs unless the database schema is the version this
// code expects (see lib/dbVersion.js) -- 503 MAINTENANCE otherwise.
app.use(requireDbInSync);
app.use(checkBanned);
// Before express.json(): Stripe's signature check needs the raw body.
app.post('/atodo/v1/stripe/webhook', express.raw({ type: 'application/json' }), atodoStripeWebhook);
// A-To-Do's data import arrives in chunks (routes/atodo/imports.js) of up to
// 1 MB -- above express.json()'s 100 kB default, which everything else
// keeps. (The TLS proxy's client_max_body_size for /atodo/v1/ allows more.)
app.post('/atodo/v1/imports/:importId/chunks', express.json({ limit: '1mb' }));
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
app.use('/maleniti/v1/price-lists', priceListsRouter);
app.use('/maleniti/v1/admin', requireSuperAdmin, malenitiAdminRouter);
app.use('/atodo/v1/api-docs', atodoDocsRouter);
app.use('/atodo/v1', atodoRouter);

// A body over its limit (see express.json above) or not valid JSON: the
// same { code, message } JSON errors the A-To-Do client reads, rather than
// Express's default HTML page with a stack trace.
app.use((err, req, res, next) => {
 if (err.type === 'entity.too.large') {
  console.error(`[request] ${req.method} ${req.originalUrl}: body of ${err.length} bytes is over the ${err.limit}-byte limit`);
  return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
 }
 if (err.type === 'entity.parse.failed') {
  return res.status(400).json({ code: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
 }
 next(err);
});

// Payments need Stripe AND fiscalization -- say plainly at startup whether
// they're on, and keep re-sending any receipt still waiting for its JIR.
const payments = paymentsStatus();
console.log(payments.ok
 ? `[atodo billing] payments enabled${payments.reason ? ` (${payments.reason})` : ''}`
 : `[atodo billing] payments DISABLED: ${payments.reason}`);
// Background jobs need the schema too: started once the database is in
// sync (and each run skipped while it isn't -- see their own run loops).
startDbVersionChecks();
let backgroundJobsStarted = false;
onDbInSync(() => {
 if (backgroundJobsStarted) return;
 backgroundJobsStarted = true;
 if (getFiscalConfig()) startReceiptRetries(getFiscalConfig());
 startPurging();
});

app.listen(port, () => {
 console.log(`Server is running on port ${port}`);
});
