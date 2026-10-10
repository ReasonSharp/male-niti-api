const db = require('../../db');
const { isDbInSync } = require('../dbVersion');
const sendEmail = require('./mailer');
const { renderEmail } = require('./emailTemplate');
const { brandTexts, formatText } = require('../maleniti/texts');
const { publicationTexts, MAX_SEND_ATTEMPTS } = require('../maleniti/legal');

// The emails telling every A-To-Do account that its Privacy Policy or Terms
// of Service changed (lib/maleniti/legal.js's publish queues one per open
// account in atodo.legal_notice_emails). Each goes out in the account's own
// language -- its texts are interface texts in the 'email' bundle, edited
// in the admin app like any other, English for a language without them --
// with that language's summary of the changes (else English's, else none),
// the refund the account is entitled to if it disagrees (any charge in the
// 14 days before and after the change) and that using the app on means
// agreeing.
//
// Sent in the background, one at a time: right after a publish
// (kickLegalNotices) and every minute after that (startLegalNotices), so a
// restart or a failing mail server only delays them. A failed send is
// tried again on a later run, at most MAX_SEND_ATTEMPTS times; a sent one
// is never sent again. An account closed meanwhile isn't emailed (its row
// goes with the account).

const REFUND_WINDOW_DAYS = 14;
const BATCH_SIZE = 50;
// Between two messages, so a large send doesn't hammer the SMTP server.
const SEND_GAP_MS = 300;

const LOCALES = { en: 'en-GB', hr: 'hr-HR' };

function formatLongDate(date, language) {
 return new Intl.DateTimeFormat(LOCALES[language] || language, {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Zagreb',
 }).format(date);
}

// A link to one of the client's pages, opening in `language`, from the
// deployment's own frontend address (like every emailed link, see
// links.js) -- never from a request.
function frontendPage(page, language, extra = {}) {
 const url = new URL(page, process.env.ATODO_FRONTEND_BASE_URL);
 url.searchParams.set('lang', language);
 for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
 return url.toString();
}

// { subject, text, html } -- pure, so it can be tested on its own.
//   kind         'privacy' | 'terms'
//   language     the language the texts are in
//   strings      the 'email' bundle's texts in it (brandTexts)
//   publishedAt  when the new version took effect
//   summary      what changed, as the admin wrote it ('' for none)
//   documentUrl, supportUrl
function buildLegalNoticeEmail({ kind, language, strings, publishedAt, summary, documentUrl, supportUrl }) {
 const prefix = kind === 'privacy' ? 'email.privacyChanged' : 'email.termsChanged';
 const day = 24 * 60 * 60 * 1000;
 const published = new Date(publishedAt);
 const date = formatLongDate(published, language);
 const subject = formatText(strings, `${prefix}.subject`);
 const summaryParagraphs = (summary || '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
 const { text, html } = renderEmail({
  lang: language,
  heading: subject,
  paragraphs: [
   formatText(strings, `${prefix}.intro`, { date }),
   ...(summaryParagraphs.length ? [formatText(strings, 'email.legalChange.summaryHeading'), ...summaryParagraphs] : []),
  ],
  action: { label: formatText(strings, `${prefix}.action`), url: documentUrl },
  afterAction: [
   formatText(strings, 'email.legalChange.refund', {
    from: formatLongDate(new Date(published.getTime() - REFUND_WINDOW_DAYS * day), language),
    to: formatLongDate(new Date(published.getTime() + REFUND_WINDOW_DAYS * day), language),
    supportUrl,
   }),
   formatText(strings, `${prefix}.continuedUse`),
  ],
 });
 return { subject, text, html };
}

// One email per publication and language, built once per run.
async function noticeFor(cache, row) {
 const cacheKey = `${row.publication_id}:${row.language || ''}`;
 if (!cache.has(cacheKey)) {
  cache.set(cacheKey, (async () => {
   const { language, strings } = await brandTexts(db, row.brand, ['email'], row.language);
   const texts = await publicationTexts(db, row.publication_id);
   const summaryOf = (lang) => (texts[lang] && texts[lang].changed ? texts[lang].summary : '');
   return buildLegalNoticeEmail({
    kind: row.kind,
    language,
    strings,
    publishedAt: row.published_at,
    summary: summaryOf(language) || summaryOf('en'),
    documentUrl: frontendPage(`${row.kind}.html`, language),
    supportUrl: frontendPage('support.html', language, { topic: 'billing' }),
   });
  })());
 }
 return cache.get(cacheKey);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends every notice still due -- skipping ones already tried since this
// run began, so a failing one waits for a later run. Returns { sent, failed }.
async function sendPendingLegalNotices({ gapMs = SEND_GAP_MS } = {}) {
 const runStartedAt = new Date();
 const cache = new Map();
 let sent = 0;
 let failed = 0;
 for (;;) {
  const { rows } = await db.query(
   `SELECT e.publication_id, e.account_id, a.email, a.language, d.kind, b.code AS brand, p.published_at
    FROM atodo.legal_notice_emails e
    JOIN atodo.accounts a ON a.id = e.account_id
    JOIN maleniti.legal_publication p USING (publication_id)
    JOIN maleniti.legal_document d USING (document_id)
    JOIN maleniti.brand b ON b.brand_id = d.brand_id
    WHERE e.sent_at IS NULL AND e.attempts < $1 AND a.closed_at IS NULL
      AND (e.last_attempt_at IS NULL OR e.last_attempt_at < $2)
    ORDER BY e.publication_id, e.account_id
    LIMIT $3`,
   [MAX_SEND_ATTEMPTS, runStartedAt, BATCH_SIZE]
  );
  if (!rows.length) break;
  for (const row of rows) {
   let ok = false;
   let error = null;
   try {
    const notice = await noticeFor(cache, row);
    ok = await sendEmail(row.email, notice.subject, notice.text, notice.html);
    if (!ok) error = 'The mail server refused or could not be reached (see the log).';
   } catch (err) {
    error = err.message;
   }
   await db.query(
    `UPDATE atodo.legal_notice_emails
     SET attempts = attempts + 1, last_attempt_at = now(), sent_at = CASE WHEN $3 THEN now() END, last_error = $4
     WHERE publication_id = $1 AND account_id = $2`,
    [row.publication_id, row.account_id, ok, error]
   );
   if (ok) sent++;
   else failed++;
   if (gapMs) await sleep(gapMs);
  }
 }
 if (sent || failed) console.log(`[atodo legal notices] sent ${sent}, failed ${failed}`);
 return { sent, failed };
}

let running = null;

// Starts a run unless one is going (publishing calls this).
function kickLegalNotices() {
 if (!running) {
  running = sendPendingLegalNotices()
   .catch((err) => console.error(`[atodo legal notices] run failed: ${err.message}`))
   .finally(() => {
    running = null;
   });
 }
 return running;
}

function startLegalNotices(intervalMs = 60 * 1000) {
 const run = () => isDbInSync() && kickLegalNotices();
 run();
 return setInterval(run, intervalMs).unref();
}

module.exports = { buildLegalNoticeEmail, formatLongDate, sendPendingLegalNotices, kickLegalNotices, startLegalNotices, REFUND_WINDOW_DAYS };
