// Continuous scraping daemon.
// Runs each source on its own interval and feeds prospects into the pipeline.
//
// Usage: npm run daemon
//
// Stops cleanly on SIGINT/SIGTERM.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Load .env
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
import { scoreProspects } from "./analyze/match.js";
import { findContactEmail } from "./enrich/findEmail.js";
import { draftEmail } from "./outreach/draft.js";
import { sendEmail, buildFooter, sleep } from "./outreach/send.js";
import { sendDraftPreview } from "./telegram-bot.js";
import {
  loadState, saveState, markSeen, alreadySeen,
  alreadyEmailed,
} from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTBOX = path.join(ROOT, "outbox");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const VENV_PYTHON = path.join(ROOT, ".venv", "bin", "python3");
const BROWSERS_PATH = path.join(ROOT, ".browsers");

// ── Source configurations ──────────────────────────────────────
// Each source has: name, enabled, interval (ms), fetch function
const SOURCES = [
  {
    name: "productHunt",
    intervalMs: 12 * 3600 * 1000, // twice a day
    fetchFn: async () => {
      if (!config.sources.productHunt?.enabled) return [];
      return fetchProductHunt({
        topN: config.sources.productHunt.topN || 40,
        token: process.env.PH_ACCESS_TOKEN,
      });
    },
  },
  {
    name: "showHN",
    intervalMs: 6 * 3600 * 1000, // 4x a day
    fetchFn: async () => {
      if (!config.sources.showHN?.enabled) return [];
      return fetchShowHN({ hoursBack: config.sources.showHN.hoursBack || 24 });
    },
  },
  {
    name: "crunchbase",
    intervalMs: 12 * 3600 * 1000,
    fetchFn: async () => {
      if (!config.sources.crunchbase?.enabled) return [];
      return runPythonScraper("crunchbase.py", config.sources.crunchbase.maxResults || 30);
    },
  },
  {
    name: "wellfound",
    intervalMs: 6 * 3600 * 1000,
    fetchFn: async () => {
      if (!config.sources.wellfound?.enabled) return [];
      return runPythonScraper("wellfound.py", config.sources.wellfound.maxResults || 30);
    },
  },
  {
    name: "saashub",
    intervalMs: 12 * 3600 * 1000,
    fetchFn: async () => {
      if (!config.sources.saashub?.enabled) return [];
      return runPythonScraper("saashub_playwright.py", config.sources.saashub.maxResults || 20);
    },
  },
  {
    name: "betalist",
    intervalMs: 12 * 3600 * 1000,
    fetchFn: async () => {
      if (!config.sources.betalist?.enabled) return [];
      return fetchBetaList({ maxResults: config.sources.betalist.maxResults || 30 });
    },
  },
];

// ── Python scraper runner ──────────────────────────────────────
async function runPythonScraper(script, maxResults) {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, "scrapers", script);
    if (!fs.existsSync(scriptPath)) {
      console.warn(`[daemon] scraper not found: ${scriptPath}`);
      return resolve([]);
    }

    const args = ["--max", String(maxResults)];
    const env = {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
    };

    const proc = spawn(VENV_PYTHON, [scriptPath, ...args], {
      env,
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const results = [];
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const lines = chunk.toString("utf8").trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          results.push(JSON.parse(line));
        } catch {
          stderr += line + "\n";
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("close", (code) => {
      if (code !== 0 && results.length === 0) {
        console.warn(`[daemon] ${script} exited ${code}: ${stderr.slice(0, 200)}`);
      }
      if (stderr.trim()) {
        for (const line of stderr.trim().split("\n")) {
          console.log(`  ${line}`);
        }
      }
      resolve(results);
    });

    proc.on("error", (err) => {
      console.warn(`[daemon] failed to start ${script}: ${err.message}`);
      resolve([]);
    });

    // 2-minute timeout per scraper run
    setTimeout(() => {
      proc.kill();
      resolve(results);
    }, 120_000);
  });
}

