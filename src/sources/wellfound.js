// Wellfound (AngelList) headless source.
// Uses Playwright to browse new company listings.
// Requires WELLFOUND_EMAIL and WELLFOUND_PASSWORD in .env.
//
// Approach:
//   1. Launch headless Chromium via Playwright.
//   2. Browse https://wellfound.com/companies — newest first.
//   3. Pull company name, tagline, website, location.
//   4. Close browser.

import { chromium } from "playwright";

const BASE = "https://wellfound.com";

export async function fetchWellfound({ maxResults = 30 }) {
  const email = process.env.WELLFOUND_EMAIL;
  const password = process.env.WELLFOUND_PASSWORD;

  if (!email || !password) {
    console.warn("[wellfound] WELLFOUND_EMAIL / WELLFOUND_PASSWORD not set — skipping");
    return [];
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // 1. Login
    console.log("[wellfound] logging in...");
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector('input[name="user[email]"]', { timeout: 10000 });

    await page.fill('input[name="user[email]"]', email);
    await page.fill('input[name="user[password]"]', password);
    await page.click('input[type="submit"]');

    // Wait for navigation after login
    await page.waitForURL("**/dashboard**", { timeout: 15000 }).catch(() => {
      // Might land on home or feed — that's fine
    });
    console.log("[wellfound] logged in");

    // 2. Browse newest companies
    console.log("[wellfound] fetching newest companies...");
    await page.goto(`${BASE}/companies?sort=created_desc`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for cards to render
    await page.waitForSelector('[class*="styles_component"]', { timeout: 15000 }).catch(() => {
      // Fallback: wait for any link or content
    });

    // Small scroll to trigger lazy load
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(2000);

    // 3. Extract company data
    const companies = await page.evaluate(() => {
      const items = [];
      // Try multiple selectors — Wellfound shuffles class names
      const selectors = [
        'a[class*="startup-link"]',
        'a[href*="/company/"]',
        '[class*="startup_card"]',
        '[class*="company_card"]',
        "tr.clickable",
      ];

      const links = new Set();
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const link = el.closest("a") || el;
          const href = link.getAttribute("href") || "";
          if (href.startsWith("/company/") && !links.has(href)) {
            links.add(href);
          }
        });
      }

      // If we found links by class, try extracting visible data
      if (links.size === 0) {
        // Fallback: standalone extraction from page text
        document.querySelectorAll("a").forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (href.startsWith("/company/") && !links.has(href) && a.textContent.trim()) {
            links.add(href);
          }
        });
      }

      // Extract visible info for each link
      for (const href of links) {
        const a = document.querySelector(`a[href="${href}"]`);
        if (!a) continue;

        const card = a.closest("[class]") || a;
        const name = (
          card.querySelector('[class*="name"]') ||
          card.querySelector("h2, h3, h4, strong") ||
          a
        )?.textContent?.trim();

        const tagline = (
          card.querySelector('[class*="tagline"]') ||
          card.querySelector('[class*="description"]') ||
          card.querySelector("p")
        )?.textContent?.trim();

        const website = (
          card.querySelector('[class*="website"]') ||
          card.querySelector('a[href*="http"]')
        )?.getAttribute("href")?.trim();

        const location = (
          card.querySelector('[class*="location"]') ||
          card.querySelector('[class*="market"]')
        )?.textContent?.trim();

        if (name && name.length < 100) {
          items.push({ href, name, tagline: tagline || "", website: website || "", location: location || "" });
        }
      }
      return items;
    });

    console.log(`[wellfound] extracted ${companies.length} companies`);
    await browser.close();
    browser = null;

    // 4. Normalize to our format
    return normalizeResults(companies, maxResults);
  } catch (err) {
    console.error(`[wellfound] error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
}

function normalizeResults(companies, maxResults) {
  return companies.slice(0, maxResults).map((c) => {
    // Build a stable-ish key from the URL slug
    const slug = c.href.replace("/company/", "").split("?")[0];
    const website = c.website || `https://${slug.toLowerCase().replace(/\s+/g, "")}.com`;

    return {
      source: "wellfound",
      key: `wf:${slug}`,
      name: c.name,
      tagline: c.tagline,
      description: c.tagline + (c.location ? ` — ${c.location}` : ""),
      votes: 0,
      listingUrl: `${BASE}${c.href}`,
      website,
      topics: [],
    };
  });
}
