const sendEmail = require('./mailer');
const { renderEmail } = require('./emailTemplate');

// Emails the business owner about something that needs a person -- a
// disputed payment, a refund that failed after its storno receipt was
// already issued. To ATODO_OWNER_EMAIL; with that unset, the alert is only
// logged (so it's never silently lost). Never rejects, like sendEmail.
async function notifyOwner(subject, paragraphs, details = [], action = null) {
 console.error(`[atodo owner alert] ${subject} -- ${paragraphs.join(' ')} ${details.map(([k, v]) => `${k}: ${v}`).join('; ')}`);
 const to = process.env.ATODO_OWNER_EMAIL;
 if (!to) return false;
 const email = renderEmail({ heading: subject, paragraphs, details, action });
 return sendEmail(to, `A-To-Do: ${subject}`, email.text, email.html);
}

module.exports = { notifyOwner };
