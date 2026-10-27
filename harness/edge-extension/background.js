// dimensio for Edge —— 后台 service worker（MV3）
//
// 拨回环 ws://127.0.0.1:<端口>/edge-link 连本机的 dimensio（harness），把它发来的 CDP 命令经 chrome.debugger
// 转给「dimensio」标签组里的标签页，事件原样回传。dimensio 那边把这条链路当成一个普通的 Chromium 调试端点用
// （见 harness/server/edge-link.ts 与 cdp.ts 的 Edge 模式）。
//
// 授权边界 = 标签组：只有组里的标签能被附着；用户把标签拖出组 / 关掉 = 收回。
// 状态显示三处：标签组的标题与颜色（连接 / 操作中）、页面上的氛围灯 + 指针 + 停止按钮（overlay.js）、工具栏弹窗。

const DEFAULT_ENDPOINT = "ws://127.0.0.1:8799/edge-link";
const GROUP_NAME = "dimensio";
const VERSION = chrome.runtime.getManifest().version;

const st = {
  ws: null,
  linked: false, // 收到 dimensio 的 hello 才算
  enabled: true,
  endpoint: DEFAULT_ENDPOINT,
  lastError: "",
  acting: false,
  groupId: -1,
  browserOpen: false,
  discover: false,
  attached: new Set(), // 调试器挂着的标签
  known: new Set(), // 组里的标签
  retry: 0,
  retryTimer: 0,
  holdUntil: 0, // 暂缓重连到这个时刻
  yielded: false, // 被同种浏览器的另一个配置顶掉了：不再自动重连，等用户点「重新连接」
  ready: null,
};

// ── 启动 / 设置 ───────────────────────────────────────────────────────────────

st.ready = (async () => {
  const local = await chrome.storage.local.get({ enabled: true, endpoint: DEFAULT_ENDPOINT });
  st.enabled = local.enabled !== false;
  st.endpoint = String(local.endpoint || DEFAULT_ENDPOINT);
  const sess = await chrome.storage.session.get({ groupId: -1 });
  st.groupId = await validGroup(Number(sess.groupId));
  await refreshKnown();
  chrome.alarms.create("dx-keepalive", { periodInMinutes: 0.5 });
  paint();
  connect();
})();

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dx-keepalive") void st.ready.then(connect);
});

async function validGroup(id) {
  if (!(id >= 0)) return -1;
  try {
    await chrome.tabGroups.get(id);
    return id;
  } catch {
    return -1;
  }
}

async function setGroup(id) {
  st.groupId = id;
  await chrome.storage.session.set({ groupId: id });
}

async function refreshKnown() {
  st.known.clear();
  if (st.groupId < 0) return;
  const tabs = await chrome.tabs.query({ groupId: st.groupId });
  for (const t of tabs) st.known.add(t.id);
}

