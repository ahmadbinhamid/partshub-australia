// src/services/email/mailer.js

const nodemailer = require("nodemailer");
const { logger } = require("../../loaders/logging");
const config = require("../../config");
const { getTransporterForTenant } = require("./smtp.keys.service");

// Platform transporter — used for platform-level system email (login OTP,
// password reset, account verified) always, and as the fallback for
// tenant-facing email when a tenant hasn't configured their own SMTP yet
// (see sendEmail's tenantId branch below).
const platformTransporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465, // implicit TLS on 465; 587/25/2525 use STARTTLS
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
  // Pooled + rate-limited: without this, concurrent worker jobs each open
  // their own SMTP connection and blast sends at once, which trips
  // "too many emails per second" on throttled sandboxes. Pooling paces
  // sends through the configured limit instead of firing them all at once.
  pool: true,
  maxConnections: config.smtp.maxConnections,
  rateLimit: config.smtp.rateLimit,
  rateDelta: config.smtp.rateDeltaMs,
});

// `from` is a full pre-built "Name <address>" string — used verbatim,
// regardless of which transporter ends up sending it. Only safe for
// platform-level sends (OTP, password reset, ...), which always go out
// through the platform's own verified mailbox.
//
// `fromName` is a display-name-only alternative for customer-facing order
// email (see email.service.js) — its actual address portion depends on
// which transporter is used, so it can't be pre-built by the caller: most
// SMTP providers (Gmail, Office 365, ...) reject or spam-flag a From address
// that doesn't match the authenticated mailbox, so a tenant's own SMTP send
// MUST use their own address, never the platform's.
//
// tenantId is only ever passed for customer-facing order email — every
// platform-level send omits it and always uses the platform mailbox.
async function sendEmail({ from, to, subject, html, text, attachments, tenantId, fromName }) {
  let transporter = platformTransporter;
  let resolvedFrom = from;

  if (!resolvedFrom && tenantId) {
    const tenantSmtp = await getTransporterForTenant(tenantId);
    if (tenantSmtp) {
      transporter = tenantSmtp.transporter;
      resolvedFrom = `"${fromName || tenantSmtp.creds.fromName || tenantSmtp.creds.user}" <${tenantSmtp.creds.fromEmail || tenantSmtp.creds.user}>`;
    }
    // No tenant SMTP configured — falls through to the platform transporter
    // below, matching the pre-BYOK behaviour instead of failing the send.
  }

  if (!resolvedFrom) {
    resolvedFrom = `"${fromName || config.emailBrand.fromName}" <${config.emailBrand.fromEmail}>`;
  }

  const mail = { from: resolvedFrom, to, subject, html, text, attachments };
  try {
    await transporter.sendMail(mail);
    return true;
  } catch (err) {
    logger.error(`Email send failed: ${err.message}`, err);
    return false;
  }
}

module.exports = { sendEmail };
