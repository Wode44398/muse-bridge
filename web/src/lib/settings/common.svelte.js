// 设置页两套外壳共用的带状态部分。每个 create*() 在外壳组件初始化时调用：里面的 $state / $effect 跟着那个外壳实例走，
// 关了设置就随之销毁，跟原来写在外壳里一样。外壳按原来的先后顺序调用，副作用（请求、effect）的次序不变。
import { t, tc, tr, lang } from '../i18n.js';
import { me, agentOn } from '../state.svelte.js';
import { api, getToken } from '../api.js';
import { ags, agentById, addAccount, updateAccount } from '../agentSettings.svelte.js';
import { cs } from '../claudeSettings.svelte.js';
import { setVal } from '../claudeSettingsView.js';
import { dimDispatchLine } from '../dimensioSettings.svelte.js';
import { cp, loadProviders, canUseCustomApi } from '../claudeProviders.svelte.js';
import { hub, loadHub } from '../modelHub.svelte.js';
import { saPing } from '../serverAdmin.svelte.js';
import { serverOnThisMachine } from '../nativeDesktop.js';
import { appVersionLine, fetchServerInfo } from '../appUpdate.js';
import { DISTRO, feedbackDest } from '../distro.js';
import { setServerBase } from '../server.js';
import { normalizeServerAddress } from '../connectPair.js';
import { startPairLogin } from '../pair.js';
import { changeMyPassword } from '../me.js';
import { recall, remember } from '../lastKnown.js';

// 两个入口探针的结果放在模块里、并记进快照（lib/lastKnown）：设置每开一次控制器都是新建的，
// 结果要是跟着实例走，每次打开根页都从「没有」起步，探针一回来「服务器」那一组才插进来、把下面整列推开。
// 现在先按上次的结果画，探针回来只在真变了时才增减（增减那一下由 RootPages 的 grow 过渡接住）。
const probes = $state({ ext: recall('probe.ext') === true, srvAdmin: recall('probe.srvAdmin') === true });
const keepProbes = () => { remember('probe.ext', probes.ext); remember('probe.srvAdmin', probes.srvAdmin); };

// —— 服务端控制台入口：服务端就在这台电脑上（本机直连放行），或服务端开着远程管理（features.remoteAdmin）时的管理员 ——
// 后端探针（/api/admin/ping，本地管理员门；旧后端 404 → 入口不出现，绝不给一个点了报错的入口）
export function createSrvAdminProbe() {
  let pinged = false;
  $effect(() => {
    const want = serverOnThisMachine() || (me.kind === 'admin' && !!me.features?.remoteAdmin);
    if (!want) { if (probes.srvAdmin) { probes.srvAdmin = false; keepProbes(); } return; }
    if (pinged) return;
    pinged = true;
    // 每开一次设置复核一次（服务端可能刚关了远程管理）；没通过才撤掉入口
    saPing().then(() => { probes.srvAdmin = true; }).catch(() => { probes.srvAdmin = false; }).finally(keepProbes);
  });
  return { get ok() { return probes.srvAdmin; } };
}

// —— 扩展中心入口：admin 探针通过才显示。门是 admin token/cookie（可远程），与控制台的 loopback 门不同——手机出门也能管扩展。
// 成员探的是自己的技能接口（/api/my-extensions：只有技能，见 ext/Customize 的成员模式）。
export function createExtProbe() {
  // 探针落定（成功或失败）：冷开直达「扩展」（插件详情）时探针还在路上，两套外壳都要等它落定、确实没过才把人撤出这一分区。
  // 落定看的是这一次打开发出的探针（跟着实例），结果本身沿用上次的（模块里）
  let extSettled = $state(false);
  const extMember = me.kind === 'user';
  api.get(extMember ? '/api/my-extensions' : '/api/extensions')
    .then(() => { probes.ext = true; })
    // 断网 / 超时不算「没有」：留着上次的结果，别让一次抖动把整组入口撤掉又加回
    .catch((e) => { if ([401, 403, 404].includes(e?.status)) probes.ext = false; })
    .finally(() => { extSettled = true; keepProbes(); });
  return { get ok() { return probes.ext; }, get settled() { return extSettled; }, member: extMember };
}

