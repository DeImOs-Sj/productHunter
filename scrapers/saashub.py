#!/usr/bin/env python3
"""
SaaSHub scraper using crawl4ai headless browser.

Scrapes newly listed SaaS products from SaaSHub's homepage/New page.

Usage:
  source .venv/bin/activate && \
  PLAYWRIGHT_BROWSERS_PATH=./.browsers python3 scrapers/saashub.py [--max N]

Outputs JSON lines to stdout: one prospect per line.
"""

import asyncio, json, sys, os, re

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH",
    os.path.join(os.path.dirname(__file__), "..", ".browsers"))


async def scrape_saashub(max_results=30):
    from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

    results = []

    async with AsyncWebCrawler() as crawler:
        print("[saashub] fetching...", file=sys.stderr)

        cfg = CrawlerRunConfig(
            word_count_threshold=5,
            cache_mode=CacheMode.BYPASS,
            wait_until="networkidle",
            verbose=False,
            magic=True,
            simulate_user=True,
            override_navigator=True,
            delay_before_return_html=3.0,
            scan_full_page=True,
        )

        result = await crawler.arun(
            url="https://www.saashub.com/?ref=donkeydirectories",
            config=cfg,
        )

        if not result.success:
            print(f"[saashub] failed: {result.error}", file=sys.stderr)
            return []

        content = result.markdown or result.html or ""

        # Extract products from the rendered content
        products = _extract_from_content(content, result.html or "")

        if not products:
            print("[saashub] no products found in markdown, trying JS extraction...", file=sys.stderr)
            products = await _js_extract(crawler)

        print(f"[saashub] extracted {len(products)} products", file=sys.stderr)

        # Normalize
        for p in products[:max_results]:
            name = p.get("name", "").strip()
            if not name or len(name) > 80:
                continue
            slug = re.sub(r'[^a-z0-9]+', "-", name.lower()).strip("-")
            results.append({
                "source": "saashub",
                "key": f"sh:{slug[:40]}",
                "name": name,
                "tagline": (p.get("tagline") or p.get("description", ""))[:120],
                "description": p.get("description", ""),
                "votes": 0,
                "listingUrl": p.get("url", f"https://www.saashub.com/{slug}"),
                "website": p.get("website", ""),
                "topics": p.get("categories", []),
            })

    return results


def _extract_from_content(markdown, html):
    """Extract product listings from rendered markdown/HTML."""
    products = []

    # Method 1: Look for product links in markdown
    # SaaSHub renders items like: [Product Name](https://www.saashub.com/product-name)
    lines = markdown.split("\n") if markdown else []
    current = {}
    for line in lines:
        line = line.strip()

        # Product link: [Name](/slug) or [Name](https://saashub.com/slug)
        m = re.search(r'\[([^\]]+)\]\(https?://(?:www\.)?saashub\.com/([a-z0-9-]+)\)', line)
        if m:
            name = m.group(1).strip()
            slug = m.group(2)
            if name and current.get("name") and current["name"] != name:
                products.append(current)
            current = {"name": name, "slug": slug, "url": f"https://www.saashub.com/{slug}", "tagline": "", "website": ""}
            continue

        m2 = re.search(r'\[([^\]]+)\]\(/([a-z0-9-]+)\)', line)
        if m2:
            name = m2.group(1).strip()
            slug = m2.group(2)
            if name and current.get("name") and current["name"] != name:
                products.append(current)
            current = {"name": name, "slug": slug, "url": f"https://www.saashub.com/{slug}", "tagline": "", "website": ""}
            continue

        # Description/tagline line (medium length text after a product name)
        if current.get("name") and not current.get("tagline") and len(line) > 15 and len(line) < 200:
            current["tagline"] = line

    if current.get("name"):
        products.append(current)

    # Method 2: Extract from HTML if markdown didn't give enough
    if len(products) < 3 and html:
        # Look for product cards in HTML
        card_pattern = re.compile(
            r'<a[^>]*href="(https?://(?:www\.)?saashub\.com/([a-z0-9-]+))"[^>]*>([^<]+)</a>',
            re.IGNORECASE
        )
        for m in card_pattern.finditer(html):
            url = m.group(1)
            slug = m.group(2)
            name = m.group(3).strip()
            # Skip nav links, filters, etc.
            skip = {"register", "login", "startups", "newsletter", "community", "blog", "advertise", "about", "contact", "privacy", "terms"}
            if slug in skip or len(name) > 60:
                continue
            if not any(p.get("slug") == slug for p in products):
                products.append({"name": name, "slug": slug, "url": url, "tagline": "", "website": ""})

    # Dedupe
    seen = set()
    unique = []
    for p in products:
        if p["name"] not in seen:
            seen.add(p["name"])
            unique.append(p)

    return unique


async def _js_extract(crawler):
    """Extract via JS evaluation if markdown extraction fails."""
    try:
        js_result = await crawler.crawl(
            url="https://www.saashub.com/?ref=donkeydirectories",
            js_code="""
                const items = [];
                const seen = new Set();

                // Find grid items / clickable cards
                document.querySelectorAll('[class*="card"], [class*="grid"] a[href*="/"][href!="/"], a.clickable-card-link').forEach(a => {
                    const href = a.getAttribute('href');
                    if (!href || href.startsWith('http') || seen.has(href)) return;
                    if (href === '/' || href.startsWith('/register') || href.startsWith('/login') || href.startsWith('#')) return;
                    seen.add(href);

                    const name = a.textContent.trim();
                    if (!name || name.length > 60) return;

                    const card = a.closest('[class]');
                    const desc = card?.querySelector('p, [class*="desc"], [class*="text-"]')?.textContent?.trim() || '';

                    items.push({ href, name, description: desc });
                });

                // Also try any h2/h3 which might contain product names
                document.querySelectorAll('h2, h3, h4').forEach(h => {
                    const name = h.textContent.trim();
                    if (!name || name.length > 60 || seen.has(name)) return;
                    const parent = h.closest('[class]');
                    const link = parent?.querySelector('a');
                    if (link && link.getAttribute('href') && !link.getAttribute('href').startsWith('#')) {
                        if (seen.has(link.getAttribute('href'))) return;
                        seen.add(link.getAttribute('href'));
                        const desc = parent?.querySelector('p, [class*="desc"]')?.textContent?.trim() || '';
                        items.push({ href: link.getAttribute('href'), name, description: desc });
                    }
                });

                return JSON.stringify(items.slice(0, 50));
            """,
            wait_until="networkidle",
        )
        if js_result:
            items = json.loads(js_result)
            return [{"name": i["name"], "slug": i["href"].lstrip("/"), "url": f"https://www.saashub.com{i['href']}" if not i["href"].startswith("http") else i["href"], "tagline": i.get("description", ""), "website": ""} for i in items]
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    return []


async def main():
    max_results = 30
    for i, arg in enumerate(sys.argv):
        if arg == "--max" and i + 1 < len(sys.argv):
            max_results = int(sys.argv[i + 1])
    products = await scrape_saashub(max_results)
    for p in products:
        print(json.dumps(p))
    print(f"[saashub] {len(products)} products found", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
