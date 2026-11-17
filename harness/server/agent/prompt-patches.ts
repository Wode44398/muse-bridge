// 按家族加进主系统提示词的补丁段（档案 profile.prompt.patches 点名，id → 文本与挂点）。
// 补丁只往固定挂点插入整段文字，不改动原有句子：没点名任何补丁时提示词逐字节不变（model-profile-golden.test.ts 守着）。
// 挂点找不到就抛错而不是静默跳过——提示词改版把挂点改没了，补丁会悄悄失效，A/B 的结论也就作废了。

export interface PromptPatch {
  // 插在哪段文字之前（必须在主提示词里恰好出现一次）
  before: string;
  text: string;
}

// 「How to work」列表结束、VerificationAudit 那段开始之前
const AFTER_HOW_TO_WORK = "\n\nIf no meaningful executable check exists";

export const PROMPT_PATCHES: Readonly<Record<string, PromptPatch>> = Object.freeze({
  // 针对「自称做完、其实没做完」：Kimi K3.1 Pro 在第二批难题上的失败全是这一类（漏改 README、只挪了一部分文件、审查漏项）。
  // 写法参照 Kimi Code 交付前的收尾自查与「明说剩下什么」。
  completion_audit: {
    before: AFTER_HOW_TO_WORK,
    text:
      "Before you send your final reply, go back to the user's most recent request and list every explicit requirement in it, including formats, edge cases, every file or item it names, and each \"must\". " +
      "For each one, point to concrete evidence from this session that it is satisfied: a passing command, output you read, a file you changed. " +
      "If any requirement lacks evidence, keep working on it. If you truly cannot finish it, say so in the first lines of your reply and name exactly what is left. " +
      "Never describe work you planned or only partly did as complete.",
  },
});

export function unknownPatches(ids: readonly string[]): string[] {
  return ids.filter((id) => !Object.hasOwn(PROMPT_PATCHES, id));
}

/** 按 ids 的顺序把补丁插进提示词；ids 为空原样返回。不认识的 id 由档案解析时剔掉，这里遇到就抛。 */
export function applyPromptPatches(prompt: string, ids: readonly string[] | undefined): string {
  if (!ids?.length) return prompt;
  let out = prompt;
  for (const id of ids) {
    const p = Object.hasOwn(PROMPT_PATCHES, id) ? PROMPT_PATCHES[id] : undefined;
    if (!p) throw new Error(`未知的提示词补丁：${id}`);
    const at = out.indexOf(p.before);
    if (at < 0 || out.indexOf(p.before, at + 1) >= 0) throw new Error(`提示词补丁 ${id} 的挂点不存在或不唯一`);
    out = `${out.slice(0, at)}\n\n${p.text}${out.slice(at)}`;
  }
  return out;
}
