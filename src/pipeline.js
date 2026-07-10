// Launch-outreach pipeline.
//
//   node src/pipeline.js scan     → fetch launches, match genre, find emails, write drafts to outbox/
//   node src/pipeline.js send     → review drafts marked "approved": true, send them
//   node src/pipeline.js send --all-approved-now   (same, alias)
//   node src/pipeline.js status   → counts
//
// Drafts land in outbox/<key>.json with "approved": false.
// You review each file, flip approved to true (or delete the file), then run send.

import fs from "node:fs";
import path from "node:path";

// Load .env sitting next to package.json (cron won't have shell env)
const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
import { fetchProductHunt } from "./sources/producthunt.js";
import { fetchShowHN } from "./sources/showhn.js";
import { fetchSaaSHub } from "./sources/saashub.js";
import { fetchBetaList } from "./sources/betalist.js";
import { findContactEmail } from "./enrich/findEmail.js";
import { draftEmail } from "./outreach/draft.js";
import { sendEmail, buildFooter, sleep } from "./outreach/send.js";
import { sendFollowUps } from "./outreach/followup.js";
import { checkReplies } from "./outreach/replyHandler.js";
import { sendDraftPreview } from "./telegram-bot.js";
import {
  loadState, saveState, markSeen, alreadySeen,
  alreadyEmailed, sentToday, logSent,
} from "./state.js";

const OUTBOX = path.resolve("outbox");
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"));

function assertConfigured() {
  if (config.product.name === "YOUR PRODUCT NAME") {
    console.error("Edit config.json first — product name/description still placeholders.");
    process.exit(1);
  }
}

