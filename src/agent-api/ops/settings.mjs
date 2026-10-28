// Claude 设置与模型（settings.* 组 + chat.models）：读 / 改 设置 › Claude 里存在服务端的那些项（按身份同步的开关与默认值，管理员另有主机级几项），
// 列出这个身份能选的模型（订阅模型 + 他自己在「模型服务」里接的自定义 API 模型）。
// 都经进程内请求走现成路由（GET / POST /api/claude/settings、GET /api/claude/providers）：校验、权限、落盘、总线推送
// （别的设备上的设置页当场跟上）全在路由里，这里只把快照翻成给 agent 看的样子。
// 自定义模型服务的增删改（要填第三方 API Key）不经接口：Key 只在设置页里由本人填。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { CLAUDE_SETTINGS, CLAUDE_SETTING_GROUPS, CLAUDE_SETTING_BY_KEY, BUILTIN_OUTPUT_STYLES } from '../../config/claude-settings.mjs';
import { CAPABILITIES } from '../../config/capabilities.mjs';

defineGroup('settings', 'Claude 设置', '设置 › Claude 里存在服务端、随账号同步的开关与默认值（如「自动继续被中断的对话」「限额重置后自动继续」）。');

const GROUP_LABEL = Object.fromEntries(CLAUDE_SETTING_GROUPS.map((g) => [g.id, g.label]));
// 设置页上没有入口、只能经接口改的项（值照样随账号同步）
const NO_UI = new Set(['newChatLanding']);
const CODE_OF = { 400: 'bad_args', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };

// 路由快照 → 逐项清单：只列这个身份看得到、这台服务端做得到的；「只存这台设备」的项服务端不认，不列。
function settingsView(s) {
  const unsupported = new Set(s.unsupported || []);
  const items = [];
  for (const d of CLAUDE_SETTINGS) {
    if (d.scope === 'device') continue;
    if ((d.admin || d.scope === 'host') && !s.admin) continue;
    if (d.shell && !s.shell) continue;
    if (unsupported.has(d.key)) continue;
    let options = Array.isArray(d.options) ? d.options : null;
    if (d.key === 'permissionMode') options = s.permissionModes || options;
    else if (d.options === 'dynamic' && d.key === 'outputStyle') options = s.outputStyles || null;
    const labelOf = (v) => {
      const i = Array.isArray(d.options) ? d.options.indexOf(v) : (d.key === 'outputStyle' ? BUILTIN_OUTPUT_STYLES.indexOf(v) : -1);
      return i >= 0 && d.optionLabels ? d.optionLabels[i] : '';
    };
    items.push({
      key: d.key, group: GROUP_LABEL[d.group] || d.group, label: d.label, ...(d.desc ? { desc: d.desc } : {}),
      type: d.type, value: s.values?.[d.key] ?? d.default, default: d.default,
      ...(options ? { options: options.map((v) => { const l = labelOf(v); return l ? { value: v, label: l } : { value: v }; }) } : {}),
      ...(d.dependsOn ? { dependsOn: d.dependsOn } : {}),
      ...(d.scope === 'host' ? { scope: 'host' } : {}),
      ...(d.maxLen ? { maxLen: d.maxLen } : {}),
      ...(d.confirm ? { confirm: true } : {}),
      ...(NO_UI.has(d.key) ? { noUi: true } : {}),
    });
  }
  return items;
}

async function readSettings(env) {
  const r = await internalRequest(env.identity, 'GET', '/api/claude/settings');
  if (r.status !== 200 || !r.json?.settings) throw new OpError(CODE_OF[r.status] || 'failed', routeError(r));
  return r.json.settings;
}

defineOp({
  name: 'settings.claude', title: '看 Claude 的设置',
  desc: [
    '设置 › Claude 里存在服务端、随账号同步到所有设备的项，每项：key、group（设置页上的分组名）、label（界面上的名字）、desc、type（bool / enum / int / string / frac）、',
    'value（当前值）、default、options（可选值 value 与界面文字 label）、dependsOn（主项关着时这项在界面上不显示）、',
    'scope=host（主机级：对整台服务器生效，只有服务器主机看得到改得了）、confirm（打开前设置页会先确认，改它要带 confirm=true）、noUi（设置页上没有入口，只能经接口改）。',
    '只列这个身份看得到、这台服务端做得到的项；「通知」三项和「思考动画」「用工作树」只存在各台设备上，不在这里。',
    '用户问「某个开关开着没 / 默认是什么」就看它；常用项：autoResumeOnRestart（服务意外重启时自动继续被中断的对话）、autoContinueOnLimit（限额重置后自动继续）、',
    'permissionMode（新会话默认权限模式）、questionTimeout（Claude 提问无人回答时）、replyLanguage、autoArchiveDays。',
  ].join(''),
  need: ['agent:claude'],
  handler: async (ctx, args, env) => {
    const s = await readSettings(env);
    return { settings: settingsView(s), you: { admin: !!s.admin, shell: !!s.shell } };
  },
});

