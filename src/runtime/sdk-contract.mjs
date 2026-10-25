// SDK 契约体检（2026-10-18）：bridge 依赖的 Claude Agent SDK / 内置 CLI 行为，很多不在官方文档里
//（输入建议的抑制条件、压缩边界的接法、后台任务帧序、权限对话框、Stop hook 带 effort……）。
// 升级 SDK 时它们会无声地变——10-07 就出过「package.json 写着 0.3.293、npm 的隐藏锁把 0.3.280
// 骗成已装好」，一直没人发现。这里把这些依赖写成可检查的清单：
//   · 静态（不调 API，node --test 也跑）：三处版本一致 + sdk.d.ts / claude.exe 里每个依赖点都还在；
//   · 实打（scripts/sdk-contract.mjs --live，花几分钱）：把关键运行时行为真跑一遍。
// 新接了 SDK 的未文档行为，就往 CONTRACT 里加一行，写清是哪个功能靠它。

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN_PKG = { win32: 'claude-agent-sdk-win32-x64', linux: 'claude-agent-sdk-linux-x64', darwin: process.arch === 'arm64' ? 'claude-agent-sdk-darwin-arm64' : 'claude-agent-sdk-darwin-x64' }[process.platform];
// root 可换（单测用假安装目录验证「真能抓到问题」），默认 = 本仓库。
function paths(root = REPO) {
  const NM = path.join(root, 'node_modules');
  const BIN_DIR = BIN_PKG ? path.join(NM, '@anthropic-ai', BIN_PKG) : '';
  return {
    ROOT: root, NM,
    SDK_DIR: path.join(NM, '@anthropic-ai', 'claude-agent-sdk'),
    BIN_DIR,
    EXE: BIN_DIR ? path.join(BIN_DIR, process.platform === 'win32' ? 'claude.exe' : 'claude') : '',
  };
}

