// Fetch the prospect's website (plus /contact and /about) and extract a contact email.
// Regex-based on raw HTML — good enough for founder sites; no headless browser.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const JUNK_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i,
  /@(example|sentry|wixpress|sentry-next|godaddy|domain)\./i,
  /^(noreply|no-reply|donotreply)@/i,
  /@\d+x\./, // image srcset artifacts like image@2x.png
];

const PREFERRED_PREFIXES = ["hello", "hi", "hey", "contact", "founders", "team", "support", "info"];

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; outreach-research/1.0)" },
    });
    if (!res.ok) return { html: "", finalUrl: url };
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("text/plain")) {
      return { html: "", finalUrl: res.url };
    }
    return { html: await res.text(), finalUrl: res.url };
  } catch {
    return { html: "", finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

function extractEmails(html) {
  const found = new Set();
  // mailto: links first — highest confidence
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(decodeURIComponent(m[1]));
  for (const m of html.matchAll(EMAIL_RE)) found.add(m[0]);
  return [...found]
    .map((e) => e.trim().replace(/[.,;:\\]+$/, "").toLowerCase())
    .filter((e) => EMAIL_RE.test(e) && !JUNK_PATTERNS.some((p) => p.test(e)));
}

function rankEmails(emails, siteDomain) {
  const domainMatch = (e) => {
    const d = e.split("@")[1];
    return siteDomain.endsWith(d) || d.endsWith(siteDomain) ? 1 : 0;
  };
  const prefixRank = (e) => {
    const prefix = e.split("@")[0];
    const i = PREFERRED_PREFIXES.indexOf(prefix);
    return i === -1 ? PREFERRED_PREFIXES.length : i;
  };
  return [...emails].sort(
    (a, b) => domainMatch(b) - domainMatch(a) || prefixRank(a) - prefixRank(b)
  );
}

export async function findContactEmail(websiteUrl) {
  const { html, finalUrl } = await fetchText(websiteUrl);
  let origin, domain;
  try {
    const u = new URL(finalUrl);
    origin = u.origin;
    domain = u.hostname.replace(/^www\./, "");
  } catch {
    return { email: null, website: websiteUrl, domain: null };
  }

  let emails = extractEmails(html);

  // Try common contact pages if the homepage yields nothing
  if (emails.length === 0) {
    for (const p of ["/contact", "/about", "/contact-us", "/support"]) {
      const page = await fetchText(origin + p, 8000);
      emails = extractEmails(page.html);
      if (emails.length > 0) break;
    }
  }

  const ranked = rankEmails(emails, domain);
  return { email: ranked[0] ?? null, website: origin, domain };
}
