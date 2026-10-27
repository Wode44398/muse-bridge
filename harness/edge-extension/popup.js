const $ = (id) => document.getElementById(id);

const LINES = {
  paused: ["已暂停", "打开右上角开关，dimensio 才能连上这个浏览器。"],
  offline: ["未连接", ""],
  ready: ["已连接 dimensio", "它需要用你的浏览器时，会在「dimensio」标签组里工作。"],
  acting: ["dimensio 正在操作", "页面四边的朱色光表示它正在动手。"],
};

let editingEndpoint = false;

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "popup:get" });
  if (!s) return;
  $("enabled").checked = s.enabled;
  $("status").dataset.s = s.status;
  const [line, hint] = LINES[s.status];
  $("statusLine").textContent = line;
  $("statusHint").textContent = s.status === "offline" ? s.lastError || "正在找本机的 dimensio…" : hint;
  $("stop").hidden = s.status !== "acting";

  const t = s.tab;
  $("tabBox").hidden = !t || !s.enabled;
  if (t) {
    $("tabTitle").textContent = t.title ? `当前标签：${t.title}` : "当前标签";
    $("share").hidden = t.inGroup;
    $("unshare").hidden = !t.inGroup;
    $("share").disabled = t.restricted;
    $("tabNote").textContent = t.restricted
      ? "浏览器自己的页面（设置、扩展商店等）不能交给 dimensio。"
      : t.inGroup
        ? "这个标签在「dimensio」组里，dimensio 可以操作它。"
        : "";
  }
  if (!editingEndpoint) $("endpoint").value = s.endpoint;
  $("sub").textContent = `for ${String(s.browser).split(" ")[0]}`;
  $("meta").textContent = `${s.browser} · 扩展 ${s.version} · 组里 ${s.groupTabs} 个标签`;
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "popup:enabled", value: e.target.checked });
  refresh();
});
$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "dx:stop" });
  refresh();
});
$("share").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup:share" });
  refresh();
});
$("unshare").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup:unshare" });
  refresh();
});
$("endpoint").addEventListener("focus", () => (editingEndpoint = true));
$("endpointForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await chrome.runtime.sendMessage({ type: "popup:endpoint", value: $("endpoint").value });
  $("endpointNote").textContent = r?.ok ? "已保存，正在重连…" : r?.error || "保存失败";
  editingEndpoint = false;
  refresh();
});

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "dx:popup-changed") refresh();
});

refresh();
chrome.runtime.sendMessage({ type: "popup:reconnect" });
