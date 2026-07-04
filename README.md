# launch-outreach

Automated pipeline: scan new product launches (Product Hunt + Show HN), keep only the ones
in your product's genre (Claude scores relevance), find a contact email on their website,
draft a personalized email, and send — after you approve each draft.

## Flow

```
Product Hunt API ─┐
                  ├─→ dedupe → Claude genre match → website email scrape
Show HN (Algolia) ┘                                        │
                                                           ▼
                              outbox/*.json drafts (approved: false)
                                                           │
                                you review, flip approved: true
                                                           ▼
                                 Resend → sent (capped, paced, logged)
```

## Setup

```bash
npm install
cp .env.example .env    # fill in keys
# edit config.json — product description, ideal prospect, sender identity, postal address
```

Keys needed:

| Key | Where |
|---|---|
| `NVIDIA_API_KEY` | build.nvidia.com (free Nemotron models, OpenAI-compatible API) |
| `PH_ACCESS_TOKEN` | producthunt.com/v2/oauth/applications → Developer Token (free) |
| `SMTP_PASSWORD` | your own mailbox password (Namecheap Private Email etc.) — preferred |
| `RESEND_API_KEY` | resend.com — alternative if no SMTP mailbox; verify domain first |

## Usage

```bash
npm run scan     # fetch launches → drafts in outbox/
# review outbox/*.json, set "approved": true on the ones you want
npm run send     # sends approved drafts (daily cap + delay between sends)
npm run auto     # scan + send in one shot, NO review step (cron mode)
npm run status   # counters
```

`auto` refuses to run until `.env` has both API keys and `config.json` has a real
postal address. Daily cap, pacing, dedupe, and suppression still apply.

Fully automated evening run via cron:

```cron
7 18 * * * cd /home/shlok/Desktop/.codes/producthunt && /home/shlok/.nvm/versions/node/v22.21.1/bin/node src/pipeline.js auto >> scan.log 2>&1
```

## Deliverability & legal rules baked in

- **Review-before-send** is the default. Auto-approve only after weeks of good drafts.
- **Daily cap** (`email.maxPerDay`, default 15) + delay between sends. A new domain that
  blasts 100 cold emails/day gets blacklisted within days. Warm up: 10-15/day for the
  first month.
- **CAN-SPAM footer** auto-appended: your identity, physical postal address, opt-out line.
  Fill `email.postalAddress` with a real address — it's legally required.
- **Suppression list**: when someone replies "unsubscribe", add their address to
  `data/state.json` → `suppress`. Never email them again.
- **Dedupe**: never emails the same address twice; never re-processes a seen launch.

## Practical tips

- Send from a **separate domain** (e.g. `getyourproduct.com` if your main is
  `yourproduct.com`) so cold outreach can't damage your primary domain's reputation.
  Set up SPF, DKIM, and DMARC in Resend before the first send.
- The quality lever is `config.json → product.description` and `targeting.idealProspect`.
  Specific beats broad: "founders of B2B SaaS with a web dashboard who churn users at
  onboarding" > "startups".
- `targeting.minRelevanceScore: 7` is strict on purpose. Lower it and reply rates drop —
  irrelevant email = spam, whatever the intent.
- Indie Hackers has no API and is a JS-rendered SPA; not included. PH + Show HN cover
  most launch volume. BetaList could be added later (HTML is scrapable).