// Auto mode sends without human review — hold it to a stricter bar.
function assertAutoSafe() {
  const problems = [];
  if (config.email.postalAddress.startsWith("YOUR REAL"))
    problems.push("config.json → email.postalAddress is still a placeholder (CAN-SPAM requires a real postal address)");
  if (!process.env.SMTP_PASSWORD && !process.env.RESEND_API_KEY)
    problems.push("no send provider in .env — set SMTP_PASSWORD (own mailbox) or RESEND_API_KEY");
  if (!process.env.NVIDIA_API_KEY) problems.push("NVIDIA_API_KEY missing in .env");
  if (problems.length) {
    console.error("Auto mode blocked:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
}

async function scan(autoApprove = false) {
  assertConfigured();
  const state = loadState();

  // 1. Gather launches
  const candidates = [];
  if (config.sources.productHunt.enabled) {
    candidates.push(
      ...(await fetchProductHunt({
        topN: config.sources.productHunt.topN,
        token: process.env.PH_ACCESS_TOKEN,
      }))
    );
  }
  if (config.sources.showHN.enabled) {
    candidates.push(...(await fetchShowHN({ hoursBack: config.sources.showHN.hoursBack })));
  }
  if (config.sources.betalist.enabled) {
    candidates.push(...(await fetchBetaList({ maxResults: config.sources.betalist.maxResults || 20 })));
  }
  if (config.sources.saashub.enabled) {
    candidates.push(...(await fetchSaaSHub({ maxResults: config.sources.saashub.maxResults || 20 })));
  }
  console.log(`Fetched ${candidates.length} launches`);

  // 2. Skip already-seen
  const fresh = candidates.filter((c) => !alreadySeen(state, c.key));
  fresh.forEach((c) => markSeen(state, c.key));
  console.log(`${fresh.length} new since last scan`);
  if (fresh.length === 0) { saveState(state); return; }

  // 3. Skip scoring — send to ALL fresh launches (broad outreach to every PH + HN product)
  const matches = fresh;
  console.log(`${matches.length} prospects — all passed through (broad outreach mode, no scoring)`);

  // 4. Find contact email + 5. draft
  fs.mkdirSync(OUTBOX, { recursive: true });
  let drafted = 0;
  for (const prospect of matches) {
    process.stdout.write(`  ${prospect.name} ... `);

    const { email, website, domain } = await findContactEmail(prospect.website);
    if (!email) { console.log("no email found, skipped"); continue; }
    if (alreadyEmailed(state, email)) { console.log(`${email} already contacted/suppressed, skipped`); continue; }

    const draft = await draftEmail(config, prospect);

    const file = path.join(OUTBOX, `${prospect.key.replace(/[^a-z0-9]/gi, "_")}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          approved: true,
          to: email,
          subject: draft.subject,
          body: draft.body,
          preview_footer: buildFooter(config),
          prospect: {
            name: prospect.name,
            website,
            domain,
            listing: prospect.listingUrl,
            source: prospect.source,
          },
        },
        null,
        2
      )
    );
    drafted++;
    console.log(`draft → ${path.relative(process.cwd(), file)} (${email})`);
  }

  saveState(state);
  if (autoApprove) console.log(`\n${drafted} drafts auto-approved.`);
  else console.log(`\n${drafted} drafts in outbox/. Review each file, set "approved": true, then: npm run send`);
}

async function send() {
  assertConfigured();
  const state = loadState();

  if (!fs.existsSync(OUTBOX)) { console.log("outbox/ empty"); return; }
  const files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json"));
  const approved = files
    .map((f) => ({ file: path.join(OUTBOX, f), draft: JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8")) }))
    .filter((d) => d.draft.approved === true);

  if (approved.length === 0) {
    console.log(`No approved drafts (${files.length} pending review in outbox/).`);
    return;
  }

  const budget = config.email.maxPerDay - sentToday(state);
  if (budget <= 0) {
    console.log(`Daily cap of ${config.email.maxPerDay} already reached. Try tomorrow.`);
    return;
  }

  const toSend = approved.slice(0, budget);
  console.log(`Sending ${toSend.length} of ${approved.length} approved (daily budget: ${budget})`);

  for (const [i, { file, draft }] of toSend.entries()) {
    if (alreadyEmailed(state, draft.to)) {
      console.log(`  skip ${draft.to} — already contacted`);
      fs.unlinkSync(file);
      continue;
    }
    try {
      await sendEmail(config, draft);
      logSent(state, { email: draft.to, product: draft.prospect.name, subject: draft.subject });
      saveState(state);
      fs.renameSync(file, file.replace(/\.json$/, ".sent.json"));
      console.log(`  sent → ${draft.to} (${draft.prospect.name})`);
    } catch (err) {
      console.error(`  FAILED ${draft.to}: ${err.message}`);
    }
    if (i < toSend.length - 1) await sleep(config.email.delaySecondsBetweenSends);
  }
}

function status() {
  const state = loadState();
  const pending = fs.existsSync(OUTBOX)
    ? fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json") && !f.endsWith(".sent.json")).length
    : 0;
  console.log(`Seen products : ${Object.keys(state.seen).length}`);
  console.log(`Emails sent   : ${state.sent.length} (today: ${sentToday(state)}/${config.email.maxPerDay})`);
  console.log(`Suppressed    : ${state.suppress.length}`);
  console.log(`Outbox pending: ${pending}`);
}

async function reviewOnTelegram() {
  if (!fs.existsSync(OUTBOX)) { console.log("No outbox/ — nothing to review."); return; }
  const files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json") && !f.endsWith(".sent.json"));
  if (files.length === 0) { console.log("No pending drafts to review."); return; }

  let sent = 0;
  for (const file of files) {
    const draft = JSON.parse(fs.readFileSync(path.join(OUTBOX, file), "utf8"));
    draft.file = path.join(OUTBOX, file);
    try {
      await sendDraftPreview(draft);
      console.log(`  sent to Telegram: ${file} → ${draft.to} (${draft.prospect.name})`);
      sent++;
    } catch (err) {
      console.error(`  FAILED sending ${file} to Telegram: ${err.message}`);
    }
  }
  console.log(`\n${sent} drafts sent to Telegram for review.`);
  console.log("The Telegram bot (poll mode) will handle approve/reject and sending.");
}

const cmd = process.argv[2];
if (cmd === "scan") await scan();
else if (cmd === "send") await send();
else if (cmd === "auto") {
  // Full hands-off run: scan, auto-approve every draft, send immediately.
  // Daily cap, pacing, dedupe, and suppression still apply.
  assertAutoSafe();
  await scan(true);
  await send();
}
else if (cmd === "followup") {
  // Send follow-up emails for non-converting prospects
  assertConfigured();
  await sendFollowUps(config);
}
else if (cmd === "check-replies") {
  // Check inbox for replies to sent outreach
  assertConfigured();
  await checkReplies(config);
}
else if (cmd === "status") status();
else if (cmd === "review") {
  // Scan + send drafts to Telegram for manual approval
  await scan(false);
  await reviewOnTelegram();
}
else console.log("Usage: node src/pipeline.js scan | send | auto | followup | check-replies | review | status");
