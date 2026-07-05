#!/usr/bin/env python3
"""
Crawl4AI-based Wellfound (AngelList) scraper.

Headless browser scraper for Wellfound's newest company listings.
Attempts public access first; falls back to login if credentials provided.

Usage:
  source .venv/bin/activate && \
  PLAYWRIGHT_BROWSERS_PATH=./.browsers python3 scrapers/wellfound.py [--max N]

Outputs JSON lines to stdout: one prospect per line.
"""

import asyncio, json, sys, os, re

# Load .env if present
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
    """Scrape Wellfound for newest companies using headless browser."""
    from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

    email = os.environ.get("WELLFOUND_EMAIL", "")
    password = os.environ.get("WELLFOUND_PASSWORD", "")

    async with AsyncWebCrawler() as crawler:
        # Try public access first
        print("[wellfound] fetching newest companies (public)...", file=sys.stderr)
        cfg = CrawlerRunConfig(
            word_count_threshold=10,
            cache_mode=CacheMode.BYPASS,
            wait_until="networkidle",
            verbose=False,
            magic=True,
            simulate_user=True,
            override_navigator=True,
            scan_full_page=True,
            delay_before_return_html=2.0,
        )
        result = await crawler.arun(
            url="https://wellfound.com/companies?sort=created_desc",
            config=cfg,
        )

        if not result.success and email and password:
            print("[wellfound] public access failed, trying login...", file=sys.stderr)
            await _login(crawler, email, password)
            result = await crawler.arun(
                url="https://wellfound.com/companies?sort=created_desc",
                config=cfg,
            )

        if not result.success:
            print(f"[wellfound] failed: {result.error}", file=sys.stderr)
            return []

        # Extract
        content = result.markdown or result.html or ""
        companies = _extract_from_markdown(content)

        if not companies:
            print("[wellfound] trying JS extraction...", file=sys.stderr)
            companies = await _js_extract(crawler)

    return _normalize(companies, max_results)


async def _login(crawler, email, password):
    """Login to Wellfound."""
    await crawler.arun(
        url="https://wellfound.com/login",
        js_code=f"""
            document.querySelector('input[name="user[email]"]')?.focus();
            document.querySelector('input[name="user[email]"]').value = '{email}';
            document.querySelector('input[name="user[password]"]')?.focus();
            document.querySelector('input[name="user[password]"]').value = '{password}';
            document.querySelector('input[type="submit"]')?.click();
        """,
        wait_for="js:() => window.location.pathname.includes('dashboard') || window.location.pathname.includes('feed')",
        wait_until="networkidle",
        bypass_cache=True,
    )


async def _js_extract(crawler):
    """Extract companies via JS evaluation on the page."""
    try:
        js_result = await crawler.crawl(
            url="https://wellfound.com/companies?sort=created_desc",
            js_code="""
                const items = [];
                document.querySelectorAll('a[href*="/company/"]').forEach(a => {
                    const href = a.getAttribute('href');
                    if (!href || items.some(i => i.href === href)) return;
                    const card = a.closest('[class]') || a.parentElement;
                    const name = (card?.querySelector('h2, h3, h4, strong, [class*="name"]')?.textContent || a.textContent).trim();
                    const tagline = (card?.querySelector('p, [class*="tagline"], [class*="description"]')?.textContent || '').trim();
                    const website = card?.querySelector('a[href*="http"]:not([href*="wellfound"])')?.getAttribute('href') || '';
                    items.push({ href, name, tagline, website });
                });
                return JSON.stringify(items.slice(0, 30));
            """,
            wait_until="networkidle",
        )
        if js_result:
            return json.loads(js_result)
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    return []


def _extract_from_markdown(content):
    """Extract company listings from rendered markdown content."""
    companies = []
    current = {}
    for line in content.split("\n"):
        line = line.strip()
        if not line:
            continue

        wf_link = re.search(r'\[([^\]]+)\]\(https://wellfound\.com/company/([^)]+)\)', line)
        if wf_link:
            if current.get("name"):
                companies.append(current)
            current = {
                "name": wf_link.group(1).strip(),
                "href": f"/company/{wf_link.group(2)}",
                "tagline": "",
                "website": "",
            }
            continue

        ext_link = re.search(r'\(https?://(?:www\.)?(?!wellfound)([a-z0-9][-a-z0-9]+\.[a-z]{2,})[^)]*\)', line)
        if ext_link and current.get("name") and not current.get("website"):
            current["website"] = f"https://{ext_link.group(1)}"
            continue

        if current.get("name") and len(line) > 15 and line[0].isupper() and not current.get("tagline"):
            current["tagline"] = line[:200]

    if current.get("name"):
        companies.append(current)
    return companies


def _normalize(companies, max_results):
    """Normalize to standard prospect format."""
    results = []
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
