// Product Hunt official GraphQL API (no scraping).
// Token: https://www.producthunt.com/v2/oauth/applications → "Developer Token".
// Rate limit is generous for one scan/day.

const PH_ENDPOINT = "https://api.producthunt.com/v2/api/graphql";

const QUERY = `
query TodaysPosts($first: Int!, $postedAfter: DateTime) {
  posts(order: VOTES, first: $first, postedAfter: $postedAfter) {
    edges {
      node {
        id
        name
        tagline
        description
        votesCount
        url
        website
        topics(first: 5) { edges { node { name } } }
      }
    }
  }
}`;

export async function fetchProductHunt({ topN = 40, token }) {
  if (!token) {
    console.warn("[producthunt] PH_ACCESS_TOKEN not set — skipping source");
    return [];
  }

  const postedAfter = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

  const res = await fetch(PH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { first: topN, postedAfter },
    }),
  });

  if (!res.ok) {
    throw new Error(`[producthunt] API error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`[producthunt] GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data.posts.edges.map(({ node }) => ({
    source: "producthunt",
    key: `ph:${node.id}`,
    name: node.name,
    tagline: node.tagline || "",
    description: node.description || "",
    votes: node.votesCount,
    listingUrl: node.url,
    // `website` is a PH redirect URL; the real domain resolves when we fetch it
    website: node.website,
    topics: node.topics.edges.map((e) => e.node.name),
  }));
}
