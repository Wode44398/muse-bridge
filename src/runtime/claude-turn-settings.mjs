// Claude 设置 → 每一轮 query 的启动参数（2026-10-20，对齐官方 Claude Desktop 3.1623「Settings → Claude Code」）。
//
// 注册表与按身份存储见 src/config/claude-settings.mjs / src/runtime/claude-settings.mjs；这里只做「设置值 → SDK 选项」
// 的翻译，claude.mjs 构造 options 那段只留一次调用（turnSettings），新增设置项接线改这一个文件。
//
// 一律走 flag 层（query 的 settings 字面量）：admin 会话还会读 ~/.claude/settings.json（与官方 Desktop / 终端共享），
// 沙箱身份 settingSources:[] 读不到任何文件设置——只有 flag 层对所有身份都生效，而且盖得过项目里的 .claude/settings.json。
// 凡是放进返回的 sdk 对象里的值都会自动进停放 CLI 的复用签名（warmSig），改了下一条消息冷起生效。
//
// 「默认值不下发」：outputStyle='default'、replyLanguage='auto'、attribution='default' 时什么都不写，
// 让 CLI 走它自己的设置层级（admin 的 ~/.claude/settings.json 里写过 outputStyle 的，照旧生效）。
import { getClaudeSettings, noteOutputStyles, outputStylesFor, claudeSettingsSnapshot } from './claude-settings.mjs';
import { busPublish } from './bus.mjs';
import { chatPrefsFor } from './chat-prefs.mjs';
import { buildLadder, currentPlan, normKey } from './model-ratings.mjs';

// 回复语言 → CLI 的 language 设置（自由文本，CLI 拼成「Always respond in {language}…」系统提示段）。
const LANGUAGE = { zh: 'Simplified Chinese', en: 'English' };

// 提交与拉取请求署名：none = 两处都不署名、也不附会话链接（SDK 文档：旧版 CLI 不认布尔，必须用对象形式）。
const NO_ATTRIBUTION = Object.freeze({ commit: '', pr: '', sessionUrl: false });

/**
 * 这一轮该用的设置。
 *   ctx         身份上下文（快照访客 ctx.snap → 一律走老行为：不暂停、不建议、不下发任何偏好）
 *   suggest     老客户端请求体里的 suggest（输入建议开关，原先存在每台设备的 localStorage）
 *   compactFrac 老客户端请求体里的自动压缩点
 *   sessionId   续聊的会话 id（取会话级输出风格覆盖）
 *   outputStyle 这条请求随带的会话级输出风格（新会话在发出第一条前就选好了的）
 * 返回 { suggest, compactFrac, pauseOnFlag, sdk, autoContinue, dispatch }（autoContinue 只是开头那一刻的值；撞墙处用 autoContinueDefault 现读；
 * dispatch = 子 agent 调度偏好原文，拼系统提示见 dispatchNudge）。
 *
 * 输入建议 / 自动压缩点以服务端设置为准；服务端是默认值（没人改过）时才看请求体——老 apk 本机关掉的建议、
 * 拖过的压缩点照旧生效，新前端带的就是服务端值，两边一致。
 */
export function turnSettings(ctx, { suggest, compactFrac, sessionId, outputStyle } = {}) {
  const snap = !!(ctx && ctx.snap);
  if (snap) return { suggest: false, compactFrac: undefined, pauseOnFlag: false, sdk: {}, autoContinue: false, dispatch: '' };
  const v = getClaudeSettings(ctx);
  const sdk = {};
  // 输出风格：会话覆盖（菜单里给这个会话单选的，含「默认」）优先，否则全局默认；全局是默认就不写。
  const over = cleanStyle(outputStyle) ?? (sessionId ? cleanStyle(chatPrefsFor(ctx, sessionId)?.outputStyle) : null);
  if (over) sdk.outputStyle = over;
  else if (v.outputStyle && v.outputStyle !== 'default') sdk.outputStyle = v.outputStyle;
  if (LANGUAGE[v.replyLanguage]) sdk.language = LANGUAGE[v.replyLanguage];
  if (v.attribution === 'none') sdk.attribution = { ...NO_ATTRIBUTION };
  // 动态工作流只对能跑命令的身份有意义（注册表 shell:true）；其余身份不写，交给 CLI 按套餐默认。
  // ultracode 档的 effortOpts.settings 在 claude.mjs 里排在后面，仍强制 enableWorkflows:true。
  if (ctx && (ctx.kind === 'admin' || ctx.shell)) sdk.enableWorkflows = v.enableWorkflows !== false;
  // 安全栅门：关着（默认）= 暂停二选一（switchModelsOnFlag:false + 声明 refusal 对话框）；
  // 开着 = 不声明对话框，走自动切换 → model_refusal_fallback → 输入框上方横条。
  // 两种状态都必须显式下发布尔值：开着时若不写，CLI 回落去读 user / project 层——维护者本机 ~/.claude/settings.json
  // 就写着 switchModelsOnFlag:false，而 CLI 2.1.299 的 shouldSuppressRefusalFallback 判定「宿主没声明对话框 &&
  // 解析值 === false」→ 直接压掉回退模型，这一轮按经典拒答收尾（既不换模型也不暂停）。flag 层写 true 才盖得过。
  const pauseOnFlag = !v.switchModelsOnFlag;
  sdk.switchModelsOnFlag = !pauseOnFlag;
  const sug = v.promptSuggestions === false ? false : !!suggest;
  const frac = typeof v.compactFrac === 'number' ? v.compactFrac : compactFrac;
  const dispatch = ctx && (ctx.kind === 'admin' || ctx.shell) && typeof v.subagentDispatch === 'string' ? v.subagentDispatch.trim() : '';
  return { suggest: sug, compactFrac: frac, pauseOnFlag, sdk, autoContinue: v.autoContinueOnLimit !== false, dispatch };
}

