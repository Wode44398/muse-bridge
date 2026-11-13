// 用户界面：看用户此刻在 bridge 里看什么、把他的界面带到某处（取代旧全局助手的「带你去」）。
// 下行经账号事件总线发 ui.cmd（前端 web/src/lib/agentUi.js 执行），所以不需要有对话正在跑。
// 前端执行完拿 ui.cmd 的 id 回执（POST /api/ui/answer，见 runtime/ui-state.mjs 的 waitUiAck）：
// 有回执才算确认；没回执照实报「未确认」——界面在后台 / 锁屏 / 已关，或是不回执的旧版 App。

import { randomUUID } from 'node:crypto';
import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { getUiState, waitUiAck } from '../../runtime/ui-state.mjs';
import { busPublish, busSubscribers } from '../../runtime/bus.mjs';
import { listDevices } from '../../runtime/phone-control.mjs';
import { phoneClients, phoneHandle, phoneName } from '../../runtime/client-origins.mjs';

defineGroup('ui', '用户界面', '看用户此刻开着的 bridge 界面，把它带到某个页面 / 会话 / 文件。');

// 2026-11-04：Gemini 对话下线，vertex 页换成 Media Studio（studio）；它的 module 是四个创作页
const PAGES = ['home', 'claude', 'files', 'routines', 'settings', 'chatgpt', 'dimensio', 'studio'];
const PAGE_AGENT = { claude: 'claude', chatgpt: 'codex', dimensio: 'dimensio', studio: 'studio' };
const STUDIO_MODULES = ['image', 'video', 'voice', 'music'];

// 等回执的上限：换页 / 开会话要加载，给宽一点；弹提示是即时的
const ACK_MS = { open: 5000, toast: 3000 };

const NO_LINK = '用户现在没有连着的 bridge 界面（手机 app / 网页 / 桌面客户端都没开着，或都断线了）';
const NO_DEVICE = '这台手机上没有开着的 bridge 界面（或是认不出设备号的旧版 App）。可以先用手机操控（phone_open_app）把 bridge 切到前台，等几秒再试；设备句柄见 ui.view 的 device。';
const NO_ACK = {
  open: '发出去了，但没收到界面回执，不确定打开了没有：那个界面可能在后台、锁屏或已关掉（这时没打开），也可能是不回执的旧版 App（这时可能已经打开）。别跟用户说已经打开；先确认（问用户，或看手机屏幕），需要时让 bridge 回到前台再试。',
  toast: '发出去了，但没收到界面回执，不确定用户看到没有：那个界面可能在后台、锁屏或已关掉，也可能是不回执的旧版 App。别说已经提醒到了。',
};
const HIDDEN = {
  open: '打开了，但这个界面在后台，用户此刻看不见；别说「已经打开在你眼前」。',
  toast: '弹出来了，但这个界面在后台，用户多半没看见。',
};

// 手机设备 id（'d:…' / 'm:…'）→ 句柄与名字，口径同手机操控的 phone_devices
function deviceLookup(ctx) {
  let ctl = [], known = [];
  try { ctl = listDevices(ctx.key, { includeOffline: true }); } catch {}
  try { known = phoneClients(ctx.key); } catch {}
  return (id) => {
    if (!id) return null;
    const d = ctl.find((x) => x.id === id);
    if (d) return { handle: d.handle, label: d.label, name: d.name || '', model: d.model || '' };
    const p = known.find((x) => x.id === id);
    const model = (p && p.model) || (id.startsWith('m:') ? id.slice(2) : '');
    return { handle: phoneHandle(id), label: p ? phoneName(p) : (model || '安卓手机'), name: (p && p.name) || '', model };
  };
}

defineOp({
  name: 'ui.view', title: '用户此刻在看什么',
  desc: '列出这个账号开着的 bridge 界面（手机 app / 网页 / 桌面客户端），每个给出所在页面、工作台状态、文件面板路径、正在预览的文件；排在前面的是用户最近在用的。'
    + 'fresh=true 只说明 90 秒内联系过（新版界面在前台时每分钟报一次），不代表用户一定看得见；visible=false 表示界面在后台，null 表示旧版不报。'
    + '手机 app 带 device（同手机操控 phone_devices 的设备句柄）和 deviceLabel：要在某台手机上打开东西，把 device 传给 ui.open。'
    + 'kernel（有时才有）= 这个界面的对话同步最近一次某一步超过 2 秒的记录（slow 哪一步、ms、trace 最近的步骤）：用户说「明明在跑却显示已结束」「切会话要转很久」时拿它当现场。',
  handler: async (ctx) => {
    const dev = deviceLookup(ctx);
    return {
      clients: getUiState(ctx.key).map((c) => {
        const d = dev(c.device);
        return { client: c.clientId, kind: c.client, fresh: c.fresh, visible: c.visible, at: c.at, ...(d ? { device: d.handle, deviceLabel: d.label } : {}), ...c.state };
      }),
    };
  },
});

