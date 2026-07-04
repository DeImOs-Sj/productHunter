// Genre/relevance matching via NVIDIA Nemotron.
// One request scores the whole batch of candidates against your product profile.
import { chatJSON } from "../llm.js";

export async function scoreProspects(config, candidates) {
  if (candidates.length === 0) return [];

  const profile = config.product;
  const targeting = config.targeting;

  const candidateList = candidates
    .map(
      (c) =>
        `key: ${c.key}\nname: ${c.name}\ntagline: ${c.tagline}\ndescription: ${c.description.slice(0, 400)}\ntopics: ${c.topics.join(", ")}`
    )
    .join("\n---\n");

  const { results = [] } = await chatJSON({
    system: `You score cold-outreach prospects. Be strict: a high score means the prospect's team would plausibly become a real user of the sender's product, not merely that both are software. Score 0-10.

Respond with ONLY a JSON object, no prose, exactly this shape:
{"results": [{"key": "<candidate key>", "score": <integer 0-10>, "reason": "<one sentence why they would or wouldn't genuinely benefit>"}]}
Include one result per candidate key, all keys included.`,
    user: `My product:
Name: ${profile.name}
URL: ${profile.url}
What it does: ${profile.description}
Genre: ${profile.genre}

Who I want to reach: ${targeting.idealProspect}
Keywords that indicate a fit: ${targeting.keywords.join(", ")}

Score each of these newly launched products for how well their makers fit as prospects:

${candidateList}`,
    temperature: 0.2,
    maxTokens: 16384,
  });

  const byKey = new Map(results.map((r) => [r.key, r]));

  return candidates.map((c) => ({
    ...c,
    score: byKey.get(c.key)?.score ?? 0,
    matchReason: byKey.get(c.key)?.reason ?? "not scored",
  }));
}
