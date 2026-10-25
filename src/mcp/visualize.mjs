// In-process MCP「visualize」：对话内嵌交互图表（对齐官方 Claude Desktop 3.1623 的内置 visualize server）。
//
//   read_me     → 返回画图指南（按 modules + platform 拼段，见 visualize-guide.mjs）。对话里不显示（官方 hidden_in_chat）。
//   show_widget → 入参 loading_messages / title / widget_code，结果是固定一句话；真正的渲染在前端：
//                 直播时 claude.mjs 把 tool_use 的参数增量（input_json_delta）经 makeWidgetStream 切出 widget_code
//                 推 widget_* 帧，历史重建（routes/sessions.mjs）把 tool_use 直接落成 widget 段。
//                 前端 components/claude/WidgetFrame.svelte：网页 / 桌面壳 = sandbox="allow-scripts" 的 srcdoc iframe；
//                 手机 apk = 剥掉脚本的静态渲染（原生桥注入所有帧，脚本能读到 token）。
//
// 服务端没有任何主机能力（不执行命令、不读写文件），所以所有身份都给；设置「对话内交互图表」关掉就不挂。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { claudeSetting } from '../runtime/claude-settings.mjs';
import { guideFor, MODULES, PLATFORMS } from './visualize-guide.mjs';

export const VIZ_SERVER = 'visualize';
export const VIZ_SHOW = 'mcp__visualize__show_widget';
export const VIZ_README = 'mcp__visualize__read_me';
export const isVizTool = (name) => typeof name === 'string' && name.startsWith('mcp__visualize__');
// 显式放行（SDK allowedTools）：auto 模式下 MCP 工具默认要过安全分类器——画图是纯展示，过一次分类器既慢又要多花一次
// 模型请求，分类器一时不可用还会把图表整张拦掉（隔离实例实测：「Auto mode could not evaluate this action」）。
// 代价：SDK 每次 query() 都为这两个裸名打一条 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 警告——agents/claude.mjs 里每进程只放行第一条。
export const VIZ_ALLOWED_TOOLS = [VIZ_README, VIZ_SHOW];

// widget_code 上限：模型偶尔会把整份数据集内联进来；再大前端也画不动、重放缓冲也背不起。
export const MAX_WIDGET_CODE = 512 * 1024;

const SHOW_DESC = `Show a visual — an SVG diagram or illustration, a chart, or a small interactive HTML widget — inline in the conversation, right where you call it.
Good for flowcharts, architecture diagrams, charts, dashboards, comparison cards, calculators, forms and simple games.
widget_code that starts with <svg is rendered as SVG; anything else as an HTML fragment.
Inside HTML a global sendPrompt(text) sends a message to the chat as if the user typed it (only from a user click).
IMPORTANT: call read_me before your first show_widget in a conversation. Do it silently — never mention read_me to the user; carry on as if you went straight to drawing.`;

const READ_DESC = `Returns the drawing guide for show_widget: the host's CSS variables, color palette, typography, layout rules and patterns for each module. Call it before your first show_widget, and again when you need a different module. It is an internal setup step: do not mention or narrate it to the user — call it silently and go straight on to the visual.`;

const LOADING_DESC = `1–4 short status lines (about 5 words each) shown while the visual is being drawn, in the user's language. One is enough for a simple visual, more for a complex one. For serious or sensitive subjects — illness, death, grief, war, disasters, abuse, addiction, money trouble, politics, anything personal — keep them plain and literal, describing the work in the dullest way ("Setting up the chart", "Laying out the stages"). Otherwise a little playfulness is welcome: alliteration, a pun, personification ("Lining up the bars", "Herding boxes into rows").`;

const TITLE_DESC = `Short snake_case name that tells this visual apart from others in the conversation, e.g. "q3_revenue_by_region" rather than "chart", "oauth_login_flow" rather than "diagram". Also used as the download file name: letters, digits and underscores only.`;

const CODE_DESC = `The SVG or HTML to render. SVG: one <svg> root with a viewBox (width 680, or 380 on the phone), colors from the host's CSS variables and c-* classes. HTML: a fragment — no DOCTYPE, <html>, <head> or <body>; keep the outer background transparent and add no top-level padding; use the CSS variables for theming. Scripts run after the code finishes streaming — and never on the phone app, so the markup must make sense on its own.`;

const RENDERED = 'Rendered and shown to the user inline. Do not repeat its content in text — it is already visible; refer to it instead.';

/** 设置「对话内交互图表」开没开。快照访客 getClaudeSettings 回默认值（开）。 */
export function vizEnabled(ctx) {
  try { return claudeSetting(ctx, 'inlineVisualizations') !== false; } catch { return true; }
}