defineOp({
  name: 'settings.claude_set', title: '改 Claude 的设置',
  desc: [
    'values = { key: 新值 }，可一次改几项；值传 null = 恢复默认。key 与可选值见 settings.claude；任一项不合法整批不改。',
    '和用户在设置页上改是一回事：随账号同步，别的设备上的设置页当场跟上；只影响之后的行为（新会话、下一轮），不动正在跑的轮。',
    '只在用户要你改时改。标 confirm 的项（如「允许绕过权限模式」）是设置页要先确认的高风险开关：先跟用户说清后果，同意了才带 confirm=true。',
  ].join(''),
  access: 'write', need: ['agent:claude'],
  params: {
    values: { type: 'object', required: true, desc: '{ key: 新值 }，null = 恢复默认' },
    confirm: { type: 'boolean', default: false, desc: '改标了 confirm 的项时必须带 true（先问过用户）' },
  },
  example: { values: { autoResumeOnRestart: false } },
  handler: async (ctx, args, env) => {
    const keys = Object.keys(args.values);
    if (!keys.length) throw new OpError('bad_args', 'values 是空的', { hint: '例：{ "autoResumeOnRestart": false }' });
    for (const k of keys) {
      const d = CLAUDE_SETTING_BY_KEY[k];
      if (!d || d.scope === 'device') throw new OpError('bad_args', `没有设置项「${k}」${d ? '（这一项只存在各台设备上，服务端改不了）' : ''}`, { hint: '可改的项见 settings.claude' });
      if (d.confirm && args.values[k] === true && !args.confirm) {
        throw new OpError('conflict', `「${d.label}」是高风险开关，设置页打开它前要先确认`, { hint: '先跟用户说清后果；同意后带 confirm: true 重试' });
      }
    }
    const before = await readSettings(env);
    const r = await internalRequest(env.identity, 'POST', '/api/claude/settings', { patch: args.values });
    if (r.status !== 200 || !r.json?.settings) throw new OpError(CODE_OF[r.status] || 'failed', routeError(r), { hint: '可改的项与可选值见 settings.claude' });
    const after = r.json.settings;
    const changed = keys.filter((k) => JSON.stringify(before.values?.[k]) !== JSON.stringify(after.values?.[k]))
      .map((k) => ({ key: k, label: CLAUDE_SETTING_BY_KEY[k].label, from: before.values?.[k], to: after.values?.[k] }));
    return { changed, ...(changed.length ? {} : { note: '值和原来一样，没有改动' }) };
  },
});

defineOp({
  name: 'chat.models', title: '列出能选的 Claude 模型',
  desc: [
    'chat.send 的 model 能填哪些：builtin 是订阅模型（id、name）与默认模型、思考强度档位；',
    'custom 是这个身份自己在 设置 › Claude ›「模型服务」›「自定义 API」里接的模型（主机管理员与成员各管各的一份），',
    'id 形如 custom:<服务>:<模型>，带所属服务名、能不能看图、上下文窗口、自己的思考档位表（efforts，为空 = 不能调思考强度）、isDefault（该服务的默认模型）、',
    'hidden（服务设了不显示在模型菜单里，照样能用）。services 是这些服务的概况（hasKey=false 的服务缺 Key 用不了）。API Key 不出服务端，这里也看不到。',
    '成员能不能用 1M 上下文、快速模式、Ultracode 由管理员的额度策略决定。接新服务、填 Key 只能在设置页里做。',
  ].join(''),
  need: ['agent:claude'],
  handler: async (ctx, args, env) => {
    const c = CAPABILITIES.claude || {};
    const builtin = {
      models: (c.models || []).map((m) => ({ id: m.id, name: m.name })),
      default: c.defaults?.model || '',
      efforts: (c.efforts || []).map((e) => ({ id: e.id, name: e.name })),
    };
    const r = await internalRequest(env.identity, 'GET', '/api/claude/providers');
    if (r.status === 403 || r.status === 401) return { builtin, custom: [], services: [], note: '这个身份不能用自定义 API' };
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    const services = (r.json.providers || []).map((p) => ({
      id: p.id, name: p.name || '', ...(p.preset ? { preset: p.preset } : {}), enabled: p.enabled !== false, hasKey: !!p.hasKey,
      models: (p.models || []).filter((m) => m.kind === 'chat' || !m.kind).length,
    }));
    const custom = (r.json.models || []).map((m) => ({
      id: m.id, name: m.name || '', provider: m.providerName || m.provider || '',
      ...(m.vision ? { vision: true } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      efforts: (m.efforts || []).map((e) => e.id), ...(m.effortDefault ? { effortDefault: m.effortDefault } : {}),
      ...(m.isDefault ? { isDefault: true } : {}), ...(m.hidden ? { hidden: true } : {}),
    }));
    return { builtin, custom, services, ...(r.json.member ? { maxServices: r.json.maxProviders || 0 } : {}) };
  },
});
