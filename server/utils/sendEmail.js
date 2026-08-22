const { sendEmail: queueEmail } = require('../middleware/email');

async function sendEmail(toEmail, subject, text, html) {
  return queueEmail({
    to: toEmail,
    subject,
    text,
    html,
    metadata: { legacyUtility: true },
  });
}

module.exports = sendEmail;