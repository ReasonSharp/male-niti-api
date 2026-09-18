// Mock email delivery: dumps the message to the log instead of actually
// sending it, and always "succeeds" -- there's no real mail provider wired
// up yet, see CLAUDE.md.
module.exports = function sendEmail(to, subject, body) {
 console.log(`[atodo mail] To: ${to} | Subject: ${subject}\n${body}`);
 return Promise.resolve();
};