// where：dts = sdk.d.ts / sdk-tools.d.ts 里必须出现；js = SDK 运行时（sdk.mjs）里必须出现——类型里没有、
// bridge 却在用的未公开接口；bin = CLI 二进制里必须出现（CLI 发的帧、写的字段、文案锚点）。
// level：fail = 缺了就是坏了；warn = 缺了要人看一眼（可能只是改名）。
export const CONTRACT = [
  // —— query 选项 ——
  { where: 'dts', needle: 'perTaskStopAffordance', feature: '任务面板单条停止；声明后 interrupt 只停当前轮、放过后台任务' },
  { where: 'dts', needle: 'supportedDialogKinds', feature: '安全栅门「会话暂停」卡（不自动切回退模型）' },
  { where: 'dts', needle: 'onUserDialog', feature: '安全栅门「会话暂停」卡的回话通道' },
  { where: 'dts', needle: 'refusal_fallback_prompt', feature: '安全栅门对话框种类' },
  { where: 'dts', needle: 'switchModelsOnFlag', feature: '安全栅门：关掉自动切模型', level: 'warn' },
  { where: 'dts', needle: 'agentProgressSummaries', feature: '子 agent 进度摘要（悬停静默判死的心跳）' },
  { where: 'dts', needle: 'promptSuggestions', feature: '输入建议（Tab 填入）' },
  { where: 'dts', needle: 'enableFileCheckpointing', feature: '检查点回滚（文件快照）' },
  { where: 'dts', needle: 'resumeSessionAt', feature: '对话回滚：从锚点续起' },
  { where: 'dts', needle: 'includePartialMessages', feature: '逐字流式' },
  { where: 'dts', needle: 'snapshot?: boolean', feature: 'systemPrompt 必须 snapshot:false，否则逐轮 append 被首轮录制冻住' },
  { where: 'dts', needle: 'autoCompactWindow', feature: '用量弹层「自动压缩点」滑块' },
  { where: 'dts', needle: 'fastMode', feature: 'Fast mode 开关（settings.fastMode）' },
  // —— Query 控制方法 ——
  { where: 'dts', needle: 'getContextUsage(', feature: '上下文环形面板（result 后 break 前取 full 档）' },
  { where: 'dts', needle: 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(', feature: '额度窗口（/usage 数据源）', level: 'warn' },
  { where: 'js', needle: 'getSettings(', feature: 'Ultracode 实况定局（applied.ultracode）——类型里没有的控制方法' },
  { where: 'dts', needle: 'setModel(', feature: '挂起接力时换模型' },
  { where: 'dts', needle: 'supportedCommands(', feature: '输入栏「/」菜单' },
  { where: 'dts', needle: 'initializationResult(', feature: '新会话预热：等初始化完成再停放' },
  { where: 'dts', needle: 'stopTask(', feature: '任务面板 ⏹、后台 shell 封顶' },
  { where: 'dts', needle: 'interrupt(', feature: '软停止（只停当前轮，后台任务照跑）' },
  { where: 'dts', needle: 'rewindFiles(', feature: '检查点回滚（文件）' },
  // —— 消息帧与字段 ——
  { where: 'dts', needle: "'prompt_suggestion'", feature: '输入建议帧（result 之后 7–14s 才到）' },
  { where: 'dts', needle: "'compact_boundary'", feature: '上下文压缩边界（顺 logicalParentUuid 接链）' },
  { where: 'bin', needle: 'logicalParentUuid', feature: '压缩后记录接链（transcript 字段）' },
  { where: 'dts', needle: "'background_tasks_changed'", feature: '后台任务悬停收轮的电平信号' },
  { where: 'dts', needle: "'task_notification'", feature: '后台任务完成通知（续轮）' },
  { where: 'dts', needle: "'task_progress'", feature: '任务面板进度' },
  { where: 'dts', needle: "'task_started'", feature: '任务面板' },
  { where: 'bin', needle: 'command_lifecycle', feature: '插话气泡的 queued/started 状态——类型里没有的帧' },
  { where: 'dts', needle: "'rate_limit_event'", feature: '额度环与号池换号' },
  { where: 'dts', needle: "'api_retry'", feature: '「正在重试」提示' },
  { where: 'dts', needle: 'user_message_uuids', feature: '挂起接力/插话：result 带回是哪条用户消息' },
  { where: 'dts', needle: 'queued_turn_count', feature: '接力：CLI 队列里还有用户消息时不定局' },
  { where: 'dts', needle: 'terminal_slash_commands', feature: '「/」菜单藏掉终端专属命令', level: 'warn' },
  { where: 'dts', needle: 'fast_mode_state', feature: 'Fast 实况芯片' },
  { where: 'dts', needle: 'background_tasks', feature: 'Stop hook 带后台任务富信息（命令行）' },
  { where: 'dts', needle: 'effort?:', feature: 'Stop hook 带实际生效 effort（芯片实况）', level: 'warn' },
  { where: 'dts', needle: 'PushNotificationInput', feature: '模型推送 → 手机通知栏（push-notices）' },
  // —— CLI 二进制里的行为/文案锚点 ——
  { where: 'bin', needle: 'Mobile push not sent (Remote Control inactive)', feature: 'pushHook 的 additionalContext 措辞对着这句写', level: 'warn' },
  { where: 'bin', needle: 'claim_session', feature: 'SDK 预热认领（bridge 暂未用，变了不影响）', level: 'warn' },
  { where: 'bin', needle: 'requires a full-scope login token', feature: 'Remote Control 仍要完整权限登录（号池 token 开不了 RC）', level: 'warn' },
  { where: 'bin', needle: 'no-mode-asserted', feature: '跨会话消息入站闸（cc-msg）', level: 'warn' },
  // —— 权限模式 / 逐次审批 / 计划审批（runtime/permissions.mjs，2026-10-20）——
  { where: 'dts', needle: 'allowDangerouslySkipPermissions', feature: '绕过权限要中途切得进去，启动时就得带这个旗' },
  { where: 'dts', needle: 'setPermissionMode(', feature: '会话中切权限模式（在跑 / 停放的 CLI 当场生效）' },
  { where: 'dts', needle: "subtype: 'permission_denied'", feature: '工具行「被自动模式拦下」', level: 'warn' },
  { where: 'dts', needle: 'decisionClassification', feature: '审批卡答复分类（允许一次 / 始终允许 / 拒绝）', level: 'warn' },
  { where: 'js', needle: 'decisionReasonType', feature: '计划模式里被改判成「要问」的写请求（卡上标 plan mode）——类型里没有的字段' },
  { where: 'bin', needle: 'Exit plan mode?', feature: '计划审批卡：ExitPlanMode 恒走 canUseTool', level: 'warn' },
  { where: 'bin', needle: 'User has approved your plan', feature: '历史重建按这句认「计划已批准」' },
  { where: 'bin', needle: 'because the session was not launched with', feature: '绕过权限没带启动旗时 setPermissionMode 的报错（接口回 bypass_not_launched）', level: 'warn' },
];

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// 三处版本：SDK 包 / 平台二进制包 / npm 隐藏锁（node_modules/.package-lock.json）必须一致，
// 且 claude.exe --version 等于 SDK 声明的 claudeCodeVersion。
export function versionReport({ runExe = true, root } = {}) {
  const { ROOT, NM, SDK_DIR, BIN_DIR, EXE } = paths(root);
  const out = [];
  const sdk = readJson(path.join(SDK_DIR, 'package.json'));
  const bin = BIN_DIR ? readJson(path.join(BIN_DIR, 'package.json')) : null;
  const lock = readJson(path.join(NM, '.package-lock.json'));
  const want = readJson(path.join(ROOT, 'package.json'))?.dependencies?.['@anthropic-ai/claude-agent-sdk'] || '';
  const push = (ok, item, detail, level = 'fail') => out.push({ ok, level, item, detail });
  push(!!sdk, 'SDK 已安装', sdk ? sdk.version : `缺 ${SDK_DIR}`);
  if (!sdk) return out;
  push(!!bin && bin.version === sdk.version, '平台二进制包与 SDK 同版本', `${BIN_PKG}=${bin?.version || '缺'} / sdk=${sdk.version}`);
  const lv = lock?.packages?.['node_modules/@anthropic-ai/claude-agent-sdk']?.version;
  push(!lock || lv === sdk.version, 'npm 隐藏锁与实际安装一致', lock ? `隐藏锁=${lv || '无'} / 实装=${sdk.version}（不一致时 npm install 会回 up to date 而不真装）` : '无隐藏锁');
  const m = /(\d+\.\d+\.\d+)/.exec(want);
  push(!m || cmpVer(sdk.version, m[1]) >= 0, 'package.json 要求的版本已装上', `要求 ${want} / 实装 ${sdk.version}`);
  const cc = sdk.claudeCodeVersion;
  if (runExe && EXE && existsSync(EXE)) {
    let v = '';
    try { v = execFileSync(EXE, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim(); } catch (e) { v = 'ERR ' + (e && e.message); }
    push(!!cc && v.startsWith(cc), '内置 CLI 版本 = SDK 声明的 claudeCodeVersion', `claude --version → ${v} / 声明 ${cc || '无'}`);
  } else {
    push(!EXE || existsSync(EXE), '内置 CLI 存在', EXE || '未知平台');
  }
  return out;
}

function cmpVer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// 二进制里找锚点：分块按 latin1 扫（270MB 不整读进字符串），块间留重叠防切断。
function binaryHas(file, needles) {
  const found = new Set();
  const maxLen = Math.max(...needles.map((n) => n.length));
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const CH = 16 * 1024 * 1024;
    const buf = Buffer.alloc(CH + maxLen);
    let carry = '';
    for (let pos = 0; pos < size && found.size < needles.length; pos += CH) {
      const n = readSync(fd, buf, 0, CH, pos);
      const s = carry + buf.toString('latin1', 0, n);
      for (const k of needles) if (!found.has(k) && s.includes(k)) found.add(k);
      carry = s.slice(-maxLen);
    }
  } finally { closeSync(fd); }
  return found;
}

export function surfaceReport({ binary = true, root } = {}) {
  const { SDK_DIR, EXE } = paths(root);
  const out = [];
  const dts = ['sdk.d.ts', 'sdk-tools.d.ts'].map((f) => { try { return readFileSync(path.join(SDK_DIR, f), 'utf8'); } catch { return ''; } }).join('\n');
  for (const c of CONTRACT.filter((x) => x.where === 'dts')) {
    out.push({ ok: dts.includes(c.needle), level: c.level || 'fail', item: `sdk.d.ts 有 ${c.needle}`, detail: c.feature });
  }
  const js = (() => { try { return readFileSync(path.join(SDK_DIR, 'sdk.mjs'), 'utf8'); } catch { return ''; } })();
  for (const c of CONTRACT.filter((x) => x.where === 'js')) {
    out.push({ ok: js.includes(c.needle), level: c.level || 'fail', item: `sdk.mjs 有 ${c.needle}`, detail: c.feature });
  }
  const bins = CONTRACT.filter((x) => x.where === 'bin');
  if (binary && bins.length && EXE && existsSync(EXE)) {
    const hit = binaryHas(EXE, bins.map((c) => c.needle));
    for (const c of bins) out.push({ ok: hit.has(c.needle), level: c.level || 'fail', item: `claude 二进制有「${c.needle}」`, detail: c.feature });
  }
  return out;
}
