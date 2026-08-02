const nodemailer = require('nodemailer');

const sendEmail = async (toEmail, subject, text) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, // ඔයාගේ Gmail address එක
      pass: process.env.EMAIL_PASS, // App Password එක (Gmail App Password)
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: subject,
    text: text,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;