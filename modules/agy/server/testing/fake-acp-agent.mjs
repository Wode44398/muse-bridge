// 供单测使用的假 ACP stdio 服务：严格模拟 agy acp 的协议行为（含字符串请求 ID、
// 跨进程重置会话配置、动态思考档位校验、历史回放、取消时序与模拟崩溃）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { maybeHandleFakeCliSubcommand } from './fake-cli-subcommands.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

maybeHandleFakeCliSubcommand();

const stateFile = process.env.FAKE_ACP_STATE_FILE || '';
// 模拟真 agy 的数据目录（brain/<会话>/.system_generated/…）：给了才演后台子代理那一套
const fakeDataDir = process.env.FAKE_AGY_DATA_DIR || '';

function brainDirOf(sid) {
  return path.join(fakeDataDir, 'brain', sid);
}

// 文字记录（真 agy 一步一行）：回报到达时追加一条 SYSTEM_MESSAGE，模型回应后再追加 MODEL 的步骤
function transcriptFile(sid) {
  return path.join(brainDirOf(sid), '.system_generated', 'logs', 'transcript_full.jsonl');
}
function appendTranscript(sid, step) {
  const file = transcriptFile(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ status: 'DONE', created_at: new Date().toISOString(), ...step }) + '\n', 'utf8');
}

// 模型还没回应的回报：文字记录末尾连续的 SYSTEM_MESSAGE（真 agy 在下一条 prompt 到来时把它们交给模型）。
// 取到就算交付：追加一条 MODEL 步骤收尾。
function deliverInbox(sid) {
  if (!fakeDataDir) return [];
  let lines = [];
  try { lines = fs.readFileSync(transcriptFile(sid), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const fresh = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let o = null;
    try { o = JSON.parse(lines[i]); } catch {}
    if (!o || o.type !== 'SYSTEM_MESSAGE') break;
    fresh.unshift({ content: String(o.reportBody || '') });
  }
  if (fresh.length) appendTranscript(sid, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'ack' });
  return fresh;
}

// 派一个后台子代理：登记文件立刻写，delayMs 之后把成品和回报落进主会话的收件箱
function spawnFakeSubagent(sid, delayMs) {
  const subId = crypto.randomUUID();
  const sys = path.join(brainDirOf(sid), '.system_generated');
  fs.mkdirSync(path.join(sys, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(sys, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(sys, 'subagents', subId + '.json'), JSON.stringify({
    conversationId: subId,
    subagentDescriptor: { typeName: 'image-generator', role: 'Image Generator' },
    state: 'SUBAGENT_STATE_ALIVE',
  }), 'utf8');
  const timer = setTimeout(() => {
    const img = path.join(brainDirOf(sid), 'fake_image_' + Date.now() + '.png');
    // 界面验收时用 FAKE_AGY_IMAGE 指一张真图，进度卡换成品时才看得到预览
    const sample = process.env.FAKE_AGY_IMAGE || '';
    if (sample && fs.existsSync(sample)) fs.copyFileSync(sample, img);
    else fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'));
    const mid = crypto.randomUUID();
    const content = img + '\n\nA fake generated image.';
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(sys, 'messages', mid + '.json'), JSON.stringify({ id: mid, recipient: sid, sender: subId, timestamp, content }), 'utf8');
    // 真 agy：回报到达的那一刻就标已读（不代表模型看过），同时往文字记录追加一条系统消息
    let read = {};
    try { read = JSON.parse(fs.readFileSync(path.join(sys, 'messages', 'read.json'), 'utf8')); } catch {}
    read[mid] = true;
    fs.writeFileSync(path.join(sys, 'messages', 'read.json'), JSON.stringify(read), 'utf8');
    appendTranscript(sid, {
      source: 'SYSTEM', type: 'SYSTEM_MESSAGE', reportBody: content,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${timestamp.slice(0, 19)}Z sender=${subId} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`,
    });
  }, delayMs);
  timer.unref?.();
  return subId;
}

// 派一个多代理 Teamwork 团队（两层嵌套：总协调器 → 调研代理），用于测试多代理树、后台自动唤醒、后台提问与兜底唤醒
function spawnFakeTeamwork(sid, { mode = 'auto', delayMs = 260, askInBg = false } = {}) {
  const coordId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const rootSys = path.join(brainDirOf(sid), '.system_generated');
  const coordSys = path.join(brainDirOf(coordId), '.system_generated');
  const childSys = path.join(brainDirOf(childId), '.system_generated');
  fs.mkdirSync(path.join(rootSys, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(rootSys, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(coordSys, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(coordSys, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(coordSys, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(childSys, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(childSys, 'logs'), { recursive: true });

  fs.writeFileSync(path.join(rootSys, 'subagents', coordId + '.json'), JSON.stringify({
    conversationId: coordId,
    subagentDescriptor: { typeName: 'teamwork_coordinator', role: 'Teamwork Coordinator' },
    state: 'SUBAGENT_STATE_ALIVE',
    spawnStepIndex: 1,
  }), 'utf8');
  fs.writeFileSync(path.join(coordSys, 'subagents', childId + '.json'), JSON.stringify({
    conversationId: childId,
    subagentDescriptor: { typeName: 'teamwork_explorer', role: 'Codebase Explorer' },
    state: 'SUBAGENT_STATE_ALIVE',
    spawnStepIndex: 2,
  }), 'utf8');

  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(coordSys, 'logs', 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: nowIso, content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${sid} priority=MESSAGE_PRIORITY_HIGH content=请协调整个代码审查与修复任务。\n</SYSTEM_MESSAGE>` }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, model: 'gemini-4-neon-xhigh', input_tokens: 1800, output_tokens: 240, thinking: '先派一个代码库调研代理。', tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'teamwork_explorer', Role: 'Codebase Explorer', Prompt: '扫描仓库关键文件' } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: nowIso, content: `Subagent launched with conversationId: ${childId}` }),
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(childSys, 'logs', 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: nowIso, content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${coordId} priority=MESSAGE_PRIORITY_HIGH content=扫描仓库关键文件并汇报结构。\n</SYSTEM_MESSAGE>` }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, model: 'gemini-4-hydrogen-tiered-high', input_tokens: 900, output_tokens: 180, thinking: '检查目录结构。', tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status --short', toolSummary: '检查仓库状态' } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: nowIso, content: 'M src/index.mjs\n' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, model: 'gemini-4-hydrogen-tiered-high', input_tokens: 1100, output_tokens: 120, content: '已完成仓库扫描，发现 1 处待修复。' }),
  ].join('\n') + '\n', 'utf8');

  const timer = setTimeout(async () => {
    const ts = new Date().toISOString();
    const mid = crypto.randomUUID();
    const reportBody = '总协调器已收到调研结果，任务方案草案已就绪。';
    fs.writeFileSync(path.join(rootSys, 'messages', mid + '.json'), JSON.stringify({
      id: mid, recipient: sid, sender: coordId, timestamp: ts, content: reportBody,
    }), 'utf8');
    appendTranscript(sid, {
      step_index: 2,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      reportBody,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${ts.slice(0, 19)}Z sender=${coordId} priority=MESSAGE_PRIORITY_HIGH content=${reportBody}\n</SYSTEM_MESSAGE>`,
    });

    if (mode === 'auto') {
      // 模拟真实 agy 后台自动唤醒：不发 session/update，直接把回复写进 transcript_full.jsonl；可选发后台 elicitation/create
      appendTranscript(sid, {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-xhigh',
        thinking: '总协调器发来草案，准备向用户汇报。',
        content: '草案已就绪，请审阅并确认是否启动执行。',
        ...(askInBg ? { tool_calls: [{ name: 'ask_question', args: { question: '是否批准启动执行？' } }] } : {}),
      });
      if (askInBg) {
        try {
          const qRes = await callClientWithStringId('bgask', 'elicitation/create', {
            sessionId: sid,
            mode: 'form',
            message: '草案已就绪，是否批准启动执行？',
            requestedSchema: {
              type: 'object',
              required: ['approve'],
              properties: {
                approve: {
                  type: 'string',
                  title: '确认动作',
                  oneOf: [
                    { const: 'yes', title: '批准启动' },
                    { const: 'edit', title: '先修改草案' },
                  ],
                },
              },
            },
          });
          const ansText = qRes?.action === 'accept'
            ? `已收到批准：${JSON.stringify(qRes.content || {})}，开始正式执行！`
            : `用户操作：${qRes?.action || 'cancel'}`;
          appendTranscript(sid, { step_index: 4, source: 'SYSTEM', type: 'GENERIC', content: `A1: ${qRes?.action}` });
          appendTranscript(sid, { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', content: ansText });
        } catch {}
      }
    }
  }, delayMs);
  timer.unref?.();
    return { coordId, childId };
}

