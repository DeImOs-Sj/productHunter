#!/usr/bin/env python3
"""Extract products from SaaSHub /new page."""
import asyncio, json, re
from playwright.async_api import async_playwright

async def extract():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            viewport={"width": 1280, "height": 800}
        )
        await ctx.add_init_script('Object.defineProperty(navigator,"webdriver",{get:()=>undefined})')
        page = await ctx.new_page()
        await page.goto("https://www.saashub.com/new", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(5000)
        
        text = await page.evaluate("() => document.body?.innerText || ''")
        
        # Extract products from "SaaSHub Submit" section
        # Pattern: Product Name on its own line, followed by posted info, followed by description
        products = []
        
        # Split into lines
        lines = text.split("\n")
        
        in_submit = False
        product_names = []
        product_map = {}  # name -> {desc, source}
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # Find "SaaSHub Submit" section
            if "SaaSHub Submit" in line or "Featured" in line:
                in_submit = True
                i += 1
                continue
            
            if not in_submit:
                i += 1
                continue
            
            # Stop at next major section
            if line.startswith("Top 15") or line.startswith("SaaSHub Experts"):
                break
            
            # Skip empty lines and nav items
            if not line or len(line) < 2:
                i += 1
                continue
            if line in ("Feedback", "Register", "Login", "Startups"):
                i += 1
                continue
            if line.startswith("Tools & Categories") or line.startswith("Software Alternatives"):
                i += 1
                continue
            
            # Check if this line looks like a product name (not a description)
            # Product names: typically short, no lowercase start, not starting with "Posted"
            if (line[0].isupper() or line[0].isdigit()) and len(line) < 50:
                # Check if next few lines contain "Posted on" or description
                lookahead = " ".join(lines[i:i+5])
                if "Posted on" in lookahead or "posts" in lookahead.lower():
                    name = line
                    desc = ""
                    source_info = ""
                    
                    # Collect description from following lines
                    j = i + 1
                    while j < len(lines) and j < i + 10:
                        nl = lines[j].strip()
                        if not nl:
                            j += 1
                            continue
                        if nl.startswith("Posted on"):
                            source_info = nl
                        elif nl.startswith("http") or nl.startswith("/"):
                            pass
                        elif nl == name or (nl[0].isupper() and len(nl) < 50 and nl not in product_names and "Posted on" in " ".join(lines[j:j+3])):
                            # Next product
                            break
                        else:
                            if not desc:
                                desc = nl
                        j += 1
                    
                    if name not in product_names:
                        product_names.append(name)
                        product_map[name] = {"name": name, "description": desc, "source_info": source_info}
                    i = j
                    continue
            
            i += 1
        
        await browser.close()
        
        for name, info in product_map.items():
            print(f"{name}|{info['description']}|{info['source_info']}")

asyncio.run(extract())
