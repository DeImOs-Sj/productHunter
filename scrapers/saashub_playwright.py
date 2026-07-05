#!/usr/bin/env python3
"""
SaaSHub scraper using Playwright (direct, no crawl4ai).

Extracts recently submitted products from SaaSHub's /new page.

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
        await page.wait_for_timeout(5000)
        
        text = await page.evaluate("() => document.body?.innerText || ''")
        await browser.close()
    
    products = _extract(text, max_results)
    
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
            "listingUrl": f"https://www.saashub.com/new",
            "website": p.get("website", ""),
            "topics": [],
        })
    
    return results


def _extract(text, max_results):
    """Extract products from the 'SaaSHub Submit' section of the page."""
    products = []
    lines = text.split("\n")
    
    in_submit = False
    i = 0
    while i < len(lines) and len(products) < max_results:
        line = lines[i].strip()
        
        # Find the Submit section
        if "SaaSHub Submit" in line or line == "Featured":
            in_submit = True
            i += 1
            continue
        
        if not in_submit:
            i += 1
            continue
        
        # Stop at next major sections
        if line.startswith("Top 15") or "SaaSHub Experts" in line:
            break
        
        # Skip empty/trivial lines
        if not line or len(line) < 2 or line in ("Feedback", "Register", "Login", "Startups"):
            i += 1
            continue
        if line.startswith("Tools & Categories") or line.startswith("Software Alternatives"):
            i += 1
            continue
        if line.startswith("⭐") or line.startswith("Featured"):
            i += 1
            continue
        
        # Product names: short, capitalized, NOT starting with "Posted"
        if (line[0].isupper() or line[0].isdigit()) and len(line) < 50 and not line.startswith("Posted"):
            lookahead = " ".join(lines[i:i+5])
            if "Posted on" in lookahead or "posts" in lookahead.lower() or "posts" in line.lower():
                name = line
                desc = ""
                
                # Walk through following lines for description
                j = i + 1
                desc_lines = []
                while j < len(lines) and j < i + 8:
                    nl = lines[j].strip()
                    if not nl:
                        j += 1
                        continue
                    if nl.startswith("Posted on") or nl.startswith("posts") or "posts" in nl.split()[:1]:
                        j += 1
                        continue
                    if nl.startswith("http") or nl.startswith("/"):
                        j += 1
                        continue
                    # Check if this is a new product
                    if nl[0].isupper() and len(nl) < 50 and nl != name and "Posted" in " ".join(lines[j:j+3]):
                        break
                    desc_lines.append(nl)
                    j += 1
                
                desc = " ".join(desc_lines)
                products.append({"name": name, "description": desc})
                i = j
                continue
        
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