// —— 子 agent 调度（设置 › Claude › 对话 › 子 agent 调度偏好）——
// 官方 Agent 工具的 effort / model 参数写着「只在用户或 CLAUDE.md 这类指令明确要求时才设，别自己判断」，Workflow 的 agent() 也是
// 「默认省略、继承主会话」——结果 Claude 派出去的子 agent 几乎全跟主会话同模型同档。这段系统提示就是那个「明确要求」：
// 每个子 agent 按难度显式定档；自定义 API 会话再列出能派的第三方模型（代理按模型名跨服务转发，见 claude-providers-transform 的 pickTarget）。
const fmtCtx = (n) => (n >= 1e6 ? +(n / 1048576).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : '');
const MAX_CATALOG = 40;
const NL = String.fromCharCode(10);

/**
 * 动态工作流开着的轮拼进系统提示的一段（关着回 ''）。
 *   on        这一轮开着动态工作流（设置项或 Ultracode）
 *   text      用户写的调度偏好（可空）
 *   custom    主会话是自定义 API 模型：{ main, small }（型号 id）；官方模型为 null
 *   catalog   subagentModelCatalog()：能派给子 agent 的第三方模型
 *   routed    官方订阅会话也经上游代理转发第三方模型（claude-upstream.mjs 的 /r/<令牌>）；false = 只提一句派不了
 *   plan      订阅档（'pro' | 'max20'，单测用；默认取当前激活号的）
 * 有性价比快照（model-ratings.mjs）时给四档阶梯：每档首选 + 备选、auto:<档> 写法；没有快照就是老的「分档 + 全清单」。
 */