// 挑目标界面。默认 = 最近在用、联系着、且没报在后台的那个；device = 那台手机上的 bridge。
function pickClient(ctx, want, device) {
  if (want && device) throw new OpError('bad_args', 'client 和 device 只给一个');
  const all = getUiState(ctx.key);
  if (want === 'all') {
    const fresh = all.filter((c) => c.fresh);
    return { target: null, count: fresh.length, acks: fresh.filter((c) => c.visible === true).length };
  }
  const one = (c, extra = {}) => ({ target: c.clientId, kind: c.client, count: 1, visible: c.visible, ...(c.fresh ? {} : { stale: true }), ...extra });
  if (want) {
    const c = all.find((x) => x.clientId === want);
    if (!c) throw new OpError('not_found', '没有这个界面', { hint: '界面 id 见 ui.view 的 client' });
    return one(c);
  }
  if (device) {
    const w = String(device).trim().toLowerCase();
    const dev = deviceLookup(ctx);
    const phones = all.filter((c) => c.device).map((c) => ({ c, d: dev(c.device) }));
    const exact = phones.filter(({ c, d }) => {
      const id = c.device.toLowerCase();
      return id === w || d.handle.toLowerCase() === w || (id.startsWith('d:') && w.length >= 4 && id.slice(2).startsWith(w));
    });
    const hits = exact.length ? exact : phones.filter(({ d }) => [d.name, d.model, d.label].some((s) => s && s.toLowerCase().includes(w)));
    if (!hits.length) return { target: null, count: 0, noDevice: true };
    const ids = [...new Set(hits.map(({ c }) => c.device))];
    if (ids.length > 1) {
      throw new OpError('bad_args', '有几台手机都对得上「' + device + '」', {
        hint: '换成设备句柄：' + ids.map((id) => { const d = dev(id); return d.handle + '（' + d.label + '）'; }).join('、'),
      });
    }
    // 同一台手机上可能有好几个界面（重装、清过数据）：挑联系着且在前台的
    const best = hits.find(({ c }) => c.fresh && c.visible !== false) || hits.find(({ c }) => c.fresh) || hits[0];
    return one(best.c, { device: best.d.handle });
  }
  const fresh = all.filter((c) => c.fresh);
  if (!fresh.length) return { target: null, count: 0 };
  return one(fresh.find((c) => c.visible !== false) || fresh[0]);
}

// 发一条 ui.cmd 并等回执。先登记回执再发，回执来得再快也接得住。
async function deliver(ctx, pick, op, body) {
  const who = pick.target ? { client: pick.target, kind: pick.kind, ...(pick.device ? { device: pick.device } : {}) } : { clients: pick.count };
  if (!busSubscribers(ctx.key)) return { delivered: false, ...who, note: NO_LINK };
  const id = randomUUID();
  const ack = waitUiAck(ctx.key, id, ACK_MS[op], { needOk: !pick.target, expect: pick.acks || 0 });
  busPublish(ctx.key, { type: 'ui.cmd', id, at: Date.now(), op, ...body, ...(pick.target ? { client: pick.target } : {}) });
  const a = await ack;
  if (!a) return { delivered: false, sent: true, confirmed: false, ...who, ...(pick.stale ? { stale: true } : {}), note: NO_ACK[op] };
  const client = typeof a.client === 'string' && a.client ? a.client.slice(0, 64) : pick.target;
  const kind = (getUiState(ctx.key).find((c) => c.clientId === client) || {}).client || pick.kind;
  const ok = a.ok !== false;
  const visible = typeof a.visible === 'boolean' ? a.visible : null;
  return {
    delivered: true, confirmed: true, ...(op === 'open' ? { opened: ok } : { shown: ok }),
    ...(client ? { client } : {}), ...(kind ? { kind } : {}), ...(pick.device ? { device: pick.device } : {}), visible,
    ...(!ok && a.reason ? { reason: String(a.reason).slice(0, 200) } : {}),
    ...(ok && visible === false ? { note: HIDDEN[op] } : {}),
  };
}

