// 界面扩展（插件接口四期，第三批）：ctx.ui.*——插件往 bridge 自己的界面里加东西。
//
// 原则：手机 App 不跑第三方代码。所以这里登记的大多是【声明】（标题、图标、文字、按钮），由 bridge 自己画；
// 按下去执行的是插件服务端的 handler（POST /api/plugins/ui/run）。只有 workbench 是插件页面（不透明源 iframe，同插件面板，
// App 里点开独立干净页面）。
//
//   ctx.ui.homeCard({ id, title, icon?, order?, who?, data?(who) → { text?, tone?, items?: [{ label, value }], badge? }, open?: 'panel' | { action } | { url } })
//   ctx.ui.workbench({ id, title, icon?, page, who? })                    Claude 工作台一个标签（插件页面；SDK 的 bridge.context() 拿当前会话）
//   ctx.ui.command({ name, description, who?, template? | handler?(who, { args, sessionId, agent }) })   输入框「/」菜单
//   ctx.ui.composerAction({ id, label, icon?, who?, handler(who, { sessionId, text, agent }) })            输入框「＋」菜单
//   ctx.ui.messageAction({ id, label, icon?, who?, roles?, handler(who, { sessionId, text, role, agent }) }) 消息的操作菜单
//   ctx.ui.sessionAction({ id, label, icon?, who?, handler(who, { sessionId, title, agent }) })            会话列表的菜单
//   ctx.ui.theme({ vars: { '--名字': 值 }, who? })                         主题变量（只收 -- 开头的名字，值过滤 url( / expression( / ; { }）
// handler 回：字符串（当 toast）或 { toast?, insert?（插进输入框）, send?: true（插进去顺手发出）, open?: 'panel' | 网址 }。
// who：'host'（缺省，只给服务器主机）| 'members'（成员也给）。英文界面：插件 locales/en.json 的 ui.<种类>.<id>.<字段> 覆盖人话。
import { kernel } from './state.mjs';
import { busPublishAll } from '../runtime/bus.mjs';

export const UI_SLOT = 'ui';
export const UI_KINDS = Object.freeze(['homeCard', 'workbench', 'command', 'composerAction', 'messageAction', 'sessionAction', 'theme']);
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CMD_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;
const str = (v, n) => (v == null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, n));

function check(kind, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`ctx.ui.${kind} 要一个对象`);
  if (spec.who && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  if (kind === 'theme') {
    if (!spec.vars || typeof spec.vars !== 'object') throw new Error('ctx.ui.theme 要 { vars }');
    return;
  }
  if (kind === 'command') {
    if (!CMD_RE.test(String(spec.name || ''))) throw new Error(`命令名「${spec.name}」不对（小写字母开头，只用小写字母、数字、连字符）`);
    if (typeof spec.template !== 'string' && typeof spec.handler !== 'function') throw new Error(`命令 /${spec.name} 要有 template 或 handler`);
    return;
  }
  if (!ID_RE.test(String(spec.id || ''))) throw new Error(`ctx.ui.${kind} 要有 id（小写字母开头，只用小写字母、数字、连字符）`);
  if (kind === 'workbench' && (typeof spec.page !== 'string' || !spec.page || spec.page.includes('..'))) throw new Error('ctx.ui.workbench 要 page（插件目录里的页面，如 web/bench.html）');
  if (['composerAction', 'messageAction', 'sessionAction'].includes(kind) && typeof spec.handler !== 'function') throw new Error(`ctx.ui.${kind} 要 handler`);
}

export function makeUi(ctx) {
  const add = (kind) => (spec) => { check(kind, spec); return ctx.contribute(UI_SLOT, { kind, spec }); };
  return Object.fromEntries(UI_KINDS.map((k) => [k, add(k)]));
}

// 登记变了就推给在线页面（各插槽据此重拉 /api/plugins/ui）
let pub = null;
export function watchUi() {
  if (pub || !kernel.started) return;
  pub = kernel.slot(UI_SLOT).onChange(() => { try { busPublishAll({ type: 'plugins.ui', at: Date.now() }); } catch {} });
}

const audience = (who, c) => (who === 'members' ? c.kind === 'admin' || c.kind === 'user' : c.kind === 'admin');

// 英文词条：locales/en.json → ui.<种类>.<id>.<字段>
function tr(owner, kind, id, field, zh, lang) {
  if (!/^en/i.test(lang || '')) return zh;
  const v = kernel.rawRecord(owner)?.extra?.i18n?.en?.ui?.[kind]?.[id]?.[field];
  return typeof v === 'string' && v.trim() ? v.trim() : zh;
}

const SAFE_CSS = /^[^;{}<>]{0,120}$/;
const BAD_CSS = /(url\s*\(|expression\s*\(|@import|javascript:)/i;

async function within(ms, fn) {
  let t;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((r) => { t = setTimeout(() => r(undefined), ms); t.unref?.(); })]); }
  finally { clearTimeout(t); }
}

