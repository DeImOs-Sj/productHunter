// Draft a personalized email per prospect via NVIDIA Nemotron.
import { chatJSON } from "../llm.js";

export async function draftEmail(config, prospect) {
  const p = config.product;

  const draft = await chatJSON({
    system: `You write short, honest cold emails — one founder to another, after noticing their launch.

Rules:
- Open with something SPECIFIC from their launch listing (tagline, feature, description). Prove a human looked. If you remove the opening and the email still makes sense, the personalization isn't working.
- Congratulate the launch in ONE clause, not a paragraph.
- Lead with "you/your" over "I/we." Their world first.
- One or two sentences connecting your product's value to THEIR specific situation. The connection should feel obvious, not stretched.
- One low-pressure ask. Interest-based CTAs ("worth a look?" / "happy to run a free scan") beat meeting requests. Never ask for a call.
- No: "I hope this finds you well," "My name is X," template language, hype words (leverage, revolutionize, best-in-class, synergy), fake familiarity, flattery padding, emojis.
- Plain text. 60-120 words. Sign with the sender's name and role only — no signature block, no postal address, no unsubscribe line (footer is added separately).
- Read it aloud before finishing. If it sounds like marketing copy, rewrite it.

Respond with ONLY a JSON object, no prose, exactly this shape:
{"subject": "<short, specific, 2-4 words, lowercase fine, no punctuation tricks, no clickbait, no ALL CAPS, no 'quick question'>", "body": "<plain-text email body, 60-120 words, no HTML>"}`,
    user: `Sender: ${p.senderName}, ${p.senderRole} of ${p.name} (${p.url})
Sender's product: ${p.description}

Prospect launch:
Name: ${prospect.name}
Tagline: ${prospect.tagline}
Description: ${prospect.description.slice(0, 500)}
Launched on: ${prospect.source === "producthunt" ? "Product Hunt" : "Hacker News (Show HN)"}
Why they're relevant: ${prospect.matchReason}

Write the email.`,
    temperature: 0.7,
    maxTokens: 8192,
  });

  if (!draft.subject || !draft.body) throw new Error("model returned incomplete draft");
  return draft;
}
