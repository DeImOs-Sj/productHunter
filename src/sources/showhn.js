// "Show HN" posts via the free Algolia HN API. No key needed.

export async function fetchShowHN({ hoursBack = 24 }) {
  const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn` +
    `&numericFilters=created_at_i>${since}&hitsPerPage=100`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`[showhn] Algolia error ${res.status}`);
  const json = await res.json();

  return json.hits
    .filter((h) => h.url) // text-only Show HNs have no product site
    .map((h) => ({
      source: "showhn",
      key: `hn:${h.objectID}`,
      name: h.title.replace(/^Show HN:\s*/i, ""),
      tagline: "",
      description: h.story_text || "",
      votes: h.points || 0,
      listingUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
      website: h.url,
      topics: [],
    }));
}
