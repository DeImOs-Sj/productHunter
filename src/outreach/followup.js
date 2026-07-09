// Follow-up sequence for non-converting prospects.
// Sends follow-up emails at day 3 and day 7 after initial outreach.
import { chatJSON } from "../llm.js";
import { sendEmail, buildFooter, sleep } from "./send.js";
import { loadState, saveState } from "../state.js";

const LINK_URL = "https://surli.cc/doclbs";
const DAY_MS = 24 * 3600 * 1000;

export async function sendFollowUps(config) {
  const state = loadState();
  const now = Date.now();
  let sent = 0;

  for (const entry of state.sent) {
    // Skip if no initial date or already sent all follow-ups
    if (!entry.date) continue;
    if ((entry.followUpSent || 0) >= 2) continue; // max 2 follow-ups

    const initialDate = new Date(entry.date).getTime();
    const daysSince = (now - initialDate) / DAY_MS;
    const followUpNum = entry.followUpSent || 0;

    // Follow-up 1 at day 3, Follow-up 2 at day 7
    const shouldSend =
      (followUpNum === 0 && daysSince >= 3) ||
      (followUpNum === 1 && daysSince >= 7);

    if (!shouldSend) continue;

    const subject = followUpNum === 0
      ? `re: ${entry.product}`
      : `one more thing, ${entry.product}`;

    const body = followUpNum === 0
      ? `Hey — circling back on this. If your launch is picking up steam, now's the time to see whether AI answer engines are citing your site or skipping it entirely.\n\nMost founders tell me they have no idea how they show up in ChatGPT or Gemini until they actually check. The scan takes about 90 seconds and shows your full citation map across ChatGPT, Gemini, Perplexity, Claude, and Copilot.\n\nWorth a look? ${LINK_URL}\n\n${config.product.senderName}, ${config.product.senderRole}`
      : `Last note on this — we've scanned over a dozen launch-week sites in the past week, and the results are almost always the same: most are invisible in AI answers on launch day, and the fix takes less than an afternoon.\n\nYour scan is still free — no card, no signup. See where you stand: ${LINK_URL}\n\nWon't bother you again either way.\n\n${config.product.senderName}, ${config.product.senderRole}`;

    try {
      await sendEmail(config, { to: entry.email, subject, body });
      entry.followUpSent = (entry.followUpSent || 0) + 1;
      if (!entry.followUpDates) entry.followUpDates = [];
      entry.followUpDates.push(new Date().toISOString());
      saveState(state);
      console.log(`  follow-up ${followUpNum + 1} → ${entry.email} (${entry.product})`);
      sent++;
    } catch (err) {
      console.error(`  FAILED follow-up ${entry.email}: ${err.message}`);
    }

    await sleep(config.email.delaySecondsBetweenSends || 120);
  }

  if (sent === 0) console.log("  no follow-ups due today");
  return sent;
}
