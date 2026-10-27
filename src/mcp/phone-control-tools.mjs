// 「手机操控」MCP——给 Claude 的 Tier 2/3 工具（v2，09-25 翻修）。
//
// 相对 v1 的根本变化：
//   · 【多设备】同一账号可有多台手机开着操控。每个工具都可带 device；不带时按「本轮已选定 → 发起这轮对话的
//     那台 → 唯一在线那台」挑，多台又判断不了就报错让模型指定。本轮一旦选定就锁住（读屏在 A、点按跑到 B 的
//     事故不再可能），换台必须显式传 device。
//   · 【一个动作一轮】动作类工具默认在手机侧等界面稳定（无障碍事件静默）后直接带回新画面（元素清单 +
//     带编号框的截图），不用再 wait→screen 来回。
//   · 【如实】输入回读核对、提交是否生效、画面是否变化都由手机回报，这里原样转述——不再「已输入并提交」
//     而实际没提交。
//   · phone_devices = 就绪自检；phone_confirm = 子 agent 也能向用户确认高危动作。
//
// makePhoneControlMcp({genKey, getGen, originDevice}) 把工具绑定到一个 caller（只下发到这个人自己的手机）。

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { requestPhoneControl, resolveDevice, listDevices, deviceLabel, deviceHandle } from '../runtime/phone-control.mjs';
import { getCurrentGen, genEmit } from '../runtime/gen.mjs';
import { waitForAnswer, sessionQuestions } from '../runtime/questions.mjs';
import { learnApp, formatPlaybook, linkAppPkg } from '../runtime/phone-playbook.mjs';

const txt = (s) => ({ content: [{ type: 'text', text: s }] });
const nrm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const errText = (e) => txt('手机操控失败：' + String(e?.message ?? e).slice(0, 400));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 画面格式化 ——
const WIN_TYPE = { 1: '应用', 2: '输入法', 3: '系统', 4: '无障碍浮层', 5: '分屏分隔条', 6: '放大镜' };
function winDesc(w) {
  const t = WIN_TYPE[w.type] || w.typeName || '窗口';
  const who = w.title || w.pkg || '';
  return t + (who ? ' ' + who : '') + (w.active ? '（活动）' : '') + (w.bounds ? ' @' + w.bounds.join(',') : '');
}
// 一行一个元素：[编号] w窗口 「文字」 能力 @左,上,右,下
function fmtEl(e, showWin) {
  const label = e.label || e.text || e.desc || '';
  const flags = [
    e.editable && '输入框', e.clickable && '可点', e.longClickable && !e.clickable && '可长按',
    e.scrollable && '可滚', e.checkable && (e.checked ? '已勾选' : '未勾选'), !e.checkable && e.checked && '已勾选',
    e.selected && '已选中', e.focused && '聚焦', e.password && '密码框',
  ].filter(Boolean).join('/');
  const name = label ? '「' + label + '」' : (e.hint ? '（提示「' + e.hint + '」）' : (e.cls || '') + (e.id ? ' #' + e.id : ''));
  return '[' + e.i + ']' + (showWin && e.w != null ? ' w' + e.w : '') + ' ' + name + (flags ? ' ' + flags : '') + ' @' + (e.bounds || []).join(',');
}
/** 观察结果 → 文本（v2 apk 带 windows/ime/changed；旧 apk 只有 elements+package，同样能排）。 */
export function fmtObservation(r, tag) {
  const els = Array.isArray(r?.elements) ? r.elements : [];
  const wins = Array.isArray(r?.windows) ? r.windows : [];
  const head = [tag, '前台 ' + (r?.package || '?'), '屏幕 ' + (r?.screenW || '?') + '×' + (r?.screenH || '?')].filter(Boolean);
  if (r?.ime && r.ime.visible) head.push('键盘已弹出' + (r.ime.bounds ? '（占 @' + r.ime.bounds.join(',') + '）' : ''));
  if (r?.changed === false) head.push('⚠ 画面和动作前一样，这一下可能没生效');
  if (r?.settle && r.settle.quiet === false) head.push('（画面还在动，可能没加载完）');
  const lines = [head.join(' · ')];
  if (wins.length > 1) lines.push('窗口（上层在前）：' + wins.map((w) => 'w' + w.i + ' ' + winDesc(w)).join('；'));
  if (els.length) {
    for (const e of els) lines.push(fmtEl(e, wins.length > 1));
    if (r?.truncated) lines.push('（元素太多，只列了前 ' + els.length + ' 个）');
  } else if (Array.isArray(r?.elements)) {
    lines.push('（没读到元素——这个界面不开放无障碍信息，只能看截图按坐标操作）');
  }
  if (r?.note) lines.push('注：' + r.note);
  return lines.join('\n');
}
function shotHint(r) {
  if (r?.som) return '截图上的彩色编号框 = 清单里同编号的元素，点它用 phone_tap by:index。清单里没有的目标（纯图标、自绘区域）看图按四边 0–100 刻度估位置，用 by:coord 传 0~1 比例。';
  return '截图四边标了 0–100 刻度' + (r?.grid !== false ? '、叠了每 10% 一条的网格' : '') + '：按刻度读出目标位置，用 phone_tap by:coord 传 0~1 比例（x≈45、y≈70 就传 x:0.45 y:0.70）。';
}
/** 观察 → MCP content（文本 + 截图图像块）。图像块格式是扁平的 {type:'image',data,mimeType}（SDK MCP 校验要求）。 */
function obsContent(r, tag, preface) {
  const content = [{ type: 'text', text: (preface ? preface + '\n' : '') + fmtObservation(r, tag) }];
  if (r?.screenshot) {
    content.push({ type: 'text', text: shotHint(r) });
    content.push({ type: 'image', data: r.screenshot, mimeType: 'image/jpeg' });
  } else if (r?.shotError) {
    content.push({ type: 'text', text: '（截图失败：' + r.shotError + '）' });
  }
  return { content };
}
const hasObservation = (r) => !!r && (Array.isArray(r.elements) || !!r.screenshot);