// —— 模型中心那一页 / 分区出不出现：hub.ok（管理员的总览）|| cp.ok（能自定义 API 的成员自己的 Claude 服务），两样都是开设置才拉。
// 直达这一页时数据多半还在路上：mhSettled 落定前先停在这页等，落定了确实两边都没有再退回去
export function createHubPresence() {
  let mhSettled = $state(false);
  Promise.allSettled([loadHub(), canUseCustomApi() ? loadProviders() : null]).then(() => { mhSettled = true; });
  const mhOn = $derived(hub.ok || cp.ok || (me.kind === 'admin' && !!hub.err));
  return {
    get settled() { return mhSettled; },
    get on() { return mhOn; },
    maybe: () => hub.ok || cp.ok || (!mhSettled && canUseCustomApi()),
  };
}

// —— 版本：「The Bridge · v5.67（380）」——
export function createVersionLine() {
  let verLine = $state(DISTRO.brand);
  appVersionLine().then((line) => { verLine = line; }).catch(() => {});
  return { get line() { return verLine; } };
}

// —— 根页 / 侧栏的 agent 行 ——
// 管理员：服务器上全部 agent（含这台机器跑不了的，行尾标「不可用」）；其他人：只有 Claude 有本机偏好可调。
// 在「扩展 › 功能扩展」里关掉的 agent 直接不列（维护者 10-21）；开着但这台机器跑不起来的仍列出、变灰，点进去看原因。
// Claude 是核心、不在功能扩展里，关了也得留着入口才开得回来。
// 成员拿不到 /api/agents：被授权用 dimensio 就有它的一页，里面只出他自己能改的（模型、key、规则、偏好……）
// 2026-11-04 Gemini 对话下线：Gemini 那一页删掉，原来的位置由 Media Studio（'studio' 页）接替。服务端的 AGENTS 里有 studio 时
// 按它的次序排；成员拿不到 /api/agents、或 dev fixture（localStorage bridge-studio-fixture=1）时补在 Claude 后面。
// devClaude：拿不到 agent 清单时 Claude 那一行在开发模式下也照列（桌面壳的 dev 调试入口要它）。
export function createAgentList({ devClaude = false } = {}) {
  const studioDev = import.meta.env.DEV && (() => { try { return localStorage.getItem('bridge-studio-fixture') === '1'; } catch { return false; } })();
  // 显示条件：管理员看 /api/agents 里有没有 studio（关着也列出来，好在这里打开）；成员看自己的 agent 名单。
  const studioOn = $derived(studioDev || (me.kind === 'admin' && !!agentById('studio')) || (Array.isArray(me.agents) && me.agents.includes('studio')));
  const agentRows = $derived.by(() => {
    const rows = (ags.agents?.agents?.length ? ags.agents.agents : agentOn('claude') || devClaude ? [{ id: 'claude', label: 'Claude', local: true }] : [])
      .filter((a) => (a.local || a.id === 'claude' || a.switch !== false) && a.id !== 'gemini');
    if (!ags.agents?.agents?.length && me.kind === 'user' && Array.isArray(me.agents) && me.agents.includes('dimensio')) rows.push({ id: 'dimensio', label: 'dimensio', local: true });
    // 被授权用 Codex 的成员（完全信任档）：分区里只有他自己的默认档与已归档的对话
    if (!ags.agents?.agents?.length && me.kind === 'user' && Array.isArray(me.agents) && me.agents.includes('codex')) rows.push({ id: 'codex', label: 'Codex', local: true });
    if (studioOn && !rows.some((a) => a.id === 'studio')) rows.splice(rows[0]?.id === 'claude' ? 1 : 0, 0, { id: 'studio', label: 'Media Studio', local: true });
    return rows;
  });
  const studioIds = $derived((ags.agents?.agents || []).filter((a) => a.runnable).map((a) => a.id));
  return { get studioOn() { return studioOn; }, get agentRows() { return agentRows; }, get studioIds() { return studioIds; } };
}

