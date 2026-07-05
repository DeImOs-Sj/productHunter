// BetaList source — fetches recently listed startups.
// BetaList is server-rendered HTML (not SPA), easy to scrape.

const BASE = "https://betalist.com";

export async function fetchBetaList({ maxResults = 25 } = {}) {
  const results = [];

  try {
    const res = await fetch(`${BASE}/`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebCited/1.0)" },
    });
    if (!res.ok) return results;

    const html = await res.text();

    // BetaList home page has startup cards with this structure:
    // <a href="/startups/<slug>">
    //   <div class="font-medium ...">Name</div>
    // </a>
    // <div class="text-gray-600 ...">Tagline</div>

    // Extract all startup blocks between href="/startups/" and the next article/card
    const startups = [];
    const regex = /href="(\/startups\/[^"]+)"[\s\S]*?<div[^>]*class="[^"]*font-medium[^"]*"[^>]*>([^<]+)<\/div>[\s\S]*?<div[^>]*class="text-gray-600[^"]*"[^>]*>([^<]+)<\/div>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const name = match[2].trim();
      if (name && name.length < 80) {
        startups.push({
          href: match[1],
          name,
          tagline: match[3].trim(),
        });
      }
    }

    // Fallback: simpler extraction
    if (startups.length === 0) {
      const linkRegex = /href="(\/startups\/[a-z0-9][^"]+)"[\s\S]*?<div[^>]*class="[^"]*font-medium[^"]*"[^>]*>([^<]+)<\/div>/gi;
      while ((match = linkRegex.exec(html)) !== null) {
        const name = match[2].trim();
        if (name && name.length < 80) {
          startups.push({ href: match[1], name, tagline: "" });
        }
      }
    }

    // Dedupe by href
    const seen = new Set();
    const unique = startups.filter((s) => {
      if (seen.has(s.href)) return false;
      seen.add(s.href);
      return true;
    });

    for (const s of unique.slice(0, maxResults)) {
      results.push({
        source: "betalist",
        key: `bl:${s.href.replace("/startups/", "").toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
        name: s.name,
        tagline: s.tagline.slice(0, 120),
        description: s.tagline,
        votes: 0,
        listingUrl: `${BASE}${s.href}`,
        website: "",
        topics: [],
      });
    }
  } catch (err) {
    console.warn(`[betalist] error: ${err.message}`);
  }

  return results;
}