// 自己装在哪种浏览器里：Edge 和 Chrome 可以同时装着本扩展，dimensio 按种类各留一条链路、agent 用 browser 参数挑
function browserKind() {
  const brands = navigator.userAgentData?.brands || [];
  if (brands.some((b) => /Edge/i.test(b.brand)) || /Edg\//.test(navigator.userAgent)) return "edge";
  if (brands.some((b) => /Google Chrome/i.test(b.brand))) return "chrome";
  return "chromium";
}

function uaSummary() {
  const brands = navigator.userAgentData?.brands || [];
  const kind = browserKind();
  const name = { edge: "Edge", chrome: "Chrome", chromium: "Chromium" }[kind];
  const b = brands.find((x) => (kind === "edge" ? /Edge/i : kind === "chrome" ? /Google Chrome/i : /Chromium/i).test(x.brand));
  if (b) return `${name} ${b.version}`;
  const m = navigator.userAgent.match(kind === "edge" ? /Edg\/(\d+)/ : /Chrome\/(\d+)/);
  return m ? `${name} ${m[1]}` : name;
}

// ── 与 dimensio 的连接 ────────────────────────────────────────────────────────

function endpointUrl() {
  const sep = st.endpoint.includes("?") ? "&" : "?";
  return `${st.endpoint}${sep}browser=${browserKind()}`;
}

function connect() {
  if (!st.enabled) return;
  if (st.ws && (st.ws.readyState === WebSocket.CONNECTING || st.ws.readyState === WebSocket.OPEN)) return;
  if (Date.now() < st.holdUntil || st.yielded) return;
  clearTimeout(st.retryTimer);
  let sock;
  try {
    sock = new WebSocket(endpointUrl());
  } catch (e) {
    st.lastError = `连接地址无效：${e.message}`;
    notifyPopup();
    return;
  }
  st.ws = sock;
  sock.onopen = () => {
    if (st.ws !== sock) return;
    send({ t: "hello", version: VERSION, browser: uaSummary() });
  };
  sock.onmessage = (ev) => {
    if (st.ws !== sock) return;
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    void onMessage(m);
  };
  sock.onclose = () => {
    if (st.ws !== sock) return;
    st.ws = null;
    const was = st.linked;
    st.linked = false;
    st.acting = false;
    st.browserOpen = false;
    st.discover = false;
    if (Date.now() >= st.holdUntil && !st.yielded) st.lastError = was ? "与 dimensio 的连接断开了，正在重连" : "连不上 dimensio——它没在运行，或地址不对";
    void detachAll("dimensio 断开");
    paint();
    scheduleReconnect();
  };
  sock.onerror = () => {};
}

function scheduleReconnect() {
  if (!st.enabled) return;
  clearTimeout(st.retryTimer);
  const wait = Math.max(Math.min(15000, 1000 * 2 ** st.retry), st.holdUntil - Date.now());
  st.retry = Math.min(st.retry + 1, 4);
  st.retryTimer = setTimeout(connect, wait);
}

function send(obj) {
  if (st.ws?.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(obj));
}

function disconnect() {
  clearTimeout(st.retryTimer);
  const s = st.ws;
  st.ws = null;
  st.linked = false;
  st.acting = false;
  try {
    s?.close();
  } catch {}
  void detachAll("已暂停");
}

async function onMessage(m) {
  switch (m.t) {
    case "hello": {
      // 从磁盘加载的解压扩展：dimensio 那边的扩展文件更新了就自己重载一次（同一版本只试一次，防来回重载）
      if (m.expectVersion && m.expectVersion !== VERSION) {
        const { reloadedFor } = await chrome.storage.local.get({ reloadedFor: "" });
        if (reloadedFor !== m.expectVersion) {
          await chrome.storage.local.set({ reloadedFor: m.expectVersion });
          chrome.runtime.reload();
          return;
        }
      }
      st.linked = true;
      st.lastError = "";
      st.retry = 0;
      paint();
      break;
    }
    case "ping":
      send({ t: "pong" });
      break;
    case "replaced":
      // 同一种浏览器的另一个配置（另一个 Edge 用户配置）连进来顶掉了我们。以前 60 秒后自动重连、再把对方顶掉——
      // 两边来回抢、正在用的标签被摘掉调试器。现在让位就一直让着，用户在弹窗里点「重新连接」才抢回来。
      st.lastError = `同一${uaSummary().split(" ")[0]}的另一个用户配置接管了 dimensio——要换回这里，点「重新连接」`;
      st.yielded = true;
      break;
    case "activity":
      st.acting = Boolean(m.on);
      paint();
      break;
    case "open":
      await openChannel(String(m.ch));
      break;
    case "close":
      await closeChannel(String(m.ch));
      break;
    case "cdp":
      if (m.ch === "browser") await browserCommand(m.id, m.method, m.params || {});
      else await pageCommand(Number(m.ch), m.id, m.method, m.params || {});
      break;
    case "rpc":
      await rpc(m.rid, m.op, m.args || {});
      break;
  }
}

async function rpc(rid, op, args) {
  try {
    let result;
    if (op === "list") result = { tabs: await listTabs() };
    else throw new Error(`unknown op ${op}`);
    send({ t: "rpcres", rid, result });
  } catch (e) {
    send({ t: "rpcres", rid, error: e.message || String(e) });
  }
}

async function listTabs() {
  st.groupId = await validGroup(st.groupId);
  await refreshKnown();
  if (st.groupId < 0) return [];
  const tabs = await chrome.tabs.query({ groupId: st.groupId });
  return tabs.map(tabInfo);
}

function tabInfo(t) {
  return { id: String(t.id), url: t.url || t.pendingUrl || "", title: t.title || "", active: Boolean(t.active) };
}

function targetInfo(t) {
  return { targetId: String(t.id), type: "page", url: t.url || t.pendingUrl || "", title: t.title || "", attached: st.attached.has(t.id) };
}

// ── 频道 ─────────────────────────────────────────────────────────────────────

async function openChannel(ch) {
  if (ch === "browser") {
    st.browserOpen = true;
    send({ t: "opened", ch });
    return;
  }
  const tabId = Number(ch);
  try {
    if (!st.known.has(tabId)) await refreshKnown();
    if (!st.known.has(tabId)) throw new Error("这个标签不在 dimensio 标签组里");
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      // service worker 重启过：调试器其实还挂在我们手里——摘了重挂
      if (!/already attached/i.test(e.message || "")) throw e;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, "1.3");
    }
    st.attached.add(tabId);
    send({ t: "opened", ch });
    await ensureOverlay(tabId);
    pushOverlay(tabId);
    paint();
  } catch (e) {
    send({ t: "closed", ch, reason: e.message || String(e) });
  }
}