// —— Claude 订阅号池：添加 / 编辑账号的表单、删除确认 ——
export function createAcctForm() {
  let acctForm = $state(null);   // null | { id?, label, token, isNew, hasToken, tokenTail, busy, err }
  let acctDel = $state(null);    // null | account
  function openAddAcct() { ags.err = ''; acctForm = { label: '', token: '', plan: '', isNew: true, busy: false, err: '' }; }
  function openEditAcct(a) { ags.err = ''; acctForm = { id: a.id, label: a.label, token: '', plan: a.plan || '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail, busy: false, err: '' }; }
  async function saveAcctForm(e) {
    e?.preventDefault?.();
    const f = acctForm;
    if (!f || f.busy) return;
    if (f.isNew && !f.token.trim()) { f.err = t('token 不能为空'); return; }
    f.busy = true; f.err = '';
    const done = f.isNew ? await addAccount(f.label, f.token, f.plan) : await updateAccount(f.id, f.label, f.token, f.plan);
    // 表单里的错只在表单里说，别漏到背后那一页的脚注上
    if (done) acctForm = null; else { f.err = ags.err; ags.err = ''; f.busy = false; }
  }
  return {
    get acctForm() { return acctForm; }, set acctForm(v) { acctForm = v; },
    get acctDel() { return acctDel; }, set acctDel(v) { acctDel = v; },
    openAddAcct, openEditAcct, saveAcctForm,
  };
}

// —— Claude 设置：「允许绕过权限模式」打开前先确认（危险操作的解释放在确认框里，页面上不写）——
export function createBypass() {
  let bypassAsk = $state(false);
  function setCs(key, v) {
    if (key === 'allowBypass' && v) { bypassAsk = true; return; }
    setVal(key, v);
  }
  function confirmBypass() { bypassAsk = false; setVal('allowBypass', true); }
  return { get bypassAsk() { return bypassAsk; }, set bypassAsk(v) { bypassAsk = v; }, setCs, confirmBypass };
}

// —— 子 agent 调用策略的入口行（Claude 那份 + dimensio 那份）——
// 状态模块 lib/dispatchPolicy.svelte.js 与子页正文 components/claude/dispatch/DispatchPolicy.svelte 都懒加载：
// 页面露面才取状态模块（副标题要读生效策略），进子页才取正文——设置页首屏不带它们
// dimensio 页「子 agent 调用策略」那一行的快照（lib/lastKnown）：策略要先懒加载状态模块、再等一个请求，
// 冷开时副标题和行尾开关要晚一秒才出现。只留副标题与开关要的几项（策略名、总开关、跟随、范围、能不能改），
// 状态模块读到了就以它为准。放模块里：设置每开一次控制器都是新建的。
const LK_DDP = 'dimensio.dispatchRow';
let ddpLast = $state.raw((() => { const v = recall(LK_DDP); return v && v.policy ? v : null; })());
function keepDdp(d) {
  const p = d?.policy;
  if (!p) return;
  ddpLast = {
    policy: { enabled: !!p.enabled, follow: p.follow, scope: { ...(p.scope || {}) }, activeId: p.activeId, strategies: (p.strategies || []).map((x) => ({ id: x.id, name: x.name })) },
    claude: d.claude ? { name: d.claude.name } : null,
    canEdit: d.canEdit,
  };
  remember(LK_DDP, ddpLast);
}

export function createDispatchRows() {
  const dpShown = $derived(cs.shell || cs.admin);   // 能改策略的身份（管理员 / 能跑命令的）才有这一行
  let dpm = $state.raw(null);      // 状态模块（{ dp, loadDispatch, setDispatch, … }）
  const dp = $derived(dpm?.dp || null);
  let dpImp = null;
  function dpLoad() {
    dpImp ||= import('../dispatchPolicy.svelte.js');
    dpImp.then((m) => { dpm = m; return m.loadDispatch(); }).catch(() => { if (!dpm) dpImp = null; });   // 模块没取到：下次进来再试
  }
  // 副标题只放状态。关：一句去向；开：生效策略名 · 开着的范围（一个都没勾也照实说）
  const dpSub = $derived.by(() => {
    const p = dp?.policy;
    if (!p) return dp?.err ? t('调用策略没读出来，点进去重试') : '';
    if (!p.enabled) return t('已关闭 · 走 Claude Code 原生调用');
    const s = (p.strategies || []).find((x) => x.id === p.activeId) || p.strategies?.[0];
    const on = [p.scope?.workflow && tc('调用范围', '工作流'), p.scope?.subagent && tc('调用范围', '普通子 agent'), p.scope?.session && tc('调用范围', '发起新会话')].filter(Boolean);
    // 迁移时自动建的那套叫「默认」，英文界面跟着译；用户自己起的名字原样显示
    const named = !!s?.name && s.name !== '默认';   // i18n-ignore 与存下来的名字比较
    return (named ? s.name : t('默认')) + ' · ' + (on.length ? on.join(t('、')) : t('未选生效范围'));
  });
  // 总开关即点即存（状态模块乐观更新，失败回滚并抛）：没存上时这一行的副标题换成红字说一声（onFail：外壳让开关弹回去）
  let dpRowErr = $state(''), dpErrTimer = 0;
  async function setDispatch(v, onFail) {
    dpRowErr = '';
    try { await dpm.setDispatch({ enabled: v }); }
    catch (e) {
      onFail?.();
      dpRowErr = tr(e?.message || '') || t('没保存上，请重试');   // 状态模块抛的 Error.message 就是给人看的那句话
      clearTimeout(dpErrTimer); dpErrTimer = setTimeout(() => { dpRowErr = ''; }, 4000);
    }
  }
  // dimensio 那份（手机设置的 dimensio 页那一行用；桌面的 desktop/settings/DimensioSection 自己管）：副标题读 dimensio 那份状态（dimDispatch），
  // 状态模块同上懒加载
  // 状态模块读到了策略就用它；还没读到（模块在路上、请求在路上、一时读失败）先用上次的快照
  const ddp = $derived(dpm?.dimDispatch.dp.policy ? dpm.dimDispatch.dp : ddpLast || dpm?.dimDispatch.dp || null);
  const ddpImport = () => (dpImp ||= import('../dispatchPolicy.svelte.js'));
  function ddpLoad() {
    ddpImport().then((m) => { dpm = m; return m.dimDispatch.loadDispatch().then((ok) => { if (ok) keepDdp(m.dimDispatch.dp); }); })
      .catch(() => { if (!dpm) dpImp = null; });
  }
  const ddpSub = $derived(ddp ? dimDispatchLine(ddp) : '');
  let ddpRowErr = $state(''), ddpErrTimer = 0;
  async function toggleDimDispatch() {
    if (!ddp?.policy) return;
    const want = !ddp.policy.enabled;   // 按用户此刻看到的那一档翻（快照画出来的开关也能点）
    ddpRowErr = '';
    try {
      const m = dpm || await ddpImport();
      dpm = m;
      if (!m.dimDispatch.dp.policy && !(await m.dimDispatch.loadDispatch())) throw new Error(m.dimDispatch.dp.err || '');
      await m.dimDispatch.setDispatch({ enabled: want });
      keepDdp(m.dimDispatch.dp);
    }
    catch (e) {
      ddpRowErr = tr(e?.message || '') || t('没保存上，请重试');
      clearTimeout(ddpErrTimer); ddpErrTimer = setTimeout(() => { ddpRowErr = ''; }, 4000);
    }
  }
  return {
    get dpShown() { return dpShown; }, get dpm() { return dpm; }, get dp() { return dp; }, dpLoad, get dpSub() { return dpSub; },
    get dpRowErr() { return dpRowErr; }, setDispatch,
    get ddp() { return ddp; }, ddpLoad, get ddpSub() { return ddpSub; }, get ddpRowErr() { return ddpRowErr; }, toggleDimDispatch,
  };
}

// —— 账户：扫码登录（网页端出码、手机扫）：进 qr 模式即领票出码 + 长轮询，离开即停 ——
// active()：这一刻该不该出码（在账户页、没登录、选了扫码）。
// 回调里不读 pair（读了就成了本 effect 的依赖，写回触发自身重跑 → 每圈领一张新票把限流打满）。
export function createPairLogin(active, onDone) {
  let pair = $state({ status: 'idle', svg: '', error: '' });
  let pairCtl = null;
  $effect(() => {
    if (!active()) return;
    let svg = '';
    const ctl = startPairLogin((u) => {
      if (u.svg !== undefined) svg = u.svg;
      pair = { status: u.status, svg, error: u.error || '' };
      if (u.status === 'done') onDone();
    });
    pairCtl = ctl;
    return () => { ctl.stop(); if (pairCtl === ctl) pairCtl = null; pair = { status: 'idle', svg: '', error: '' }; };
  });
  const pairMsg = $derived(pair.status === 'scanned' ? t('已扫描，请在手机上确认')
    : pair.status === 'approved' ? t('登录中…')
    : pair.status === 'rejected' ? t('已在手机上取消 · 点击刷新')
    : pair.status === 'error' ? t('{error} · 点击刷新', { error: tr(pair.error) || t('出错了') })
    : pair.status === 'expired' ? t('二维码已过期 · 点击刷新')
    : pair.status === 'pending' ? '' : t('生成中…'));
  return { get pair() { return pair; }, get pairCtl() { return pairCtl; }, get pairMsg() { return pairMsg; } };
}

// —— 账户：改密码（注册用户）——
export function createPasswordChange() {
  let form = $state(null);   // null | { old, next, again, busy, err }
  let done = $state(false);  // 刚改好
  async function save(e) {
    e?.preventDefault?.();
    const f = form;
    if (!f || f.busy) return;
    if (f.next.length < 8) { f.err = t('新密码至少 8 位'); return; }
    if (f.next !== f.again) { f.err = t('两次输入的新密码不一致'); return; }
    f.busy = true; f.err = '';
    try { await changeMyPassword(f.old, f.next); form = null; done = true; }
    catch (err) { f.err = tr(err?.body?.error) || t('修改失败'); f.busy = false; }
  }
  return { get form() { return form; }, set form(v) { form = v; }, get done() { return done; }, set done(v) { done = v; }, save };
}

// —— 服务器地址：换地址先探一下 /api/auth，通了（含 401）就整页重载到新地址 ——
export function createServerAddress(initial = '') {
  let addrInput = $state(initial), addrBusy = $state(false), addrErr = $state('');
  async function connectAddr() {
    if (addrBusy) return;
    let a = addrInput.trim();
    if (!a) { addrErr = t('请输入地址'); return; }
    a = normalizeServerAddress(a) || a.replace(/\/+$/, '');   // 局域网 / 本机地址补 http，其余补 https（S1-2）
    addrBusy = true; addrErr = '';
    setServerBase(a);
    try {
      const r = await fetch(a + '/api/auth', { headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {} });
      if (r.ok || r.status === 401) { location.reload(); return; }
      addrErr = t('连接异常（HTTP {status}），检查地址', { status: r.status });
    } catch { addrErr = t('连不上这个地址，确认电脑 server 开着、地址没填错'); }
    addrBusy = false;
  }
  return {
    get addrInput() { return addrInput; }, set addrInput(v) { addrInput = v; },
    get addrBusy() { return addrBusy; }, get addrErr() { return addrErr; }, set addrErr(v) { addrErr = v; },
    connectAddr,
  };
}

// —— 服务器那头（/api/app/server-info，要登录）：{ app, multiUser, publicOrigin, server:{ uptimeSec, node } } ——
// 没有隧道状态——接口从来不给 tunnel 字段，要显示得先让服务端给。
export function createServerInfo() {
  let srvInfo = $state(null);
  let pubCopied = $state(false);
  async function copyPublic() {
    try { await navigator.clipboard.writeText(srvInfo.publicOrigin); pubCopied = true; setTimeout(() => { pubCopied = false; }, 1500); } catch {}
  }
  const load = () => fetchServerInfo().then((r) => { srvInfo = r; }).catch(() => {});
  return { get srvInfo() { return srvInfo; }, get pubCopied() { return pubCopied; }, copyPublic, load };
}

// —— 反馈去向（/api/feedback/upstream）：默认只留在这台服务器上。管理员主动打开「把用户反馈同时发给 bridge 开发者」
// （默认关）之后，提交的人还要自己勾「这条也发给 bridge 开发者」（fbConsent，默认不勾）才发。
// 没配中继地址（reason=no-relay）、不是正式实例时不出开关；开发者自己那台（mode=inbox）是汇总端，不出提示也不出开关。
export function createFeedbackUpstream() {
  let fbUp = $state(null), fbUpBusy = $state(false);
  function loadFbUp() { api.get('/api/feedback/upstream').then((r) => { fbUp = r; }).catch(() => {}); }
  // 去向文案里的「发给谁」：发行版声明的（服务端回的 dest 优先，其次注入的 DISTRO.feedback），没声明 = 本体的「bridge 开发者」
  const fbDest = $derived(feedbackDest(fbUp?.dest, lang()));
  // 开 / 关推送；onErr 收那句没改成的话（摆在反馈表单的报错位上）
  async function setFbUp(enabled, onErr) {
    if (fbUpBusy) return;
    fbUpBusy = true;
    try { fbUp = await api.post('/api/feedback/upstream', { enabled }); }
    catch (e) { onErr(t('没改成：{reason}', { reason: tr(e?.body?.error || e?.message) || t('连不上服务器') })); loadFbUp(); }
    finally { fbUpBusy = false; }
  }
  // 推送端由勾选行自己写明发什么；其余一句话说清只留本机。没配中继 / 不是正式实例（reason 有值）时开关根本不出现，
  // 不提开关名；有中继、管理员没开时才提。管理员多看一句反馈库在服务器上的位置（单人服务器自己就是管理员）
  const fbUpNote = $derived.by(() => {
    if (!fbUp || fbUp.mode === 'inbox' || fbUp.mode === 'push') return '';
    const notOn = !fbUp.reason;
    if (fbUp.admin && fbUp.libraryDir) return (notOn ? t('这台服务器没开「把用户反馈同时发给 {to}」。', { to: fbDest.to }) + ' ' : '')
      + t('反馈只留在这台服务器上，存放在 {dir}。', { dir: fbUp.libraryDir });
    return notOn ? t('这台服务器没开「把用户反馈同时发给 {to}」，反馈只留在服务器上，由管理员查看。', { to: fbDest.to })
      : t('反馈只留在这台服务器上，由管理员查看。');
  });
  const fbUpAdminSub = $derived(!fbUp?.admin ? ''
    : t('默认关。打开后，提交页会多一个「这条也发给 {to}」，提交的人自己勾了才发。', { to: fbDest.to }) + (fbDest.public ? ' ' + t('这个去向是公开的：提交的内容任何人都能看到，请提醒大家别写隐私、账号和密钥。') : '')
      + (fbUp.relayHost ? ' ' + t('发往 {host}。', { host: fbUp.relayHost }) : ''));
  // 汇总端（开发者自己那台）只给管理员看拉取状态：令牌对不上、中继没部署时一眼能看出来，不会悄悄一直失败
  const fbWhen = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fbInboxLine = $derived(!fbUp?.admin || fbUp.mode !== 'inbox' ? ''
    : fbUp.reason === 'no-relay' || fbUp.lastPullError === 'no relay'
      ? t('这台是汇总端，但没配中继地址，拉不了外部反馈：在 config.json 写 feedbackRelay，或设环境变量 BRIDGE_FEEDBACK_RELAY。')
    : fbUp.lastPullError ? t('这台是汇总端，拉取外部反馈出错（{at}）：{err}', { at: fbWhen(fbUp.lastPullAt), err: fbUp.lastPullError })
      + (/^relay 401/.test(fbUp.lastPullError) ? ' ' + t('收件令牌（config.json 的 feedbackInbox.token）和中继的 INBOX_TOKEN 对不上。')
        : /^relay 404/.test(fbUp.lastPullError) ? ' ' + t('中继还没部署收件箱，或没配 INBOX_TOKEN。') : '')
    : fbUp.lastPullOkAt ? t('这台是汇总端：上次拉取 {at}，累计收到 {n} 条外部反馈。', { at: fbWhen(fbUp.lastPullOkAt), n: fbUp.pulledTotal || 0 })
    : t('这台是汇总端：启动后约 20 秒第一次拉取外部反馈。'));
  return {
    get fbUp() { return fbUp; }, get fbUpBusy() { return fbUpBusy; }, loadFbUp, setFbUp,
    get fbDest() { return fbDest; }, get fbUpNote() { return fbUpNote; }, get fbUpAdminSub() { return fbUpAdminSub; }, get fbInboxLine() { return fbInboxLine; },
  };
}