// 把一张截图(base64)【内嵌到用户的聊天流】——data: URI，不走 /api/vertex/media（离线壳跨源取图会坏）。
function showShotToUser(resolveGen, b64) {
  try {
    const gen = resolveGen();
    if (!gen || gen.done || !b64) return false;
    const id = 'shot-' + randomBytes(6).toString('hex');
    genEmit(gen, { type: 'gen_media_start', id, kind: 'image' });
    genEmit(gen, { type: 'gen_media', id, kind: 'image', prompt: '手机截图', dataUrl: 'data:image/jpeg;base64,' + b64 });
    return true;
  } catch { return false; }
}

// —— 工具层硬确认闸 ——
// 先走那台手机的悬浮胶囊 ✕/√ 卡片；悬浮壳没开/通道异常 → 站内 AskUserQuestion（等用户在任一端作答）。
const CONFIRM = '确认执行';
async function confirmDanger({ genKey, deviceId, resolveGen }, header, question, detail) {
  if (deviceId) {
    try {
      const r = await requestPhoneControl({ genKey, deviceId, op: 'confirm', args: { title: header, question, detail }, timeoutMs: 150_000 });
      if (r && typeof r.confirmed === 'boolean') return r.confirmed;
    } catch { /* 回退站内确认 */ }
  }
  const gen = resolveGen();
  if (!gen || gen.done) throw new Error('当前没有活跃的对话流，无法弹出确认——请在对话里发起该操作。');
  const qid = 'pcq-' + randomBytes(6).toString('hex');
  const questions = [{
    question, header, multiSelect: false,
    options: [
      { label: CONFIRM, description: detail || '执行这个动作' },
      { label: '取消', description: '不执行；让 Claude 换个方式或先停下' },
    ],
  }];
  genEmit(gen, { type: 'question', qid, questions });
  if (gen.sessionId) sessionQuestions.set(gen.sessionId, { qid, kind: 'question', ownerKey: genKey, questions, ts: Date.now() });
  try {
    const ans = await waitForAnswer(qid, gen.abort && gen.abort.signal, 300_000, genKey);
    if (ans && ans.cancelled) return false;
    const sel = ans && Array.isArray(ans.answers) && ans.answers[0] && Array.isArray(ans.answers[0].selected) ? ans.answers[0].selected : [];
    return sel.includes(CONFIRM);
  } catch {
    return false;
  } finally {
    if (gen.sessionId) sessionQuestions.delete(gen.sessionId, qid);   // 只删自己这条：同一会话可能还挂着审批卡
    try { gen.events = gen.events.filter((e) => !(e && e.type === 'question' && e.qid === qid)); } catch {}
  }
}

// —— 就绪自检格式化（status op 的回包；旧 apk 没有 status 就用长轮询上报的就绪位）——
const yes = (b, ok, bad) => (b === true ? '✓ ' + ok : b === false ? '✗ ' + bad : '? ' + ok + '（未知）');
export function fmtReadiness(s) {
  if (!s) return '  （这台手机的 app 版本较旧，不会自报就绪状态——更新 app 后可见）';
  const parts = [
    s.a11y === false && s.a11ySetting === true
      ? '✗ 无障碍开关开着，但服务没在运行（更新 app 后常见 / 被系统停了）：在 设置 › 无障碍 › Claude Bridge 里关掉再打开一次'
      : yes(s.a11y, '无障碍（读屏/点按）', '无障碍没开：读不了屏也点不了——手机 设置 › 无障碍 › 已安装的应用 › Claude Bridge 打开'),
    yes(s.screenshot, '截图', '截不了图（需安卓 11+ 且无障碍已开）'),
    s.imeEnabled === false ? '✗ Bridge 输入法没在系统里启用：微信等 app 只能靠剪贴板粘贴打字——在 bridge 设置 › 手机操控 › Bridge 输入法 里启用'
      : s.imeEnabled ? '✓ Bridge 输入法已启用' + (s.imeAutoSwitch === false ? '（本机不能自动切换，需手动设为默认）' : '') : '',
    s.screenOn === false ? '✗ 熄屏中（操作前需亮屏）' : s.locked ? '✗ 锁屏中（需要用户解锁后才能操作）' : (s.screenOn ? '✓ 亮屏已解锁' : ''),
    s.overlay === false ? '△ 没有悬浮窗权限（胶囊进度/确认卡用不了，会改在聊天里确认）' : '',
  ].filter(Boolean);
  const extra = [s.foreground ? '前台 ' + s.foreground : '', s.screenW ? '屏幕 ' + s.screenW + '×' + s.screenH : '', s.appVersion ? 'app v' + s.appVersion : ''].filter(Boolean).join(' · ');
  return '  ' + parts.join('\n  ') + (extra ? '\n  ' + extra : '');
}

