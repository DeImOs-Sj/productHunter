#!/usr/bin/env python3
"""
SaaSHub scraper using Playwright (direct, no crawl4ai).

Extracts recently submitted products from SaaSHub's /new page,
getting product NAME, DESCRIPTION, and WEBSITE URL.

Usage:
  source .venv/bin/activate && \
  PLAYWRIGHT_BROWSERS_PATH=./.browsers python3 scrapers/saashub_playwright.py [--max N]

Outputs JSON lines to stdout: one prospect per line.
"""

import asyncio, json, sys, os, re
from playwright.async_api import async_playwright

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH",
    os.path.join(os.path.dirname(__file__), "..", ".browsers"))


async def scrape_saashub(max_results=30):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800}
        )
        await ctx.add_init_script('Object.defineProperty(navigator,"webdriver",{get:()=>undefined})')
        page = await ctx.new_page()
        
        print("[saashub] fetching /new...", file=sys.stderr)
        await page.goto("https://www.saashub.com/new", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(3000)
        
        # Extract structured data from the page using DOM selectors
        products = await page.evaluate("""(maxResults) => {
            const results = [];
            const links = document.querySelectorAll('a[href]');
            const productLinks = [];
            
            for (const a of links) {
                const href = a.getAttribute('href') || '';
                const text = a.textContent.trim();
                if (href.match(/^\\/[a-z0-9][a-z0-9-]+$/) && !href.includes('/new') && !href.includes('/categories') && !href.includes('/tools') && !href.includes('/experts') && !href.includes('/register') && !href.includes('/login') && !href.includes('/about') && !href.includes('/blog') && !href.includes('/submit') && text.length > 1 && text.length < 60 && text !== href) {
                    productLinks.push({ name: text, url: href });
                }
            }
            
            const seen = new Set();
            const unique = productLinks.filter(p => {
                const key = p.name.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            
            for (const p of unique.slice(0, maxResults)) {
                let description = '';
                let website = '';
                
                const allLinks = document.querySelectorAll('a[href]');
                for (const a of allLinks) {
                    if (a.textContent.trim() === p.name && a.getAttribute('href') === p.url) {
                        let parent = a.parentElement;
                        for (let depth = 0; depth < 5; depth++) {
                            if (!parent) break;
                            const externalLinks = parent.querySelectorAll('a[href]');
                            for (const el of externalLinks) {
                                const eh = el.getAttribute('href') || '';
                                if (eh.startsWith('http') && !eh.includes('saashub.com')) {
                                    website = eh;
                                }
                            }
                            const childTexts = [];
                            for (const child of parent.querySelectorAll('p, div, span')) {
                                const ct = child.textContent.trim();
                                if (ct && ct.length > 10 && ct !== p.name && !ct.startsWith('http') && !ct.includes('saashub.com') && !ct.includes('Posted on')) {
                                    childTexts.push(ct);
                                }
                            }
                            if (childTexts.length > 0) {
                                description = childTexts.slice(0, 3).join(' | ');
                            }
                            if (website) break;
                            parent = parent.parentElement;
                        }
                        break;
                    }
                }
                
                results.push({
                    name: p.name,
                    description: description,
                    website: website,
                    listingUrl: 'https://www.saashub.com' + p.url
                });
            }
            
            return results;
        }""", max_results)
        
        await browser.close()
    
    # If DOM approach found nothing, fall back to regex on full text
    if not products:
        text = await page.evaluate("() => document.body?.innerText || ''")
        await browser.close()
        
        products = _extract_fallback(text, max_results)
    
    results = []
    for p in products:
        slug = re.sub(r'[^a-z0-9]+', "-", p["name"].lower()).strip("-")
        results.append({
            "source": "saashub",
            "key": f"sh:{slug[:40] or 'unknown'}",
            "name": p["name"],
            "tagline": p.get("description", "")[:120],
            "description": p.get("description", ""),
            "votes": 0,
            "listingUrl": p.get("listingUrl", "https://www.saashub.com/new"),
            "website": p.get("website", ""),
            "topics": [],
        })
    
    return results


def _extract_fallback(text, max_results):
    """Fallback: regex extraction from innerText."""
    import re
    products = []
    # Try to find structured patterns: ProductName\nDescription\nPosted on...\nwebsite.com
    # Pattern: capitalized name followed by description text followed by a URL
    lines = text.split("\n")
    i = 0
    while i < len(lines) and len(products) < max_results:
        line = lines[i].strip()
        # Look for product name (capitalized, short) followed by website URL nearby
        if line and (line[0].isupper() or line[0].isdigit()) and len(line) < 60 and not line.startswith("http") and not line.startswith("Posted"):
            # Look ahead for a website URL
            website = ""
            desc_lines = []
            for j in range(i+1, min(i+10, len(lines))):
                nl = lines[j].strip()
                if nl.startswith("http"):
                    website = nl
                    break
                elif nl and not nl.startswith("Posted") and not nl.startswith("posts") and len(nl) > 3:
                    desc_lines.append(nl)
            if website:
                desc = " ".join(desc_lines)
                products.append({"name": line, "description": desc, "website": website, "listingUrl": ""})
        i += 1
    return products


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
