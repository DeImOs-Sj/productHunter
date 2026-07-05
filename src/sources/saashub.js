// SaaSHub source — fetches new SaaS products from their JSON endpoint.
// No API key needed, no headless browser required.
//
// SaaSHub has a public /products.json endpoint used by their search.
// We fetch the "New & Noteworthy" section.

const BASE = "https://www.saashub.com";

export async function fetchSaaSHub({ maxResults = 30 } = {}) {
  const results = [];

  // Method 1: Try the products JSON endpoint
  try {
    const res = await fetch(`${BASE}/products.json?sort=newest&limit=${maxResults}`);
    if (res.ok) {
      const json = await res.json();
      const items = Array.isArray(json) ? json : json.products || json.data || [];
      for (const item of items.slice(0, maxResults)) {
        const name = item.name || item.title || "";
        if (!name) continue;
        results.push({
          source: "saashub",
          key: `sh:${(item.slug || name).toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
          name,
          tagline: (item.tagline || item.description || item.subtitle || "").slice(0, 120),
          description: item.description || item.tagline || "",
          votes: item.votes || item.rating || 0,
          listingUrl: item.url || `${BASE}/${item.slug || ""}`,
          website: item.website || item.site_url || item.url || "",
          topics: (item.categories || item.tags || []).map((c) => (typeof c === "string" ? c : c.name || "")).filter(Boolean),
        });
      }
      if (results.length > 0) return results;
    }
  } catch {
    // fall through to method 2
  }

  // Method 2: Scrape the "New" page
  try {
    const res = await fetch(`${BASE}/new?page=1`);
    if (!res.ok) return results;
    const html = await res.text();

    // Simple extraction from HTML
    const nameRegex = /<a[^>]*href="\/[a-z0-9-]+"[^>]*>([^<]+)<\/a>/gi;
    const descRegex = /<p[^>]*class="[^"]*description[^"]*"[^>]*>([^<]+)<\/p>/gi;
    const linkRegex = /<a[^>]*href="(\/[a-z0-9-]+)"[^>]*class="[^"]*name[^"]*"[^>]*>/gi;

    const names = [...html.matchAll(nameRegex)].slice(0, maxResults);
    const descs = [...html.matchAll(descRegex)];

    for (let i = 0; i < names.length; i++) {
      const name = names[i][1].trim();
      const desc = descs[i]?.[1]?.trim() || "";
      results.push({
        source: "saashub",
        key: `sh:${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
        name,
        tagline: desc.slice(0, 120),
        description: desc,
        votes: 0,
        listingUrl: `${BASE}/${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        website: "",
        topics: [],
      });
    }
  } catch {
    // give up
  }

  return results;
}