/**
 * 这一轮挂不挂 visualize（claude.mjs 一行调用；结果进 warmSig）。除了设置关掉，下面几种也不挂：
 *  · 快照访客（ctx.snap）：对齐官方「分享时不显示交互图表」，前端 IS_CSNAP 下图表段也只给占位 + 查看代码；
 *  · 悬浮胶囊发起的轮（source:'capsule'）：原生 ClaudeStream 只渲染 text/thinking/tool，widget_* 帧全被丢掉，
 *    模型又被要求「图里有的别在正文重复」——用户什么也看不到。这类轮让模型照旧用文字 / 表格回答；
 *  · 只认文本的通道（plain：管理台代聊的 SSE）。
 */
export function vizOnFor(ctx, { source, plain } = {}) {
  if (!ctx || ctx.snap || source === 'capsule' || plain === true) return false;
  return vizEnabled(ctx);
}

/** 出图平台：手机 App，或窄屏网页（手机浏览器，前端 /api/chat 带 narrow:true）→ mobile（约 380px 宽）。 */
export function vizPlatform({ phone, narrow } = {}) {
  return phone === true || narrow === true ? 'mobile' : 'desktop';
}

/**
 * 手机 / 窄屏发起的轮补一句平台提示（官方：系统提示说明是手机时 read_me 传 mobile）。宽屏网页 / 桌面不加。
 * 第二个参数旧写法是布尔 fromPhone，仍认。
 */
export function vizNudge(on, opts = {}) {
  const { phone, narrow } = typeof opts === 'boolean' ? { phone: opts } : (opts || {});
  if (!on) return '';
  if (phone === true) return '\n\n【内嵌图表】本轮客户端是手机 App（对话栏约 380px 宽，图表只显示静态预览、不运行脚本）：调 mcp__visualize__read_me 时传 platform:"mobile"，图表用纯 SVG / HTML+CSS 画完整。';
  if (narrow === true) return '\n\n【内嵌图表】本轮客户端是窄屏（手机浏览器，对话栏约 380px 宽）：调 mcp__visualize__read_me 时传 platform:"mobile"。';
  return '';
}

// 两个工具的处理函数（纯函数，单测直接调）。
export function readMeResult(args, platform = 'desktop') {
  const a = args || {};
  const p = a.platform && a.platform !== 'unknown' ? a.platform : platform;
  return { content: [{ type: 'text', text: guideFor(a.modules, p) }] };
}
export function showWidgetResult(args) {
  const code = String((args && args.widget_code) || '');
  if (!code.trim()) return { content: [{ type: 'text', text: 'widget_code is empty — nothing was shown. Call show_widget again with the SVG or HTML.' }], isError: true };
  if (code.length > MAX_WIDGET_CODE) return { content: [{ type: 'text', text: `widget_code is too large (${code.length} characters, limit ${MAX_WIDGET_CODE}) — nothing was shown. Draw a smaller visual and keep bulk data out of the code.` }], isError: true };
  return { content: [{ type: 'text', text: RENDERED }] };
}

/** platform：本轮发起端（'mobile' | 'desktop'）——模型没传或传 unknown 时用它。 */
export const makeVisualizeMcp = ({ platform = 'desktop' } = {}) => createSdkMcpServer({
  name: VIZ_SERVER,
  version: '1.0.0',
  alwaysLoad: true,   // 不走工具搜索：read_me 的「先调一次」约定要求两件工具常驻
  tools: [
    tool('read_me', READ_DESC, {
      modules: z.array(z.enum(MODULES)).optional().describe('Which guide modules to load. Pick every one that fits.'),
      platform: z.enum(PLATFORMS).optional().describe('Where the visual will be shown: "mobile" when your system prompt says the client is the phone app (≈380px wide, SVG viewBox and layout sized for it), otherwise "desktop". Omit or "unknown" to let the app decide.'),
    }, async (args) => readMeResult(args, platform), { annotations: { readOnlyHint: true } }),
    tool('show_widget', SHOW_DESC, {
      loading_messages: z.array(z.string()).min(1).max(4).describe(LOADING_DESC),
      title: z.string().describe(TITLE_DESC),
      widget_code: z.string().describe(CODE_DESC),
    }, async (args) => showWidgetResult(args), { annotations: { readOnlyHint: true } }),
  ],
});

// —— 参数增量 → widget 帧 ——
// 模型按 schema 顺序吐 JSON：loading_messages → title → widget_code（官方 claude.ai 也靠这个顺序先显示加载语）。
// widget_code 是一个很长的 JSON 字符串：从它的起点开始逐字解码（\n \" \\ \uXXXX，含代理对），
// 末尾不完整的转义先不解，下次增量来了接着解——整轮 O(n)，不反复 JSON.parse 累计串。

