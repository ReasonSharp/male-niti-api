const nodemailer = require('nodemailer');

// Outbound email for the atodo integration, over plain SMTP -- any provider
// works (currently Zoho: smtp.zoho.eu/.com, port 465, the mailbox's
// app-specific password), configured entirely from the environment:
//   ATODO_SMTP_HOST   e.g. smtp.zoho.eu -- empty/unset = don't send, just log
//   ATODO_SMTP_PORT   465 (implicit TLS, the default) or 587 (STARTTLS)
//   ATODO_SMTP_USER   the mailbox to authenticate as
//   ATODO_SMTP_PASS   its (app-specific) password
//   ATODO_MAIL_FROM   e.g. "A-To-Do <noreply@maleniti.com>" -- must be an
//                     address the SMTP user may send as (itself or an alias)
//
// With no host configured (local development), messages are printed to the
// log instead, exactly like the old mock -- so every flow that emails a link
// stays usable without a mail account.
//
// Never rejects: every caller fires and forgets (a failed send shouldn't
// fail the request that triggered it, e.g. registering), and an unhandled
// rejection would take the whole process down. A failure is logged instead
// -- the returned promise resolves to whether the message was handed off.
//
// attachments: optional, nodemailer's shape -- e.g. an inline image
// { filename, content: Buffer, cid } referenced from the html as "cid:<cid>".
const host = process.env.ATODO_SMTP_HOST;
const port = Number(process.env.ATODO_SMTP_PORT) || 465;
const from = process.env.ATODO_MAIL_FROM || process.env.ATODO_SMTP_USER;

const transport = host
 ? nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = TLS from the start; anything else upgrades via STARTTLS
    auth: { user: process.env.ATODO_SMTP_USER, pass: process.env.ATODO_SMTP_PASS },
   })
 : null;

if (!transport) console.log('[atodo mail] ATODO_SMTP_HOST not set -- emails will be logged, not sent');

module.exports = async function sendEmail(to, subject, text, html, attachments = []) {
 if (!transport) {
  console.log(`[atodo mail] To: ${to} | Subject: ${subject}${attachments.length ? ` | ${attachments.length} attachment(s)` : ''}\n${text}`);
  return true;
 }
 try {
  await transport.sendMail({ from, to, subject, text, html, attachments });
  console.log(`[atodo mail] sent to ${to} | Subject: ${subject}`);
  return true;
 } catch (err) {
  console.error(`[atodo mail] FAILED to send to ${to} | Subject: ${subject}: ${err.message}`);
  return false;
 }
};
