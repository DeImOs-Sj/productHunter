// SaaSHub source — fetches recently submitted products from SaaSHub's Submit section.
// Uses the Playwright-based Python scraper for better extraction with website URLs.
//
// Usage: npm run scan (includes this as part of the full pipeline)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");  // src/sources/ -> root
const SCRAPER = path.join(ROOT, "scrapers", "saashub_scraper.py");
const VENV_PYTHON = path.join(ROOT, ".venv", "bin", "python3");
const BROWSERS_PATH = path.join(ROOT, ".browsers");

export async function fetchSaaSHub({ maxResults = 30 } = {}) {
  // Try the Playwright scraper first
  try {
    const results = await runPlaywrightScraper(maxResults);
    if (results.length > 0) return results;
  } catch (err) {
    console.warn(`[saashub] Playwright scraper failed: ${err.message}`);
  }

  // Fallback: try the static JSON endpoint
  try {
    return await fetchStaticResults(maxResults);
  } catch {
    return [];
  }
}

async function runPlaywrightScraper(maxResults) {
  return new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, [SCRAPER, "--max", String(maxResults)], {
      cwd: ROOT,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        console.warn(`[saashub] scraper exited ${code}: ${stderr.trim()}`);
        resolve([]);
        return;
      }

      // stderr has progress messages, stdout has JSON lines
      const lines = stdout.trim().split("\n").filter(Boolean);
      const results = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.source === "saashub" && obj.name) {
            results.push(obj);
          }
        } catch {
          // skip non-JSON lines (progress messages on stdout)
        }
      }

      resolve(results);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

async function fetchStaticResults(maxResults) {
  // Fallback: try the SaaSHub products JSON endpoint
  const BASE = "https://www.saashub.com";
  const res = await fetch(`${BASE}/products.json?sort=newest&limit=${maxResults}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; WebCited/1.0)" },
  });

  if (!res.ok) return [];

  const json = await res.json();
  const items = Array.isArray(json) ? json : json.products || json.data || [];

  return items
    .slice(0, maxResults)
    .filter((item) => item.name || item.title)
    .map((item) => {
      const name = item.name || item.title || "";
      return {
        source: "saashub",
        key: `sh:${(item.slug || name).toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
        name,
        tagline: (item.tagline || item.description || "").slice(0, 120),
        description: item.description || item.tagline || "",
        votes: item.votes || item.rating || 0,
        listingUrl: item.url || `${BASE}/${item.slug || ""}`,
        website: item.website || item.site_url || "",
        topics: (item.categories || item.tags || []).map((c) =>
          typeof c === "string" ? c : c.name || ""
        ).filter(Boolean),
      };
    });
}