// 合法 1×1 PNG 帧（纯色像素，供 Swarm 截图时间线在单测与浏览器验收中真实渲染）
const DEMO_PNG_DARK = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001649444154789c6318191900011000224466ff8001001d28014357cc107e0000000049454e44ae426082',
  'hex',
);
const DEMO_PNG_BLUE = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001649444154789c634878e8000110004a90f0ff8001003c800370f6f8fb9d0000000049454e44ae426082',
  'hex',
);

// 构造一份完整的 Native Swarm 现场（members.json / board.jsonl / plan.json / 多频道 / 截图时间线 / worker 转录）
function spawnFakeSwarm(sid) {
  const backendId = crypto.randomUUID();
  const frontendId = crypto.randomUUID();
  const verifierId = crypto.randomUUID();
  const monitorId = crypto.randomUUID();
  const swarmDir = path.join(brainDirOf(sid), '.system_generated', 'swarm');
  fs.mkdirSync(swarmDir, { recursive: true });

  const mkLogs = (cid) => {
    const dir = path.join(brainDirOf(cid), '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const bLogs = mkLogs(backendId);
  const fLogs = mkLogs(frontendId);
  const vLogs = mkLogs(verifierId);
  const mLogs = mkLogs(monitorId);

  const shot1 = path.join(brainDirOf(frontendId), 'step1-before.png');
  const shot2 = path.join(brainDirOf(frontendId), 'step2-after.png');
  fs.writeFileSync(shot1, DEMO_PNG_DARK);
  fs.writeFileSync(shot2, DEMO_PNG_BLUE);

  const t0 = Date.now() - 95_000;
  const isoAt = (dt) => new Date(t0 + dt).toISOString();
  const boardTime = (dt) => {
    const d = new Date(t0 + dt);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
    title: 'Swarm 面板适配与验收',
    members: {
      coordinator: {
        conversation_id: sid,
        model: 'gemini-4-neon-xhigh',
        role: 'coordinator',
        wake_mode: 'mentions',
        wait_since: 6,
        last_read_seq: 7,
        killed: false,
        channels: ['*'],
      },
      backend: {
        conversation_id: backendId,
        model: 'gemini-4-neon-high',
        role: 'worker',
        wake_mode: 'mentions',
        wait_since: 5,
        last_read_seq: 7,
        killed: false,
        workspace_mode: 'share',
        workspace: path.join(brainDirOf(sid), 'worktree-backend'),
        channels: ['api'],
      },
      frontend: {
        conversation_id: frontendId,
        model: 'gemini-4-hydrogen-tiered-high',
        role: 'worker',
        wake_mode: 'working',
        wait_since: 0,
        last_read_seq: 6,
        killed: false,
        workspace_mode: 'share',
        workspace: path.join(brainDirOf(sid), 'worktree-frontend'),
        channels: ['ui'],
      },
      verifier: {
        conversation_id: verifierId,
        model: 'gemini-4-carbon-medium',
        role: 'worker',
        wake_mode: 'mentions',
        wait_since: 7,
        last_read_seq: 7,
        killed: false,
        workspace_mode: 'inherit',
        channels: ['api', 'ui'],
      },
      monitor: {
        conversation_id: monitorId,
        model: 'gemini-3.8-flash-low',
        role: 'monitor',
        wake_mode: 'mentions',
        wait_since: 7,
        last_read_seq: 7,
        killed: false,
        channels: ['*'],
      },
    },
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(swarmDir, 'plan.json'), JSON.stringify({
    goal: {
      title: '完成 Bridge Swarm 完整视图适配',
      line: '只读解析落盘数据并补齐总览、消息板、成员与协作图。',
    },
    tasks: {
      backend: '解析 members.json 与 board.jsonl 接口',
      frontend: '搭建总览、消息板与截图对比界面',
      verifier: '核验接口鉴权、i18n 与双主题排版',
    },
    threads: [
      { id: 't-api', title: '服务端只读解析', goal: '安全读取 Swarm 落盘与截图帧。', tasks: ['backend'] },
      { id: 't-ui', title: '工作区面板与卡片', goal: '对话卡片与右侧四视图无缝联动。', tasks: ['frontend', 'verifier'] },
    ],
  }, null, 2), 'utf8');

  const boardLines = [
    { seq: 1, agent: 'coordinator', time: boardTime(0), channel: 'api', control: { op: 'create', channel: 'api', topic: '服务端路由与只读解析' }, text: '[channel] created #api — 服务端路由与只读解析' },
    { seq: 2, agent: 'coordinator', time: boardTime(2000), channel: 'ui', control: { op: 'create', channel: 'ui', topic: '前端面板与双主题样式' }, text: '[channel] created #ui — 前端面板与双主题样式' },
    { seq: 3, agent: 'coordinator', time: boardTime(5000), channel: 'api', text: '@backend 你负责实现 GET /api/agy/swarm 与截图白名单校验，完成后发 [done]。' },
    { seq: 4, agent: 'coordinator', time: boardTime(8000), channel: 'ui', text: '@frontend 你负责总览、消息板、成员与协作图组件，顺手贴两张前后对比截图。' },
    { seq: 5, agent: 'backend', time: boardTime(32000), channel: 'api', text: '@coordinator @verifier [done] 已完成 swarm.mjs 与路由鉴权，全部单测通过。' },
    { seq: 6, agent: 'frontend', time: boardTime(58000), channel: 'ui', text: `@verifier 正在打磨浅色与暗色排版，先看两帧进度对比（参考 #5 接口结构）：\nScreenshot: ${shot1} | 初始布局基线\nScreenshot: ${shot2} | 补齐对比度与消息板高亮` },
    { seq: 7, agent: 'verifier', time: boardTime(75000), text: '@#ui @backend 已核对 #5 接口字段和 #6 首帧截图，未发现越权风险。' },
  ];
  fs.writeFileSync(path.join(swarmDir, 'board.jsonl'), boardLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(bLogs, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: isoAt(5000), content: '你负责实现 GET /api/agy/swarm 只读接口。' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(12000), model: 'gemini-4-neon-high', input_tokens: 2400, output_tokens: 480, thinking: '**实现 Swarm 只读解析器**\n校验路径边界。', tool_calls: [{ name: 'write_file', args: { Path: 'modules/agy/server/swarm.mjs', toolSummary: '编写 swarm.mjs' } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: isoAt(15000), content: 'Wrote modules/agy/server/swarm.mjs' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(32000), model: 'gemini-4-neon-high', input_tokens: 1800, output_tokens: 220, content: '已发帖汇报 [done]。' }),
  ].join('\n') + '\n', 'utf8');

  // frontend 处于运行中（最后一步为 RUNNING 工具调用）
  fs.writeFileSync(path.join(fLogs, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: isoAt(8000), content: '你负责 Swarm 前端四视图与消息板交互。' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(45000), model: 'gemini-4-hydrogen-tiered-high', input_tokens: 3100, output_tokens: 620, thinking: '**微调消息板响应式排版**\n核对手机窄屏折行。', tool_calls: [{ name: 'edit_file', args: { Path: 'web/src/components/agy/swarm/AgySwarmBoard.svelte', toolSummary: '优化消息板与引用样式' } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'RUNNING', created_at: isoAt(88000), content: 'editing...' }),
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(vLogs, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: isoAt(60000), content: '核验后端接口与前端视图。' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(75000), model: 'gemini-4-carbon-medium', input_tokens: 1200, output_tokens: 160, tool_calls: [{ name: 'swarm_wait', args: { since: 7 } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: isoAt(76000), content: 'parked' }),
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(mLogs, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: isoAt(6000), content: '监控 Swarm 是否停滞。' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(10000), model: 'gemini-3.8-flash-low', input_tokens: 400, output_tokens: 60, tool_calls: [{ name: 'swarm_wait', args: { since: 7, mentions_only: true } }] }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: isoAt(11000), content: 'parked' }),
  ].join('\n') + '\n', 'utf8');

  return { backendId, frontendId, verifierId, monitorId, shot1, shot2 };
}

function loadDiskState() {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return { sessions: {}, bootCount: 0, rpcLog: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { sessions: {}, bootCount: 0, rpcLog: [] };
  }
}

function saveDiskState(st) {
  if (!stateFile) return;
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
}

const disk = loadDiskState();
disk.bootCount = (disk.bootCount || 0) + 1;
saveDiskState(disk);

// 进程内会话态：与真实 agy 一致，新进程启动时全部回到默认配置
const liveSessions = new Map();
const activePrompts = new Map();
const pendingClientCalls = new Map();
// 模拟真 agy：子代理卡在待审批（steps.status=9）时不会主动推 session/request_permission，
// 必须等客户端对该 subId 调 session/resume 才立刻推送权限请求。
const pendingSubagentPerms = new Map(); // subId -> () => Promise<void>
let clientReqSeq = 1;

function thoughtOptionsFor(model) {
  if (model === 'gemini-4-hydrogen') {
    return [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'XHigh' },
    ];
  }
  return [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ];
}

