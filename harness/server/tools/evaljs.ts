import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import { existingSharedBrowser, claimBrowser } from "../cdp.ts";
import { browserAvailable } from "../headless.ts";
import { fileUrlBlock } from "../sandbox.ts";
import { redactOutput } from "../redact.ts";

// Eval: run JavaScript inside the Browser's page and get the result back.
// The precision instrument for verification — assert DOM state, read computed
// styles, count elements, extract data — exact answers where a screenshot
// would only give an impression.

const MAX_RESULT = 8_000;

export const evalTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  enabled: browserAvailable, // 与 Browser 同进同退
  def: {
    name: "Eval",
    description:
      "Evaluate a JavaScript expression in the Browser's current page and return its value (JSON-serialized; " +
      "promises are awaited — both top-level `await x` and an expression that returns a promise, e.g. " +
      "`(async () => { …; return x; })()`). Use for exact checks a screenshot can't give: DOM assertions " +
      "(`document.querySelector('.err')?.textContent`), computed styles (`getComputedStyle(el).color`), " +
      "counts, extracting text/data, or poking app state. Multiple statements: wrap in an IIFE — " +
      "`(() => { …; return x; })()`. Return JSON-serializable values (DOM nodes serialize as {} — return " +
      "their properties instead). Use this for DEBUGGING and INSPECTION; to change app behavior, edit the " +
      "source files.",
    parameters: {
      type: "object",
      properties: {
        js: {
          type: "string",
          description: "The JavaScript expression to evaluate in the page.",
        },
        verify: {
          type: "boolean",
          description:
            "Treat the expression as completion evidence. It must evaluate to a boolean: true passes, false fails " +
            "verification. A non-boolean value is rejected as a malformed check (not recorded as evidence). To say WHY " +
            "a check fails, throw an Error with the details — its message comes back to you.",
        },
      },
      required: ["js"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const js = String(args.js ?? "").trim();
    if (!js) return fail("eval", "Eval requires `js`.");
    const denied = claimBrowser(ctx.ownerId ?? "");
    if (denied) return fail("eval", denied);
    const page = existingSharedBrowser();
    if (!page) return fail("eval", "No browser is running — Browser(navigate, url:…) first.");
    // S4（#37②）：当前页是 file:// 且过不了与 Read 同一道闸（点链接、脚本跳转绕过了导航检查）→ 不读。
    const fileBlock = fileUrlBlock(page.url, ctx.sandbox);
    if (fileBlock) return fail("eval", `The current page is a blocked local file — ${fileBlock}. Navigate away first.`);
    try {
      const value = await page.eval(js);
      let rendered: string;
      if (value === undefined) rendered = "undefined";
      else if (typeof value === "string") rendered = value;
      else {
        try {
          rendered = JSON.stringify(value, null, 1) ?? String(value);
        } catch {
          rendered = String(value);
        }
      }
      // S4 出口脱敏：页面里的令牌（localStorage、接口响应…）不原样交给模型。
      rendered = redactOutput(rendered);
      if (args.verify === true && value !== true) {
        const shown = rendered.length > MAX_RESULT ? rendered.slice(0, MAX_RESULT) + "\n… (truncated)" : rendered;
        // V4（#56）：形态不对（不是布尔）是写法问题，不是「检查没通过」——不记成失败证据。
        if (typeof value !== "boolean") {
          return fail(
            "eval assertion malformed",
            `verify:true needs the expression to evaluate to a boolean (true = pass, false = fail), but it returned:\n${shown}\n` +
              "This call is NOT recorded as verification evidence. Return a boolean; to report why a check fails, throw an Error with the details.",
          );
        }
        return {
          ...fail(
            "eval assertion failed",
            `Verification assertion at ${page.url} did not return boolean true. Received:\n${shown}`,
          ),
          verification: { passed: false, detail: `Eval assertion failed at ${page.url}: ${shown.slice(0, 240)}` },
        };
      }
      let note = "";
      if (rendered.length > MAX_RESULT) {
        rendered = rendered.slice(0, MAX_RESULT);
        note = `\n… (result truncated at ${MAX_RESULT} chars — narrow what you return)`;
      }
      const result = ok("eval ok", `Result (at ${page.url}):\n${rendered}${note}`);
      if (args.verify === true) {
        result.verification = { passed: true, detail: `Eval assertion passed at ${page.url}` };
      }
      return result;
    } catch (e) {
      const message = redactOutput((e as Error).message);
      const res = fail("eval error", `Eval failed: ${message}`);
      // verify:true 时脚本自己 throw 的（断言带细节）如实记为一次失败的检查；语法错误属于写法问题、
      // 超时与浏览器故障不是页面的结论，都不记成证据。
      const thrown = (e as Error & { pageException?: string }).pageException;
      if (args.verify === true && thrown && thrown !== "SyntaxError") {
        res.verification = { passed: false, detail: `Eval assertion threw at ${page.url}: ${message.slice(0, 240)}` };
      }
      return res;
    }
  },
};
