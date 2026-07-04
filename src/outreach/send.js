// Send approved drafts, with CAN-SPAM footer, daily cap, and pacing.
//
// Provider is picked from .env:
//   SMTP_PASSWORD set  → send through your own mailbox via SMTP
//                        (defaults to Namecheap Private Email: mail.privateemail.com)
//   RESEND_API_KEY set → send through Resend's API
import nodemailer from "nodemailer";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function buildFooter(config) {
  return [
    "",
    "—",
    `${config.product.senderName} · ${config.product.name} · ${config.product.url}`,
    config.email.postalAddress,
    `Not interested? Reply "unsubscribe" and you won't hear from me again.`,
  ].join("\n");
}

let smtpTransport;
function getSmtpTransport(config) {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "mail.privateemail.com",
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER || config.email.replyTo,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }
  return smtpTransport;
}

async function sendViaSmtp(config, { to, subject, body }) {
  return getSmtpTransport(config).sendMail({
    from: config.email.from,
    to,
    replyTo: config.email.replyTo,
    subject,
    text: body + buildFooter(config),
  });
}

async function sendViaResend(config, { to, subject, body }) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [to],
      reply_to: config.email.replyTo,
      subject,
      text: body + buildFooter(config),
    }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function sendEmail(config, draft) {
  if (process.env.SMTP_PASSWORD) return sendViaSmtp(config, draft);
  if (process.env.RESEND_API_KEY) return sendViaResend(config, draft);
  throw new Error("No send provider configured: set SMTP_PASSWORD (own mailbox) or RESEND_API_KEY in .env");
}

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
