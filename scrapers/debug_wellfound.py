#!/usr/bin/env python3
"""Debug Wellfound page structure."""
import asyncio, json
from playwright.async_api import async_playwright

async def debug():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": 1280, "height": 800})
        await page.goto("https://wellfound.com/companies?sort=created_desc", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(5000)
        
        print("URL:", page.url)
        print("Title:", await page.title())
        
        # Get all links
        links = await page.evaluate("""
            () => {
                const all = document.querySelectorAll('a');
                return Array.from(all).slice(0, 40).map(a => ({
                    href: a.getAttribute('href') || '',
                    text: (a.textContent || '').trim().slice(0, 80)
                }));
            }
        """)
        print("Links:", json.dumps(links, indent=2)[:2000])
        
        # Body text
        body = await page.evaluate("() => (document.body?.innerText || '').slice(0, 1500)")
        print("\nBody:", body[:1000])
        
        await browser.close()

asyncio.run(debug())