export function buildPhoneControlTools(genKey, getGen, originDevice) {
  const resolveGen = () => (getGen && getGen()) || getCurrentGen(genKey);
  // 本轮锁定的设备（buildPhoneControlTools 每次 query 重建 = 每轮一份；子 agent 与主线程共用同一 MCP 实例）。
  const st = { deviceId: null };
  const pick = (want) => {
    const r = resolveDevice(genKey, { want, sticky: st.deviceId, origin: originDevice });
    if (r.error) throw new Error(r.error);
    const switched = st.deviceId && st.deviceId !== r.device.id;
    st.deviceId = r.device.id;
    return { d: r.device, switched };
  };
  const tagOf = (d) => '【' + (d.name || d.model || deviceHandle(d)) + '】';
  // 发给选定设备；返回 {r, d, tag, note}。note 在换台时提醒「编号作废」。
  const run = async (op, args, timeoutMs, want) => {
    const { d, switched } = pick(want);
    const r = await requestPhoneControl({ genKey, deviceId: d.id, op, args, timeoutMs });
    return { r, d, tag: tagOf(d), note: switched ? '（已切换到 ' + deviceLabel(d) + '，之前那台的元素编号作废）' : '' };
  };
  // 经验带回：按包名每轮一次，防刷屏。
  const surfaced = new Set();
  const surfaceExp = (out, pkg) => {
    const key = nrm(pkg);
    if (!key || surfaced.has(key)) return;
    const exp = formatPlaybook(pkg);
    if (!exp) return;
    surfaced.add(key);
    out.content.push({ type: 'text', text: '📒 以前记下的这个 app 的经验（参考，坐标可能随机型/布局失效，以当前画面为准；失效就 phone_learn 更新）：\n' + exp });
  };
  // 动作类的共同参数：observe（默认 both=清单+编号截图）。旧 apk 只认 withScreen（只回清单）。
  const obsArgs = (a) => { const o = a.observe || 'both'; return { observe: o, withScreen: o !== 'none' }; };
  const actionResult = (msg, pack) => {
    const { r, tag, note } = pack;
    const pre = msg + (note ? ' ' + note : '');
    if (hasObservation(r)) { const out = obsContent(r, tag, pre); surfaceExp(out, r.package); return out; }
    return txt(tag + ' ' + pre + (r && r.changed === false ? '（⚠ 画面和动作前一样，可能没生效）' : ''));
  };

  const device = z.string().optional().describe('操作哪台手机：phone_devices 列出的句柄或名字。只有一台在线、或本轮已选定时可省略');
  const observe = z.enum(['both', 'elements', 'screenshot', 'none']).optional().describe('做完后带回的画面：both(默认，清单+编号截图) / elements / screenshot / none(连续快速动作时省流量)');

  return [
    // ———————————————————————— 设备与就绪自检 ————————————————————————
    {
      name: 'phone_devices',
      description: '列出开着「手机操控」的手机，以及每台现在能不能用：无障碍（读屏/点按）、截图、Bridge 输入法、是否亮屏解锁、前台 app。开始一个手机任务前、或操作失败想查原因时调用。标「本轮目标」的就是不传 device 时会操作的那台。',
      schema: {},
      handler: async () => {
        try {
          const on = listDevices(genKey);
          if (!on.length) return txt('没有手机开着操控。请让用户在手机 app 的 设置 › 手机操控 里打开（读屏/点按还需要授予无障碍）。');
          const target = resolveDevice(genKey, { sticky: st.deviceId, origin: originDevice });
          const rows = await Promise.all(on.map(async (d) => {
            let s = null;
            try { s = await requestPhoneControl({ genKey, deviceId: d.id, op: 'status', args: {}, timeoutMs: 10_000 }); }
            catch (e) { if (!/未知操作/.test(String(e?.message))) s = { error: String(e?.message || e) }; }
            const mark = target.device && target.device.id === d.id ? (d.id === originDevice ? '  ← 本轮目标（用户正在用它发消息）' : '  ← 本轮目标') : '';
            const head = '「' + d.handle + '」' + d.label + mark;
            if (s && s.error) return head + '\n  ✗ 查询失败：' + s.error;
            return head + '\n' + fmtReadiness(s || (d.ready ? { ...d.ready } : null));
          }));
          const tail = target.error ? '\n\n' + target.error : '';
          return txt(rows.join('\n\n') + tail);
        } catch (e) { return errText(e); }
      },
    },

    // ———————————————————————— Tier 2：意图 / 系统 ————————————————————————
    {
      name: 'phone_open_app',
      description: '打开一个 app（中文名如 微信/淘宝/设置，或包名 com.tencent.mm；内置常用映射，其余按已安装应用名匹配）。会等它真的到前台、界面稳定后带回画面；到不了前台会如实说明。',
      schema: { app: z.string().describe('app 中文名或包名'), device, observe },
      handler: async (a) => {
        try {
          const pack = await run('open_app', { app: a.app, ...obsArgs(a) }, 30_000, a.device);
          const r = pack.r || {};
          if (r.pkg) linkAppPkg(a.app, r.pkg);
          let msg = '已启动 ' + (r.label || a.app) + (r.pkg ? '（' + r.pkg + '）' : '');
          if (r.foreground === false) msg += '——⚠ 等了 ' + Math.round((r.waitMs || 0) / 100) / 10 + ' 秒它还没到前台（被系统拦了后台启动 / 有别的界面盖着 / 还在加载），看下面的画面判断';
          const out = actionResult(msg, pack);
          // open_app 知道 名字↔包名：按名字再兜一次经验（读屏按包名反查要求先登记过包名）。
          if (!(r.pkg && surfaced.has(nrm(r.pkg))) && !surfaced.has(nrm(a.app))) {
            const exp = formatPlaybook(a.app);
            if (exp) {
              surfaced.add(nrm(a.app)); if (r.pkg) surfaced.add(nrm(r.pkg));
              out.content.push({ type: 'text', text: '📒 以前记下的「' + (r.label || a.app) + '」经验（参考，坐标可能随机型/布局失效，以当前画面为准）：\n' + exp });
            }
          }
          return out;
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_open_url',
      description: '用默认浏览器/对应 app 打开网址（http/https，或 geo:、tel: 等 scheme）。',
      schema: { url: z.string().describe('要打开的 URL'), device, observe },
      handler: async (a) => { try { return actionResult('已打开 ' + a.url, await run('open_url', { url: a.url, ...obsArgs(a) }, 30_000, a.device)); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_open_settings',
      description: '打开系统设置的某一页：wifi / bluetooth / battery / location / data / display / sound / app / apps / nfc / hotspot / accessibility / input（输入法）/ storage；留空=设置首页。',
      schema: { page: z.string().optional().describe('设置子页关键字，留空=首页'), device, observe },
      handler: async (a) => { try { return actionResult('已打开设置' + (a.page ? '：' + a.page : ''), await run('open_settings', { page: a.page || '', ...obsArgs(a) }, 30_000, a.device)); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_share',
      description: '通过系统「分享」把一段文字发出去；target=目标 app（如「微信」）则直达它的分享入口，不填弹系统选择器。只分享文字。',
      schema: { text: z.string().describe('要分享的文字'), target: z.string().optional().describe('目标 app（中文名或包名）'), device, observe },
      handler: async (a) => { try { return actionResult('已发起分享' + (a.target ? '到 ' + a.target : '（系统选择器）'), await run('share', { text: a.text, target: a.target || '', ...obsArgs(a) }, 30_000, a.device)); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_clipboard_set',
      description: '把文字写进手机剪贴板（会覆盖用户原来的剪贴板内容）。输入法注入不可用时，可配合长按输入框 →「粘贴」来输入。',
      schema: { text: z.string().describe('要复制的文字'), device },
      handler: async (a) => { try { const p = await run('clipboard_set', { text: a.text }, 15_000, a.device); return txt(p.tag + ' 已写入剪贴板（' + a.text.length + ' 字）' + p.note); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_clipboard_get',
      description: '读手机剪贴板的文字。安卓 10+ 限制后台读取，常常读到空——读不到就换别的办法，别当成剪贴板真是空的。',
      schema: { device },
      handler: async (a) => { try { const p = await run('clipboard_get', {}, 15_000, a.device); const t = p.r?.text || ''; return txt(p.tag + ' ' + (t ? '剪贴板内容：\n' + t : '（读到空——可能真是空的，也可能被系统限制了后台读取）')); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_notify',
      description: '在手机上弹一条通知（标题+正文），用于提醒用户某事做完了或需要他处理（比如解锁手机、自己完成付款）。',
      schema: { title: z.string(), text: z.string(), device },
      handler: async (a) => { try { const p = await run('notify', { title: a.title, text: a.text }, 15_000, a.device); return txt(p.tag + ' 已发通知：' + a.title); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_compose_sms',
      description: '打开短信 app 并预填收件人和内容，【不发送】，由用户自己按发送。安全，无需确认。',
      schema: { to: z.string(), body: z.string(), device },
      handler: async (a) => { try { const p = await run('compose_sms', { to: a.to, body: a.body }, 15_000, a.device); return txt(p.tag + ' 已打开短信编辑界面（预填给 ' + a.to + '，未发送）'); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_send_sms',
      description: '【高危·直接发出短信】调用时会自动弹确认卡片（手机悬浮胶囊或聊天里），用户点确认才发；不必另外确认。用户取消就别硬来，可改用 phone_compose_sms。',
      schema: { to: z.string(), body: z.string(), device },
      handler: async (a) => {
        try {
          const { d } = pick(a.device);
          const ok = await confirmDanger({ genKey, deviceId: d.id, resolveGen }, '发送短信', '确认用 ' + deviceLabel(d) + ' 给 ' + a.to + ' 发这条短信吗？', '内容：' + a.body);
          if (!ok) return txt('已取消：用户没有确认发送这条短信。');
          await requestPhoneControl({ genKey, deviceId: d.id, op: 'send_sms', args: { to: a.to, body: a.body } });
          return txt(tagOf(d) + ' ✓ 已发出短信给 ' + a.to);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_dial',
      description: '打开拨号盘并预填号码，【不拨出】。安全，无需确认。',
      schema: { number: z.string(), device },
      handler: async (a) => { try { const p = await run('dial', { number: a.number }, 15_000, a.device); return txt(p.tag + ' 已打开拨号盘并预填 ' + a.number + '（未拨出）'); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_call',
      description: '【高危·直接拨打电话】调用时会自动弹确认卡片，用户确认才拨。用户取消就改用 phone_dial。',
      schema: { number: z.string(), device },
      handler: async (a) => {
        try {
          const { d } = pick(a.device);
          const ok = await confirmDanger({ genKey, deviceId: d.id, resolveGen }, '拨打电话', '确认用 ' + deviceLabel(d) + ' 拨打 ' + a.number + ' 吗？', '会立即拨出。');
          if (!ok) return txt('已取消：用户没有确认拨打。');
          await requestPhoneControl({ genKey, deviceId: d.id, op: 'call', args: { number: a.number } });
          return txt(tagOf(d) + ' ✓ 已拨打 ' + a.number);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_vibrate',
      description: '让手机震动一下（默认 300ms）。',
      schema: { ms: z.number().optional(), device },
      handler: async (a) => { try { const p = await run('vibrate', { ms: Math.max(1, Math.min(a.ms ?? 300, 3000)) }, 15_000, a.device); return txt(p.tag + ' 已震动'); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_speak',
      description: '让手机用系统语音把一段文字读出来。',
      schema: { text: z.string(), device },
      handler: async (a) => { try { const p = await run('speak', { text: a.text }, 15_000, a.device); return txt(p.tag + ' 已朗读：' + a.text.slice(0, 40)); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_confirm',
      description: '在执行不可撤回的动作（发消息、下单、删除、改账号/安全设置…）之前向用户确认：优先在那台手机的悬浮胶囊上弹 ✕/√ 卡片，没开悬浮窗就在聊天里弹选择卡。返回用户是否同意。子 agent 用它代替 AskUserQuestion。',
      schema: { question: z.string().describe('要问用户的话，写清对象和内容，如「确认给 张三 发送“今晚七点见”吗？」'), detail: z.string().optional(), device },
      handler: async (a) => {
        try {
          let deviceId = null;
          try { deviceId = pick(a.device).d.id; } catch { /* 没设备在线也能在聊天里问 */ }
          const ok = await confirmDanger({ genKey, deviceId, resolveGen }, '确认操作', a.question, a.detail || '');
          return txt(ok ? '用户已确认，可以执行。' : '用户没有确认（拒绝或超时）——不要执行，按用户意思换做法或停下回报。');
        } catch (e) { return errText(e); }
      },
    },

    // ———————————————————————— Tier 3：无障碍（眼睛与手）————————————————————————
    {
      name: 'phone_screen',
      description: '看手机当前画面。默认 both：元素清单（编号/文字/能力/位置，覆盖所有窗口，上层弹窗在前）+ 截图（能读到元素时截图上画了同编号的框；读不到时画坐标网格）。elements / screenshot 只要其一。toUser:true 时把一张干净截图发到用户的聊天里（用户说「给我看看屏幕」时用）。',
      schema: {
        format: z.enum(['both', 'elements', 'screenshot']).optional().describe('默认 both'),
        toUser: z.boolean().optional().describe('true=把截图内嵌发到用户聊天里'),
        device,
      },
      handler: async (a) => {
        try {
          const f = a.format || 'both';
          const pack = await run('screen', { format: f, grid: !a.toUser, som: !a.toUser, clean: !!a.toUser }, 30_000, a.device);
          const r = pack.r || {};
          let pre = pack.note || '';
          if (a.toUser) pre += (r.screenshot && showShotToUser(resolveGen, r.screenshot)) ? '（这张截图已发到用户聊天里）' : '（没拿到截图，没能发给用户）';
          const out = obsContent(r, pack.tag, pre);
          surfaceExp(out, r.package);
          return out;
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_tap',
      description: '点一下。by=index（默认，用最近一次画面里的编号，最准；元素已经消失/变了会直接报错，不会点空）/ text（按可见文字找可点元素，有歧义会报错）/ coord（看截图估的 0~1 比例 x,y，读不到元素的界面用这个）。做完带回新画面。',
      schema: {
        by: z.enum(['index', 'text', 'coord']).optional(),
        index: z.number().optional(), text: z.string().optional(),
        x: z.number().optional().describe('by=coord：0~1 屏幕比例（也接受像素）'), y: z.number().optional(),
        device, observe,
      },
      handler: async (a) => {
        try {
          const by = a.by || (a.index != null ? 'index' : a.text ? 'text' : 'coord');
          const pack = await run('tap', { by, index: a.index, text: a.text, x: a.x, y: a.y, ...obsArgs(a) }, 30_000, a.device);
          return actionResult(pack.r?.target ? '点了 ' + pack.r.target : '已点按', pack);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_long_press',
      description: '长按（弹出粘贴菜单、多选、拖动前的按住等）。by=index / coord（0~1 比例）。做完带回新画面。',
      schema: { by: z.enum(['index', 'coord']).optional(), index: z.number().optional(), x: z.number().optional(), y: z.number().optional(), durationMs: z.number().optional().describe('默认 650'), device, observe },
      handler: async (a) => {
        try {
          const by = a.by || (a.index != null ? 'index' : 'coord');
          const pack = await run('long_press', { by, index: a.index, x: a.x, y: a.y, durationMs: a.durationMs, ...obsArgs(a) }, 30_000, a.device);
          return actionResult(pack.r?.target ? '长按了 ' + pack.r.target : '已长按', pack);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_swipe',
      description: '从 (x1,y1) 划到 (x2,y2)，坐标用 0~1 屏幕比例（也接受像素）。翻页/滚列表优先用 phone_scroll。',
      schema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationMs: z.number().optional().describe('默认 350'), device, observe },
      handler: async (a) => {
        try { return actionResult('已划动', await run('swipe', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, durationMs: a.durationMs || 350, ...obsArgs(a) }, 30_000, a.device)); }
        catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_scroll',
      description: '滚动一块区域。direction=down 看下面的内容 / up / left / right；index=要滚的那块（清单里标「可滚」的编号）——大屏左右两栏时一定要指定；不传就滚画面里最大的可滚区域。amount 0~1 默认 0.6。会如实报告画面有没有变（没变=到头了或没滚动）。',
      schema: { direction: z.enum(['up', 'down', 'left', 'right']), index: z.number().optional(), amount: z.number().optional(), device, observe },
      handler: async (a) => {
        try {
          const pack = await run('scroll', { direction: a.direction, index: a.index, amount: a.amount ?? 0.6, ...obsArgs(a) }, 30_000, a.device);
          return actionResult('已滚动（' + a.direction + '）' + (pack.r?.region ? '：' + pack.r.region : ''), pack);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_input',
      description: '往输入框写文字（整串一次写入，不要去屏幕键盘上逐字点）。by=focused（默认，当前聚焦的输入框；没聚焦先点一下它）/ index（清单里的输入框编号）。clear 默认 true 覆盖原内容。submit=写完顺带按：search / send / go / done / next / enter。回报会写明：走的哪条路（Bridge 输入法 / 无障碍）、回读核对是否真写进去了、提交是否生效——没核实或没生效就不要当成功，换办法（点屏幕上的搜索/发送键；或 clipboard_set + 长按输入框 + 粘贴）。',
      schema: { text: z.string(), by: z.enum(['focused', 'index']).optional(), index: z.number().optional(), clear: z.boolean().optional(), submit: z.enum(['enter', 'search', 'send', 'go', 'done', 'next']).optional(), device, observe },
      handler: async (a) => {
        try {
          const pack = await run('input', { text: a.text, by: a.by || (a.index != null ? 'index' : 'focused'), index: a.index, clear: a.clear !== false, submit: a.submit || '', ...obsArgs(a) }, 30_000, a.device);
          const r = pack.r || {};
          let msg;
          if (r.path) {
            const via = r.path === 'ime' ? 'Bridge 输入法' : '无障碍';
            const ver = r.verified === true ? '回读核对：已写入' : r.verified === false ? '⚠ 回读核对：输入框里没有这段文字' : '（这个界面读不到输入框内容，无法核对，请看截图确认）';
            msg = '经' + via + '写入「' + (a.text.length > 30 ? a.text.slice(0, 30) + '…' : a.text) + '」。' + ver;
            if (r.imeReason) msg += '。没用 Bridge 输入法的原因：' + r.imeReason;
            if (a.submit) msg += r.submitted ? '。已执行提交（' + a.submit + '）——看画面确认是否真的搜索/发送了' : '。⚠ 提交没有生效：' + (r.submitNote || '这个输入框不接受该动作') + '——请点屏幕上的对应按钮';
          } else {
            msg = '已输入（旧版 app 不回报核对结果——请看画面确认' + (a.submit ? '，提交可能没生效' : '') + '）';
          }
          return actionResult(msg, pack);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_key',
      description: '按系统键：back 返回 / home 桌面 / recents 最近任务 / notifications 下拉通知栏 / enter 对当前输入框按回车（经输入法或无障碍，不保证每个 app 都接受）。',
      schema: { key: z.enum(['back', 'home', 'recents', 'notifications', 'enter']), device, observe },
      handler: async (a) => { try { return actionResult('已按 ' + a.key, await run('key', { key: a.key, ...obsArgs(a) }, 30_000, a.device)); } catch (e) { return errText(e); } },
    },
    {
      name: 'phone_wait',
      description: '干等一会儿（毫秒，默认 800，最多 10000），给还在加载的页面时间。动作类工具已经自带「等稳定再看」，一般用不上。',
      schema: { ms: z.number().optional() },
      handler: async (a) => { const ms = Math.min(Math.max(a.ms ?? 800, 0), 10000); await sleep(ms); return txt('已等待 ' + ms + 'ms'); },
    },

    // ———————————————————————— 经验库 ————————————————————————
    {
      name: 'phone_recall',
      description: '查以前为某个 app 记下的操作经验（特性、做法、坑）。phone_open_app 与读屏已会自动带回，一般不用单独调。',
      schema: { app: z.string().describe('app 中文名或包名') },
      handler: async (a) => {
        try { const t = formatPlaybook(a.app); return txt(t ? '「' + a.app + '」的经验（参考，以当前画面为准）：\n' + t : '还没有「' + a.app + '」的经验记录。'); }
        catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_learn',
      description: '记一条操作经验，下次操作同一个 app 时会自动带回（这台电脑上所有驾驶 Claude 共享）。只记非显然、下次能省事的：①app 特性（读不读得到元素、哪些页禁止截图、大屏是不是双栏）；②某类任务验证有效的做法（写语义步骤，如「顶部搜索→输入联系人名→点结果里的“联系人”栏」，不要写死坐标）；③踩到的坑。写明适用的布局（如「折叠屏展开双栏」「普通手机单栏」）。同一 app+task 再记会覆盖并累计验证次数。',
      schema: {
        app: z.string().describe('app 中文名或包名'),
        task: z.string().optional().describe('任务类型，如「发消息给某人」；留空=只记 app 级特性'),
        steps: z.string().optional().describe('验证有效的语义步骤'),
        gotchas: z.string().optional().describe('坑 / 注意点'),
        traits: z.union([z.string(), z.array(z.string())]).optional().describe('app 级特性'),
      },
      handler: async (a) => {
        try { learnApp({ app: a.app, task: a.task, steps: a.steps, gotchas: a.gotchas, traits: a.traits }); return txt('已记下「' + a.app + '」' + (a.task ? '·' + a.task : '') + ' 的经验。'); }
        catch (e) { return errText(e); }
      },
    },
  ];
}

// 绑定到一个 caller 的「手机操控」MCP。originDevice = 发起这轮对话的那台手机（从手机发起时才有）。
export function makePhoneControlMcp({ genKey = 'admin', getGen, originDevice } = {}) {
  return createSdkMcpServer({
    name: 'phoneControl',
    version: '2.0.0',
    tools: buildPhoneControlTools(genKey, getGen, originDevice).map((t) => tool(t.name, t.description, t.schema, t.handler)),
  });
}

export const PHONE_TOOL_NAMES = [
  'phone_devices', 'phone_open_app', 'phone_open_url', 'phone_open_settings', 'phone_share', 'phone_clipboard_set', 'phone_clipboard_get',
  'phone_notify', 'phone_compose_sms', 'phone_send_sms', 'phone_dial', 'phone_call', 'phone_vibrate', 'phone_speak', 'phone_confirm',
  'phone_screen', 'phone_tap', 'phone_long_press', 'phone_swipe', 'phone_scroll', 'phone_input', 'phone_key', 'phone_wait',
  'phone_recall', 'phone_learn',
];

// 子 agent「手机操作员」：多步手机任务在它自己的上下文里跑（截图不堆进主对话），做完回一段总结。
// 提示词是普通字符串拼接——别用反引号。
const OPERATOR_PROMPT = [
  '你是「手机操作员」：用 mcp__phoneControl__* 工具在用户的安卓手机上完成委派给你的任务，做完用中文简要回报。',
  '',
  '【循环】看画面 → 做一个动作 → 看结果。tap / long_press / swipe / scroll / input / key / open_app 做完会在手机上等界面稳定，并直接带回新画面（元素清单 + 截图），一般不用再单独 phone_screen，也不用 phone_wait。只有画面标注「还在动/没加载完」时才 phone_wait 一下再 phone_screen。',
  '【看画面】清单每行：[编号] 「文字」 能力 @左,上,右,下。能读到元素时截图上画了同编号的彩色框。清单里有的目标一律 phone_tap by:index（最准，元素变了会直接报错而不是点空）；清单里没有的（纯图标、微信这类不开放元素的 app、游戏）看截图，按四边 0–100 刻度估位置，用 by:coord 传 0~1 比例。编号只对最近一次画面有效。',
  '【窗口与弹窗】多个窗口时清单按「上层在前」列出（w0 最上层）。上层有弹窗时下层基本点不到：先处理弹窗（关闭/取消/以后再说）。广告、领券、升级提示直接关掉；权限申请、协议同意、支付安全这类别替用户同意，选拒绝/取消，必要时回报。',
  '【大屏与分屏】折叠屏展开、平板常是左右两栏：先看清目标在哪一栏。phone_scroll 要传 index 指定滚哪一块。两栏的聊天类 app，右栏可能开着别的会话。',
  '【输入】phone_input 会回报走的路（Bridge 输入法 / 无障碍）、回读核对、提交是否生效。没核实、没生效就换办法：点屏幕上的搜索/发送按钮；写不进去时用 phone_clipboard_set 写剪贴板 → 长按输入框 → 点弹出菜单里的「粘贴」。',
  '【如实】工具说「失败 / 画面没变 / 没核实」就是没做成，不要自己圆过去。同一招失败两次就换思路；换了三种办法还卡住，就停下回报卡在哪一步、画面是什么样。',
  '【确认】发消息、发帖、下单、删除、改账号或安全设置等不可撤回的动作：委派说明里明确授权了（对象和内容都对得上）才做；否则先 phone_confirm 问用户，用户不同意就停。phone_send_sms / phone_call 自带确认。发消息前再看一眼会话标题，确认对象没错。',
  '【金融】绝不完成支付、转账、下单结算、借贷、理财购买：带到付款/确认页就停，phone_notify 提醒用户自己操作，并在回报里说明。',
  '【隐私】画面里的聊天、通知、验证码只为完成任务而看；回报里别转述与任务无关的内容。',
  '【设备】委派说明写了哪台手机就用 device 指定那台；本轮第一次选定后后续命令自动锁定它。报「无障碍没开 / 锁屏 / 未连接」时别硬试，phone_devices 看一眼后回报用户需要做什么。',
  '【经验】开 app 时会带回以前记下的经验：当参考，坐标可能随机型/布局失效，以当前画面为准。做成一件非显然的事、或踩到反直觉的坑后，用 phone_learn 记一条（语义步骤 + 适用布局，不写死坐标）。',
  '【回报】最后一条消息写：做成了什么（附画面上的证据，如搜索结果标题、已发出的消息）、没做成什么及原因、需要用户自己做什么。',
].join('\n');

export function phoneOperatorAgent() {
  return {
    description: '手机操作员：在用户的安卓手机上执行多步操作任务（在 app 里搜索、发消息、找设置项、填表、查信息……）。它有独立上下文，截图不会占用主对话；做完回报结果。委派时写清：目标、哪台手机（phone_devices 的句柄）、用户原话里明确授权的不可撤回动作（对象+内容）、要回报什么。',
    prompt: OPERATOR_PROMPT,
    tools: PHONE_TOOL_NAMES.map((n) => 'mcp__phoneControl__' + n),
    omitClaudeMd: true,
    maxTurns: 80,
  };
}

// 主线程 systemPrompt 追加：有这套工具 + 多设备规则 + 何时委派子 agent + 高危/金融护栏。
export const PHONE_CONTROL_NUDGE = '\n\n你还有一组「手机操控」工具（mcp__phoneControl__*），通过用户安卓手机上的常驻服务真实操作手机：开 app、看画面、点按、输入、滚动、按键，以及剪贴板、通知、短信、拨号等。'
  + '\n【哪台手机】用户可能有多台手机同时开着操控。不传 device 时：本轮已选定的那台 → 发起这轮对话的那台手机 → 唯一在线的那台；从电脑发起且多台在线时必须用 device 指定，不确定用户说的是哪台就先问。本轮选定后自动锁定，换台要显式传 device。phone_devices 列出在线设备和各自的就绪状态（无障碍/截图/输入法/亮屏解锁），开始任务前或出错时先看它。'
  + '\n【多步任务交给子 agent】需要在 app 里连续操作的任务（搜东西、发消息、找设置项、填表、查页面信息……），用 Agent 工具派 subagent_type:"phone-operator"。委派说明写清：目标、哪台手机（句柄）、用户原话里明确授权的不可撤回动作（对象+内容；没授权的它会先向用户确认）、要回报什么。它在自己的上下文里跑，截图不会塞满主对话。单步的小事（开个 app、写剪贴板、发个通知、看一眼屏幕）直接调工具即可。'
  + '\n【高危】发消息、下单、删除、改安全设置等不可撤回的动作：用户原话已明确要求（对象+内容）才直接做，否则先确认（主对话用 AskUserQuestion；子 agent 用 phone_confirm）。phone_send_sms / phone_call 自带确认卡。'
  + '\n【金融护栏】绝不自动完成支付/转账/下单结算，只带到那一步交给用户。'
  + '\n【如实】工具或子 agent 回报「没核实 / 没生效 / 画面没变 / 失败」时不要当成功；向用户汇报时分清哪些做成了、哪些没确认。报「无障碍没开 / 锁屏 / 未连接」时照实告诉用户怎么处理。';