defineOp({
  name: 'ui.open', title: '把用户的界面带到某处',
  desc: [
    '四选一：page（页面，可带 module / section）、session（打开一个 Claude 会话）、file（把文件推进预览）、folder（文件面板定位到文件夹）。',
    '默认发给用户最近在用、且在前台的那个界面；client 指定某一个（ui.view 里的 client），device 指定某台手机上的 bridge（ui.view 的 device，即手机操控的设备句柄，也认设备名 / 机型），all 发给全部。',
    '结果以 confirmed / opened 为准：confirmed=true 才是界面回执过；opened=false 时 reason 说明原因；visible=false 表示打开在后台、用户此刻看不见。',
    '没收到回执时 delivered=false、confirmed=false（界面在后台 / 锁屏 / 已关，或旧版 App 不回执）——别跟用户说已经打开。用户没开着任何 bridge 界面时 delivered=false。',
    'page 取值：', PAGES.join(' / '), '；studio（Media Studio）的 module 是创作页：', STUDIO_MODULES.join(' / '), '；settings 的 section 是设置分区（如 account、devices、agentapi（Agent 接入））。',
    '只在用户要你「带我去 / 打开给我看」时用，别擅自把用户从正在看的地方拽走。',
  ].join(''),
  access: 'write',
  params: {
    page: { type: 'string', enum: PAGES },
    module: { type: 'string', enum: STUDIO_MODULES },
    section: { type: 'string', max: 40 },
    session: { type: 'string', desc: 'Claude 会话 id' },
    file: { type: 'string', desc: '相对工作空间根的文件路径' },
    folder: { type: 'string', desc: '相对工作空间根的文件夹路径' },
    client: { type: 'string', desc: '发给哪个界面（ui.view 的 client）；all = 全部' },
    device: { type: 'string', max: 64, desc: '发给哪台手机上的 bridge（ui.view 的 device，也认设备名 / 机型）；和 client 二选一' },
  },
  handler: async (ctx, args) => {
    const kinds = ['page', 'session', 'file', 'folder'].filter((k) => args[k] !== undefined && args[k] !== '');
    if (kinds.length !== 1) throw new OpError('bad_args', 'page / session / file / folder 要且只要给一个');
    if (args.page && PAGE_AGENT[args.page] && !(ctx.agents || []).includes(PAGE_AGENT[args.page])) {
      throw new OpError('forbidden', `「${args.page}」页对你没开`);
    }
    const target = args.page ? { page: args.page, ...(args.module ? { module: args.module } : {}), ...(args.section ? { section: args.section } : {}) }
      : args.session ? { session: String(args.session) }
        : args.file ? { file: String(args.file).replace(/\\/g, '/') }
          : { folder: String(args.folder).replace(/\\/g, '/') };
    const pick = pickClient(ctx, args.client, args.device);
    if (pick.noDevice) return { delivered: false, note: NO_DEVICE, target };
    if (!pick.count) return { delivered: false, note: '用户现在没有开着的 bridge 界面（手机 app / 网页 / 桌面客户端都没在前台）', target };
    return { ...(await deliver(ctx, pick, 'open', { target })), target };
  },
});

defineOp({
  name: 'ui.notify', title: '在用户界面上弹一条提示',
  desc: '在用户开着的 bridge 界面底部弹一条几秒自隐的提示（toast）。适合「做完了」这类轻提醒。挑界面与回执的口径同 ui.open：confirmed=true 才算弹出来了，没回执时 delivered=false，别说已经提醒到了。',
  access: 'write',
  params: {
    text: { type: 'string', required: true, max: 200 },
    client: { type: 'string', desc: '同 ui.open' },
    device: { type: 'string', max: 64, desc: '同 ui.open' },
  },
  handler: async (ctx, args) => {
    const pick = pickClient(ctx, args.client, args.device);
    if (pick.noDevice) return { delivered: false, note: NO_DEVICE };
    if (!pick.count) return { delivered: false, note: '用户现在没有开着的 bridge 界面' };
    return deliver(ctx, pick, 'toast', { text: args.text });
  },
});
