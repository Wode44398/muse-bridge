// 拉 Lucide 图标（ISC），把 <path>/<circle>/<rect>/<line>/<polyline>/<polygon>/<ellipse> 统一转成一条 path 数据。
import fs from "node:fs";

const MAP = {
  history: "rotate-ccw", plus: "plus", gear: "settings-2", panel: "panel-left", panelR: "panel-right",
  send: "arrow-up", attach: "paperclip", chevronD: "chevron-down", chevronR: "chevron-right", chevronL: "chevron-left", chevronU: "chevron-up",
  close: "x", reload: "rotate-cw", external: "arrow-up-right", trash: "trash", undo: "undo-2", redo: "redo-2", check: "check", copy: "copy",
  folder: "folder", folderOpen: "folder-open", folderPlus: "folder-plus", folderSearch: "folder-search", file: "file", fileText: "file-text", filePlus: "file-plus", fileDiff: "file-diff",
  upload: "upload", download: "download", eye: "eye", eyeOff: "eye-off", terminal: "square-terminal", branch: "git-branch", compare: "git-compare",
  search: "search", textSearch: "text-search", globe: "globe", monitor: "monitor", tabletDev: "tablet", phoneDev: "smartphone", laptop: "laptop",
  edit: "pencil", read: "book-open-text", todo: "list-checks", agent: "bot", tasks: "list-tree", audio: "audio-lines", camera: "camera",
  brain: "brain", memory: "notebook-text", shield: "shield", shieldCheck: "shield-check", question: "circle-question-mark", arrowL: "arrow-left", arrowR: "arrow-right",
  arrowD: "arrow-down", arrowU: "arrow-up", user: "user", spark: "sparkle", sparkles: "sparkles", image: "image", layout: "columns-2", more: "ellipsis",
  pin: "pin", pinOff: "pin-off", flask: "flask-conical", bolt: "zap", target: "target", plug: "plug", home: "house", sun: "sun", moon: "moon",
  key: "key-round", lock: "lock", unlock: "lock-open", cpu: "cpu", gauge: "gauge", layers: "layers", timer: "timer", pause: "pause", play: "play",
  info: "info", alert: "triangle-alert", xCircle: "circle-x", checkCircle: "circle-check", clock: "clock-3", command: "command", slash: "slash",
  hand: "hand", message: "message-square", listIcon: "list", filter: "list-filter", sort: "arrow-down-up", minimize: "minimize-2", maximize: "maximize-2",
  cloud: "cloud", wifiOff: "wifi-off", workflow: "workflow", network: "network", appWindow: "app-window", mousePointer: "mouse-pointer-2",
  code: "code", braces: "braces", hash: "hash", at: "at-sign", circleDot: "circle-dot", circle: "circle", square: "square", scissors: "scissors",
  archive: "archive", inbox: "inbox", logOut: "log-out", link: "link", rotateCcw: "rotate-ccw", fastForward: "fast-forward", sliders: "sliders-horizontal",
  goal: "flag", compass: "compass", package: "package", wand: "wand-sparkles", eraser: "eraser", split: "split", merge: "merge",
  cornerDownLeft: "corner-down-left", copyCheck: "copy-check",
};

const f = (n) => +(+n).toFixed(3);
function circle(cx, cy, r) {
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
}
function ellipse(cx, cy, rx, ry) {
  return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;
}
function rect(x, y, w, h, rx = 0, ry = rx) {
  x = +x; y = +y; w = +w; h = +h; rx = Math.min(+rx || 0, w / 2); ry = Math.min(+ry || rx, h / 2);
  if (!rx) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
  return `M${f(x + rx)} ${f(y)}h${f(w - 2 * rx)}a${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} ${f(ry)}v${f(h - 2 * ry)}a${f(rx)} ${f(ry)} 0 0 1 ${f(-rx)} ${f(ry)}h${f(-(w - 2 * rx))}a${f(rx)} ${f(ry)} 0 0 1 ${f(-rx)} ${f(-ry)}v${f(-(h - 2 * ry))}a${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} ${f(-ry)}Z`;
}
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function toPath(svg) {
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
  const out = [];
  for (const m of body.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)\/?>/g)) {
    const a = attrs(m[2]);
    switch (m[1]) {
      case "path": {
        // 拼接时首个相对 moveto 会被当成相对上一段——只把第一对坐标改成绝对 M，其后的隐式坐标对保持相对（补 l）
        const t = a.d.trim().match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g);
        if (t[0] === "m") {
          const rest = t.slice(3);
          out.push(`M${t[1]} ${t[2]}` + (rest.length && !/[a-zA-Z]/.test(rest[0]) ? "l" : "") + rest.join(" ").replace(/ ([a-zA-Z]) /g, "$1").replace(/^([a-zA-Z]) /, "$1"));
        } else out.push(a.d.trim());
        break;
      }
      case "circle": out.push(circle(a.cx, a.cy, a.r)); break;
      case "ellipse": out.push(ellipse(a.cx, a.cy, a.rx, a.ry)); break;
      case "rect": out.push(rect(a.x ?? 0, a.y ?? 0, a.width, a.height, a.rx ?? a.ry ?? 0, a.ry ?? a.rx ?? 0)); break;
      case "line": out.push(`M${a.x1} ${a.y1}L${a.x2} ${a.y2}`); break;
      case "polyline": { const n = a.points.trim().split(/[\s,]+/).map(Number); const pts = []; for (let i = 0; i + 1 < n.length; i += 2) pts.push(`${n[i]} ${n[i + 1]}`); out.push("M" + pts.join("L")); break; }
      case "polygon": { const n = a.points.trim().split(/[\s,]+/).map(Number); const pts = []; for (let i = 0; i + 1 < n.length; i += 2) pts.push(`${n[i]} ${n[i + 1]}`); out.push("M" + pts.join("L") + "Z"); break; }
    }
  }
  return out.join("");
}

const res = {};
for (const [key, name] of Object.entries(MAP)) {
  const r = await fetch(`https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${name}.svg`);
  if (!r.ok) { console.error("MISS", key, name, r.status); continue; }
  res[key] = toPath(await r.text());
}
fs.writeFileSync(new URL("lucide-paths.json", import.meta.url), JSON.stringify(res, null, 1));
console.log("ok", Object.keys(res).length);