function buildConfigOptions(cfg) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: cfg.model,
      options: [
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: cfg.thought_level,
      options: thoughtOptionsFor(cfg.model),
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: cfg.mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

function sessionResultPayload(sessionId, cfg) {
  return {
    sessionId,
    models: {
      currentModelId: `${cfg.model}-${cfg.thought_level}`,
      availableModels: [
        { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
        { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      ],
    },
    modes: {
      currentModeId: cfg.mode,
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'auto', name: 'Auto' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: buildConfigOptions(cfg),
    _meta: {
      antigravity: {
        tier: { name: 'Google AI Ultra', id: 'g1-ultra-tier', upgradeUri: '' },
      },
    },
  };
}

function send(obj) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
}

function sendUpdate(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } });
}

function callClientWithStringId(prefix, method, params) {
  const strId = `${prefix}-${clientReqSeq++}`;
  return new Promise((resolve, reject) => {
    pendingClientCalls.set(strId, { expectedStringId: strId, resolve, reject });
    send({ id: strId, method, params });
  });
}

function recordRpc(method, params) {
  // 测试运行中改写的回放开关以磁盘为准，别被内存里的旧状态冲掉
  const fresh = loadDiskState();
  for (const k of ['lateReplayCount', 'lateReplayGapMs']) {
    if (k in fresh) disk[k] = fresh[k]; else delete disk[k];
  }
  disk.rpcLog.push({ pid: process.pid, method, params });
  saveDiskState(disk);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on('end', () => process.exit(0));
rl.on('close', () => process.exit(0));

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // 客户端对反向请求的回复：必须保持字符串类型的 id
  if (msg.id !== undefined && msg.method === undefined) {
    const key = String(msg.id);
    const pending = pendingClientCalls.get(key);
    if (!pending) return;
    pendingClientCalls.delete(key);
    if (typeof msg.id !== 'string' || msg.id !== pending.expectedStringId) {
      pending.reject(new Error(`Expected string id "${pending.expectedStringId}", got ${typeof msg.id} (${JSON.stringify(msg.id)})`));
      return;
    }
    if (msg.error) pending.reject(new Error(msg.error.message || 'client error'));
    else pending.resolve(msg.result);
    return;
  }

  const { id, method, params = {} } = msg;
  recordRpc(method, params);

  if (method === 'initialize') {
    const freshDisk = loadDiskState();
    Object.assign(disk, freshDisk);
    disk.bootCount = (freshDisk.bootCount || 0);

    // 可选：拉起一个模拟 language_server 的孙进程，供单测验证进程树收尸不留孤儿
    if (disk.spawnGrandchild) {
      const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      grand.unref();
      disk.grandchildPids = [...(disk.grandchildPids || []), grand.pid];
      saveDiskState(disk);
    }

    if (disk.failInitOnce) {
      const waitMs = Number(disk.failInitDelayMs) || 120;
      disk.failInitOnce = false;
      saveDiskState(disk);
      await new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.(); });
      send({ id, error: { code: -32603, message: 'Simulated init failure' } });
      process.exit(3);
    }

    send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
        agentCapabilities: {
          loadSession: true,
          // 状态文件里写了 promptCapabilities 就按它报（null = 像老版本那样不报），用来测附件按能力分流
          ...('promptCapabilities' in disk
            ? (disk.promptCapabilities ? { promptCapabilities: disk.promptCapabilities } : {})
            : { promptCapabilities: { image: true, audio: false, embeddedContext: true } }),
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google', description: 'Google OAuth' }],
      },
    });

    if ((disk.autoCrashRemaining || 0) > 0) {
      disk.autoCrashRemaining -= 1;
      saveDiskState(disk);
      const crashTimer = setTimeout(() => process.exit(2), Number(disk.autoCrashAfterMs) || 60);
      crashTimer.unref?.();
    }
    return;
  }

  if (method === 'logout') {
    send({ id, result: {} });
    return;
  }

  if (method === 'test/crash') {
    process.exit(2);
  }

  if (method === 'test/hang') {
    // 故意不回复以验证客户端超时
    return;
  }

  if (method === 'session/new') {
    const freshDisk = loadDiskState();
    Object.assign(disk, freshDisk);
    if (Number(disk.newSessionDelayOnceMs) > 0) {
      const waitMs = Number(disk.newSessionDelayOnceMs);
      disk.newSessionDelayOnceMs = 0;
      saveDiskState(disk);
      await new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.(); });
    }
    const sid = crypto.randomUUID();
    const cfg = { model: 'gemini-4-carbon', thought_level: 'medium', mode: 'default' };
    liveSessions.set(sid, {
      cwd: params.cwd,
      cfg,
      append: params._meta?.antigravity?.systemPrompt?.append || '',
    });
    disk.sessions[sid] = {
      sessionId: sid,
      cwd: '/' + String(params.cwd || '').replace(/\\/g, '/'),
      title: 'New Session',
      updatedAt: new Date().toISOString(),
      append: params._meta?.antigravity?.systemPrompt?.append || '',
      history: [],
    };
    saveDiskState(disk);
    send({ id, result: sessionResultPayload(sid, cfg) });
    sendUpdate(sid, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'plan', description: 'Plan carefully' }, { name: 'compact', description: 'Compact context' }],
    });
    sendUpdate(sid, { sessionUpdate: 'usage_update', used: 0, size: 1048576 });
    return;
  }

  if (method === 'session/resume') {
    const sid = params.sessionId;
    if (pendingSubagentPerms.has(sid)) {
      const cfg = { model: 'gemini-4-carbon', thought_level: 'medium', mode: 'default' };
      liveSessions.set(sid, { cwd: params.cwd, cfg, append: '' });
      send({ id, result: sessionResultPayload(sid, cfg) });
      const trigger = pendingSubagentPerms.get(sid);
      pendingSubagentPerms.delete(sid);
      setImmediate(() => { trigger().catch(() => {}); });
      return;
    }
    if (!disk.sessions[sid]) {
      send({ id, error: { code: -32602, message: `Unknown session: ${sid}` } });
      return;
    }
    const cfg = { model: 'gemini-4-carbon', thought_level: 'medium', mode: 'default' };
    liveSessions.set(sid, {
      cwd: params.cwd,
      cfg,
      append: params._meta?.antigravity?.systemPrompt?.append || '',
    });
    send({ id, result: sessionResultPayload(sid, cfg) });
    sendUpdate(sid, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'plan', description: 'Plan carefully' }],
    });
    sendUpdate(sid, { sessionUpdate: 'session_info_update', title: disk.sessions[sid].title });
    return;
  }

  if (method === 'session/load') {
    const freshDisk = loadDiskState();
    Object.assign(disk, freshDisk);
    const sid = params.sessionId;
    const saved = disk.sessions[sid];
    if (!saved) {
      send({ id, error: { code: -32602, message: `Unknown session: ${sid}` } });
      return;
    }
    const cfg = { model: 'gemini-4-carbon', thought_level: 'medium', mode: 'default' };
    liveSessions.set(sid, {
      cwd: params.cwd,
      cfg,
      append: params._meta?.antigravity?.systemPrompt?.append || '',
    });
    const hist = saved.history || [];
    const half = Math.ceil(hist.length / 2);
    for (const u of hist.slice(0, half)) {
      sendUpdate(sid, u);
    }
    if (Number(disk.loadDelayMs) > 0) {
      await new Promise((r) => { const t = setTimeout(r, Number(disk.loadDelayMs)); t.unref?.(); });
    }
    // lateReplayCount：模拟真 agy 热加载——最后 N 条历史在 load 响应之后才推（间隔 lateReplayGapMs）
    const late = Math.min(Math.max(Number(disk.lateReplayCount) || 0, 0), hist.length - half);
    const tail = hist.slice(half);
    for (const u of tail.slice(0, tail.length - late)) {
      sendUpdate(sid, u);
    }
    if (late) send({ id, result: sessionResultPayload(sid, cfg) });
    let lateIdx = 0;
    for (const u of tail.slice(tail.length - late)) {
      if (Number(disk.lateReplayGapMs) > 0) {
        await new Promise((r) => { const t = setTimeout(r, Number(disk.lateReplayGapMs)); t.unref?.(); });
      }
      sendUpdate(sid, u);
      // 真 agy 热加载时标题与命令更新夹在回放中间推来（实测第 377/487 条），后面还有历史
      if (++lateIdx === 1 && late > 1) {
        sendUpdate(sid, { sessionUpdate: 'available_commands_update', availableCommands: [] });
        sendUpdate(sid, { sessionUpdate: 'session_info_update', title: saved.title });
      }
    }
    sendUpdate(sid, { sessionUpdate: 'usage_update', used: 512, size: 1048576 });
    if (!late) {
      send({ id, result: sessionResultPayload(sid, cfg) });
      sendUpdate(sid, { sessionUpdate: 'session_info_update', title: saved.title });
    }
    return;
  }

  if (method === 'session/close') {
    const freshDisk = loadDiskState();
    if (Number(freshDisk.closeDelayMs) > 0) {
      await new Promise((r) => { const t = setTimeout(r, Number(freshDisk.closeDelayMs)); t.unref?.(); });
    }
    liveSessions.delete(params.sessionId);
    send({ id, result: {} });
    return;
  }

  if (method === 'session/list') {
    const freshDisk = loadDiskState();
    Object.assign(disk, freshDisk);
    // 捕获请求发出时刻的快照；若配置了单次慢响应，延迟返回当时那份旧快照以复现在途失效竞态
    const snapshotSessions = Object.values(disk.sessions).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    if (Number(disk.listDelayOnceMs) > 0) {
      const waitMs = Number(disk.listDelayOnceMs);
      disk.listDelayOnceMs = 0;
      saveDiskState(disk);
      await new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.(); });
    }
    // 模拟真实 agy：夹带一条无工作区记录、回填当前进程 cwd 的旧会话
    const phantom = {
      sessionId: '00000000-0000-0000-0000-phantom00001',
      cwd: process.cwd(),
      title: 'Unscoped Legacy Session',
      updatedAt: '2026-07-01T00:00:00Z',
    };
    const sessions = [phantom, ...snapshotSessions];
    send({ id, result: { sessions } });
    return;
  }

  if (method === 'session/set_config_option') {
    const live = liveSessions.get(params.sessionId);
    if (!live) {
      send({ id, error: { code: -32602, message: 'Session not mounted' } });
      return;
    }
    const { configId, value } = params;
    if (configId === 'model') {
      live.cfg.model = value;
      const allowedThoughts = thoughtOptionsFor(value).map((o) => o.value);
      if (!allowedThoughts.includes(live.cfg.thought_level)) {
        live.cfg.thought_level = 'medium';
      }
    } else if (configId === 'thought_level') {
      const allowed = thoughtOptionsFor(live.cfg.model).map((o) => o.value);
      if (!allowed.includes(value)) {
        send({ id, error: { code: -32602, message: `Unsupported thought_level ${value} for model ${live.cfg.model}` } });
        return;
      }
      live.cfg.thought_level = value;
    } else if (configId === 'mode') {
      live.cfg.mode = value;
      sendUpdate(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: value });
    }
    const configOptions = buildConfigOptions(live.cfg);
    send({ id, result: { configOptions } });
    sendUpdate(params.sessionId, { sessionUpdate: 'config_option_update', configOptions });
    return;
  }

  if (method === 'session/set_mode') {
    const live = liveSessions.get(params.sessionId);
    if (!live) {
      send({ id, error: { code: -32602, message: 'Session not mounted' } });
      return;
    }
    live.cfg.mode = params.modeId;
    send({ id, result: {} });
    sendUpdate(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    sendUpdate(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions(live.cfg) });
    return;
  }

  if (method === 'session/set_model') {
    const live = liveSessions.get(params.sessionId);
    if (!live) {
      send({ id, error: { code: -32602, message: 'Session not mounted' } });
      return;
    }
    const m = /^(.*)-(low|medium|high|xhigh)$/.exec(String(params.modelId || ''));
    if (m) {
      live.cfg.model = m[1];
      live.cfg.thought_level = m[2];
    } else {
      live.cfg.model = params.modelId;
    }
    send({ id, result: {} });
    sendUpdate(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions(live.cfg) });
    return;
  }

  if (method === 'session/cancel') {
    const active = activePrompts.get(params.sessionId);
    if (active) active.cancel();
    return;
  }

  if (method === 'session/prompt') {
    const sid = params.sessionId;
    const live = liveSessions.get(sid);
    if (!live) {
      send({ id, error: { code: -32602, message: 'Session not mounted' } });
      return;
    }

    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    // 状态文件里的 rejectPromptBlockTypes：带了这些类型的内容块就整条拒收（模拟 agy 不认某种块）
    const rejectTypes = loadDiskState().rejectPromptBlockTypes;
    if (Array.isArray(rejectTypes) && blocks.some((b) => rejectTypes.includes(b?.type))) {
      send({ id, error: { code: -32602, message: 'unsupported content block type' } });
      return;
    }
    const textBlock = blocks.find((b) => b.type === 'text');
    const imageCount = blocks.filter((b) => b.type === 'image').length;
    const promptText = textBlock?.text || '';

    // 一条还没答完又来一条（中途插话）：和真 agy 一样，前一条立刻以 end_turn 返回，新消息并进正在跑的这一轮，
    // 由新这条的请求 id 收尾
    const running = activePrompts.get(sid);
    if (running?.steer) {
      running.steer(id, promptText);
      return;
    }

    let cancelled = false;
    let onCancel = null;
    activePrompts.set(sid, {
      cancel: () => {
        cancelled = true;
        if (onCancel) onCancel();
      },
    });

    const saved = disk.sessions[sid];

    // 后台子代理的回报在这一条到来时送达（真 agy 没有自动叫醒，靠下一条 prompt）
    const delivered = deliverInbox(sid);
    if (delivered.length) {
      saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
      const firstBody = String(delivered[0].content || '');
      const isImgReport = /\.(?:png|jpe?g|webp|gif)\b/i.test(firstBody.split('\n')[0] || '');
      const text = isImgReport
        ? `图片好了：${delivered.map((m) => { const file = String(m.content || '').split('\n')[0]; return `[${path.basename(file)}](${file})`; }).join(' ')}`
        : `子代理已汇报：${delivered.map((m) => m.content).join('\n')}`;
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saveDiskState(disk);
      activePrompts.delete(sid);
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 12, cachedReadTokens: 0, thoughtTokens: 3, totalTokens: 45 } } });
      return;
    }

    // [SWARM_DEMO]：创建完整 Native Swarm 落盘现场并发送 swarm 工具调用，供单测与浏览器可视化验收
    if (promptText.includes('[SWARM_DEMO]') && fakeDataDir) {
      saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
      const sw = spawnFakeSwarm(sid);
      const calls = [
        {
          toolCallId: 'call_sw_title_' + Date.now(),
          name: 'swarm',
          kind: 'other',
          title: 'Run swarm',
          rawInput: { action: 'title', title: 'Swarm 面板适配与验收' },
          rawOutput: { output: 'Title updated.' },
        },
        {
          toolCallId: 'call_sw_be_' + Date.now(),
          name: 'swarm',
          kind: 'other',
          title: 'Run swarm',
          rawInput: { action: 'add', name: 'backend', workspace: 'share', brief: '实现 Swarm 只读解析接口' },
          rawOutput: { output: `Added worker backend (${sw.backendId})` },
        },
        {
          toolCallId: 'call_sw_fe_' + Date.now(),
          name: 'swarm',
          kind: 'other',
          title: 'Run swarm',
          rawInput: { action: 'add', name: 'frontend', workspace: 'share', brief: '搭建 Swarm 四视图界面' },
          rawOutput: { output: `Added worker frontend (${sw.frontendId})` },
        },
      ];
      for (const call of calls) {
        sendUpdate(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
        sendUpdate(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...call });
        saved.history.push({ sessionUpdate: 'tool_call', status: 'completed', ...call });
      }
      const text = '已启动多代理协作群，backend 已完工，frontend 正在微调界面，verifier 正在复核。';
      appendTranscript(sid, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: promptText });
      appendTranscript(sid, { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: text });
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saveDiskState(disk);
      activePrompts.delete(sid);
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 32, cachedReadTokens: 0, thoughtTokens: 6, totalTokens: 118 } } });
      return;
    }

    // [TEAMWORK_SUB_PERM]：两层子代理里第 2 层 worker 卡在 steps.status=9 待审批，
    // 复现真 agy 行为：不经 session/resume(workerId) 绝不发 session/request_permission；resume 后立即推送。
    if (promptText.includes('[TEAMWORK_SUB_PERM]') && fakeDataDir) {
      saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
      const coordId = crypto.randomUUID();
      const workerId = crypto.randomUUID();
      const rootSys = path.join(brainDirOf(sid), '.system_generated');
      const coordSys = path.join(brainDirOf(coordId), '.system_generated');
      const workerSys = path.join(brainDirOf(workerId), '.system_generated');
      fs.mkdirSync(path.join(rootSys, 'subagents'), { recursive: true });
      fs.mkdirSync(path.join(rootSys, 'messages'), { recursive: true });
      fs.mkdirSync(path.join(coordSys, 'subagents'), { recursive: true });
      fs.mkdirSync(path.join(coordSys, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(workerSys, 'logs'), { recursive: true });
      const convDir = path.join(fakeDataDir, 'conversations');
      fs.mkdirSync(convDir, { recursive: true });

      const nowIso = new Date().toISOString();
      fs.writeFileSync(path.join(rootSys, 'subagents', coordId + '.json'), JSON.stringify({
        conversationId: coordId,
        subagentDescriptor: { typeName: 'teamwork_coordinator', role: 'Teamwork Coordinator' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 1,
      }), 'utf8');
      fs.writeFileSync(path.join(coordSys, 'subagents', workerId + '.json'), JSON.stringify({
        conversationId: workerId,
        subagentDescriptor: { typeName: 'teamwork_worker', role: 'M1 Live Sync Worker' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 2,
      }), 'utf8');

      fs.writeFileSync(path.join(coordSys, 'logs', 'transcript_full.jsonl'), [
        JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: nowIso, content: '协调抓取任务' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, model: 'gemini-4-neon-high', tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'teamwork_worker', Role: 'M1 Live Sync Worker' } }] }),
        JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE', created_at: nowIso, content: `Subagent launched with conversationId: ${workerId}` }),
      ].join('\n') + '\n', 'utf8');

      fs.writeFileSync(path.join(workerSys, 'logs', 'transcript_full.jsonl'), [
        JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: nowIso, content: '运行线上榜单抓取脚本' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, model: 'gemini-4-hydrogen-tiered-high', tool_calls: [{ name: 'run_command', args: { CommandLine: 'python aa_data/fetch_ca.py', BypassSandbox: true, toolSummary: '抓取线上榜单' } }] }),
      ].join('\n') + '\n', 'utf8');

      const workerDbFile = path.join(convDir, workerId + '.db');
      const wdb = new DatabaseSync(workerDbFile);
      wdb.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0)');
      wdb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 101, 3);
      wdb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 3);
      wdb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(2, 132, 9);
      wdb.close();

      pendingSubagentPerms.set(workerId, async () => {
        const permRes = await callClientWithStringId('subperm', 'session/request_permission', {
          sessionId: workerId,
          toolCall: {
            toolCallId: 'sub_cmd_1',
            name: 'run_command',
            kind: 'execute',
            status: 'pending',
            title: 'python aa_data/fetch_ca.py',
            rawInput: { CommandLine: 'python aa_data/fetch_ca.py', BypassSandbox: true, toolSummary: '抓取线上榜单' },
          },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        });
        const opt = permRes?.outcome?.optionId || permRes?.outcome?.outcome || 'cancelled';
        const udb = new DatabaseSync(workerDbFile);
        udb.exec('PRAGMA busy_timeout=5000;');
        udb.prepare('UPDATE steps SET status = ? WHERE idx = 2').run(opt === 'allow' ? 3 : 7);
        udb.close();
        appendTranscript(workerId, {
          step_index: 2,
          source: 'SYSTEM',
          type: 'GENERIC',
          status: opt === 'allow' ? 'DONE' : 'ERROR',
          content: `subperm=${opt}`,
        });
        appendTranscript(sid, {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: `子代理权限结果：${opt}`,
        });
      });

      const call = {
        toolCallId: 'call_tw_perm_' + Date.now(),
        name: 'invoke_subagent',
        kind: 'other',
        title: 'Run invoke_subagent',
        rawInput: { TypeName: 'teamwork_coordinator', Role: 'Teamwork Coordinator', Prompt: '协调抓取' },
        rawOutput: { output: `Subagent launched with conversationId: ${coordId}` },
      };
      sendUpdate(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
      sendUpdate(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...call });
      saved.history.push({ sessionUpdate: 'tool_call', status: 'completed', ...call });
      const text = '已派出 Teamwork 团队执行抓取。';
      appendTranscript(sid, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: promptText });
      appendTranscript(sid, { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: text });
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saveDiskState(disk);
      activePrompts.delete(sid);
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 60, outputTokens: 20, cachedReadTokens: 0, thoughtTokens: 5, totalTokens: 85 } } });
      return;
    }

    // [TEAMWORK_AUTO] / [TEAMWORK_ASK] / [TEAMWORK_STALL]：派一个两层多代理团队并正常收尾
    if ((promptText.includes('[TEAMWORK_AUTO]') || promptText.includes('[TEAMWORK_ASK]') || promptText.includes('[TEAMWORK_STALL]')) && fakeDataDir) {
      const isStall = promptText.includes('[TEAMWORK_STALL]');
      const askInBg = promptText.includes('[TEAMWORK_ASK]');
      saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
      const { coordId } = spawnFakeTeamwork(sid, {
        mode: isStall ? 'stall' : 'auto',
        delayMs: 220,
        askInBg,
      });
      const call = {
        toolCallId: 'call_tw_' + Date.now(),
        name: 'invoke_subagent',
        kind: 'other',
        title: 'Run invoke_subagent',
        rawInput: { TypeName: 'teamwork_coordinator', Role: 'Teamwork Coordinator', Prompt: '协调整个项目任务' },
        rawOutput: { output: `Subagent launched with conversationId: ${coordId}` },
      };
      sendUpdate(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
      sendUpdate(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...call });
      saved.history.push({ sessionUpdate: 'tool_call', status: 'completed', ...call });
      const text = '已派出 Teamwork 总协调器，有进展会自动同步给你。';
      appendTranscript(sid, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: promptText });
      appendTranscript(sid, { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: text });
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saveDiskState(disk);
      activePrompts.delete(sid);
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 60, outputTokens: 20, cachedReadTokens: 0, thoughtTokens: 5, totalTokens: 85 } } });
      return;
    }

    // [BG:<毫秒>]：派一个后台生图子代理后马上结束这一轮（「请稍候」），成品过一会儿才落进收件箱
    const bgMatch = /\[BG:(\d+)\]/.exec(promptText);
    if (bgMatch && fakeDataDir) {
      saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
      const call = { toolCallId: 'call_sub_' + Date.now(), name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', rawInput: { TypeName: 'image-generator', Role: 'Image Generator', Prompt: 'draw' } };
      sendUpdate(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
      spawnFakeSubagent(sid, Number(bgMatch[1]));
      sendUpdate(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...call });
      saved.history.push({ sessionUpdate: 'tool_call', status: 'completed', ...call });
      const text = '正在生成图片，请稍候。';
      appendTranscript(sid, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: text });
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      saveDiskState(disk);
      activePrompts.delete(sid);
      send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 10, cachedReadTokens: 0, thoughtTokens: 2, totalTokens: 52 } } });
      return;
    }
    saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
    saved.title = 'Fake Title: ' + promptText.slice(0, 24);
    saved.updatedAt = new Date().toISOString();
    saveDiskState(disk);

    sendUpdate(sid, { sessionUpdate: 'session_info_update', title: saved.title });

    // 演示流（11-19，动效验收用）：按真实节奏推一整轮——思考分段流出、读文件 / 跑命令 / 改文件三步工具、
    // 再按 ~90ms 一批、带抖动地吐一段含标题 / 列表 / 代码块 / 表格的正文。[DEMO_SLOW] 节奏放慢一倍。
    if (promptText.includes('[DEMO')) {
      const k = promptText.includes('[DEMO_SLOW]') ? 2 : 1;
      const sleep = (ms) => new Promise((resolve) => {
        const tm = setTimeout(resolve, ms * k);
        onCancel = () => { clearTimeout(tm); resolve(); };
      });
      const push = (u) => { sendUpdate(sid, u); saved.history.push(u); };
      await sleep(700);
      for (const piece of ['先看一下', '项目结构，', '确认动效相关的组件', '都在哪里，再决定', '从哪一块开始改。']) {
        if (cancelled) break;
        push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
        await sleep(260);
      }
      const tools = [
        { id: 'demo_read', name: 'view_file', kind: 'read', title: 'src/components/Composer.svelte', rawInput: { AbsolutePath: (live.cwd || '') + '/src/components/Composer.svelte' }, ms: 900 },
        { id: 'demo_cmd', name: 'run_command', kind: 'execute', title: 'npm run test -- motion', rawInput: { CommandLine: 'npm run test -- motion' }, ms: 1600, out: 'ok 12 tests' },
        { id: 'demo_edit', name: 'replace_file_content', kind: 'edit', title: 'motion.js', rawInput: { TargetFile: (live.cwd || '') + '/motion.js' }, ms: 1100, diff: true },
      ];
      for (const tl of tools) {
        if (cancelled) break;
        push({ sessionUpdate: 'tool_call', toolCallId: tl.id, name: tl.name, kind: tl.kind, status: 'in_progress', title: tl.title, rawInput: tl.rawInput });
        await sleep(tl.ms);
        const done = { sessionUpdate: 'tool_call_update', toolCallId: tl.id, name: tl.name, kind: tl.kind, status: 'completed', title: tl.title, rawInput: tl.rawInput };
        if (tl.out) done.rawOutput = { output: tl.out, exit_code: 0 };
        if (tl.diff) done.content = [{ type: 'diff', path: (live.cwd || '') + '/motion.js', oldText: ['a', 'b', ''].join('\n'), newText: ['a', 'B', 'c', ''].join('\n') }];
        push(done);
        await sleep(240);
      }
      if (!cancelled) {
        push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '测试通过，开始整理结论。' } });
        await sleep(900);
      }
      const answer = `## 改动概览

这一版把分页的动效统一成一套 **Material 3** 的节奏：进场用 emphasized decelerate，退场用 emphasized accelerate，同一个元素在两个状态之间移动时走 emphasized 曲线；空间类的位移允许一点点回弹，透明度一律临界阻尼。

- 欢迎页的标记在发出第一条消息时直接飞进状态栏
- 状态文字在同一个位置向上滚动换场
- 仪表展开成菜单，关闭时再缩回去

~~~js
export const EASE = {
  decel: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  accel: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
};
~~~

| 场景 | 曲线 | 时长 |
| --- | --- | --- |
| 进场 | decelerate | 420ms |
| 退场 | accelerate | 200ms |
| 共享元素 | emphasized | 600ms |

验证方式：在隔离的测试实例里逐帧截图，确认每一段动画首尾都和静止态严丝合缝地对上。`;
      let pos = 0;
      while (pos < answer.length && !cancelled) {
        const n = 6 + Math.floor(Math.random() * 14);
        const piece = answer.slice(pos, pos + n);
        pos += n;
        push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
        await sleep(60 + Math.random() * 70);
      }
      saved.updatedAt = new Date().toISOString();
      disk.sessions[sid] = saved;
      saveDiskState(disk);
      activePrompts.delete(sid);
      sendUpdate(sid, { sessionUpdate: 'usage_update', used: 18400, size: 1048576 });
      send({
        id,
        result: {
          stopReason: cancelled ? 'cancelled' : 'end_turn',
          usage: { inputTokens: 1200, outputTokens: 640, cachedReadTokens: 0, thoughtTokens: 180, totalTokens: 2020 },
        },
      });
      return;
    }

    // 慢速流式模式：用于验证 session/cancel（支持携带未完结工具卡供历史回放验证）
    if (promptText.includes('[SLOW]')) {
      if (promptText.includes('[SLOW_TOOL]')) {
        const slowTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_slow_1',
          name: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          title: 'npm run benchmark -- --full',
          rawInput: { CommandLine: 'npm run benchmark -- --full' },
        };
        sendUpdate(sid, slowTool);
        saved.history.push(slowTool);
      }
      const mcpMatch = /\[SLOW_MCP:([a-zA-Z0-9_]+)\]/.exec(promptText);
      if (mcpMatch) {
        const mcpTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_mcp_1',
          name: mcpMatch[1],
          kind: 'other',
          status: 'in_progress',
          title: mcpMatch[1],
          rawInput: {},
        };
        sendUpdate(sid, mcpTool);
        saved.history.push(mcpTool);
      }
      sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1... ' } });
      saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1... ' } });
      saveDiskState(disk);
      // 插话接管：前一条立刻返回，之后由新 id 收尾；插话里带 [GO] 就不再干等、马上往下走
      let replyId = id;
      const steered = [];
      let finishWait = null;
      activePrompts.get(sid).steer = (newId, text) => {
        send({ id: replyId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 120 } } });
        replyId = newId;
        steered.push(text);
        saved.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        if (text.includes('[GO]') && finishWait) finishWait();
      };
      await new Promise((resolve) => {
        const t = setTimeout(resolve, promptText.includes('[SLOW_LONG]') ? 120_000 : 10_000);
        t.unref?.();
        finishWait = () => { clearTimeout(t); resolve(); };
        onCancel = finishWait;
      });
      if (steered.length && !cancelled) {
        const text = `steered=${steered.join('|')}`;
        sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        // 等的这段时间里别的请求（session/list 等）会把内存状态整份换成磁盘上的：把这一轮攒下的历史挂回去再存
        disk.sessions[sid] = saved;
        saveDiskState(disk);
      }
      activePrompts.delete(sid);
      sendUpdate(sid, { sessionUpdate: 'usage_update', used: 120, size: 1048576 });
      send({
        id: replyId,
        result: {
          stopReason: cancelled ? 'cancelled' : 'end_turn',
          usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 120 },
        },
      });
      return;
    }

    sendUpdate(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在思考方案...' } });
    saved.history.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在思考方案...' } });

    // 触发文件编辑 diff
    if (promptText.includes('[EDIT]')) {
      const uriPath = '/' + String(live.cwd || '').replace(/\\/g, '/') + '/edited.txt';
      sendUpdate(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_edit_1',
        name: 'edit_file',
        kind: 'edit',
        status: 'in_progress',
        title: 'File edited.txt',
        locations: [{ path: live.cwd + '\\edited.txt' }],
        rawInput: { Path: live.cwd + '\\edited.txt' },
      });
      const completedTool = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_edit_1',
        name: 'edit_file',
        kind: 'edit',
        status: 'completed',
        title: `File ${uriPath}`,
        locations: [{ path: uriPath }],
        rawInput: { Path: live.cwd + '\\edited.txt' },
        content: [{ type: 'diff', path: uriPath, oldText: 'before\n', newText: 'after\n' }],
      };
      sendUpdate(sid, completedTool);
      saved.history.push({ ...completedTool, sessionUpdate: 'tool_call' });
    }

    // 触发权限请求（使用字符串 ID）
    let permNote = '';
    if (promptText.includes('[PERM]')) {
      const cmdLine = promptText.includes('[PERM_CD]')
        ? `Set-Location "${live.cwd}"; node app.js --verify`
        : 'echo ok';
      // [PERM_BRIDGE]：换成 bridge 自家工具的审批（mcp_bridge_call + chat.send 发给 Claude），验插件审批策略
      const bridgeArgs = { op: 'chat.send', args: { message: '帮我出 apk' } };
      const toolCall = promptText.includes('[PERM_BRIDGE]') ? {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_cmd_1',
        name: 'mcp_bridge_call',
        kind: 'other',
        status: 'pending',
        title: 'bridge / call',
        args: bridgeArgs,
        rawInput: bridgeArgs,
      } : {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_cmd_1',
        name: 'run_command',
        kind: 'execute',
        status: 'pending',
        title: cmdLine,
        args: { CommandLine: cmdLine, toolSummary: 'Verify app.js execution' },
        rawInput: { CommandLine: cmdLine, toolSummary: 'Verify app.js execution' },
      };
      sendUpdate(sid, { ...toolCall, status: 'in_progress' });
      sendUpdate(sid, { ...toolCall, sessionUpdate: 'tool_call_update', status: 'pending' });
      saved.history.push({ ...toolCall, status: 'in_progress' });
      saved.history.push({ ...toolCall, sessionUpdate: 'tool_call_update', status: 'pending' });
      disk.sessions[sid] = saved;
      saveDiskState(disk);

      try {
        const permPromise = callClientWithStringId('perm', 'session/request_permission', {
          sessionId: sid,
          toolCall,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        });
        const cancelPromise = new Promise((resolve) => {
          onCancel = () => resolve({ __cancelledByNotify: true });
        });
        const permRes = await Promise.race([permPromise, cancelPromise]);
        if (cancelled || permRes?.__cancelledByNotify) {
          sendUpdate(sid, { ...toolCall, sessionUpdate: 'tool_call_update', status: 'failed', rawOutput: { output: '' } });
          activePrompts.delete(sid);
          send({
            id,
            result: {
              stopReason: 'cancelled',
              usage: { inputTokens: 80, outputTokens: 10, cachedReadTokens: 0, thoughtTokens: 5, totalTokens: 95 },
            },
          });
          return;
        }
        const selected = permRes?.outcome?.optionId;
        permNote = ` perm=${selected}`;
        const finalPermTool = {
          ...toolCall,
          sessionUpdate: 'tool_call_update',
          status: selected === 'allow' ? 'completed' : 'failed',
          rawOutput: { output: selected === 'allow' ? 'ok\n' : 'denied\n', exit_code: selected === 'allow' ? 0 : 1 },
        };
        sendUpdate(sid, finalPermTool);
        saved.history.push(finalPermTool);
      } catch (err) {
        activePrompts.delete(sid);
        send({ id, error: { code: -32603, message: err.message } });
        return;
      }
    }

    // 触发结构化表单提问（elicitation/create，使用字符串 ID）
    let questionNote = '';
    if (promptText.includes('[QUESTION]')) {
      try {
        const qRes = await callClientWithStringId('ask', 'elicitation/create', {
          mode: 'form',
          message: '请选择部署目标环境',
          requestedSchema: {
            type: 'object',
            required: ['env'],
            properties: {
              env: {
                type: 'string',
                title: '目标环境',
                oneOf: [
                  { const: 'staging', title: '测试环境' },
                  { const: 'prod', title: '生产环境' },
                ],
              },
              features: {
                type: 'array',
                title: '启用特性',
                items: {
                  type: 'string',
                  anyOf: [
                    { const: 'cache', title: '缓存' },
                    { const: 'metrics', title: '监控' },
                  ],
                },
              },
            },
          },
        });
        questionNote = ` answer=${qRes?.action}:${JSON.stringify(qRes?.content || {})}`;
      } catch (err) {
        activePrompts.delete(sid);
        send({ id, error: { code: -32603, message: err.message } });
        return;
      }
    }

    const linkMatches = [...promptText.matchAll(/\[LINK:([^\]]+)\]/g)];
    const linkSuffix = linkMatches.map((m, idx) => ` [产物${idx + 1}](${m[1]})`).join('');
    const replyText = `model=${live.cfg.model}/${live.cfg.thought_level}/${live.cfg.mode} imgs=${imageCount}${permNote}${questionNote}${linkSuffix}${live.append ? ' [APPEND_OK]' : ''}`;

    sendUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replyText } });
    sendUpdate(sid, { sessionUpdate: 'usage_update', used: 256, size: 1048576 });

    saved.history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replyText } });
    saved.updatedAt = new Date().toISOString();
    disk.sessions[sid] = saved;
    saveDiskState(disk);

    activePrompts.delete(sid);
    send({
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 200, outputTokens: 56, cachedReadTokens: 50, thoughtTokens: 12, totalTokens: 256 },
      },
    });
    return;
  }

  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
