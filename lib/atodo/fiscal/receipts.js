const QRCode = require('qrcode');
const db = require('../../../db');
const sendEmail = require('../mailer');
const { renderEmail } = require('../emailTemplate');
const { computeZki, verificationUrl, receiptDateTime } = require('./format');
const { fiscalizeReceipt } = require('./cis');

// Issuing, fiscalizing and emailing receipts (atodo.fiscal_receipts).
//
// Issuing (issueReceipt): the receipt number is allocated, the ZKI computed
// and the row stored in one transaction under an advisory lock, so numbers
// are sequential without gaps even with concurrent requests (a Stripe webhook
// and a client's status poll can race to report the same payment). Then it's
// sent to CIS (the Tax Administration's service) and emailed to the customer.
//
// No JIR back (CIS unreachable, or an error in its answer)? The receipt
// stands as issued -- with its ZKI, as the specification allows -- and stays
// 'pending': retryPendingReceipts re-sends it as a late delivery (NakDost)
// until it gets one. Issuing is idempotent per Stripe invoice (a sale) and
// per Stripe refund (its storno).
//
// A refund is fiscalized as a storno receipt: a new receipt of its own --
// next number in the sequence -- for the negative refunded amount, naming
// the receipt it cancels (fully, or partly for a partial refund). CIS itself
// has no field linking the two; the reference is on the receipt the customer
// gets (see emailReceipt).

const NUMBERING_LOCK = 'atodo-fiscal-receipt-numbering';

function zagrebYear(date) {
 return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', year: 'numeric' }).format(date));
}

const toReceipt = (row) => ({
 id: row.id,
 accountId: row.account_id,
 customerEmail: row.customer_email,
 stripeInvoiceId: row.stripe_invoice_id,
 stripeRefundId: row.stripe_refund_id,
 originalReceiptId: row.original_receipt_id,
 number: row.number,
 premises: row.premises,
 device: row.device,
 issuedAt: new Date(row.issued_at),
 description: row.description,
 totalCents: row.total_cents,
 zki: row.zki,
 jir: row.jir,
 status: row.status,
});

// The receipt already issued for this sale (stripeRefundId null) or refund.
const findIssued = (q, { stripeInvoiceId, stripeRefundId }) =>
 stripeRefundId
  ? q.query('SELECT * FROM atodo.fiscal_receipts WHERE stripe_refund_id = $1', [stripeRefundId])
  : q.query('SELECT * FROM atodo.fiscal_receipts WHERE stripe_invoice_id = $1 AND stripe_refund_id IS NULL', [stripeInvoiceId]);