async function closeChannel(ch) {
  if (ch === "browser") {
    st.browserOpen = false;
    st.discover = false;
    return;
  }
  const tabId = Number(ch);
  if (!st.attached.has(tabId)) return;
  st.attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  pushOverlay(tabId);
}

async function detachAll(reason) {
  for (const tabId of [...st.attached]) {
    st.attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    pushOverlay(tabId);
    send({ t: "closed", ch: String(tabId), reason });
  }
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!st.attached.has(src.tabId)) return;
  send({ t: "evt", ch: String(src.tabId), method, params });
});

chrome.debugger.onDetach.addListener((src, reason) => {
  if (!st.attached.has(src.tabId)) return;
  st.attached.delete(src.tabId);
  pushOverlay(src.tabId);
  send({ t: "closed", ch: String(src.tabId), reason });
  // 用户在「正在调试此浏览器」提示条上点了取消 = 叫停
  if (reason === "canceled_by_user") requestStop("canceled_by_user");
});

// ── Target 域（dimensio 用它管理标签：发现 / 新建 / 关闭 / 切换）──────────────

async function browserCommand(id, method, params) {
  try {
    let result = {};
    switch (method) {
      case "Target.setDiscoverTargets": {
        st.discover = Boolean(params.discover);
        if (st.discover) for (const t of await listTabsRaw()) emitTarget("Target.targetCreated", t);
        break;
      }
      case "Target.createTarget": {
        const tab = await createGroupTab(String(params.url || "about:blank"));
        result = { targetId: String(tab.id) };
        break;
      }
      case "Target.closeTarget": {
        const tabId = Number(params.targetId);
        if (!st.known.has(tabId)) throw new Error("not a dimensio tab");
        await chrome.tabs.remove(tabId);
        result = { success: true };
        break;
      }
      case "Target.activateTarget": {
        const tabId = Number(params.targetId);
        if (!st.known.has(tabId)) throw new Error("not a dimensio tab");
        await chrome.tabs.update(tabId, { active: true });
        break;
      }
      default:
        throw new Error(`${method} is not available through the dimensio Edge extension`);
    }
    send({ t: "res", ch: "browser", id, result });
  } catch (e) {
    send({ t: "res", ch: "browser", id, error: e.message || String(e) });
  }
}

async function listTabsRaw() {
  st.groupId = await validGroup(st.groupId);
  if (st.groupId < 0) return [];
  return chrome.tabs.query({ groupId: st.groupId });
}

function emitTarget(method, tab) {
  if (!st.browserOpen || !st.discover) return;
  if (method === "Target.targetDestroyed") send({ t: "evt", ch: "browser", method, params: { targetId: String(tab) } });
  else send({ t: "evt", ch: "browser", method, params: { targetInfo: targetInfo(tab) } });
}

