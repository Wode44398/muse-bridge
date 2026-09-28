// Vision-verify channel: hand a screenshot to a multimodal model and get a text
// verdict back. This is DECOUPLED from the main agent provider (config.ts) on
// purpose — the agent may be a non-multimodal model (e.g. DeepSeek), and this is
// how it borrows a pair of eyes. Configured entirely from env:
//   VISION_API_KEY   — DashScope (Alibaba Model Studio) key
//   VISION_BASE_URL  — OpenAI-compatible endpoint (…/compatible-mode/v1)
//   VISION_MODEL     — e.g. qwen3.7-plus
// The key is never returned to the client; only visionConfigured() is exposed.

export function visionConfigured(): boolean {
  return Boolean(process.env.VISION_API_KEY?.trim());
}

export function visionModel(): string {
  return process.env.VISION_MODEL?.trim() || "qwen3.7-plus";
}

interface VisionResult {
  text: string;
  model: string;
  thinking?: string;
}

// Send a PNG (raw bytes) plus a question to the vision model. Returns the model's
// text answer. Throws with the provider's error message on failure so the caller
// can surface it to the agent.
export async function describeImage(
  image: Buffer,
  question: string,
  opts: { thinking?: boolean; thinkingBudget?: number; timeoutMs?: number; mime?: string } = {},
): Promise<VisionResult> {
  const key = process.env.VISION_API_KEY?.trim();
  if (!key) throw new Error("VISION_API_KEY is not set — the vision-verify model is not configured.");
  const base = (process.env.VISION_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const model = visionModel();
  const dataUri = `data:${opts.mime ?? "image/png"};base64,${image.toString("base64")}`;

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: question },
        ],
      },
    ],
    // DashScope: thinking on/off is a top-level field on the OpenAI-compatible
    // surface (not extra_body) for Node-style callers.
    enable_thinking: opts.thinking ?? false,
  };
  if (opts.thinking && opts.thinkingBudget) body.thinking_budget = opts.thinkingBudget;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`vision request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try {
      msg = JSON.parse(raw)?.error?.message ?? raw;
    } catch {
      /* keep raw */
    }
    throw new Error(`vision model ${res.status}: ${msg}`);
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`vision model returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const choice = json?.choices?.[0]?.message;
  const text = String(choice?.content ?? "").trim();
  const thinking = choice?.reasoning_content ? String(choice.reasoning_content).trim() : undefined;
  if (!text) throw new Error("vision model returned an empty answer");
  return { text, model, thinking };
}