// A sale: stripeInvoiceId, positive totalCents. A storno: also
// stripeRefundId and originalReceiptId, negative totalCents.
async function issueReceipt(config, { accountId, customerEmail, stripeInvoiceId, stripeRefundId = null, originalReceiptId = null, description, totalCents }) {
 const { rows: existing } = await findIssued(db, { stripeInvoiceId, stripeRefundId });
 if (existing.length) return toReceipt(existing[0]);

 const client = await db.getClient();
 let row;
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [NUMBERING_LOCK]);
  // Re-checked under the lock: whoever got here first already issued it.
  const { rows: raced } = await findIssued(client, { stripeInvoiceId, stripeRefundId });
  if (raced.length) {
   await client.query('COMMIT');
   return toReceipt(raced[0]);
  }
  const issuedAt = new Date();
  const year = zagrebYear(issuedAt);
  const { rows: [{ next }] } = await client.query(
   'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM atodo.fiscal_receipts WHERE premises = $1 AND device = $2 AND year = $3',
   [config.premises, config.device, year]
  );
  const zki = computeZki(config.certificate.keyPem, {
   oib: config.oib,
   issuedAt,
   number: next,
   premises: config.premises,
   device: config.device,
   totalCents,
  });
  ({ rows: [row] } = await client.query(
   `INSERT INTO atodo.fiscal_receipts
     (account_id, customer_email, stripe_invoice_id, stripe_refund_id, original_receipt_id, year, number, premises, device, issued_at, description, total_cents, zki)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
   [accountId, customerEmail, stripeInvoiceId, stripeRefundId, originalReceiptId, year, next, config.premises, config.device, issuedAt, description, totalCents, zki]
  ));
  await client.query('COMMIT');
 } catch (err) {
  await client.query('ROLLBACK');
  throw err;
 } finally {
  client.release();
 }

 let receipt = await sendToCis(config, toReceipt(row), { lateDelivery: false });
 await emailReceipt(config, receipt);
 return receipt;
}

// One attempt at getting a JIR; records the outcome either way.
async function sendToCis(config, receipt, { lateDelivery }) {
 let outcome;
 try {
  outcome = await fiscalizeReceipt(config, receipt, { lateDelivery });
 } catch (err) {
  outcome = { errors: [{ code: 'transport', message: err.message }] };
 }
 if (outcome.jir) {
  const { rows } = await db.query(
   `UPDATE atodo.fiscal_receipts SET jir = $1, status = 'fiscalized', attempts = attempts + 1, last_error = NULL, last_attempt_at = now()
    WHERE id = $2 RETURNING *`,
   [outcome.jir, receipt.id]
  );
  return toReceipt(rows[0]);
 }
 const error = outcome.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
 console.error(`[atodo fiscal] receipt ${receipt.number}/${receipt.premises}/${receipt.device} not fiscalized: ${error}`);
 const { rows } = await db.query(
  'UPDATE atodo.fiscal_receipts SET attempts = attempts + 1, last_error = $1, last_attempt_at = now() WHERE id = $2 RETURNING *',
  [error, receipt.id]
 );
 return toReceipt(rows[0]);
}

// Re-sends every receipt still without a JIR, as a late delivery. Run
// periodically (see startReceiptRetries) -- the law expects late deliveries
// within two working days of issuing.
async function retryPendingReceipts(config) {
 const { rows } = await db.query("SELECT * FROM atodo.fiscal_receipts WHERE status = 'pending' ORDER BY issued_at LIMIT 50");
 for (const row of rows) await sendToCis(config, toReceipt(row), { lateDelivery: true });
 return rows.length;
}

function startReceiptRetries(config, intervalMs = 10 * 60 * 1000) {
 const run = () =>
  retryPendingReceipts(config).catch((err) => console.error(`[atodo fiscal] retrying pending receipts failed: ${err.message}`));
 run();
 return setInterval(run, intervalMs).unref();
}

const formatEuro = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} EUR`;
const receiptNumberOf = (r) => `${r.number}/${r.premises}/${r.device}`;

// The receipt itself, as the customer gets it: in Croatian (a fiscal
// receipt), with the seller's details, the receipt number, date and time,
// what was paid for and how, the ZKI and JIR, the VAT note, and the
// verification QR code (section 2.7) -- inline, since remote/data-URL images
// are blocked by many email clients. Resolves whether it was handed off.
async function emailReceipt(config, receipt) {
 const receiptNumber = receiptNumberOf(receipt);
 let original = null;
 if (receipt.originalReceiptId) {
  const { rows } = await db.query('SELECT * FROM atodo.fiscal_receipts WHERE id = $1', [receipt.originalReceiptId]);
  original = rows[0] ? toReceipt(rows[0]) : null;
 }
 const qrUrl = verificationUrl({ jir: receipt.jir, zki: receipt.zki, issuedAt: receipt.issuedAt, totalCents: receipt.totalCents });
 // ISO/IEC 18004, error correction at least L (section 2.7); M for margin.
 const qrPng = await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
 const email = renderEmail({
  lang: 'hr',
  heading: receipt.originalReceiptId ? `Storno račun br. ${receiptNumber}` : `Račun br. ${receiptNumber}`,
  paragraphs: [
   receipt.originalReceiptId
    ? 'Vaša uplata je vraćena. Ovo je storno račun za povrat. (Your payment has been refunded -- this is the cancelling receipt for the refund.)'
    : 'Hvala na uplati! Ovo je račun za vašu A-To-Do Pro pretplatu. (Thank you for your payment -- this is the receipt for your A-To-Do Pro subscription.)',
  ],
  details: [
   ['Prodavatelj', config.sellerName],
   ['Adresa', config.sellerAddress],
   ['OIB', config.oib],
   ['Broj računa', receiptNumber],
   ['Datum i vrijeme', receiptDateTime(receipt.issuedAt)],
   ...(original ? [['Stornira račun', `${receiptNumberOf(original)} od ${receiptDateTime(original.issuedAt)}`]] : []),
   ['Usluga', receipt.description],
   ['Iznos', formatEuro(receipt.totalCents)],
   ['Način plaćanja', 'Kartica'],
   ['Oznaka operatera', config.operatorOib],
   ['ZKI', receipt.zki],
   ['JIR', receipt.jir || '-'],
   ['Napomena', config.vatNote],
  ],
  image: { cid: 'receipt-qr', alt: 'QR kod za provjeru računa', caption: `Provjera računa: ${qrUrl}` },
 });
 const subject = receipt.originalReceiptId ? `A-To-Do: storno račun br. ${receiptNumber}` : `A-To-Do: račun br. ${receiptNumber}`;
 const sent = await sendEmail(receipt.customerEmail, subject, email.text, email.html, [
  { filename: 'provjera-racuna.png', content: qrPng, cid: 'receipt-qr' },
 ]);
 if (sent) await db.query('UPDATE atodo.fiscal_receipts SET emailed_at = now() WHERE id = $1', [receipt.id]);
 return sent;
}

module.exports = { issueReceipt, retryPendingReceipts, startReceiptRetries, emailReceipt };
