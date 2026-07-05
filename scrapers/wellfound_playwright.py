#!/usr/bin/env python3
"""
Wellfound (AngelList) scraper using Playwright directly (no crawl4ai).

Usage:
  source .venv/bin/activate && \
  PLAYWRIGHT_BROWSERS_PATH=./.browsers python3 scrapers/wellfound_playwright.py [--max N]

Outputs JSON lines to stdout: one prospect per line.
"""

import asyncio, json, sys, os, re

# Load .env
env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m:
                os.environ.setdefault(m.group(1), m.group(2))

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH",
    os.path.join(os.path.dirname(__file__), "..", ".browsers"))


async def scrape_wellfound(max_results=30):
    from playwright.async_api import async_playwright

    results = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = await context.new_page()

        try:
            print("[wellfound] fetching newest companies...", file=sys.stderr)
            await page.goto(
                "https://wellfound.com/companies?sort=created_desc",
                wait_until="networkidle",
                timeout=30000,
            )
            await page.wait_for_timeout(3000)

            # Scroll to trigger lazy loading
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.3)")
            await page.wait_for_timeout(2000)

            # Extract companies
            companies = await page.evaluate("""
                () => {
                    const items = [];
                    const seen = new Set();

                    // Try finding company links
                    const links = document.querySelectorAll('a[href*="/company/"]');
                    links.forEach(a => {
                        const href = a.getAttribute('href');
                        if (!href || !href.startsWith('/company/')) return;
                        if (seen.has(href)) return;
                        seen.add(href);

                        // Walk up to find the card containing name + description
                        const card = a.closest('[class]');
                        const nameEl = card?.querySelector('h2,h3,h4,strong,[class*=\"name\"]');
                        const name = nameEl?.textContent?.trim() || a.textContent?.trim();
                        if (!name || name.length > 100) return;

                        const tagline = card?.querySelector('p,[class*=\"tagline\"],[class*=\"description\"]')?.textContent?.trim() || '';
                        const websiteLink = card?.querySelector('a[href*=\"http\"]:not([href*=\"wellfound\"])');
                        const website = websiteLink?.getAttribute('href') || '';

                        items.push({ href, name, tagline, website });
                    });

                    return JSON.stringify(items.slice(0, 50));
                }
            """)

            companies = json.loads(companies)
            print(f"[wellfound] found {len(companies)} companies", file=sys.stderr)

        except Exception as e:
            print(f"[wellfound] error: {e}", file=sys.stderr)
            companies = []
        finally:
            await browser.close()

    # Normalize
    for c in companies[:max_results]:
        slug = c.get("href", "").replace("/company/", "").split("?")[0]
        if not slug and c.get("name"):
            slug = c["name"].lower().replace(" ", "-")
        website = c.get("website", "")
        if not website and slug:
            website = f"https://{slug}.com"
        results.append({
            "source": "wellfound",
            "key": f"wf:{re.sub(r'[^a-z0-9]', '_', (slug or c.get('name', 'unknown')).lower())[:40]}",
            "name": c.get("name", "Unnamed"),
            "tagline": (c.get("tagline") or "")[:120],
            "description": c.get("tagline", ""),
            "votes": 0,
            "listingUrl": f"https://wellfound.com{c['href']}" if c.get("href") else "",
            "website": website,
            "topics": [],
        })

    return results


async def main():
    max_results = 30
    for i, arg in enumerate(sys.argv):
        if arg == "--max" and i + 1 < len(sys.argv):
            max_results = int(sys.argv[i + 1])
    companies = await scrape_wellfound(max_results)
    for c in companies:
        print(json.dumps(c))
    print(f"[wellfound] {len(companies)} companies found", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