// 新标签开在组所在的窗口（没有组就开在最近用的窗口并建组）。about:blank 起步：edge://newtab 附着不了。
async function createGroupTab(url) {
  st.groupId = await validGroup(st.groupId);
  let windowId;
  if (st.groupId >= 0) windowId = (await chrome.tabGroups.get(st.groupId)).windowId;
  else windowId = (await lastNormalWindow()).id;
  const tab = await chrome.tabs.create({ windowId, url, active: true });
  await addToGroup(tab.id, windowId);
  return tab;
}

async function lastNormalWindow() {
  try {
    return await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    return chrome.windows.create({ url: "about:blank", focused: false });
  }
}

async function addToGroup(tabId, windowId) {
  st.groupId = await validGroup(st.groupId);
  if (st.groupId >= 0) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: st.groupId });
  } else {
    const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: windowId ? { windowId } : undefined });
    await setGroup(gid);
  }
  st.known.add(tabId);
  paint();
}

// ── 标签页的 CDP：转发，外加两处「让人看得见」的加工 ─────────────────────────────

async function pageCommand(tabId, id, method, params) {
  const ch = String(tabId);
  if (!st.attached.has(tabId)) {
    send({ t: "res", ch, id, error: "tab is not attached" });
    return;
  }
  try {
    let result;
    if (method === "Input.dispatchMouseEvent") await pointerFx(tabId, params);
    if (method === "Page.captureScreenshot") {
      // agent 截图里不要有我们自己的氛围灯和指针
      await overlayCall(tabId, { type: "dx:hide" });
      try {
        result = await chrome.debugger.sendCommand({ tabId }, method, params);
      } finally {
        void overlayCall(tabId, { type: "dx:show" });
      }
    } else {
      result = await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    send({ t: "res", ch, id, result: result || {} });
  } catch (e) {
    send({ t: "res", ch, id, error: e.message || String(e) });
  }
}

// 指针先走过去再点：mouseMoved 等页面上的指针动画落到位；按下时出一圈涟漪。
async function pointerFx(tabId, p) {
  if (p.type === "mouseMoved") await overlayCall(tabId, { type: "dx:move", x: p.x, y: p.y });
  else if (p.type === "mousePressed") void overlayCall(tabId, { type: "dx:press", x: p.x, y: p.y });
}

// ── 页面覆盖层（overlay.js）─────────────────────────────────────────────────────

async function ensureOverlay(tabId) {
  const ok = await overlayCall(tabId, { type: "dx:ping" });
  if (ok?.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"], injectImmediately: true }).catch(() => {});
}

function overlayCall(tabId, msg) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(null);
    }, 900);
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => {
        void chrome.runtime.lastError;
        if (done) return;
        clearTimeout(timer);
        resolve(r ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function overlayState(tabId) {
  const attached = st.attached.has(tabId);
  return { type: "dx:state", attached, acting: attached && st.acting && st.linked };
}

function pushOverlay(tabId) {
  void overlayCall(tabId, overlayState(tabId));
}

// 组里的标签导航了：新文档里重新放上覆盖层（只注入组里的标签，别的页面一概不碰）
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !st.attached.has(d.tabId)) return;
  void ensureOverlay(d.tabId).then(() => pushOverlay(d.tabId));
});

// ── 标签组的进出 ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if ("groupId" in info) {
    const inGroup = st.groupId >= 0 && tab.groupId === st.groupId;
    if (inGroup && !st.known.has(tabId)) {
      st.known.add(tabId);
      emitTarget("Target.targetCreated", tab);
    } else if (!inGroup && st.known.has(tabId)) {
      // 拖出组 = 收回授权
      st.known.delete(tabId);
      if (st.attached.has(tabId)) {
        st.attached.delete(tabId);
        void chrome.debugger.detach({ tabId }).catch(() => {});
        pushOverlay(tabId);
        send({ t: "closed", ch: String(tabId), reason: "tab left the dimensio group" });
      }
      emitTarget("Target.targetDestroyed", tabId);
    }
    return;
  }
  if (st.known.has(tabId) && ("title" in info || "url" in info)) emitTarget("Target.targetInfoChanged", tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!st.known.has(tabId)) return;
  st.known.delete(tabId);
  st.attached.delete(tabId);
  emitTarget("Target.targetDestroyed", tabId);
});

