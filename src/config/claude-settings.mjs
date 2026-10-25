// Claude 分页设置注册表（2026-10-20，对齐官方 Claude Desktop 3.1623「Settings → Claude Code」）。
//
// 纯数据、无 node 依赖：服务端（src/runtime/claude-settings.mjs 读写与校验）和前端两套设置外壳
// （手机 Settings.svelte / 桌面 SettingsDesktop.svelte，单 agent 模式也用这两套）
// 都从这一份表渲染与取默认值，避免同一项写两遍再写歪。官方同款做法（官方桌面端 ion-dist cc7db14f1 的注册表）。
//
// 每项字段：
//   key        存储键（服务端 values[key] / 前端 cs.values[key]）
//   group      分组 id（见 CLAUDE_SETTING_GROUPS，决定在页面上的位置；组内按本表顺序）
//   scope      'user'   按身份存服务端（ctx.dataDir/claude-settings.json），同账号多设备同步
//              'host'   主机级，存 config.json 的 claudeHost 键，仅管理员可见可改
//              'device' 只存这台设备（localStorage，由前端自管；服务端不认这些键）
//   type       'bool' | 'enum' | 'int' | 'string' | 'frac'
//   options    enum/int 的合法值（'dynamic' = 运行期给出，如输出风格）
//   default    缺省值（服务端只存与默认不同的显式值，便于「已改过 / 恢复默认」）
//   admin      true = 只有管理员身份看得到、改得了
//   shell      true = 只有能跑命令行的身份（ctx.shell）才有意义
//   dependsOn  主项 key：主项为假值时本项不显示（依赖项缩进紧跟主项）
//   maxLen / multiline  string 的长度上限 / 多行文本（设置页给文本区）
//   label/desc 中文原文（前端过 t() 出英文，英文在 web/src/i18n/en/*）；desc 只在允许每行一句说明的外壳里用
//   optionLabels  enum 各值的中文显示名（与 options 同序）；optionDescs 选择页里每项的一行说明
export const CLAUDE_SETTING_GROUPS = Object.freeze([
  { id: 'limits', label: '撞上限额时' },
  { id: 'defaults', label: '新会话默认' },
  { id: 'chat', label: '对话' },
  { id: 'collab', label: '会话协作' },
  { id: 'git', label: 'Git 与拉取请求' },
  { id: 'sessions', label: '会话管理' },
  { id: 'notify', label: '通知' },
  { id: 'host', label: '这台电脑' },
  { id: 'safety', label: '安全' },
]);