const KEY_RE = (k) => new RegExp('"' + k + '"\\s*:\\s*');
const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * 从 s[i]（字符串值开头引号之后）解码 JSON 字符串到尽头或未完的转义处。
 * 返回 { text, next, closed }：next = 下次从哪接着解，closed = 遇到了结束引号。
 */
export function decodeJsonString(s, i) {
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { text: out, next: i + 1, closed: true };
    if (c !== '\\') {
      // 一段没有转义的连续字符整体拷贝
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\\') j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (i + 1 >= s.length) break;                 // 反斜杠在末尾：等下一段
    const e = s[i + 1];
    if (e === 'u') {
      if (i + 6 > s.length) break;
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i += 6; continue; }
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        // 高代理：要等低代理一起解，否则会切出半个字符
        if (i + 12 > s.length) break;
        const lo = s.slice(i + 6, i + 12);
        if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lo)) { out += String.fromCharCode(code, parseInt(lo.slice(2), 16)); i += 12; continue; }
      }
      out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    out += ESC[e] !== undefined ? ESC[e] : e;
    i += 2;
  }
  return { text: out, next: i, closed: false };
}

/** 从（可能不完整的）参数 JSON 里抠 title 与已写完的 loading_messages。 */
export function peekWidgetMeta(json) {
  const meta = { title: '', loading: [] };
  const tm = KEY_RE('title').exec(json);
  if (tm && json[tm.index + tm[0].length] === '"') {
    const r = decodeJsonString(json, tm.index + tm[0].length + 1);
    if (r.closed) meta.title = r.text;
  }
  const lm = KEY_RE('loading_messages').exec(json);
  if (lm && json[lm.index + lm[0].length] === '[') {
    let i = lm.index + lm[0].length + 1;
    while (i < json.length && meta.loading.length < 4) {
      while (i < json.length && /[\s,]/.test(json[i])) i++;
      if (json[i] !== '"') break;
      const r = decodeJsonString(json, i + 1);
      if (!r.closed) break;
      meta.loading.push(r.text);
      i = r.next;
    }
  }
  return meta;
}

const THROTTLE_MS = 100;

/**
 * 直播桥：claude.mjs 在 message_start / content_block_start / input_json_delta / content_block_stop / tool_result 各调一行。
 * 帧：widget_start {id} → widget_delta {id, from, add, title?, loading?}（节流 ~100ms，只发追加片段）
 *    → widget {id, title, loading, code}（完整、权威；随后从重放缓冲剔掉本 id 的 widget_delta）
 *    → widget_done {id, isError, error?}（tool_result 到达）。
 * getGen：剔重放缓冲用（同 phone-control-tools.mjs 剔 question 帧的做法）。
 */
