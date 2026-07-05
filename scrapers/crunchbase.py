#!/usr/bin/env python3
"""
Crawl4AI-based Crunchbase scraper.

Scrapes recently added/funded companies from Crunchbase using headless browser.

Usage:
  PLAYWRIGHT_BROWSERS_PATH=./.browsers python3 scrapers/crunchbase.py [--max N]
  
Outputs JSON lines to stdout: one prospect per line.
"""

import asyncio, json, sys, os, re
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Ensure browsers path
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", 
    os.path.join(os.path.dirname(__file__), "..", ".browsers"))

async def scrape_crunchbase(max_results=30):
    """Scrape Crunchbase for recently added companies."""
    from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

    results = []

    async with AsyncWebCrawler() as crawler:
        # Browse the "Discover" page — recently funded/added organizations
        url = "https://www.crunchbase.com/discover/organization"

        cfg = CrawlerRunConfig(
            css_selector="grid-row, .grid-row, [class*='gridRow'], table tr",
            word_count_threshold=5,
            cache_mode=CacheMode.BYPASS,
            verbose=False,
        )
        result = await crawler.arun(url=url, config=cfg)
        
        if not result.success:
            print(f"[crunchbase] Crawl failed: {result.error}", file=sys.stderr)
            return results
        
        # Try extracting from markdown or HTML
        content = result.markdown or result.html or ""
        
        # Crunchbase is JS-rendered — let's try extracting from the page
        # by looking for company names and links
        companies = extract_from_page(content)
        
        for c in companies[:max_results]:
            results.append({
                "source": "crunchbase",
                "key": f"cb:{sanitize_key(c.get('name', ''))}",
                "name": c.get("name", ""),
                "tagline": c.get("tagline", c.get("description", ""))[:120],
                "description": c.get("description", ""),
                "votes": 0,
                "listingUrl": c.get("url", ""),
                "website": c.get("website", ""),
                "topics": c.get("categories", []),
            })
    
    return results


def extract_from_page(content):
    """Extract company data from page text/markdown."""
    companies = []
    
    # Try to find company patterns: Name + website + description
    # Crunchbase renders company cards with links
    lines = content.split("\n")
    
    current = {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        # Detect company link pattern
        # Crunchbase URLs look like: https://www.crunchbase.com/organization/company-name
        url_match = re.search(r'https://www\.crunchbase\.com/organization/([a-z0-9-]+)', line)
        if url_match:
            if current.get("name"):
                companies.append(current)
            current = {"url": url_match.group(0), "slug": url_match.group(1)}
            # The company name is usually near the link
            name = extract_name_near_url(line, url_match.group(0))
            if name:
                current["name"] = name
            continue
        
        # Website link pattern
        website_match = re.search(r'https?://(?:www\.)?([a-z0-9][-a-z0-9]+\.[a-z]{2,})', line)
        if website_match and current.get("slug"):
            current["website"] = website_match.group(0)
            continue
        
        # Description pattern
        if current.get("slug") and not current.get("description") and len(line) > 20:
            current["description"] = line
        
        # Company name standalone
        if not current.get("slug") and line.isascii() and not line.startswith("http") and len(line) < 60:
            pass  # Could be a company name but hard to confirm without context
    
    if current.get("name"):
        companies.append(current)
    
    return companies


def extract_name_near_url(line, url):
    """Extract company name near a Crunchbase URL in text."""
    # Remove the URL itself
    text = line.replace(url, "").strip()
    # Remove common noise
    text = re.sub(r'[•·●○♦⁃›»|]\s*$', "", text).strip()
    # If we have text before the URL, that's likely the name
    idx = line.find(url)
    if idx > 0:
        before = line[:idx].strip().rstrip("•·●○♦⁃›»|-,")
        if before and len(before) < 60:
            return before
    return text if text and len(text) < 60 else ""


def sanitize_key(name):
    if not name:
        return "unknown"
    return re.sub(r"[^a-z0-9]", "_", name.lower().strip())[:40]


async def main():
    max_results = 30
    for i, arg in enumerate(sys.argv):
        if arg == "--max" and i + 1 < len(sys.argv):
            max_results = int(sys.argv[i + 1])
    
    companies = await scrape_crunchbase(max_results)
    
    for c in companies:
        print(json.dumps(c))
    
    print(f"[crunchbase] {len(companies)} companies found", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
