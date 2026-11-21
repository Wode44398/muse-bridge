// 把一张截图交回去的那一半（本地浏览器 captureAndReport 与 bridge 共享浏览器 shared.ts 共用）：
// 多模态模型拿到图片本身（feedback）自己看；纯文本模型问了 question 就让外部视觉模型给一段文字结论；用户那边一律看到图。
// 给界面的截图存成会话资产、事件只带 id（不把 base64 塞进事件流）。
import type { ToolContext, ToolRunResult } from "../types.ts";
import { describeImage, visionConfigured, visionModel } from "../../vision.ts";
import { screenshotEvent } from "../../image-assets.ts";

/** framing：拼在 "Captured <url>" 后面的说明（截了什么、图多大、等没等动画）；scope：summary 里的取景（整屏为 ""）。 */
export async function shotResult(
  png: Buffer,
  url: string,
  framing: string,
  scope: string,
  question: string,
  ctx: ToolContext,
): Promise<ToolRunResult> {
  const shot = (verdict?: string) => screenshotEvent(ctx.ownerId, png, "image/png", url, verdict);

  if (ctx.agentSeesImages) {
    const q = question ? `You wanted to verify: "${question}". ` : "";
    return {
      ok: true,
      summary: `screenshot ${url}${scope}`,
      content: [
        {
          t: "text",
          text: `Captured ${url}${framing} ${q}The screenshot is attached below — look at it and judge for yourself. The user sees the same image.`,
        },
      ],
      feedback: [{ t: "image", mime: "image/png", data: png.toString("base64") }],
      events: [shot()],
    };
  }

  if (!question || !visionConfigured()) {
    const note = !question
      ? `Captured ${url}${framing} No question was asked, so no visual verdict. The user can see the image. For a text verdict, pass question:"…".`
      : `Captured ${url}${framing} But no vision model is configured (set VISION_API_KEY), so I cannot give a visual verdict. The user can see the image.`;
    return {
      ok: true,
      summary: `screenshot${scope}${question ? " (no vision model)" : ""}`,
      content: [{ t: "text", text: note }],
      events: [shot()],
    };
  }

  try {
    const verdict = await describeImage(png, question);
    return {
      ok: true,
      summary: `screenshot verdict (${verdict.model})`,
      content: [
        {
          t: "text",
          text: `Visual check of ${url} via ${verdict.model}${framing}\n\nQ: ${question}\n\nA: ${verdict.text}\n\n(A multimodal model's reading of the screenshot — the user sees the same image.)`,
        },
      ],
      events: [shot(verdict.text)],
    };
  } catch (e) {
    return {
      ok: false,
      summary: "screenshot (vision failed)",
      content: [
        {
          t: "text",
          text: `Captured ${url}${framing} But the vision model (${visionModel()}) failed: ${(e as Error).message}\nThe screenshot is shown to the user, but I could not get an automated visual verdict.`,
        },
      ],
      events: [shot()],
    };
  }
}