export function makeWidgetStream(send, getGen) {
  const live = new Map();     // content-block index -> 记录
  const pending = new Map();  // 已定稿、等 tool_result 的 tool_use id -> 定稿代码（判失败用，见 widgetResultError）
  // 丢掉某个 index 上的残留记录：上一条 API 消息里没等到 content_block_stop 的 show_widget（流断重试、安全栅门切模型）
  // 留在这里的话，下一条消息同一 index 上别的工具的参数增量会被喂进来、它的 content_block_stop 还会把拼坏的代码定稿。
  const drop = (index) => {
    const old = live.get(index);
    if (!old) return;
    if (old.timer) clearTimeout(old.timer);
    live.delete(index);
  };

  const flush = (rec) => {
    rec.timer = null;
    const json = rec.json;
    if (!rec.metaDone) {
      const m = peekWidgetMeta(json);
      if (m.title && m.title !== rec.title) { rec.title = m.title; rec.dirtyMeta = true; }
      if (m.loading.length > rec.loading.length) { rec.loading = m.loading; rec.dirtyMeta = true; }
    }
    if (rec.codeAt < 0) {
      const km = KEY_RE('widget_code').exec(json);
      if (km && json[km.index + km[0].length] === '"') { rec.codeAt = km.index + km[0].length + 1; rec.scan = rec.codeAt; rec.metaDone = true; }
    }
    if (rec.codeAt >= 0 && !rec.closed) {
      const r = decodeJsonString(json, rec.scan);
      rec.code += r.text;
      rec.scan = r.next;
      rec.closed = r.closed;
    }
    const add = rec.code.slice(rec.sent);
    if (!add && !rec.dirtyMeta) return;
    const f = { type: 'widget_delta', id: rec.id, from: rec.sent, add };
    if (rec.dirtyMeta) { f.title = rec.title; f.loading = rec.loading; rec.dirtyMeta = false; }
    rec.sent = rec.code.length;
    send(f);
  };

  return {
    start(index, name, id) {
      drop(index);   // 不管新块是什么工具，同一 index 上的旧记录都作废
      if (name !== VIZ_SHOW || !id) return false;
      const rec = { id, json: '', title: '', loading: [], code: '', codeAt: -1, scan: 0, closed: false, sent: 0, metaDone: false, dirtyMeta: false, timer: null };
      live.set(index, rec);
      send({ type: 'widget_start', id, at: Date.now() });
      return true;
    },
    /** 新一条 API 消息开始（message_start）：content-block index 从 0 重新数，上一条没收尾的记录一律作废。 */
    reset() {
      for (const index of [...live.keys()]) drop(index);
    },
    delta(index, json) {
      const rec = live.get(index);
      if (!rec || typeof json !== 'string') return;
      rec.json = json;
      if (!rec.timer) {
        rec.timer = setTimeout(() => { if (live.get(index) === rec) flush(rec); }, THROTTLE_MS);
        if (rec.timer.unref) rec.timer.unref();
      }
    },
    stop(index, input) {
      const rec = live.get(index);
      if (!rec) return;
      live.delete(index);
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      const a = input && typeof input === 'object' ? input : {};
      const code = typeof a.widget_code === 'string' ? a.widget_code : rec.code;
      const loading = Array.isArray(a.loading_messages) ? a.loading_messages.map(String).slice(0, 4) : rec.loading;
      send({ type: 'widget', id: rec.id, title: typeof a.title === 'string' ? a.title : rec.title, loading, code });
      pending.set(rec.id, code);
      // 定稿帧已带完整代码：中间的增量帧对之后 attach 的客户端没用了，别让重放缓冲背着整份代码两遍
      try {
        const gen = getGen && getGen();
        if (gen && Array.isArray(gen.events)) gen.events = gen.events.filter((e) => !(e && e.type === 'widget_delta' && e.id === rec.id));
      } catch {}
    },
    result(blk) {
      if (!blk || !pending.has(blk.tool_use_id)) return false;
      const code = pending.get(blk.tool_use_id);
      pending.delete(blk.tool_use_id);
      const err = widgetResultError(blk, code);
      send({ type: 'widget_done', id: blk.tool_use_id, isError: !!err, ...(err ? { error: err } : {}) });
      return true;
    },
  };
}

// CLI 自己合成的中断 / 跳过标记（is_error，但不是 show_widget 报的错）：用户按了停止、轮被提前收掉、会话结束……
// 这时 widget_code 是完整的、直播里也已经画出来了。
const CLI_SYNTH_RE = /^\s*\[(Request interrupted by user|Tool call (skipped|interrupted)\b)/;

/**
 * 这张图算不算失败（直播 widget_done 与历史重建共用一个判据，两边对账一致）：返回错误文本，'' = 没失败。
 * 官方回放直接拿 tool_use 的 input 渲染、不看结果；这里只有「代码为空」或工具真报了错（代码为空 / 超 512KB /
 * 参数校验没过——模型会改了重调，别留一张重复的图）才算失败，CLI 的合成中断标记不算。
 */
export function widgetResultError(blk, code) {
  if (!String(code || '').trim()) return resultText(blk).slice(0, 300) || 'widget_code is empty';
  if (!blk || !blk.is_error) return '';
  const text = resultText(blk);
  if (CLI_SYNTH_RE.test(text)) return '';
  return text.slice(0, 300) || 'error';
}

function resultText(b) {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
  return '';
}

// —— 历史重建（routes/sessions.mjs）——
// 段形状与直播 widget_* 帧落成的完全一致（web/src/lib/widgetSeg.js）。read_me 不落段（官方 hidden_in_chat）。
export function widgetSegFromToolUse(b) {
  if (!b || b.name !== VIZ_SHOW) return null;
  const a = b.input && typeof b.input === 'object' ? b.input : {};
  return {
    kind: 'widget', id: b.id || '',
    title: typeof a.title === 'string' ? a.title : '',
    loading: Array.isArray(a.loading_messages) ? a.loading_messages.map(String).slice(0, 4) : [],
    code: typeof a.widget_code === 'string' ? a.widget_code : '',
    status: 'ready', error: '',
  };
}
export function applyWidgetResult(seg, b) {
  if (!seg || !b) return;
  const err = widgetResultError(b, seg.code);
  if (!err) return;
  seg.status = 'error';
  seg.error = err;
}
