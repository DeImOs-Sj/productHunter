// Send approved drafts, with CAN-SPAM footer, daily cap, and pacing.
//
// Provider is picked from .env:
//   SMTP_PASSWORD set  → send through your own mailbox via SMTP
//                        (defaults to Namecheap Private Email: mail.privateemail.com)
//   RESEND_API_KEY set → send through Resend's API
import nodemailer from "nodemailer";
import IMAP from "imap";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Build a raw RFC822 message from parts.
 */
function buildRawMessage(config, { to, subject, body }) {
  const date = new Date().toUTCString();
  const text = body + buildFooter(config);
  return [
    `From: ${config.email.from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
  ].join("\r\n");
}

/**
 * Append a copy of a sent message to the IMAP Sent folder so it shows
 * in the webmail "Sent" view.  Reuses the SMTP credentials.
 */
function appendToSentFolder(config, rawMessage) {
  return new Promise((resolve, reject) => {
    const imap = new IMAP({
      user: process.env.SMTP_USER || config.email.replyTo,
      password: process.env.SMTP_PASSWORD,
      host: process.env.SMTP_HOST || "mail.privateemail.com",
      port: 993,
      tls: true,
    });

    const SENT_FOLDERS = ["Sent", "Sent Messages", "INBOX.Sent", "INBOX.Sent Messages"];

    imap.once("ready", () => {
      // Try common folder names for Sent
      (function tryFolder(idx) {
        if (idx >= SENT_FOLDERS.length) {
          imap.end();
          resolve(); // non-fatal — email was already delivered
          return;
        }
        const folder = SENT_FOLDERS[idx];
        imap.openBox(folder, false, (err) => {
          if (err) return tryFolder(idx + 1);
          imap.append(rawMessage, { mailbox: folder }, (appendErr) => {
            if (appendErr) {
              // try next folder name
              imap.closeBox(false, () => tryFolder(idx + 1));
            } else {
              imap.end();
              resolve();
            }
          });
        });
      })(0);
    });

    imap.once("error", (err) => {
      resolve(); // non-fatal — email was already sent via SMTP
    });

    imap.connect();
  });
}

export function buildFooter(config) {
  return [
    "",
    "—",
    `${config.product.senderName} · ${config.product.name} · ${config.product.url}`,
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
  const rawMsg = buildRawMessage(config, { to, subject, body });
  const result = await getSmtpTransport(config).sendMail({
    from: config.email.from,
    to,
    replyTo: config.email.replyTo,
    subject,
    text: body + buildFooter(config),
  });
  // Save a copy to the IMAP Sent folder so it appears in webmail
  await appendToSentFolder(config, rawMsg).catch(() => {});
  return result;
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
