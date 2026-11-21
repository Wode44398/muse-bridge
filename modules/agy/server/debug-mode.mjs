// Antigravity 的调试模式（设置 › Antigravity › 调试，仅主机管理员）：开着时这一轮的首要产出是 harness 反馈，任务本身其次。
// 口径照 Claude 分页（src/mcp/bridge-tools.mjs 的 debugNudge），改成 agy 手上实际有的东西：
// 挂着 bridge 操作工具时经中枢的 call 调 feedback.harness（统一格式 + 索引，会话 id 由中枢按归属轮自动记上）；
// 没挂时用 agy 自己的写文件工具直接写进同一个反馈文件夹。

import path from 'node:path';
import { HARNESS_FEEDBACK_DIR } from '@bridge/core/agent-api/ops/feedback.mjs';

/** 这一轮调试模式算不算开：只认主机管理员的非沙箱身份 + 设置开关为真（与 Claude 分页 claude-turn-settings 同口径）。 */
export function agyDebugOn(ctx, settings = {}) {
  return !!(ctx && ctx.kind === 'admin' && !ctx.sandbox && settings?.debugMode === true);
}

/** 反馈落盘目录：feedback.harness 按 agent 名分的那一层（不另算一份根目录）。 */
export const AGY_HARNESS_FEEDBACK_DIR = path.join(HARNESS_FEEDBACK_DIR, 'agy');

/**
 * 调试模式提示词。bridgeCall = 这一轮挂着中枢的 bridge 组（manual / call）。
 * dir 只给单测换目录用。
 */
export function agyDebugPrompt({ bridgeCall = false, dir = AGY_HARNESS_FEEDBACK_DIR } = {}) {
  const sep = path.sep;
  const how = bridgeCall
    ? '调 bridge 服务的 call 工具，op:"feedback.harness"。args 必填三项：kind、title、details——details 是问题说明正文（现象、为什么认定是 harness 的锅、影响），evidence / suggestion 代替不了它；选填 tool、severity、task、evidence、workaround、suggestion、model。例：{op:"feedback.harness",args:{kind:"bug",title:"…",details:"…",evidence:"…"}}。会话 id 会自动记上。不用先在对话里问用户；写完继续干活。'
    : `这一轮没有挂 bridge 操作工具：用你自己的写文件工具在 ${dir}${sep}<YYYY-MM-DD>${sep}<HHMMSS>-<kind>-<短标题>.md 写一份 Markdown（标题、类型、严重度、涉及工具、当时在做什么、问题说明、证据、怎么绕的、改进建议）。`;
  return [
    '【调试模式 · 已开启 · 最高优先级】用户（bridge 的开发者）打开了调试模式：这一轮的首要目的是【找出 harness 的毛病、为以后改进 harness 攒反馈】，手头的任务本身是第二位的。所谓 harness，就是你此刻手上的一切：你自带的工具（读写文件、搜索、跑命令……）、bridge 服务的各个工具（mcp_bridge_*）、系统提示里的各节说明、权限审批、bridge 注入的机制与约定（会话工作目录、附件、右侧工作区卡片……）。请批判性地使用它，而不是默默适应它：',
    '① 遇到报错、结果不对、行为反常：先停一下判断是不是 harness / 工具的锅（参数说明误导、返回不全、路径换算错、超时、权限误拦、提示和实际不符……），而不是任务本身或你自己用错。是的话就记一条（kind:"bug"）。拿不准也记，写明你的判断依据。',
    '② 觉得某个设计冗余、没必要：多余的步骤、重复或互相打架的提示、白白多一轮的确认、塞进上下文却用不上的东西——记一条（kind:"redundant"）。',
    '③ 觉得缺了某个功能：本该有一件工具 / 一个参数 / 一条信息却没有——记一条（kind:"missing"）。',
    '④ 不得不故意绕路才能完成任务：换工具、拼命令、猜路径、反复试错——记一条（kind:"workaround"，写清怎么绕的）。能用但别扭、难懂，记 kind:"friction"。',
    `怎么记：${how}`,
    '铁律：反馈体验就是这一轮最重要的交付物。不许犯懒，不许为了专心把项目做完而跳过反馈，也不许攒到最后凭印象补——发现一条就当场记一条，一个问题一条，写到开发者拿来就能复现、能改的程度（证据贴原文）。宁可多记几条小问题，也别漏掉。没遇到问题就不硬编。最终回答末尾附一行「本轮调试反馈：N 条」并列出标题；一条也没有就说明为什么。',
  ].join('\n');
}