chrome.tabGroups.onRemoved.addListener((g) => {
  if (g.id === st.groupId) void setGroup(-1);
});

// ── 状态显示：标签组标题 / 颜色、工具栏徽标、弹窗 ─────────────────────────────

function statusWord() {
  if (!st.enabled) return "paused";
  if (!st.linked) return "offline";
  return st.acting ? "acting" : "ready";
}

function paint() {
  const word = statusWord();
  if (st.groupId >= 0) {
    const look = {
      paused: { title: `${GROUP_NAME} · 已暂停`, color: "grey" },
      offline: { title: `${GROUP_NAME} · 未连接`, color: "grey" },
      ready: { title: GROUP_NAME, color: "grey" },
      acting: { title: `${GROUP_NAME} · 操作中`, color: "red" },
    }[word];
    chrome.tabGroups.update(st.groupId, look).catch(() => {});
  }
  const badge = { paused: ["", "#8a857c"], offline: ["", "#8a857c"], ready: ["", "#171614"], acting: ["●", "#C8412B"] }[word];
  chrome.action.setBadgeText({ text: badge[0] }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: badge[1] }).catch(() => {});
  chrome.action.setTitle({ title: { paused: "dimensio · 已暂停", offline: "dimensio · 未连接", ready: "dimensio · 已连接", acting: "dimensio · 正在操作" }[word] }).catch(() => {});
  for (const tabId of st.known) pushOverlay(tabId);
  notifyPopup();
}

function popupState(activeTab) {
  const t = activeTab;
  const restricted = !t || /^(edge|chrome|about:(?!blank)|chrome-extension|extension|view-source):/i.test(t.url || "") || /microsoftedge\.microsoft\.com\/addons|chromewebstore\.google\.com/i.test(t.url || "");
  return {
    status: statusWord(),
    enabled: st.enabled,
    endpoint: st.endpoint,
    lastError: st.lastError,
    browser: uaSummary(),
    version: VERSION,
    groupTabs: st.known.size,
    attachedTabs: st.attached.size,
    tab: t ? { id: t.id, title: t.title || "", inGroup: st.known.has(t.id), restricted } : null,
  };
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: "dx:popup-changed" }).catch(() => {});
}

function requestStop(reason) {
  send({ t: "stop", reason });
  // 不等 dimensio：先把手从页面上拿开
  void detachAll("用户叫停");
  st.acting = false;
  paint();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await st.ready;
    switch (msg?.type) {
      case "dx:hello": // overlay 注入后来要状态
        reply(sender.tab ? overlayState(sender.tab.id) : null);
        return;
      case "dx:stop":
        requestStop(sender.tab ? "page-button" : "popup");
        reply({ ok: true });
        return;
      case "popup:get": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        reply(popupState(t));
        return;
      }
      case "popup:share": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (t && !st.known.has(t.id)) await addToGroup(t.id, t.windowId);
        reply({ ok: true });
        return;
      }
      case "popup:unshare": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (t && st.known.has(t.id)) await chrome.tabs.ungroup(t.id);
        reply({ ok: true });
        return;
      }
      case "popup:enabled": {
        st.enabled = Boolean(msg.value);
        await chrome.storage.local.set({ enabled: st.enabled });
        if (st.enabled) {
          st.holdUntil = 0;
          st.yielded = false;
          st.retry = 0;
          connect();
        } else {
          disconnect();
        }
        paint();
        reply({ ok: true });
        return;
      }
      case "popup:endpoint": {
        const v = String(msg.value || "").trim() || DEFAULT_ENDPOINT;
        if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/edge-link$/.test(v)) {
          reply({ ok: false, error: "只能连本机：ws://127.0.0.1:<端口>/edge-link" });
          return;
        }
        st.endpoint = v;
        await chrome.storage.local.set({ endpoint: v });
        disconnect();
        st.holdUntil = 0;
        st.yielded = false;
        st.retry = 0;
        st.lastError = "";
        connect();
        paint();
        reply({ ok: true });
        return;
      }
      case "popup:reconnect":
        st.holdUntil = 0;
        st.yielded = false;
        st.retry = 0;
        connect();
        reply({ ok: true });
        return;
    }
    reply(null);
  })();
  return true;
});