/** 这个身份能看到的全部界面扩展（主页卡片的数据现算，每张 3 秒封顶）。c = 身份上下文；lang = 界面语言。 */
export async function uiView(c, lang = 'zh') {
  const out = { homeCards: [], workbench: [], commands: [], composerActions: [], messageActions: [], sessionActions: [], theme: {} };
  if (!kernel.started) return out;
  const cards = [];
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) {
    const s = item.spec;
    if (!audience(s.who || 'host', c)) continue;
    const pname = kernel.rawRecord(owner)?.name || owner;
    const id = s.id || s.name;
    const T = (field, zh) => tr(owner, item.kind, id, field, zh, lang);
    switch (item.kind) {
      case 'homeCard':
        cards.push((async () => {
          let data = null;
          if (typeof s.data === 'function') {
            try { data = await within(3000, () => s.data(c)); } catch (e) { kernel.contextOf(owner)?.warn('主页卡片数据出错：' + String(e?.message || e).slice(0, 200)); }
          }
          const open = s.open === 'panel' ? { panel: true } : s.open?.action ? { action: str(s.open.action, 40) } : typeof s.open?.url === 'string' && /^(https?:\/\/|\/)/.test(s.open.url) ? { url: s.open.url.slice(0, 2000) } : null;
          return {
            plugin: owner, pluginName: pname, id, title: T('title', str(s.title, 40) || pname), icon: ICON_RE.test(s.icon || '') ? s.icon : 'plugin', order: Number(s.order) || 0, open,
            data: data && typeof data === 'object' ? {
              text: str(data.text, 200), tone: ['ok', 'warn', 'error', 'idle'].includes(data.tone) ? data.tone : '', badge: str(data.badge, 12),
              items: (Array.isArray(data.items) ? data.items : []).slice(0, 6).map((x) => ({ label: str(x?.label, 30), value: str(x?.value, 80) })),
            } : null,
          };
        })());
        break;
      case 'workbench':
        out.workbench.push({ plugin: owner, pluginName: pname, id, title: T('title', str(s.title, 20) || pname), icon: ICON_RE.test(s.icon || '') ? s.icon : 'plugin', page: String(s.page).replace(/^\/+/, '') });
        break;
      case 'command':
        out.commands.push({ plugin: owner, pluginName: pname, name: s.name, description: T('description', str(s.description, 120)), mode: typeof s.handler === 'function' ? 'action' : 'template', ...(typeof s.template === 'string' ? { template: s.template.slice(0, 4000) } : {}) });
        break;
      case 'composerAction':
      case 'sessionAction':
        out[item.kind + 's'].push({ plugin: owner, pluginName: pname, id, label: T('label', str(s.label, 30) || id), icon: ICON_RE.test(s.icon || '') ? s.icon : '' });
        break;
      case 'messageAction':
        out.messageActions.push({ plugin: owner, pluginName: pname, id, label: T('label', str(s.label, 30) || id), icon: ICON_RE.test(s.icon || '') ? s.icon : '', roles: Array.isArray(s.roles) ? s.roles.filter((r) => r === 'user' || r === 'assistant') : ['assistant'] });
        break;
      case 'theme':
        for (const [k, v] of Object.entries(s.vars || {})) {
          if (!/^--[a-zA-Z0-9-]{1,40}$/.test(k)) continue;
          const val = String(v ?? '');
          if (!SAFE_CSS.test(val) || BAD_CSS.test(val)) continue;
          out.theme[k] = val;
        }
        break;
      default:
    }
  }
  out.homeCards = (await Promise.all(cards)).sort((a, b) => a.order - b.order);
  return out;
}

function findHandler(owner, kind, id) {
  const hit = kernel.slot(UI_SLOT).entries().find(({ item, owner: o }) => o === owner && item.kind === kind && (item.spec.id || item.spec.name) === id);
  return hit ? hit.item.spec : null;
}

/** 按下一个界面动作：kind = command / composerAction / messageAction / sessionAction / homeCard（open.action 指的那个 ctx.action）。 */
export async function runUi(c, { plugin, kind, id, args }) {
  if (!kernel.started || !kernel.isActive(String(plugin || ''))) throw Object.assign(new Error('插件没开'), { status: 404 });
  const spec = findHandler(plugin, kind, id);
  if (!spec || !audience(spec.who || 'host', c)) throw Object.assign(new Error('没有这个界面动作'), { status: 404 });
  if (typeof spec.handler !== 'function') throw Object.assign(new Error('这个动作没有 handler'), { status: 400 });
  const a = args && typeof args === 'object' ? args : {};
  const view = {
    sessionId: typeof a.sessionId === 'string' ? a.sessionId.slice(0, 80) : null,
    agent: a.agent === 'dimensio' ? 'dimensio' : 'claude',
    ...(kind === 'command' ? { args: str(a.args, 4000) } : {}),
    ...(kind === 'composerAction' ? { text: String(a.text ?? '').slice(0, 20_000) } : {}),
    ...(kind === 'messageAction' ? { text: String(a.text ?? '').slice(0, 100_000), role: a.role === 'user' ? 'user' : 'assistant' } : {}),
    ...(kind === 'sessionAction' ? { title: str(a.title, 200) } : {}),
  };
  let r;
  try { r = await within(60_000, () => spec.handler(c, view)); }
  catch (e) { throw Object.assign(new Error(String(e?.message || e).slice(0, 500)), { status: 500 }); }
  if (typeof r === 'string') return { toast: r.slice(0, 300) };
  if (!r || typeof r !== 'object') return {};
  return {
    ...(typeof r.toast === 'string' ? { toast: r.toast.slice(0, 300) } : {}),
    ...(typeof r.insert === 'string' ? { insert: r.insert.slice(0, 20_000) } : {}),
    ...(r.send === true ? { send: true } : {}),
    ...(r.open === 'panel' ? { open: 'panel' } : typeof r.open === 'string' && /^(https?:\/\/|\/)/.test(r.open) ? { open: r.open.slice(0, 2000) } : {}),
  };
}
