<script>
  // 插件页面的宿主（网页 / 桌面壳）：把插件 web/ 下的页面装进一个【不透明源】的 iframe——sandbox 不给 allow-same-origin，
  // 服务端还给插件页面加了 CSP sandbox 头（routes/plugins.mjs）。所以页面读不到主页面的 DOM、localStorage 里的令牌和 cookie，
  // 桌面壳的 BridgeDesktop 只进主帧、它也摸不到。原则：插件的信任止于服务器边界，碰不到使用者设备上的东西。
  //
  // 页面经 /plugins/_sdk/bridge-plugin.js 和这里对话（postMessage，{ bp: 1, type, … }）：
  //   hello → 回 init（主题、颜色变量、语言、平台、是哪个应用）     resize → 撑高（只在嵌入模式）
  //   fetch → 宿主带自己的登录态代发，只放行 /api/plugin/<本插件>/ 下的路径     toast / confirm / open / back
  // 宿主往页面推：theme（切主题）、event（插件 ctx.bus.toPage 推的，以及 _status 状态块更新）、
  //   context（Claude 工作台标签：当前会话 / 工作目录 / agent，嵌入时随 init 给一次，切会话再推；SDK 的 bridge.context()）。
  // 页面宿主能力（init 的 caps 列出这里认的）：
  //   nav / composer → lib/pageNav 落地（跳会话 / 文件预览 / 应用 / 插件详情 / 主页；交给 Claude 新对话填好输入框）
  //   grant → 已授权直接回 true，否则弹 bridge 自己画的授权框（lib/grantDialog）
  //   pick.file → 先确认 page.files 授权 → 文件选择器 → POST /api/plugins/handles 换句柄，页面只拿到句柄和文件名，拿不到路径
  //   pick.session → 会话选择器
  //   chat.sub / chat.unsub → 宿主用自己的登录态订阅 _bridge/chat/events，按订阅号推 chat.event / chat.end（重连与去重在 SDK 里）
  // 同一 iframe 同时只挂一个选择器 / 授权框 / 确认框、最多 4 路对话订阅；页面重新 hello（刷新、跳页）或宿主卸载时，旧页面的订阅和挂着的框
  // 全部收掉、迟到的回话一律丢掉（新页面的请求号从 1 重新数，旧回话会对错号）。
  // 认消息与往里推都过 lib/pluginFrameGate：只认带着这次挂载的口令（地址 # 里的 nonce）、出自在场那份文档（hello 报的 doc）的消息；
  // 页面报 bye（离开）、或 iframe 又 load 之后在场文档答不上来，就同换代一样收掉订阅和框、停推，等下一个有效 hello。宿主发的消息不带口令。
  // 动界面的调用（nav / composer / grant / pick.* / confirm / back / open）只认在前台的页面：保活在后台的应用分页脚本照样在跑，
  // 不能让看不见的页面把人拽走、在不相干的界面上弹框（见 foreground()）。
  // 代发 fetch 按浏览器真正要发的地址核归属（见 cleanPath / pluginUrl）：编码点段归一化之后同样不许出 /api/plugin/<本插件>/。
  // 手机 App 不走这里：主 WebView 的原生桥注入所有帧，iframe 挡不住，改由原生另起干净 WebView（lib/pluginPanels openPluginStandalone）。
  import { onMount } from 'svelte';
  import { apiUrl } from '../../lib/server.js';
  import { api, authHeaders } from '../../lib/api.js';
  import { busOn } from '../../lib/bus.js';
  import { isEn, t } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { currentTheme, hostPlatform, pluginPanels, panelTitle } from '../../lib/pluginPanels.svelte.js';
  import { pluginUi } from '../../lib/pluginUi.svelte.js';
  import { askGrant, PAGE_PERMS } from '../../lib/grantDialog.svelte.js';
  import { pickFiles } from '../../lib/filePicker.svelte.js';
  import { pickSession } from '../../lib/sessionPicker.svelte.js';
  import { pageNav, pageComposer } from '../../lib/pageNav.js';
  import { watchFromPage } from '../../lib/notices.svelte.js';
  import { bidiIsolate, clipText } from '../../lib/selfMount.js';
  import { createFrameGate, createWatchHold, fromFrame, makeNonce, confirmParts } from '../../lib/pluginFrameGate.js';

  // mode: 'embed'（嵌在插件详情里，高度跟内容走）| 'panel'（占满所在区域）
  // context：{ sessionId, cwd, agent } | null（只有工作台标签给）
  // app：作为插件应用的全屏分页打开时是应用 id（components/apps/PluginAppPage），其余 null；随 init 告诉页面「你是哪个应用」
  let { id, page, mode = 'embed', onBack = null, minHeight = 120, context = null, app = null } = $props();

  let frame = $state(null);
  let height = $state(0);
  let failed = $state(false);
  // 应用分页：页面 hello 之前 iframe 先藏着，内容区露的是分页底色——插件页自己的白底 / 半截排版不闪出来。
  // 不用 SDK 的页面永远不 hello，load 之后稍等一下照样亮出来
  let hello = $state(false);
  let revealT = 0;
  function onFrameLoad() {
    // 第二次及以后的 load：页面换了一份文档（跳页、刷新，也可能被导航到了别处），问一声在场的还是不是 hello 过的那份
    gate.load();
    if (!app || hello) return;
    clearTimeout(revealT);
    revealT = setTimeout(() => (hello = true), 600);
  }

  const MAX_BODY = 20 * 1024 * 1024;
  // 存回句柄文件：服务端收 50 MB，代发这条别卡得比它紧
  const MAX_FILE_WRITE = 50 * 1024 * 1024;
  const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  // 转发给接口的请求头只留无害的几个（凭据由宿主自己加）。x-* 里 bridge 自己认的不转：x-bridge-*（bridge 的登录 / 设备 /
  // 客户端头的名字空间，以后「只有 bridge 自己界面才带」的标记头也放这里，插件页面伪造不出来）、x-csnap-token / x-share-token
  // （能力令牌，带上会把这次请求换成别的身份）、x-forwarded-* / x-real-ip（反代头，服务端据此判协议与来源地址）
  const PASS_HEADERS = /^(content-type|accept|x-[a-z0-9-]+)$/i;
  const HELD_HEADERS = /^x-(bridge-|csnap-|share-|forwarded-|real-ip$)/i;
  // 插件 id 形状（同服务端）：拼代发地址前再核一次，props 里万一混进别的串也拼不出别的路由
  const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

  // 宿主认的调用（随 init 交给 SDK 的 bridge.can()）
  const CAPS = ['nav', 'composer', 'grant', 'pick.file', 'pick.session', 'chat', 'files', 'kv'];
  const SUB_MAX = 4;
  const SUB_RE = /^[A-Za-z0-9_-]{1,32}$/;
  // 同服务端 page-chat 的会话 id 形状；不对的不发请求
  const SID_RE = /^[0-9A-Za-z-]{8,80}$/;

  // 以下都不进模板，用普通变量（别做成 $state）
  let alive = true;          // 卸载后置 false：选择器 / 授权框晚回来的结果不再替页面做事
  let gen = 0;               // 页面文档的代数：每次 hello +1，旧代的回话与订阅作废
  let modal = null;          // 这个 iframe 挂着的那个选择器 / 授权框：{ ac }（abort = 按取消收掉），没有为 null
  const subs = new Map();    // 对话订阅号 → AbortController
  // 流自己断了的订阅：SDK 重连的空档里「正看着」先留着（见 chatSub 与 lib/pluginFrameGate createWatchHold）
  const holds = createWatchHold({ watch: watchFromPage });
  let navAt = 0;            // 上一次放行 nav / composer 的时间（限频）

  // 动界面的调用：页面不在前台一律不办
  const FRONT_OPS = new Set(['nav', 'composer', 'grant', 'pick.file', 'pick.session', 'confirm', 'back', 'open']);
  // nav / composer 一秒最多一次：在前台的页面也别连着把人拽来拽去、反复冲掉输入框
  const NAV_GAP = 1000;
  // 判「被浮层整个盖住」时在 iframe 露在视口里的那块取的点（相对位置）
  const PROBES = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

  // 页面在不在使用者眼前。iframe 里的脚本和 postMessage 不会因为藏起来就停：App.svelte 保活在后台的应用分页
  // （.keep.dormant：inert + visibility / content-visibility 藏起来）、Claude 页休眠时它里面的工作台标签、切走的浏览器标签 /
  // 最小化的窗口、被设置这类浮层整个盖住的页面，都还能发调用。这些时候替使用者跳走、填输入框、弹授权框 / 选择器 / 确认框，
  // 框就冒在他正看着的、不相干的界面上——所以都得先过这一关。
  function foreground() {
    const f = frame;
    if (!f || !f.isConnected || document.visibilityState !== 'visible' || f.closest('[inert]')) return false;
    if (typeof f.checkVisibility === 'function') {
      // 两套选项名（新 visibilityProperty / 旧 checkVisibilityCSS）都给：老一点的 Chromium 只认后者
      if (!f.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    } else if (!f.getClientRects().length || getComputedStyle(f).visibility !== 'visible') return false;
    // 被浮层盖住：取几个点，至少一个点命中的是 iframe 本身才算看得见（只取一个点会被角落里的 toast、半截滚出去的嵌入框误伤）
    const r = f.getBoundingClientRect();
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, window.innerWidth);
    const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, window.innerHeight);
    if (x1 - x0 < 2 || y1 - y0 < 2) return false;
    return PROBES.some(([a, b]) => document.elementFromPoint(x0 + (x1 - x0) * a, y0 + (y1 - y0) * b) === f);
  }
  // 过关返回 true；不过关时有请求号的回 409 / 429（back / open 是单向消息，直接丢）
  function frontGate(m) {
    if (!foreground()) {
      if (m.id != null) reply(m.id, null, t('页面不在前台'), null, { status: 409 });
      return false;
    }
    if (m.type === 'nav' || m.type === 'composer') {
      const now = Date.now();
      if (now - navAt < NAV_GAP) { reply(m.id, null, t('请求太频繁，稍后再试'), null, { status: 429 }); return false; }
      navAt = now;
    }
    return true;
  }

  // 口令：每次挂载随机一个，只放在 iframe 地址的 # 里（# 不发给服务器，页面 SDK 读出来随每条消息带回）
  const nonce = makeNonce();
  const src = $derived(apiUrl('/plugins/' + id + '/' + page) + '#' + new URLSearchParams({ theme: currentTheme(), mode, lang: isEn() ? 'en' : 'zh', platform: hostPlatform(), nonce }).toString());

  function themeVars() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--bg'), card: v('--card'), text: v('--text'), muted: v('--muted'), line: v('--divider'), hover: v('--hover'),
      accent: v('--st-accent'), brand: v('--coral'), ok: v('--ok'), warn: v('--warn'), crit: v('--crit'), field: v('--st-field'),
      radius: '12px',
    };
  }
  // 往里推一律经门：在场文档才发、iframe 又 load 之后核实期间先排着、没有在场文档就丢（门补 bp: 1，绝不带口令）
  const gate = createFrameGate({
    nonce,
    send: (msg, transfer) => { try { frame?.contentWindow?.postMessage(msg, '*', transfer || []); } catch {} },
    // 在场文档没了（bye / load 之后答不上）：同换代——还没回的请求作废，订阅和挂着的框收掉
    onDetach: () => { gen += 1; dropSubs(); dropModal(); },
  });
  const post = (msg, transfer) => { gate.push(msg, transfer); };
  // detail：出错时的结构化原因（status / needGrant / undeclared / perm），SDK 挂到 Error 上，好让页面分清「没授权」「会话不对」
  const reply = (rid, value, error, transfer, detail) => post({ type: 'reply', id: rid, value, ...(error ? { error } : {}), ...(error && detail ? { detail } : {}) }, transfer);
  const live = (g) => alive && g === gen;
  // 异步做完才回话的调用：只回给发请求的那一代页面
  const replyIf = (g, ...args) => { if (live(g)) reply(...args); };

  // 错误里给页面看的那句话：服务端的 error 字段优先
  function errText(e) {
    const b = e?.body;
    if (b && typeof b === 'object' && typeof b.error === 'string' && b.error) return b.error;
    if (typeof b === 'string' && b && b.length < 300) return b;
    if (e?.status) return t('服务器返回 {code}', { code: e.status });
    return String(e?.message || '') || t('网络连接失败');
  }
  const errDetail = (status, j) => ({
    status,
    ...(j && typeof j.needGrant === 'string' ? { needGrant: j.needGrant } : {}),
    ...(j && j.undeclared === true ? { undeclared: true } : {}),
    ...(j && typeof j.perm === 'string' ? { perm: j.perm } : {}),
  });

  // 授权框 / 提示里显示的插件名与应用名：从已加载的界面清单里找（插件页面自己报的不算），找不到用插件 id
  function pluginName() {
    for (const list of [pluginUi.apps, pluginUi.workbench, pluginUi.homeCards, pluginUi.commands]) {
      const hit = (list || []).find((x) => x?.plugin === id && x.pluginName);
      if (hit) return String(hit.pluginName);
    }
    const p = pluginPanels.list.find((x) => x?.id === id && x.name);
    return p ? String(p.name) : id;
  }
  function appTitle() {
    if (app) {
      const a = pluginUi.apps.find((x) => x?.plugin === id && x.id === app);
      if (a?.title) return String(a.title);
    }
    const w = pluginUi.workbench.find((x) => x?.plugin === id && x.page === page);
    if (w?.title) return String(w.title);
    const p = pluginPanels.list.find((x) => x?.id === id && x.page === page);
    return p ? panelTitle(p) : '';
  }
  const shownName = () => bidiIsolate(clipText(pluginName(), 60) || id);

  // 选择器 / 授权框 / 确认框：一个 iframe 同时只挂一个，页面连点（或循环调 bridge.confirm）不会排出一串框来。
  // 每个框带一个 signal：页面换代（刷新 / 跳页）或宿主卸载时 abort，框按取消收掉（lib/grantDialog、filePicker、sessionPicker
  // 的 { signal }，确认框见 confirmBox）——不然孤儿框留在屏幕上，答完了结果没人收，新页面的请求还得等它关掉才不回 409。
  async function modalOp(m, g, fn) {
    if (modal) return reply(m.id, null, t('上一个选择框、授权框或确认框还没关'), null, { status: 409 });
    const mine = { ac: new AbortController() };
    modal = mine;
    try { await fn(mine.ac.signal); }
    catch (e) { replyIf(g, m.id, null, errText(e), null, { status: e?.status || 0 }); }
    finally { if (modal === mine) modal = null; }
  }
  // 收掉挂着的框：闩当场放开（被收掉的那个晚些 settle 时不会再动它），新一代页面立刻能再开
  function dropModal() {
    const x = modal;
    modal = null;
    try { x?.ac.abort(); } catch {}
  }
  // 能按 signal 收掉的确认框：uiConfirm 自己认 { signal }（abort = 按「取消」结算、框当场退场，Promise 回 false）。
  // 宿主起不来、退回系统弹窗时系统框收不掉，只是答案不再算数（结算过的不会再结算）
  const confirmBox = (message, opts, signal) => uiConfirm(message, { ...opts, signal });

  // 确认已授权：授过的不打扰；回 true / false，插件根本没声明这项权限回 null（弹框是白弹，服务端会拒）
  async function ensureGrant(perm, signal) {
    let g = null;
    try { g = await api.get('/api/plugins/grants?plugin=' + encodeURIComponent(id)); } catch {}
    if (g?.granted && typeof g.granted === 'object' && g.granted[perm]) return true;
    if (g && Array.isArray(g.declared) && !g.declared.some((d) => d?.id === perm)) return null;
    if (!alive || signal?.aborted) return false;
    // 同意时 askGrant 自己存授权（POST /api/plugins/grants）；abort 时按「不允许」回、不存
    return !!(await askGrant({ plugin: id, pluginName: pluginName(), appTitle: appTitle(), perm, signal }));
  }

  async function pickFile(m, g, signal) {
    const ok = await ensureGrant('page.files', signal);
    if (ok === null) {
      // 页面已经换代 / 宿主卸载了就不提示：发起的那个页面已经不在了
      if (live(g)) showToast(t('插件「{name}」没有声明文件权限，选不了文件', { name: shownName() }), 'err');
      return replyIf(g, m.id, null);
    }
    if (!ok || !live(g)) return replyIf(g, m.id, null);
    const multiple = m.multiple === true;
    const items = await pickFiles({ multiple, accept: String(m.accept ?? '').slice(0, 200), signal });
    // 选的时候页面刷新了 / 宿主关了：不替旧页面签句柄
    if (!live(g) || !Array.isArray(items) || !items.length) return replyIf(g, m.id, null);
    const picked = (multiple ? items : items.slice(0, 1)).map((it) => ({ rel: String(it?.rel || ''), ...(it?.ws ? { ws: String(it.ws) } : {}) }));
    try {
      const r = await api.post('/api/plugins/handles', { plugin: id, items: picked, mode: 'rw' });
      replyIf(g, m.id, Array.isArray(r?.files) && r.files.length ? r.files : null);
    } catch (e) {
      // 文件不合格、授权刚被撤：告诉人一声，页面那头按取消收场
      if (live(g)) showToast(t('选中的文件没能交给插件：{msg}', { msg: errText(e) }), 'err');
      replyIf(g, m.id, null);
    }
  }

  // SSE 按块拆：空行分隔，data: 行拼起来是一条 JSON；注释行（: ok / : ping 心跳）跳过。同 SDK 的 readSse
  async function readSse(body, onEvent) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          onEvent(ev);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  // 对话订阅：宿主用自己的登录态拉 _bridge/chat/events，按订阅号转给页面。
  // 拿到 2xx 才回话（true）；拿不到回错误 + 状态码（不再有 chat.end）；流断了推 chat.end，重连与去重由 SDK 做。
  // 被 chat.unsub 收掉时回 false（页面那头已经不要了，回一声免得它的请求一直挂着），也不推 chat.end。
  async function chatSub(m, g) {
    const sub = String(m.sub ?? '');
    const sid = String(m.session ?? '');
    if (!SUB_RE.test(sub) || !SID_RE.test(sid)) return reply(m.id, null, t('请求不合法'), null, { status: 400 });
    const old = subs.get(sub);
    if (old) { subs.delete(sub); old.abort(); }
    if (subs.size >= SUB_MAX) return reply(m.id, null, t('同一个页面最多同时订阅 {n} 个对话', { n: SUB_MAX }), null, { status: 429 });
    const ac = new AbortController();
    subs.set(sub, ac);
    // SDK 又来订阅这个会话：断线时留着的「正看着」兜底计时从头算（重连失败也还在重试，空档没完）
    holds.refresh(sid);
    const mine = () => live(g) && subs.get(sub) === ac;
    let res;
    try {
      res = await fetch(apiUrl('/api/plugin/' + id + '/_bridge/chat/events?session=' + encodeURIComponent(sid)), {
        headers: authHeaders({ Accept: 'text/event-stream' }), credentials: 'same-origin', cache: 'no-store', signal: ac.signal,
      });
    } catch (e) {
      const was = mine();
      if (subs.get(sub) === ac) subs.delete(sub);
      if (was) reply(m.id, null, String(e?.message || '') || t('网络连接失败'), null, { status: 0 });
      else replyIf(g, m.id, false);
      return;
    }
    if (!mine()) { try { ac.abort(); } catch {} replyIf(g, m.id, false); return; }
    if (!res.ok || !res.body) {
      let j = null;
      try { j = await res.json(); } catch {}
      if (subs.get(sub) === ac) subs.delete(sub);
      const msg = (j && typeof j.error === 'string' && j.error) || t('服务器返回 {code}', { code: res.status });
      if (live(g)) reply(m.id, null, msg, null, errDetail(res.ok ? 502 : res.status, j));
      return;
    }
    reply(m.id, true);
    // 订阅期间这个页面就是该会话的界面：它在前台时，这个会话的「已完成 / 出错了」横幅不弹（lib/notices.svelte.js）——
    // 页面自己的流里已经收到了，横幅只会盖住应用顶栏、点一下还把人拽出应用。
    const unwatch = watchFromPage(sid, () => mine() && foreground());
    // 新登记已经在了，上一回断线留着的才撤（先登后撤，中间不留空）
    holds.releaseSession(sid);
    let error = '';
    try {
      await readSse(res.body, (ev) => { if (mine()) post({ type: 'chat.event', sub, event: ev }); });
    } catch (e) {
      error = String(e?.message || e || '') || t('网络连接失败');
    } finally {
      // 流自己断了（还是 mine()：不是 chat.unsub、换代、卸载收掉的）：SDK 退避一阵、换个订阅号重连。这一轮要是在空档里结束，
      // 完成通知来时一条登记都没有，横幅照样盖上来——所以按这个订阅号留一条登记，重新订阅上 / 页面不要了 / 换代时再撤。
      // 被收掉的（abort 也走这里）就直接注销
      if (mine()) holds.hold(sub, sid, () => live(g) && foreground());
      unwatch();
    }
    if (!mine()) return;
    subs.delete(sub);
    post({ type: 'chat.end', sub, ...(error ? { error } : {}) });
  }
  function chatUnsub(m) {
    const sub = String(m.sub ?? '');
    // 断线空档里 off()（或 SDK 不再重试）：SDK 拿断掉的那个订阅号补这一条，留着的登记撤掉
    holds.release(sub);
    const ac = subs.get(sub);
    if (!ac) return;
    subs.delete(sub);
    try { ac.abort(); } catch {}
  }
  function dropSubs() {
    for (const ac of subs.values()) { try { ac.abort(); } catch {} }
    subs.clear();
    // 换代 / 文档离开 / 卸载：断线留着的登记一并撤
    holds.clear();
  }

  // 代发路径的第一道筛：只查字面上的 '..' 不够——'%2e%2e'、'.%2e'、'%2E%2E' 这类编码点段，浏览器拼地址时按 WHATWG 规则
  // 一样当 '..' 归一化（服务端 router 的 new URL 也是），Tab / 换行则在解析时被直接删掉（'.\t.' 变 '..'）。
  // 漏过去就是带着使用者登录态的任意接口：一个 POST /api/plugins/grants 就能不经授权框给自己授 page.chat。
  // 所以每一段解码后再看：是 '.' / '..'、含 / 或 \（%2f / %5c，反代可能解开）、含控制字符的，一律不收。
  // 片段（#…）去掉：fetch 本来就不发它，留着反而会把 apiUrl 补的 ?ct= / ?st= 挤进片段里丢掉。
  function cleanPath(p) {
    const s = String(p ?? '').replace(/^\/+/, '').replace(/#[\s\S]*$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /[\\\x00-\x1f\x7f]/.test(s)) return null;
    for (const seg of s.split('?')[0].split('/')) {
      let d;
      try { d = decodeURIComponent(seg); } catch { return null; }
      if (d === '.' || d === '..' || /[/\\\x00-\x1f\x7f]/.test(d)) return null;
    }
    return s;
  }
  // 第二道（真正把关的这一道）：按浏览器真正要发的地址核归属——解析、归一化之后必须还在 /api/plugin/<本插件>/ 下、同一个源。
  // 第一道哪天漏了什么写法，这里照样拦得住。回 { url, route }（route = 插件前缀之后的路径，逐段解码，供下面按路由分流），不合格回 null
  function pluginUrl(rel) {
    if (!PLUGIN_ID_RE.test(String(id))) return null;
    try {
      const root = new URL(apiUrl('/api/plugin/' + id + '/'), location.href);
      const u = new URL(apiUrl('/api/plugin/' + id + '/' + rel), location.href);
      if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname)) return null;
      return { url: u.href, route: decodeURIComponent(u.pathname.slice(root.pathname.length)) };
    } catch { return null; }
  }

  async function doFetch(m, g) {
    const rel = cleanPath(m.path);
    const method = String(m.method || 'GET').toUpperCase();
    const target = rel == null ? null : pluginUrl(rel);
    if (!target || !METHODS.has(method)) return reply(m.id, null, t('请求不合法'), null, { status: 400 });
    // 按解码后的路由判：'_bridge/chat/%65vents' 到了会解码的反代后面也是事件流
    const { route } = target;
    // 事件流经这里会被 arrayBuffer() 攒着不回、连接一直挂着：订阅只走 chat.sub
    if (route === '_bridge/chat/events') return reply(m.id, null, t('对话事件请用 bridge.chat.on 订阅'), null, { status: 400 });
    const body = m.body;
    const max = route === '_bridge/files/write' ? MAX_FILE_WRITE : MAX_BODY;
    if (body && (body.byteLength || body.size || body.length || 0) > max) return reply(m.id, null, t('请求体太大'), null, { status: 413 });
    const headers = {};
    for (const [k, val] of Object.entries(m.headers || {})) if (PASS_HEADERS.test(k) && !HELD_HEADERS.test(k)) headers[k] = String(val);
    try {
      const res = await fetch(target.url, {
        method, headers: authHeaders(headers), body: method === 'GET' ? undefined : (body ?? undefined), credentials: 'same-origin',
      });
      const buf = await res.arrayBuffer();
      const h = {};
      for (const k of ['content-type', 'content-disposition', 'cache-control']) { const x = res.headers.get(k); if (x) h[k] = x; }
      replyIf(g, m.id, { status: res.status, headers: h, body: buf }, null, [buf]);
    } catch (e) {
      replyIf(g, m.id, null, String(e?.message || e || t('网络错误')));
    }
  }

  async function onMessage(e) {
    // 出自这个 iframe 的窗口才收；唯一的例外是跳页时旧文档的 bye——它到这儿 e.source 已经是 null（见 fromFrame），
    // 不放它进门的话门一直挂着、下一次 load 的 probe 会落进跳去的外站页
    if (!frame || !fromFrame(e, frame.contentWindow)) return;
    const m = e.data;
    // 口令不对 / 不是在场文档的一律不理；bye、here 门里已经办了
    const kind = gate.receive(m);
    if (kind !== 'hello' && kind !== 'msg') return;
    const g = gen;
    if (FRONT_OPS.has(m.type) && !frontGate(m)) return;
    switch (m.type) {
      case 'hello':
        // 新文档（首次 / 刷新 / 页内跳页）：旧文档的订阅和挂着的框收掉，还没回的请求作废
        gen += 1;
        dropSubs();
        dropModal();
        failed = false;
        hello = true;
        post({ type: 'init', theme: currentTheme(), vars: themeVars(), lang: isEn() ? 'en' : 'zh', platform: hostPlatform(), mode, user: null, context: ctxNow(), app: app ? { plugin: id, id: app } : null, caps: CAPS });
        sentCtx = JSON.stringify(ctxNow());
        break;
      case 'resize':
        if (mode === 'embed') height = Math.max(minHeight, Math.min(4000, Number(m.height) || minHeight));
        break;
      case 'fetch': doFetch(m, g); break;
      case 'toast': showToast(String(m.text || '').slice(0, 300), m.error ? 'err' : 'ok'); break;
      case 'confirm': {
        // 由 bridge 写明是谁在问，放在框自己的标题位（框的最上面）：插件没法把自己的框伪装成 bridge 的，说明写多长也顶不走它。
        // 插件的标题当正文（一行、120 字内），说明逐行收拾（去双向控制符、并空行、最多 8 行 500 字），见 lib/pluginFrameGate 的 confirmParts
        // 和选择器 / 授权框共用一把闩（modalOp）：一次只挂一个，页面换代 / 宿主卸载时按取消收掉
        const c = confirmParts(m);
        const opts = { title: t('来自插件「{plugin}」', { plugin: shownName() }), detail: c.detail, okLabel: c.okLabel || t('确定'), type: m.danger ? 'warning' : 'question' };
        modalOp(m, g, async (signal) => replyIf(g, m.id, !!(await confirmBox(c.message || t('确定吗？'), opts, signal))));
        break;
      }
      case 'open':
        if (/^https?:\/\//i.test(String(m.url || ''))) window.open(String(m.url), '_blank', 'noopener');
        break;
      case 'back': onBack?.(); break;
      // comeBack：页面就在这个界面里，跳去会话 / 别的应用 / Claude 后按系统返回回到这一页（lib/screenReturn.js）
      case 'nav': {
        const ok = await pageNav(id, { to: m.to, session: m.session, rel: m.rel, ws: m.ws, app: m.app }, { comeBack: true });
        replyIf(g, m.id, !!ok);
        break;
      }
      case 'composer':
        pageComposer(String(m.text ?? '').slice(0, 20000), { comeBack: true });
        reply(m.id, true);
        break;
      case 'grant': {
        const perm = String(m.perm || '');
        if (!PAGE_PERMS.includes(perm)) { reply(m.id, false); break; }
        modalOp(m, g, async (signal) => replyIf(g, m.id, (await ensureGrant(perm, signal)) === true));
        break;
      }
      case 'pick.file': modalOp(m, g, (signal) => pickFile(m, g, signal)); break;
      case 'pick.session':
        modalOp(m, g, async (signal) => {
          const s = await pickSession({ signal });
          replyIf(g, m.id, s && s.sessionId ? { sessionId: String(s.sessionId), title: String(s.title || '') } : null);
        });
        break;
      case 'chat.sub': chatSub(m, g); break;
      case 'chat.unsub': chatUnsub(m); break;
    }
  }

  // 上下文变了（切会话 / 换工作目录）才推；页面还没 hello 时不推（init 里会带上）
  // file：「用某个应用打开文件」时带过来的那个文件（appContexts[appKey].file）。只挑这五项、按类型规整再交给页面——
  // 句柄是服务端签给本插件的，名字 / 大小 / 类型只是展示用；context 里别的东西（以后谁往里多塞了什么）不跟着漏给页面
  const fileOf = (f) => {
    if (!f || typeof f !== 'object' || typeof f.handle !== 'string' || !f.handle) return null;
    const size = Number(f.size);
    return {
      handle: f.handle,
      name: typeof f.name === 'string' ? f.name : '',
      size: Number.isFinite(size) && size >= 0 ? size : null,
      mime: typeof f.mime === 'string' ? f.mime : '',
      mode: f.mode === 'r' ? 'r' : 'rw',
    };
  };
  const ctxNow = () => (context ? { sessionId: context.sessionId || null, cwd: context.cwd || null, agent: context.agent === 'dimensio' ? 'dimensio' : 'claude', file: fileOf(context.file) } : null);
  let sentCtx = '';
  $effect(() => {
    const c = ctxNow();
    const k = JSON.stringify(c);
    if (!c || !sentCtx || k === sentCtx) return;
    sentCtx = k;
    post({ type: 'context', context: c });
  });

  onMount(() => {
    window.addEventListener('message', onMessage);
    const offBus = busOn((ev) => {
      if (ev?.type === 'plugin.event' && ev.plugin === id) post({ type: 'event', event: ev.event, payload: ev.payload });
      else if (ev?.type === 'plugins.status' && ev.id === id) post({ type: 'event', event: '_status', payload: ev.panelStatus });
    });
    const mo = new MutationObserver(() => post({ type: 'theme', theme: currentTheme(), vars: themeVars() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      // 卸载：订阅全收掉，还挂着的选择器 / 授权框按取消收掉（就算晚回来了也不再替页面做事）
      alive = false;
      gen += 1;
      gate.close();
      dropSubs();
      dropModal();
      window.removeEventListener('message', onMessage); offBus(); mo.disconnect(); clearTimeout(revealT);
    };
  });
</script>

<div class="pf" class:panel={mode === 'panel'} style:height={mode === 'embed' ? Math.max(minHeight, height) + 'px' : null}>
  {#if failed}
    <p class="pf-err">{t('插件页面没加载出来')}</p>
  {/if}
  <!-- 不给 allow-same-origin：页面是不透明源 -->
  <iframe
    bind:this={frame}
    {src}
    title={id}
    class:wait={!!app && !hello}
    onload={onFrameLoad}
    sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
  ></iframe>
</div>

<style>
  .pf { position: relative; width: 100%; }
  .pf.panel { height: 100%; min-height: 360px; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
  iframe.wait { opacity: 0; }
  iframe:not(.wait) { transition: opacity var(--mo-quick, .2s) var(--ea-fade, ease); }
  .pf-err { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); font-size: 13px; }
</style>
