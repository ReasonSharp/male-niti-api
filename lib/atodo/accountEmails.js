const sendEmail = require('./mailer');
const jwt = require('./jwt');
const { buildFrontendLink } = require('./links');
const { renderEmail } = require('./emailTemplate');
const { toPasswordVersion } = require('./token');

// Account emails sent from more than one place -- the account's own flows
// (routes/atodo/auth.js, users.js) and the admin app's user administration
// (routes/maleniti/atodoAccounts.js). Fire and forget, like every email
// here (mailer.js never rejects).

// handleEmailVerificationLink() in the atodo client reads this `verify`
// param -- see lib/atodo/links.js. A registration started from the landing
// page's pricing buttons carries its plan along (next=checkout&plan=...,
// the same params the client's own login flow continues to checkout on).
function buildVerificationLink(token, checkoutPlan) {
 return buildFrontendLink('verify', token, checkoutPlan ? { next: 'checkout', plan: checkoutPlan } : {});
}

// A registration's activation link (valid as long as its row says, 6 hours).
function sendVerificationEmail(email, token, checkoutPlan) {
 const message = renderEmail({
  heading: 'Verify your A-To-Do account',
  paragraphs: ['Welcome! Confirm your email address to activate your A-To-Do account. The link is valid for 6 hours.'],
  action: { label: 'Verify your email', url: buildVerificationLink(token, checkoutPlan) },
  afterAction: ["If you didn't sign up for A-To-Do, just ignore this email."],
 });
 return sendEmail(email, 'Verify your A-To-Do account', message.text, message.html);
}

// "Forgot password?": a link to set a new password without the current
// one -- valid for 30 minutes, and once: the token is bound to the
// account's password version, so setting a new password (or any other
// change of it) voids it, along with any other unused link. The link lands
// on the client's `?resetPassword=` handling, which ends at POST
// /auth/reset-password.
const PASSWORD_RESET_LINK_TTL_SECONDS = 30 * 60;

function sendPasswordResetEmail(account) {
 const token = jwt.sign({ purpose: 'password-reset', acct: account.id, pwv: toPasswordVersion(account) }, PASSWORD_RESET_LINK_TTL_SECONDS);
 const message = renderEmail({
  heading: 'Reset your A-To-Do password',
  paragraphs: [`Someone -- hopefully you -- asked to reset the password for ${account.email}. Set a new one with the link below. It's valid for 30 minutes and works once.`],
  action: { label: 'Set a new password', url: buildFrontendLink('resetPassword', token) },
  afterAction: ["If you didn't ask for this, just ignore this email -- your password stays as it is."],
 });
 return sendEmail(account.email, 'Reset your A-To-Do password', message.text, message.html);
}

// The support form, for "if it wasn't you" -- an email change can't be
// undone from a link (that could be abused); support gets the account back.
function supportLink() {
 const url = new URL('support.html', process.env.ATODO_FRONTEND_BASE_URL);
 url.searchParams.set('topic', 'account');
 return url.toString();
}

// Support changed an account's login email (the admin app): both addresses
// are told.
function sendEmailSetBySupportNotices(oldEmail, newEmail) {
 const toOld = renderEmail({
  heading: 'Your login email was changed',
  paragraphs: [
   `At your request, support changed your A-To-Do login email from ${oldEmail} to ${newEmail}. From now on, you log in with ${newEmail}.`,
   "If you didn't ask for this, write to support right away -- through the support form below, or at support@maleniti.com -- and we'll help you get your account back.",
  ],
  action: { label: 'Contact support', url: supportLink() },
 });
 const toNew = renderEmail({
  heading: 'This is now your A-To-Do login email',
  paragraphs: [
   `Support changed your A-To-Do login email from ${oldEmail} to this address. From now on, you log in with ${newEmail} -- your password stays the same.`,
   "If you don't have an A-To-Do account or didn't ask for this, write to support at support@maleniti.com.",
  ],
 });
 sendEmail(oldEmail, 'Your A-To-Do login email was changed', toOld.text, toOld.html);
 sendEmail(newEmail, 'This is now your A-To-Do login email', toNew.text, toNew.html);
}

module.exports = {
 buildVerificationLink,
 sendVerificationEmail,
 sendPasswordResetEmail,
 sendEmailSetBySupportNotices,
 supportLink,
};
