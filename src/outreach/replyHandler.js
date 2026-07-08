// IMAP inbox monitor – catch replies to sent outreach emails.
//
// Runs on demand (node src/pipeline.js check-replies) or scheduled.
// - Detects "unsubscribe" → adds to suppression list
// - Detects positive replies (yes, scan, interested, etc.) → auto-replies with scan link
// - Flags unknown replies for manual review
//
import IMAP from "imap";
import nodemailer from "nodemailer";
import { loadState, saveState } from "../state.js";

const POSITIVE_PATTERNS = [
  /yes/i, /sure/i, /interested/i, /let'?s do it/i, /scan/i,
  /go ahead/i, /tell me more/i, /check it out/i, /ok/i, /okay/i,
];
const UNSUB_PATTERNS = [
  /unsubscribe/i, /stop/i, /don'?t (email|write|contact)/i,
  /remove/i, /leave me alone/i, /not interested/i,
];
const LINK_URL = "https://webcited.xyz";

function connectIMAP() {
  return new Promise((resolve, reject) => {
    const imap = new IMAP({
      user: process.env.SMTP_USER || "kiyo@webcited.xyz",
      password: process.env.SMTP_PASSWORD,
      host: process.env.SMTP_HOST || "mail.privateemail.com",
      port: 993,
      tls: true,
    });
    imap.once("ready", () => resolve(imap));
    imap.once("error", reject);
    imap.connect();
  });
}

function searchUnseen(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox("INBOX", false, (err, box) => {
      if (err) return reject(err);
      imap.search(["UNSEEN"], (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
      });
    });
  });
}

function fetchMessage(imap, uid) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch(uid, { bodies: ["HEADER", "TEXT"] });
    const msg = { uid, from: "", subject: "", text: "", date: null };
    f.on("message", (m) => {
      m.on("body", (stream, info) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk.toString("utf8")));
        stream.on("end", () => {
          if (info.which === "HEADER") {
            msg.from = data.match(/From: ([^\n]+)/)?.[1]?.trim() || "";
            msg.subject = data.match(/Subject: ([^\n]+)/)?.[1]?.trim() || "";
            msg.date = data.match(/Date: ([^\n]+)/)?.[1]?.trim() || null;
          } else {
            msg.text = data;
          }
        });
      });
    });
    f.once("error", reject);
    f.once("end", () => resolve(msg));
  });
}

function extractEmailAddress(fromHeader) {
  const m = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  return m ? m[1].toLowerCase().trim() : null;
}

function classifyReply(text) {
  const lower = text.toLowerCase();
  for (const p of UNSUB_PATTERNS) if (p.test(lower)) return "unsubscribe";
  for (const p of POSITIVE_PATTERNS) if (p.test(lower)) return "positive";
  return "unknown";
}

async function sendAutoReply(config, toEmail, type) {
  if (!process.env.SMTP_PASSWORD) return;

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "mail.privateemail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER || config.email.replyTo,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  const subject = type === "unsubscribe"
    ? "Re: your request"
    : "Re: your AI visibility scan";

  const body = type === "unsubscribe"
    ? `You're all set — you won't hear from me again.\n\n— ${config.product.senderName}`
    : `Great — head to ${LINK_URL}, enter your domain, and the scan runs in about 90 seconds. No card, no signup.\n\nYou'll see your full citation map across ChatGPT, Gemini, Perplexity, Claude, and Copilot — plus specific fixes for anything that's missing.\n\nLet me know if you have any questions!\n\n${config.product.senderName}, ${config.product.senderRole}`;

  await transport.sendMail({
    from: config.email.from,
    to: toEmail,
    replyTo: config.email.replyTo,
    subject,
    text: body,
  });
}

export async function checkReplies(config) {
  if (!process.env.SMTP_PASSWORD) {
    console.log("No SMTP_PASSWORD set — cannot check replies");
    return 0;
  }

  const state = loadState();
  let processed = 0;

  let imap;
  try {
    imap = await connectIMAP();
    const uids = await searchUnseen(imap);

    if (uids.length === 0) {
      console.log("No unseen replies in inbox");
      imap.end();
      return 0;
    }

    console.log(`Found ${uids.length} unseen messages in inbox`);

    for (const uid of uids) {
      try {
        const msg = await fetchMessage(imap, uid);
        const senderEmail = extractEmailAddress(msg.from);
        if (!senderEmail) {
          console.log(`  skip — couldn't extract email from: ${msg.from}`);
          continue;
        }

        const classification = classifyReply(msg.text + " " + msg.subject);
        console.log(`  [${classification}] ${senderEmail}: "${(msg.subject || "").slice(0, 80)}"`);

        if (classification === "unsubscribe") {
          // Add to suppression list
          if (!state.suppress.includes(senderEmail)) {
            state.suppress.push(senderEmail);
            saveState(state);
            console.log(`    → suppressed ${senderEmail}`);
          }
          // Also mark any sent entries for this email as suppressed
          for (const entry of state.sent) {
            if (entry.email === senderEmail) {
              entry.suppressed = true;
            }
          }
          saveState(state);
        }

        // Always auto-reply
        await sendAutoReply(config, senderEmail, classification);
        console.log(`    → auto-replied to ${senderEmail}`);
        processed++;
      } catch (err) {
        console.error(`  ERROR processing UID ${uid}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`IMAP connection error: ${err.message}`);
  } finally {
    if (imap) imap.end();
  }

  console.log(`\nProcessed ${processed} replies`);
  return processed;
}