export const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
// 非管理员（注册用户、沙箱身份）能选的权限模式：绕过与自动只给主机管理员。
export const PERMISSION_MODES_SANDBOX = Object.freeze(['default', 'acceptEdits', 'plan']);
export const BUILTIN_OUTPUT_STYLES = Object.freeze(['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);
// 分支前缀不许用的受保护名（官方 ccd_settings 的校验口径）。
export const BRANCH_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const BRANCH_PREFIX_RESERVED = /^(main|master|staging|warm|prod-.*|release.*)$/i;

export const CLAUDE_SETTINGS = Object.freeze([
  // —— 撞上限额时（号池 / 智能路由仍由 agentSettings 管，这里只放按身份的那一项）——
  { key: 'autoContinueOnLimit', group: 'limits', scope: 'user', type: 'bool', default: true,
    label: '限额重置后自动继续', desc: '撞上 5 小时限额时，等额度恢复后自动接着跑完这一轮' },

  // —— 新会话默认（会话里可以单独改，改的只是那个会话）——
  { key: 'permissionMode', group: 'defaults', scope: 'user', type: 'enum', options: PERMISSION_MODES, default: 'auto',
    label: '权限模式', desc: 'Claude 改文件、跑命令前要不要先问你。对新会话生效；在某个文件夹的新会话里手动选过模式的，那个文件夹沿用你上次选的。每个会话可以在输入框里另选',
    optionLabels: ['手动', '接受编辑', '计划', '自动', '绕过权限'],
    optionDescs: ['改动前总是先问', '自动接受所有文件改动', '改动前先出计划', '由 Claude 判断要不要问你', '所有操作都不问'] },
  { key: 'outputStyle', group: 'defaults', scope: 'user', type: 'enum', options: 'dynamic', default: 'default',
    label: '输出风格', desc: '回复的组织方式。对新会话生效；单个会话可以在会话菜单里另选',
    optionLabels: ['默认', '主动', '简洁', '讲解', '学习'],
    optionDescs: ['', '直接动手、少打断、先做后想', '回复简短，先说结果，不铺垫不复述', '边做边讲实现取舍和代码库里的套路', '停下来让你亲手写一小段代码练习'] },
  // 冷启动落点（D10 b「管理员可选」；前端 ClaudePage 按 landingFor() 读，缺省 auto）
  { key: 'newChatLanding', group: 'defaults', scope: 'user', type: 'enum', options: ['auto', 'temp', 'workspace'], default: 'auto',
    label: '新对话落点', desc: '打开 Claude 页、没有可以接着看的对话时，空白对话落在哪',
    optionLabels: ['自动', '临时对话', '工作空间'],
    optionDescs: ['管理员落临时对话，其他成员落自己的工作空间', '不归任何项目、不带记忆，30 天没动会清理', '默认工作空间，和平常的对话一样一直留着'] },

  // —— 对话 ——
  { key: 'promptSuggestions', group: 'chat', scope: 'user', type: 'bool', default: true,
    label: '输入建议', desc: '每次回复完猜你接下来想说的话，输入框空着时以灰字显示；每条建议多一次模型请求' },
  { key: 'inlineVisualizations', group: 'chat', scope: 'user', type: 'bool', default: true,
    label: '对话内交互图表', desc: '让 Claude 直接在对话里画图表、示意图和小工具' },
  { key: 'enableWorkflows', group: 'chat', scope: 'user', type: 'bool', default: true, shell: true,
    label: '动态工作流', desc: '复杂任务让 Claude 并行调度多个 agent。工作流会很快用掉额度' },
  // 自由文本，拼进系统提示（claude-turn-settings.dispatchNudge）；空着也会提示 Claude 按任务难度给每个子 agent 定推理强度
  { key: 'subagentDispatch', group: 'chat', scope: 'user', type: 'string', default: '', shell: true, dependsOn: 'enableWorkflows', maxLen: 2000, multiline: true,
    label: '子 agent 调度偏好', desc: '派子 agent 时怎么挑模型和推理强度。空着时由 Claude 按任务难度自己定，不再照搬主会话' },
  { key: 'switchModelsOnFlag', group: 'chat', scope: 'user', type: 'bool', default: false,
    label: '消息被拦时自动换模型', desc: '关着时会话暂停，由你选「编辑提示词」还是「换模型继续」' },
  { key: 'planClearContext', group: 'chat', scope: 'user', type: 'bool', default: false,
    label: '批准计划时可清空上下文', desc: '计划审批卡多一个「清空上下文后执行」选项' },
  { key: 'questionTimeout', group: 'chat', scope: 'user', type: 'enum', options: ['never', '5m', '10m', '30m'], default: '10m',
    label: 'Claude 提问无人回答时', optionLabels: ['一直等', '5 分钟后继续', '10 分钟后继续', '30 分钟后继续'] },
  { key: 'replyLanguage', group: 'chat', scope: 'user', type: 'enum', options: ['auto', 'zh', 'en'], default: 'auto',
    label: '回复语言', optionLabels: ['跟随对话', '简体中文', 'English'] },
  { key: 'compactFrac', group: 'chat', scope: 'user', type: 'frac', default: null,
    label: '自动压缩点', desc: '上下文用到多少时自动压缩；在用量弹层的计量条上拖动设置' },

  // —— 会话协作（10-20：Claude 发起新会话做成三档可选）——
  { key: 'newSessionPolicy', group: 'collab', scope: 'user', type: 'enum', options: ['ask', 'direct', 'onRequest'], default: 'ask', shell: true,
    label: 'Claude 发起新会话', desc: '你提了与当前任务无关的事、或 Claude 发现值得另开一个会话的活时怎么办',
    optionLabels: ['先问我', '直接开始', '只在我要求时'],
    optionDescs: ['弹卡问你「新会话 / 在这里做」，Claude 自己想到的任务出提议卡', '不弹卡，Claude 判断该开就直接开，留一张可停止的卡', 'Claude 不主动提议，只有你明说才开'] },
  // 'default' = 不下发，交给 CLI 自己的判定（会问你的模式下直接接收；绕过权限时、对方权限模式不一致或没说明时扣留）。
  // 显式 accept 会压掉 CLI 的这两层保护，所以不能当默认（10-21 安全审查）。
  { key: 'crossSessionInbound', group: 'collab', scope: 'user', type: 'enum', options: ['default', 'accept', 'hold', 'refuse'], default: 'default', admin: true,
    label: '其它会话发来的消息', desc: '官方 Claude Desktop 或终端里的 Claude 会话发给这里的消息',
    optionLabels: ['跟随 Claude 默认', '直接接收', '暂存等我确认', '拒收'],
    optionDescs: ['会问你的模式下直接接收；绕过权限时、或对方的权限模式和这里不一致时，暂存等你确认', '一律直接接收，对方的话会马上开一轮', '一律暂存，等你点接收才投递', '一律拒收'] },

  // —— Git 与拉取请求 ——
  { key: 'branchPrefix', group: 'git', scope: 'user', type: 'string', default: 'claude', shell: true,
    label: '分支前缀', desc: '新会话工作树分支名的前缀，如 claude/<名字>' },
  { key: 'worktreeBaseRef', group: 'git', scope: 'user', type: 'enum', options: ['head', 'fresh'], default: 'head', shell: true,
    label: '工作树起点', optionLabels: ['当前分支', '远端默认分支'] },
  { key: 'autoFixPullRequests', group: 'git', scope: 'user', type: 'bool', default: false, shell: true,
    label: '自动修复拉取请求', desc: '会话建的拉取请求 CI 失败、出现冲突或有评审意见时，自动叫醒那个会话去处理' },
  { key: 'autoArchiveOnPrClose', group: 'git', scope: 'user', type: 'bool', default: false, shell: true,
    label: '拉取请求合并或关闭后自动归档' },
  { key: 'attribution', group: 'git', scope: 'user', type: 'enum', options: ['default', 'none'], default: 'default', shell: true,
    label: '提交与拉取请求署名', optionLabels: ['带 Claude 署名', '不署名'] },

  // —— 会话管理 ——
  { key: 'autoArchiveDays', group: 'sessions', scope: 'user', type: 'int', options: [0, 1, 2, 7, 14, 30], default: 0,
    label: '归档不活跃的会话', desc: '运行中或有后台任务的会话不会被归档',
    optionLabels: ['从不', '1 天', '2 天', '7 天', '14 天', '30 天'] },
  { key: 'followDesktopArchive', group: 'sessions', scope: 'user', type: 'bool', default: true, admin: true,
    label: '跟随 Claude Desktop 的归档', desc: '在官方桌面端归档过的会话，这里也算已归档' },

  // —— 通知（这台设备）——
  { key: 'notifyPermission', group: 'notify', scope: 'device', type: 'bool', default: true, label: '权限请求' },
  { key: 'notifyQuestion', group: 'notify', scope: 'device', type: 'bool', default: true, label: '提问' },
  { key: 'notifyTaskComplete', group: 'notify', scope: 'device', type: 'bool', default: true, label: '任务完成' },

  // —— 这台电脑（主机级，管理员）——
  { key: 'keepAwake', group: 'host', scope: 'host', type: 'bool', default: true, admin: true,
    label: 'Claude 工作时保持唤醒', desc: '有会话在跑时不让电脑进入睡眠；屏幕照常关闭' },
  { key: 'keepAwakeOnBattery', group: 'host', scope: 'host', type: 'bool', default: true, admin: true, dependsOn: 'keepAwake',
    label: '使用电池时也保持唤醒' },

  // —— 安全（置底，管理员）——
  { key: 'allowBypass', group: 'safety', scope: 'host', type: 'bool', default: false, admin: true, confirm: true,
    label: '允许绕过权限模式' },
  { key: 'allowAutoMode', group: 'safety', scope: 'host', type: 'bool', default: true, admin: true,
    label: '允许自动模式' },
]);

export const CLAUDE_SETTING_BY_KEY = Object.freeze(Object.fromEntries(CLAUDE_SETTINGS.map((s) => [s.key, s])));

// 默认值表（不含 device 级）。
export function claudeSettingDefaults({ scope } = {}) {
  const out = {};
  for (const s of CLAUDE_SETTINGS) if (s.scope !== 'device' && (!scope || s.scope === scope)) out[s.key] = s.default;
  return out;
}

// 分支前缀校验：返回 null = 合法，否则是给人看的中文错误。
export function branchPrefixError(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;   // 空 = 恢复默认
  if (!BRANCH_PREFIX_RE.test(s)) return '用 1–40 个字母、数字或 . _ -，以字母或数字开头';
  if (BRANCH_PREFIX_RESERVED.test(s)) return '这个前缀留给受保护分支';
  return null;
}

// 单值规范化与校验。合法 → { ok:true, value }；不合法 → { ok:false, error }。
// dynamicOptions：type 为 enum 且 options==='dynamic' 时的运行期合法值。
export function normalizeClaudeSetting(key, value, { dynamicOptions } = {}) {
  const s = CLAUDE_SETTING_BY_KEY[key];
  if (!s) return { ok: false, error: 'unknown setting' };
  if (value === null || value === undefined) return { ok: true, value: s.default };   // null = 恢复默认
  switch (s.type) {
    case 'bool': return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'expected boolean' };
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n)) return { ok: false, error: 'expected integer' };
      if (Array.isArray(s.options) && !s.options.includes(n)) return { ok: false, error: 'not an allowed value' };
      return { ok: true, value: n };
    }
    case 'frac': {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n <= 1 ? { ok: true, value: n } : { ok: false, error: 'expected 0..1' };
    }
    case 'enum': {
      const opts = s.options === 'dynamic' ? (dynamicOptions || null) : s.options;
      const v = String(value);
      if (opts && !opts.includes(v)) return { ok: false, error: 'not an allowed value' };
      if (!opts && !/^[\w .()-]{1,80}$/.test(v)) return { ok: false, error: 'bad value' };
      return { ok: true, value: v };
    }
    case 'string': {
      const v = String(value).trim();
      if (s.maxLen && v.length > s.maxLen) return { ok: false, error: `最多 ${s.maxLen} 字` };
      if (key === 'branchPrefix') { const e = branchPrefixError(v); if (e) return { ok: false, error: e }; }
      return { ok: true, value: v || s.default };
    }
    default: return { ok: false, error: 'bad type' };
  }
}
