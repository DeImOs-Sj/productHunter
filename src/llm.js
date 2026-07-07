// NVIDIA NIM chat helper (OpenAI-compatible endpoint).
// No SDK — raw fetch with undici for custom long timeouts (needed for large batch scoring).

import { Agent, setGlobalDispatcher } from "undici";

// Large batch requests (e.g. 100+ candidates for scoring) need longer timeouts
setGlobalDispatcher(
  new Agent({
    headersTimeout: 300_000,   // 5 min to start receiving headers
    bodyTimeout: 300_000,       // 5 min to receive full body
    connectTimeout: 30_000,     // 30s TCP connect
  })
);

const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b";

function extractJSON(text) {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  // Try full JSON first
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      // Partial JSON — try to salvage
      const partial = cleaned.slice(start, end + 1);
      // Try to fix truncated arrays by closing them
      const fixed = partial
        .replace(/,\s*$/, "")                    // trailing comma
        .replace(/\]\s*$/, "]")                  // ensure array closes
        .replace(/""[^"]*$/, '""]')              // truncation inside string
        .replace(/"\s*$/, '"]')                  // truncation after key
        .replace(/:\s*"[^"]*$/, ':""]');          // truncation inside value
      try { return JSON.parse(fixed); } catch (e2) {
        // Last resort: drop last entry if it's truncated
        const trimmed = partial.replace(/,\s*\{[^}]*$/, "]").replace(/,\s*"[^"]*$/, "]");
        try { return JSON.parse(trimmed); } catch (e3) {
          throw new Error(`bad JSON: ${e.message}`);
        }
      }
    }
  }
  throw new Error("no JSON object in model output");
}

export async function chatJSON({ system, user, temperature = 0.4, maxTokens = 8192 }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
      const res = await fetch(ENDPOINT, {
        signal: controller.signal,
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
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}
