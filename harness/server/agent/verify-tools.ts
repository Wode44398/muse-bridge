// 验证证据的工具形状（档案 tools.verifyTools）：off 时 Bash / Eval / Network 的 schema 去掉 verify 参数（Network 连带只为它服务的
// expectedStatus），说明里只为验证门禁写的句子换成中性陈述（Browser 的 dprprobe），VerificationAudit 不下发；模型照旧传了 verify 就在进工具之前静默去掉，按普通调用执行（不打回、不记证据）。
// 工具本身不改：这里给工具包一层，定义换成去掉参数的那份、调用参数先剥再交给原工具。建会话时整张表套一次，同一会话内不变。
import type { ToolDef } from "./turn.ts";
import type { Tool, ToolRunResult } from "../tools/types.ts";
import { controlOperators, verifyOutcome } from "../tools/bash/verify.ts";

export const VERIFICATION_AUDIT = "VerificationAudit";
// 工具名 → 只为验证证据服务的参数
const VERIFY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  Bash: ["verify"],
  Eval: ["verify"],
  Network: ["verify", "expectedStatus"],
};

// 工具名 → 说明里只为验证门禁 / 证据写的句子与 off 时换成的中性陈述（参数不变）。原句取自工具说明原文，对不上就不换
//（profile-posture.test.ts 钉着两边都对得上）
const LEAN_DESC: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  Browser: [
    [
      "so canvas/WebGL pages MUST pass this probe once after edits before being declared done. Counts as verification evidence.",
      "so after editing a canvas/WebGL page it is worth running once.",
    ],
  ],
};
const shapedByPosture = (name: string): boolean => Boolean(VERIFY_PARAMS[name] || LEAN_DESC[name]);

// 恢复出来的老会话 system 里写着「交 VerificationAudit / 带 verify:true」时，工具表照原样给（不然提示词点名的工具不存在）。
// 文字取自加固版正文（姿态改造前的原文同一句）
export const VERIFY_CONTRACT_MARKER = "call VerificationAudit with a concrete reason";

const stripArgs = (args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  if (!keys.some((k) => k in args)) return args;
  const out = { ...args };
  for (const k of keys) delete out[k];
  return out;
};

function leanDef(def: ToolDef, keys: readonly string[]): ToolDef {
  let description = def.description;
  for (const [from, to] of LEAN_DESC[def.name] ?? []) description = description.split(from).join(to);
  if (!keys.length) return { ...def, description };
  const properties = { ...def.parameters.properties };
  for (const k of keys) delete properties[k];
  const required = def.parameters.required?.filter((k) => !keys.includes(k));
  return { ...def, description, parameters: { ...def.parameters, properties, ...(required ? { required } : {}) } };
}

/** 一件工具的 lean 形状；没有验证参数、说明也不用改的原样返回。只改说明的只换定义，执行原样。 */
export function withoutVerify(tool: Tool): Tool {
  if (!shapedByPosture(tool.def.name)) return tool;
  const keys = VERIFY_PARAMS[tool.def.name];
  if (!keys) return { ...tool, def: leanDef(tool.def, []) };
  const { prepare } = tool;
  return {
    ...tool,
    def: leanDef(tool.def, keys),
    ...(prepare ? { prepare: (args, ctx) => prepare(stripArgs(args, keys), ctx) } : {}),
    run: (args, ctx) => tool.run(stripArgs(args, keys), ctx),
  };
}

/** 按档案的 verifyTools 给一组工具定形：on 原样；off 去掉 VerificationAudit、剥掉验证参数。保持原有顺序。 */
export function shapeVerifyTools(tools: readonly Tool[], verifyTools: "on" | "off"): Tool[] {
  if (verifyTools === "on") return [...tools];
  return tools.filter((t) => t.def.name !== VERIFICATION_AUDIT).map(withoutVerify);
}

// ── off 时给项目知识留的验证记录 ─────────────────────────────────────────────
// off 下没有 verify:true，工具结果不带 verification，项目知识的验证历史（ProjectKnowledge health、按验证记录的召回）就断了。
// 这里从一次普通的 Bash 运行里认出「跑了一次检查」：前台跑完、命令是测试 / 构建 / 类型检查 / lint，退出码归属得到这条检查
//（不含管道、`||`、`;`、`&`，开头不是 `!`——普通运行没有 pipefail，`npm test | tail` 的退出码是 tail 的）。只进项目知识，
// 不进门禁、不算完成证据。
const CHECK_COMMAND_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b`,
    String.raw`\bnode\b[^|;&]*\s--test\b`,
    String.raw`\b(?:jest|vitest|mocha|ava|jasmine|karma|cypress\s+run|playwright\s+test|tsc|eslint|ruff|mypy|pyright)\b`,
    String.raw`\b(?:pytest|py\.test|nosetests|tox|nox)\b`,
    String.raw`\bpython[\d.]*\s+-m\s+(?:pytest|unittest)\b`,
    String.raw`\b(?:go|cargo|deno|bun|dotnet)\s+(?:test|build|vet|check|clippy)\b|\bcargo\s+nextest\b`,
    String.raw`\bmake\s+(?:test|check)\b|\bctest\b|\brspec\b|\bphpunit\b`,
    String.raw`\b(?:gradlew?|mvnw?)\b[^|;&]*\b(?:test|build|check|verify)\b`,
  ].join("|"),
  "i",
);

/** off 姿态下一次 Bash 调用若是一次跑完的检查，给出要记进项目知识的结果；不是就 null。 */
export function plainCheckOutcome(call: { name: string; args: Record<string, unknown> }, res: ToolRunResult): { passed: boolean; detail: string } | null {
  if (call.name !== "Bash" || res.verification) return null;
  const a = call.args;
  if (a.background || a.poll || a.wait || a.kill || a.jobs) return null;
  const command = String(a.command ?? "").trim();
  if (!command || /^!\s/.test(command) || !CHECK_COMMAND_RE.test(command)) return null;
  if (controlOperators(command).some((op) => op !== "&&")) return null;
  const text = res.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n");
  // 只认跑完的：取最后一行独占的状态行（[exit N] / [timeout] / [aborted]），是 [exit N] 才记；超时、被中止、转后台（没有状态行）不记。
  // 不要求它是全文最后一行——状态行之后还可能附别的提示（如工作目录变了）
  const status = [...text.matchAll(/^\[(exit (-?\d+)|timeout|aborted)\]$/gm)].at(-1);
  if (!status?.[2]) return null;
  return verifyOutcome(command, `exit ${status[2]}`, status[2] === "0" && res.ok, text);
}

/** 同上，给「定义数组 + 名字→工具」两份表（主会话的形状）：tmap 就地改，返回新的定义数组（顺序不变）。 */
export function shapeVerifyTable(defs: readonly ToolDef[], tmap: Map<string, Tool>, verifyTools: "on" | "off"): ToolDef[] {
  if (verifyTools === "on") return [...defs];
  tmap.delete(VERIFICATION_AUDIT);
  for (const [name, tool] of tmap) if (shapedByPosture(name)) tmap.set(name, withoutVerify(tool));
  return defs.filter((d) => d.name !== VERIFICATION_AUDIT).map((d) => (shapedByPosture(d.name) ? (tmap.get(d.name)?.def ?? d) : d));
}
