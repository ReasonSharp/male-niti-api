// Mock email delivery: dumps the message to the log instead of actually
// sending it, and always "succeeds" -- there's no real mail provider wired
// up yet, see CLAUDE.md. text/html mirror the two-part shape a real
// provider would want (plain-text fallback alongside the HTML body), even
// though this mock only ever prints the plain-text part.
module.exports = function sendEmail(to, subject, text, html) {
 console.log(`[atodo mail] To: ${to} | Subject: ${subject}\n${text}`);
 return Promise.resolve();
};
