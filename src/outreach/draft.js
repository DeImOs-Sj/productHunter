// Draft a personalized email per prospect via NVIDIA Nemotron.
import { chatJSON } from "../llm.js";

export async function draftEmail(config, prospect) {
  const p = config.product;

  const draft = await chatJSON({
    system: `You write short, honest cold emails from one founder to another. Rules:
- Open with something specific about THEIR product (from the launch listing) — prove a human looked.
- Congratulate the launch in one clause, not a paragraph.
- One or two sentences on why the sender's product is relevant to them specifically.
- One low-pressure ask (e.g. "worth a look?" / "happy to set you up with X").
- No hype words, no "revolutionize", no fake familiarity, no flattery padding, no emojis.
- Plain text. 60-120 words. Sign with the sender's name and role only — the footer is added separately.

Respond with ONLY a JSON object, no prose, exactly this shape:
{"subject": "<short, specific, no clickbait, no ALL CAPS, no 'quick question'>", "body": "<plain-text email body, 60-120 words, no HTML>"}`,
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