export function dispatchNudge({ on, text = '', custom = null, catalog = [], routed = false, plan } = {}) {
  if (!on) return '';
  const head = '[子 agent 调度] 派子 agent（Agent 工具、动态工作流脚本里的 agent()）时，按每个子任务的难度分别指定推理强度和模型，不要默认照搬主会话的模型和档位。'
    + '这是用户的明确要求：Agent 工具 effort / model 参数说明里「只在被明确要求时才设」的条件已经满足，Workflow 的 opts.effort / opts.model 同理。';
  // 有性价比快照、且至少一个能派的模型评上了分：给阶梯（model-ratings.mjs），不再让 Claude 自己从清单里比较
  const ladder = buildLadder({ catalog, official: !custom, routed, plan: plan || currentPlan() });
  if (ladder) return NL + ['', head, ...ladderLines(ladder, { custom, routed, catalog }), ...prefLines(text)].join(NL);
  const lines = [
    '',
    head,
    '· 推理强度（effort：low / medium / high / xhigh / max）：检索、读文件、机械改动、格式整理 → low；常规实现、一般审查 → medium；'
      + '需要设计取舍、难排查的问题 → high；最难的裁决与最终验证 → xhigh；max 只在用户要求时用。',
  ];
  const list = catalog.slice(0, MAX_CATALOG).map((m) => {
    const meta = [m.provider, fmtCtx(m.contextWindow) && '上下文 ' + fmtCtx(m.contextWindow), m.vision ? '看图' : '', m.efforts.length ? '档位 ' + m.efforts.join('/') : '不分档'].filter(Boolean).join('，');
    return `  - ${m.name} — ${m.label}（${meta}）`;
  });
  // 破折号左边是写进 agent() 的 id、右边是显示名。不说明的话 Claude 给用户列分工表时照抄 custom:p-xxxx:… 原始 id（10-30 宣传片录屏实遇）。
  const naming = list.length
    ? `  每行破折号左边是写进 agent() 的模型名，右边是显示名。跟用户说话、列分工表、汇报结果时一律用显示名（如「${catalog[0].label}」，Claude 模型说 Sonnet 5.5、Haiku 5.5 这样的名字），custom:<服务>:<型号> 这类 id 只写进代码，不要写给用户看。`
    : '';
  if (custom) {
    lines.push('· 模型：动态工作流的 agent(prompt, { model }) 可以写下面任意一个模型名（照抄；重名的写 custom:<服务>:<型号>），请求会自动转到对应的服务；'
      + `Agent 工具的 model 只能填别名：haiku = ${custom.small}，sonnet / opus = 主会话模型 ${custom.main}。effort 会自动换算成各模型自己的档位。`);
    lines.push(...(list.length ? [...list, naming] : ['  （没有别的可用模型）']));
  } else if (routed && list.length) {
    lines.push('· 模型：Claude 的 haiku 快且便宜（检索、机械活），sonnet 做常规实现，opus 留给难题；Agent 工具的 model 只能填这几个别名。');
    lines.push('  动态工作流的 agent(prompt, { model }) 还可以写下面任意一个第三方模型名（照抄；重名的写 custom:<服务>:<型号>），请求会自动转到对应的服务，effort 自动换算成它自己的档位。'
      + '注意它的上下文窗口可能比主会话小，别给它塞超长的材料。');
    lines.push(...list, naming);
  } else {
    lines.push('· 模型：haiku 快且便宜（检索、机械活），sonnet 做常规实现，opus 留给难题。');
    if (list.length) lines.push('  设置里配置的第三方模型只有主会话本身是第三方模型时才能派给子 agent；这一轮主会话是 Claude 官方模型，偏好里点名的第三方模型改用最接近的 Claude 别名。');
  }
  lines.push(...prefLines(text));
  return NL + lines.join(NL);
}

function prefLines(text) {
  const t = String(text || '').trim();
  return t ? ['[用户的调度偏好，与上面的默认分档冲突时以这里为准]', t] : [];
}

// 阶梯的一格：「opus · xhigh（Opus 5.5，智力 57 · ¥0.86 订阅等效）」。只写限制（上下文小、不看图），能力不缺的不啰嗦。
const fmtCost = (c) => (c >= 10 ? c.toFixed(1) : c >= 0.1 ? c.toFixed(2) : c > 0 ? String(+c.toPrecision(2)) : '?');
function cell(c) {
  const notes = [`智力 ${Math.round(c.ii)}${c.est ? '（估）' : ''} · ¥${fmtCost(c.cost)}${c.channel === 'sub' ? ' 订阅等效' : ''}`];
  if (c.ctx && c.ctx < 500_000) notes.push('上下文 ' + fmtCtx(c.ctx));
  if (c.channel !== 'sub' && !c.vision) notes.push('不看图');
  if (c.weaker) notes.push('比这档略弱');
  return `${c.write}${c.effort ? ' · ' + c.effort : ''}（${c.label}，${notes.join('，')}）`;
}

