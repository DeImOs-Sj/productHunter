// NVIDIA NIM chat helper (OpenAI-compatible endpoint, free Nemotron model).
// No SDK — raw fetch. Model has no enforced JSON schema, so prompts must demand
// JSON and we extract/parse defensively (reasoning models wrap output in <think> etc).

const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

function extractJSON(text) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function chatJSON({ system, user, temperature = 0.4, maxTokens = 8192 }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        top_p: 0.95,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: true },
        reasoning_budget: 4096,
        stream: false,
      }),
    });

    if (!res.ok) {
      lastErr = new Error(`NVIDIA API ${res.status}: ${await res.text()}`);
      continue;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    try {
      return extractJSON(content);
    } catch (err) {
      lastErr = new Error(`bad JSON from model (attempt ${attempt + 1}): ${err.message}`);
    }
  }
  throw lastErr;
}
