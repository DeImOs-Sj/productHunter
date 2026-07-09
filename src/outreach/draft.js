// Draft a personalized email per prospect via NVIDIA Nemotron.
// v2 – includes direct link to webcited.xyz + stronger personalization.
import { chatJSON } from "../llm.js";

const LINK_URL = "https://surli.cc/doclbs";
const SHORT_LINK = LINK_URL; // Single short link for all emails

export async function draftEmail(config, prospect) {
  const p = config.product;
  const domain = prospect.website ? new URL(prospect.website).hostname.replace(/^www\./, "") : "their-site.com";

  const draft = await chatJSON({
    system: `You write short, honest cold emails — one founder to another, after noticing their launch.

Rules:
- Open with something SPECIFIC from their launch (tagline, feature, description, problem they solve). Prove a human looked. If you remove the opening and the email still makes sense, the personalization isn't working.
- Congratulate the launch in ONE clause, not a paragraph.
- Lead with "you/your" over "I/we." Their world first.
- One or two sentences connecting your product's value to THEIR specific situation. The connection should feel obvious, not stretched.
- Describe WebCited as a platform that monitors where AI answer engines (ChatGPT, Gemini, Perplexity, Claude, Copilot) cite or ignore your website — showing a complete citation map of your AI visibility. Focus on the analysis and monitoring value, not specific technical fixes.
- CRITICAL: Include the scan link naturally in the body. Use the EXACT link: ${SHORT_LINK}. Phrase it like "see exactly how you show up → ${SHORT_LINK}" or "I can run a free scan of your site — check your AI visibility here: ${SHORT_LINK}" — make it feel like a natural handoff, not a banner ad.
- One low-pressure ask. Interest-based CTAs ("worth a look?" / "happy to run a free scan") beat meeting requests. Never ask for a call.
- No: "I hope this finds you well," "My name is X," template language, hype words (leverage, revolutionize, best-in-class, synergy), fake familiarity, flattery padding, emojis.
- Plain text. Sentence case (not all lowercase). 80-150 words. Sign with the sender's name and role only — no signature block, no postal address, no unsubscribe line (footer is added separately).
- Subject line: specific to their product. 3-6 words. No clickbait, no ALL CAPS, no "quick question." Should make them think "huh, this person actually looked at what I built."
- Read it aloud before finishing. If it sounds like marketing copy, rewrite it.

Respond with ONLY a JSON object, no prose, exactly this shape:
{"subject": "<3-6 word subject line, specific to their product>", "body": "<plain-text email body, 80-150 words, no HTML, with the scan link included naturally>"}`,
    user: `Sender: ${p.senderName}, ${p.senderRole} of ${p.name} (${p.url})
Sender's product: ${p.description}

Prospect launch:
Name: ${prospect.name}
Tagline: ${prospect.tagline}
Description: ${prospect.description.slice(0, 500)}
Domain: ${domain}
Launched on: ${prospect.source === "producthunt" ? "Product Hunt" : "Hacker News (Show HN)"}
Why they're relevant: ${prospect.matchReason}

Write the email. Use ${SHORT_LINK} as the scan link.`,
    temperature: 0.7,
    maxTokens: 8192,
  });

  if (!draft.subject || !draft.body) throw new Error("model returned incomplete draft");

  // Safety fallback: ensure the link is in the body
  if (!draft.body.includes(LINK_URL)) {
    draft.body += `\n\nSee how your site appears in AI answers → ${SHORT_LINK}`;
  }

  return draft;
}
