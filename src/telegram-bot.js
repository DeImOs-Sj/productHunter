// Telegram bot — sends draft previews for user approval, then triggers send.
//
// Two modes:
//   1. node src/telegram-bot.js get-chatid   — start bot, ask user to message it, save chat ID
//   2. node src/telegram-bot.js poll          — long-poll for button clicks, handle approve/reject
//
// Exported for use by pipeline:
//   sendDraftPreview(draftObj) — sends a single draft to the configured chat

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Load .env (same pattern as pipeline.js)
const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set in .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ENV_FILE = path.resolve(".env");

// ── helpers ──────────────────────────────────────────────────────────
async function api(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description}`);
  return data;
}

function getChatId() {
  // Check process.env first (set from .env in pipeline.js)
  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
  // Fallback: read from .env directly
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const m = env.match(/^TELEGRAM_CHAT_ID=(.+)$/m);
  return m ? m[1].trim() : null;
}

function saveChatId(id) {
  let env = fs.readFileSync(ENV_FILE, "utf8");
  if (env.includes("TELEGRAM_CHAT_ID=")) {
    env = env.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${id}`);
  } else {
    env += `\n# Telegram — chat ID for review approval\nTELEGRAM_CHAT_ID=${id}\n`;
  }
  fs.writeFileSync(ENV_FILE, env);
  process.env.TELEGRAM_CHAT_ID = id;
  console.log(`Chat ID ${id} saved to .env`);
}

// ── send draft preview to user ───────────────────────────────────────
export async function sendDraftPreview(draft) {
  const cid = getChatId();
  if (!cid) throw new Error("TELEGRAM_CHAT_ID not set — run 'node src/telegram-bot.js get-chatid' first");

  const prospect = draft.prospect;
  const msg = [
    `📧 *New draft: ${prospect.name}*`,
    `To: \`${draft.to}\``,
    `Score: ${prospect.score}/10 — ${prospect.matchReason || ""}`,
    `Source: ${prospect.source}`,
    `Listing: ${prospect.listing}`,
    ``,
    `*Subject:* ${draft.subject}`,
    ``,
    `*Body:*`,
    draft.body,
    ``,
    `*Footer:*`,
    draft.preview_footer,
  ].join("\n");
  // Send as plain message — user approves/rejects via chat with the agent
  const result = await api("sendMessage", {
    chat_id: cid,
    text: msg + `\n\n_Reply to approve or suggest changes._`,
    parse_mode: "Markdown",
  });
  return result;
}

// ── handle callback queries ──────────────────────────────────────────
async function handleCallback(query) {
  const data = query.data; // e.g. "approve:outbox/foo.json"
  const [action, filePath] = data.split(":");
  const absPath = path.resolve(filePath);
  const cid = query.message.chat.id;
  const msgId = query.message.message_id;

  if (!fs.existsSync(absPath)) {
    await api("editMessageText", {
      chat_id: cid,
      message_id: msgId,
      text: `⚠️ Draft already processed or deleted:\n\`${filePath}\``,
      parse_mode: "Markdown",
    });
    return;
  }

  if (action === "reject") {
    fs.unlinkSync(absPath);
    await api("editMessageText", {
      chat_id: cid,
      message_id: msgId,
      text: `❌ Rejected — draft deleted:\n\`${filePath}\``,
      parse_mode: "Markdown",
    });
    console.log(`Rejected: ${filePath}`);
    return;
  }

  if (action === "approve") {
    // Mark approved
    const draft = JSON.parse(fs.readFileSync(absPath, "utf8"));
    draft.approved = true;
    fs.writeFileSync(absPath, JSON.stringify(draft, null, 2));

    await api("editMessageText", {
      chat_id: cid,
      message_id: msgId,
      text: `✅ *Approved!* Sending now…\n\`${filePath}\``,
      parse_mode: "Markdown",
    });

    // Run send via child process (non-blocking)
    const child = spawn("node", ["src/pipeline.js", "send"], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("close", async (code) => {
      const result = code === 0
        ? `✅ *Sent successfully!*`
        : `❌ *Send failed (exit ${code})*`;
      await api("sendMessage", {
        chat_id: cid,
        text: `${result}\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\``,
        parse_mode: "Markdown",
      });
    });

    console.log(`Approved: ${filePath}, send triggered`);
  }
}

// ── relay file for text messages ─────────────────────────────────────
const RELAY_FILE = path.resolve("telegram-relay.jsonl");

function appendRelay(msg) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    chat_id: msg.chat.id,
    from: msg.from?.first_name || msg.from?.id,
    text: msg.text,
  }) + "\n";
  fs.appendFileSync(RELAY_FILE, line, "utf8");
  // Keep only last 50 entries to avoid unbounded growth
  const lines = fs.readFileSync(RELAY_FILE, "utf8").trim().split("\n");
  if (lines.length > 50) {
    fs.writeFileSync(RELAY_FILE, lines.slice(-50).join("\n") + "\n", "utf8");
  }
}

// ── handle text messages from the authorized user ────────────────────
async function handleMessage(msg) {
  const cid = getChatId();
  if (!cid) return; // no authorized user yet — ignore

  // Only accept messages from the authorized chat
  if (String(msg.chat.id) !== String(cid)) return;

  const text = (msg.text || "").trim();
  if (!text) return;

  // Write to relay file so the agent can pick it up
  appendRelay(msg);

  console.log(`Relay from Telegram: ${text.slice(0, 80)}`);

  // Acknowledge to the user
  await api("sendMessage", {
    chat_id: cid,
    text: `📨 Got it! Relaying to the agent:\n\n> ${text.slice(0, 200)}`,
    parse_mode: "Markdown",
  });
}

// ── long polling loop ────────────────────────────────────────────────
async function pollLoop() {
  let offset = 0;
  console.log("Telegram bot polling started (approvals + relay)...");
  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["callback_query","message"]`
      );
      const data = await res.json();
      if (!data.ok) {
        console.error("Poll error:", data.description);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          // Answer callback immediately so Telegram stops the loading spinner
          await api("answerCallbackQuery", {
            callback_query_id: update.callback_query.id,
            text: "Processing...",
          });
          await handleCallback(update.callback_query);
        }
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (err) {
      console.error("Poll error:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ── chat ID discovery ────────────────────────────────────────────────
async function getChatIdFlow() {
  console.log("🤖 Bot started. Send any message to @launchOut... and I'll capture your chat ID.");
  console.log("Waiting up to 60 seconds for you to message the bot...");

  let offset = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${API}/getUpdates?timeout=10&offset=${offset}`
    );
    const data = await res.json();
    if (data.ok) {
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        if (update.message?.from?.id && update.message.chat.type === "private") {
          const id = update.message.chat.id;
          saveChatId(id);
          await api("sendMessage", {
            chat_id: id,
            text: `✅ Chat ID captured! You'll get draft reviews here from now on.`,
          });
          return id;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("No message received within 60 seconds. Run again and message the bot.");
  process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────
const isMain = process.argv[1] && (
  process.argv[1] === import.meta.filename ||
  process.argv[1].endsWith("/telegram-bot.js")
);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "get-chatid") {
    await getChatIdFlow();
  } else if (cmd === "poll") {
    if (!getChatId()) {
      console.error("TELEGRAM_CHAT_ID not set. Run 'node src/telegram-bot.js get-chatid' first.");
      process.exit(1);
    }
    await pollLoop();
  } else {
    console.log("Usage:");
    console.log("  node src/telegram-bot.js get-chatid   — discover your chat ID");
    console.log("  node src/telegram-bot.js poll          — start polling for approvals");
  }
}