function ladderLines(L, { custom, routed, catalog }) {
  const auto = !!custom || routed;   // auto:* 要经过 bridge 换名：自定义 API 会话恒走本机代理，官方会话要这一轮挂了上游代理
  const out = [
    `· 选型已按用户的模型性价比库（${L.generated} 版：智力指数 + 这个会话实际付费口径下的每任务成本）算好，不用自己比较——先判断子任务属于哪一档，再照写。`,
    auto ? '  档位（适用）→ 写法 = 首选落点；备选' : '  档位（适用）→ 首选；备选',
  ];
  for (const t of L.tiers) {
    const alt = t.alt ? `；备选 ${cell(t.alt)}` : '';
    out.push(`  ${t.title}（${t.use}）→ ${auto ? `auto:${t.key} = ` : ''}${cell(t.pick)}${alt}`);
  }
  if (auto) {
    out.push('· 动态工作流 agent() 的 model 直接写 auto:<档>：bridge 在请求时换成该档首选的模型与档位（opts.effort 不用写，写了也以阶梯为准）。'
      + '要用备选、或用户点名某个模型时，写它的模型名（括号前那段）并按它标的档位设 effort。');
  } else {
    out.push('· 动态工作流 agent() 与 Agent 工具都写括号前的别名，effort 按它标的档位设。');
  }
  if (custom) {
    out.push(`· Agent 工具的 model 只能填别名：haiku = ${custom.small}，sonnet / opus = 主会话模型 ${custom.main}——要按阶梯选模型就用动态工作流；`
      + 'Agent 工具只按档位设 effort（最难 xhigh、难 high、常规 medium、机械 low）。effort 会自动换算成各模型自己的档位。');
  } else if (auto && L.agentTool.length) {
    out.push('· Agent 工具的 model 只能填别名：' + L.agentTool.map((t) => `${t.title} ${t.pick.write} + effort ${t.pick.effort}`).join('，') + '。');
  }
  if (!custom && !routed && catalog.length) out.push('  设置里配置的第三方模型这一轮派不了（主会话是 Claude 官方模型、没挂上转发），用户点名第三方模型时改用最接近的 Claude 别名。');
  // 显示名和型号名只差大小写 / 标点的不重复写
  const named = (name, label) => (normKey(name) === normKey(label) ? name : `${name}（${label}）`);
  if (L.others.length) out.push('· 其余已配模型（被表里更便宜或更聪明的选项胜出，只在用户点名时用）：' + L.others.map((c) => named(c.write, c.label)).join('、'));
  if (L.unrated.length) out.push('· 未评分（库里没有数据，只在用户点名时用）：' + L.unrated.map((m) => named(m.name, m.label)).join('、'));
  out.push('  写法 / 模型名只写进代码；跟用户说话、列分工表、汇报结果时一律用括号里的显示名（如「' + L.tiers[0].pick.label + '」）'
    + (auto ? '，auto:<档> 说成「自动·难」这样' : '') + (catalog.length ? '，custom:<服务>:<型号> 这类 id 不要写给用户看' : '') + '。');
  return out;
}

/**
 * 新撞上 5 小时限额时，续跑勾选框默认勾不勾（设置「限额重置后自动继续」）。撞墙那一刻现读：
 * 停放复用的 CLI 后面每一轮都跑在第一次 spawn 时的闭包里，而这项不进 warmSig，不能用开头算好的值。
 */
export function autoContinueDefault(ctx) {
  if (!ctx || ctx.snap) return false;
  return getClaudeSettings(ctx).autoContinueOnLimit !== false;
}

// 风格名：空 / 非字符串 → null；只认看着像风格名的（内置五个 + output-styles/*.md 文件名）。
function cleanStyle(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t && /^[\w .()-]{1,80}$/.test(t) ? t : null;
}

/** 会话级输出风格覆盖是否合法（在这个身份的可选清单里）。null = 清掉覆盖，回到全局默认。 */
export function validSessionOutputStyle(ctx, style) {
  if (style === null || style === undefined || style === '') return { ok: true, value: null };
  const t = cleanStyle(style);
  if (!t) return { ok: false };
  const list = outputStylesFor(ctx);
  const hit = list.find((x) => x.toLowerCase() === t.toLowerCase());
  return hit ? { ok: true, value: hit } : { ok: false };
}

// —— 可选输出风格清单：init 之后走一趟控制通道 initializationResult()，按身份缓存（noteOutputStyles）。
// 清单跟账号 / output-styles 目录走不跟会话，10 分钟内不重复问。
// 清单有变化（学到了 ~/.claude/output-styles 里的自定义风格）就推一帧 claude.settings 快照：已连着的前端
// 不必等重连 / 打开设置页，加号菜单 › 输出风格 立刻列得出来（rev 不变，前端照收）。
const stylesAt = new Map();   // ctx.key → ms
export function refreshOutputStyles(ctx, q) {
  if (!ctx || ctx.snap || !q || typeof q.initializationResult !== 'function') return;
  const now = Date.now();
  if (now - (stylesAt.get(ctx.key) || 0) < 600_000) return;
  stylesAt.set(ctx.key, now);
  q.initializationResult().then((r) => {
    if (!r || !Array.isArray(r.available_output_styles)) return;
    const before = outputStylesFor(ctx).join('|');
    noteOutputStyles(ctx, r.available_output_styles);
    if (outputStylesFor(ctx).join('|') !== before) busPublish(ctx.key, { type: 'claude.settings', settings: claudeSettingsSnapshot(ctx) });
  }).catch(() => { stylesAt.delete(ctx.key); });
}

// 单测用
export function _resetTurnSettings() { stylesAt.clear(); }
