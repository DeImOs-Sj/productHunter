// Crunchbase API source — fetches recently funded / new organizations.
// Requires CRUNCHBASE_API_KEY in .env (free: https://developer.crunchbase.com)
//
// Uses Crunchbase Basic API v4:
//   GET https://api.crunchbase.com/api/v4/entity/organizations/search
//
// We search for organizations founded/recently active in the last N days
// that have a website (i.e. are real web products), ordered by created_at.

const API_BASE = "https://api.crunchbase.com/api/v4";

// Fields we care about
const FIELDS = [
  "name",
  "short_description",
  "website_url",
  "homepage_url",
  "created_at",
  "founded_on",
  "rank",
  "categories",
].join(",");

export async function fetchCrunchbase({ hoursBack = 48, maxResults = 50 }) {
  const key = process.env.CRUNCHBASE_API_KEY;
  if (!key) {
    console.warn("[crunchbase] CRUNCHBASE_API_KEY not set — skipping source");
    return [];
  }

  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString().split("T")[0];

  // Search for organizations created or updated recently.
  // We'll do two passes: recently founded organizations + recently updated.
  const results = [];

  // Pass 1: recently founded organizations
  const payload1 = {
    field_queries: [
      {
        field: "founded_on",
        operator: "between",
        value: { gte: since },
      },
    ],
    limit: maxResults,
  };

  results.push(...(await queryCrunchbase("organizations/search", payload1, key)));

  // Pass 2 (if first pass filled up): recently updated organizations with websites
  if (results.length < maxResults) {
    const payload2 = {
      field_queries: [
        {
          field: "updated_at",
          operator: "gte",
          value: since,
        },
        {
          field: "website_url",
          operator: "not_eq",
          value: null,
        },
      ],
      order: [{ field: "updated_at", direction: "desc" }],
      limit: maxResults - results.length,
    };
    results.push(...(await queryCrunchbase("organizations/search", payload2, key)));
  }

  return normalize(results.slice(0, maxResults));
}

async function queryCrunchbase(endpoint, body, key) {
  const url = `${API_BASE}/${endpoint}?field_ids=${FIELDS}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-cb-user-key": key,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (res.status === 429) {
      console.warn("[crunchbase] rate limited — try reducing frequency");
      return [];
    }
    const text = await res.text();
    // If unauthorized, don't keep trying
    if (res.status === 401 || res.status === 403) {
      console.warn(`[crunchbase] auth error ${res.status} — check your API key`);
      return [];
    }
    console.warn(`[crunchbase] API error ${res.status}: ${text.slice(0, 200)}`);
    return [];
  }

  const json = await res.json();
  return json.entities || [];
}

function normalize(entities) {
  return entities
    .map((e) => {
      const props = e.properties || {};
      const website = props.homepage_url || props.website_url || "";
      if (!website) return null; // skip — can't reach them

      const name = props.name || "Unnamed";
      const description = props.short_description || "";
      const categories = (props.categories || [])
        .map((c) => (typeof c === "string" ? c : c.value || ""))
        .filter(Boolean);

      return {
        source: "crunchbase",
        key: `cb:${props.entity_id || e.uuid || name.replace(/\s+/g, "_").toLowerCase()}`,
        name,
        tagline: description.slice(0, 120),
        description,
        votes: props.rank || 0,
        listingUrl: `https://www.crunchbase.com/organization/${e.uuid || ""}`,
        website,
        topics: categories,
      };
    })
    .filter(Boolean);
}