// ── Pipeline: score → enrich → draft → Telegram ───────────────
async function processProspects(prospects, sourceName) {
  if (prospects.length === 0) return;

  const state = loadState();

  // Dedupe against state
  const fresh = prospects.filter((p) => !alreadySeen(state, p.key));
  if (fresh.length === 0) {
    console.log(`  [${sourceName}] all ${prospects.length} already seen`);
    return;
  }

  fresh.forEach((p) => markSeen(state, p.key));
  console.log(`  [${sourceName}] ${fresh.length} new prospects`);

  // Score for relevance
  const scored = await scoreProspects(config, fresh);
  const matches = scored
    .filter((p) => p.score >= config.targeting.minRelevanceScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.targeting.maxProspectsPerScan);

  if (matches.length === 0) {
    console.log(`  [${sourceName}] 0 relevant prospects (all below ${config.targeting.minRelevanceScore}/10)`);
    saveState(state);
    return;
  }
  console.log(`  [${sourceName}] ${matches.length} relevant prospects`);

  // Enrich + draft
  fs.mkdirSync(OUTBOX, { recursive: true });
  let drafted = 0;

  for (const prospect of matches) {
    process.stdout.write(`  → ${prospect.name} (${prospect.score}/10) ... `);

    const { email } = await findContactEmail(prospect.website);
    if (!email) { console.log("no email"); continue; }
    if (alreadyEmailed(state, email)) { console.log("already contacted"); continue; }

    const draft = await draftEmail(config, prospect);

    const file = path.join(OUTBOX, `${prospect.key.replace(/[^a-z0-9]/gi, "_")}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          approved: false,
          to: email,
          subject: draft.subject,
          body: draft.body,
          preview_footer: buildFooter(config),
          prospect: {
            name: prospect.name,
            website: prospect.website,
            domain: new URL(prospect.website).hostname,
            listing: prospect.listingUrl,
            source: prospect.source,
            score: prospect.score,
            matchReason: prospect.matchReason,
          },
        },
        null,
        2,
      ),
    );
    drafted++;
    console.log(`drafted → ${email}`);
  }

  saveState(state);
  console.log(`  [${sourceName}] ${drafted} drafts written to outbox/`);

  // Send to Telegram for review
  if (drafted > 0) {
    const files = fs.readdirSync(OUTBOX)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".sent.json"))
      .map((f) => {
        const draft = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8"));
        draft.file = path.join(OUTBOX, f);
        return draft;
      });

    for (const draft of files) {
      try {
        await sendDraftPreview(draft);
        console.log(`  sent to Telegram: ${draft.prospect.name}`);
      } catch (err) {
        console.error(`  Telegram send failed: ${err.message}`);
      }
    }
  }
}

// ── Daemon main loop ────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  productHunter Continuous Daemon");
  console.log("═══════════════════════════════════════════");

  // Validate sources
  for (const src of SOURCES) {
    const enabled = config.sources[src.name]?.enabled;
    console.log(`  ${enabled ? "✅" : "⏸"} ${src.name} (every ${src.intervalMs / 3600000}h)`);
  }
  console.log("");

  // Track last run per source
  const lastRun = {};

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[daemon] shutting down...");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Main loop
  while (!shuttingDown) {
    const now = Date.now();

    for (const src of SOURCES) {
      const enabled = config.sources[src.name]?.enabled;
      if (!enabled) continue;

      const last = lastRun[src.name] || 0;
      if (now - last < src.intervalMs) continue;

      lastRun[src.name] = now;
      console.log(`\n── [${new Date().toISOString()}] ${src.name} ──`);

      try {
        const prospects = await src.fetchFn();
        console.log(`  fetched ${prospects.length} prospects`);
        await processProspects(prospects, src.name);
      } catch (err) {
        console.error(`  [${src.name}] ERROR: ${err.message}`);
      }
    }

    // Sleep 60 seconds between loop ticks
    if (!shuttingDown) {
      await sleep(60_000);
    }
  }
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
