// HTML 站点挂载 —— 让预览里的 HTML 像在电脑上双击打开一样，相对路径的 js/css/图片/音视频全能加载。
//
// 病根：HtmlView 以前把文件文本塞进 iframe srcdoc，文档基址是 about:srcdoc，页面里
// <script src="app.js">、assets/xx.png 之类相对引用全部落空——自包含单文件能开，带资源
// 目录的课件/网站黑屏转圈（例如 课件成品/index.html + app.js + assets/）。
// 而 /api/file?path= 这类查询串式 URL 也解析不了相对路径。
//
// 做法：已鉴权的预览接口（/api/file、/api/claude/artifact、/api/codex/artifact）带 site=1
// 时不吐字节，而是把「该 HTML 所在的目录树」登记成一个挂载，回 { url:'/api/hv/<id>/<相对路径>' }。
// /api/hv/<id>/… 是路径式 URL，浏览器自己按目录解析相对引用；id 是 128 位随机能力令牌
// （同分享链接的做法），不带 cookie/token 也能取，所以 iframe 里的不透明源也拿得到。
//
// 安全边界：
//  · 每个响应都带 CSP sandbox（不含 allow-same-origin）：即便有人把这个 URL 直接当顶层页打开，
//    文档也跑在不透明源里，碰不到 bridge 的 cookie / localStorage / 同源接口。
//  · 挂载根默认＝HTML 所在目录；页面里出现 ../ 引用时按最深层数往上放宽，但绝不越过调用方给的
//    授权根（工作空间根 / 交付根）。不把整个工作空间挂出去：页面脚本可以 fetch 挂载内任意文件。
//  · 只读、GET-only、6 小时滑动过期、总数封顶。
import crypto from 'node:crypto';
import path from 'node:path';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { mimeType, safeJoin, streamFile, withinRoot } from './http-file.mjs';

const PREFIX = '/api/hv/';
const TTL = 6 * 3600 * 1000;
const MAX_MOUNTS = 256;
const mounts = new Map();   // id -> { root, exp }
const byRoot = new Map();   // root(折叠大小写) -> id，同一目录反复打开复用同一个 id（浏览器缓存才命中）

// iframe 侧 sandbox 与这里保持一致：脚本/弹窗/表单/全屏/下载可用，唯独没有 allow-same-origin。
export const HTML_SITE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms allow-pointer-lock allow-downloads allow-presentation';

const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
export const isHtmlFile = (file) => /\.html?$/i.test(String(file || ''));

// HTML 里相对引用最深往上爬几层（../../x → 2）。只读头 2MB：再大的单文件页基本是内联资源。
function parentDepth(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(statSync(file).size, 2 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8');
    let max = 0;
    const re = /(?:\b(?:src|href|poster|data)\s*=\s*["']?|url\(\s*["']?|\bimport\s*\(?\s*["'])((?:\.\.\/)+)/gi;
    let m;
    while ((m = re.exec(text))) max = Math.max(max, m[1].length / 3);
    return Math.min(max, 8);
  } catch { return 0; } finally { if (fd != null) try { closeSync(fd); } catch {} }
}

function sweep(now = Date.now()) {
  for (const [id, m] of mounts) if (m.exp <= now) { mounts.delete(id); byRoot.delete(fold(m.root)); }
  while (mounts.size > MAX_MOUNTS) {
    const [id, m] = mounts.entries().next().value;
    mounts.delete(id); byRoot.delete(fold(m.root));
  }
}

// file = 已通过调用方鉴权的 HTML 绝对路径；bounds = 授权根（挂载根不得越过）。
// 返回 '/api/hv/<id>/<相对入口>'（调用方自己拼服务器前缀）。
export function mountHtmlSite(file, bounds = []) {
  const abs = path.resolve(file);
  let root = path.dirname(abs);
  const bound = bounds.filter(Boolean).map((b) => path.resolve(b)).find((b) => withinRoot(b, abs));
  for (let up = parentDepth(abs); up > 0; up--) {
    const parent = path.dirname(root);
    if (parent === root || (bound && !withinRoot(bound, parent))) break;
    root = parent;
  }
  const now = Date.now();
  sweep(now);
  let id = byRoot.get(fold(root));
  if (!id || !mounts.has(id)) {
    id = crypto.randomBytes(16).toString('base64url');
    byRoot.set(fold(root), id);
  } else mounts.delete(id);   // 重新插到队尾（LRU）
  mounts.set(id, { root, exp: now + TTL });
  const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join('/');
  return PREFIX + id + '/' + rel;
}

export function respondHtmlSite(res, file, bounds) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ url: mountHtmlSite(file, bounds) }));
}

// 不透明源里 localStorage / sessionStorage / document.cookie 一读就抛 SecurityError——
// 课件、小游戏、PPT 类页面几乎都拿它存设置/进度，不垫一层就是启动即崩、黑屏。
// 换成内存版（本次打开内有效，刷新即丢）；真能用的环境（将来给了独立源）原样不动。
export const STORAGE_SHIM = '<script>(function(){function m(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){for(var k in d)delete d[k]},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}});try{document.cookie}catch(e){var c="";try{Object.defineProperty(document,"cookie",{get:function(){return c},set:function(){},configurable:true})}catch(_){}}})();</script>';

// 滚动条垫片：预览页是跨源沙箱 iframe，bridge 自己的全站滚动条样式管不到里面——没写滚动条样式的暗色页
// 会露出 Windows 原生的粗白条（带箭头、白轨道）。注入 Edge（Win11 Fluent 浮层）同款：平时隐身，滚动或鼠标移到
// 滚条上才浮出 4px 中灰细线（明暗底都看得清；页面根元素的文字色不可靠，故不用 currentColor），停下 1 秒隐身。
// 插在页面样式之前：页面自己写了 ::-webkit-scrollbar / scrollbar-color 的照它的来。与前端 HtmlView 的 SB_SHIM 同一段。
export const SCROLLBAR_SHIM = "<style>@media (pointer:fine){::-webkit-scrollbar{width:12px;height:12px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-button{display:none}body::-webkit-scrollbar-track,body::-webkit-scrollbar-corner{background:var(--bsb-bg,transparent)}::-webkit-scrollbar-thumb{background-color:transparent;background-clip:padding-box;border:solid transparent;border-width:0 3px 0 5px;border-radius:999px;min-height:40px}::-webkit-scrollbar-thumb:horizontal{border-width:5px 0 3px 0;min-width:40px}[data-bsb]::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.72)}::-webkit-scrollbar-thumb:hover{border-width:0 2px;background-color:rgba(140,140,140,.9)}::-webkit-scrollbar-thumb:horizontal:hover{border-width:2px 0}}</style><script>(function(){if(!window.matchMedia||!matchMedia('(pointer: fine)').matches)return;var D=document,R=D.documentElement,T=new WeakMap(),H=null;function s(e){if(!e.hasAttribute('data-bsb'))e.setAttribute('data-bsb','');clearTimeout(T.get(e))}function l(e){clearTimeout(T.get(e));T.set(e,setTimeout(function(){if(e!==H)e.removeAttribute('data-bsb')},1000))}function o(c){return c&&c!=='transparent'&&!/^rgba\\(.*,\\s*0\\)$/.test(c)}function g(){var c=getComputedStyle(R).backgroundColor;if(!o(c)&&D.body)c=getComputedStyle(D.body).backgroundColor;if(!o(c)&&D.elementsFromPoint){var a=D.elementsFromPoint(R.clientWidth-2,innerHeight/2);for(var i=0;i<a.length&&!o(c);i++)c=getComputedStyle(a[i]).backgroundColor}if(!o(c))c='#fff';if(R.style.getPropertyValue('--bsb-bg')!==c)R.style.setProperty('--bsb-bg',c)}function q(){g();setTimeout(g,450)}D.addEventListener('DOMContentLoaded',function(){q();try{var m=new MutationObserver(q),f={attributes:true,attributeFilter:['class','style','data-theme']};m.observe(R,f);m.observe(D.body,f)}catch(_){}});addEventListener('load',q);D.addEventListener('scroll',function(v){var e=v.target===D?(D.body||R):v.target;if(!(e instanceof Element))return;s(e);if(e!==H)l(e)},{capture:true,passive:true});D.addEventListener('mousemove',function(v){var e=v.target,n=null;if(e instanceof Element){if((e===R||e===D.body)&&((v.clientX>=R.clientWidth&&innerWidth>R.clientWidth+1)||(v.clientY>=R.clientHeight&&innerHeight>R.clientHeight+1)))n=D.body||R;else if(e!==R&&((v.offsetX>=e.clientWidth&&e.offsetWidth>e.clientWidth+1&&e.scrollHeight>e.clientHeight)||(v.offsetY>=e.clientHeight&&e.offsetHeight>e.clientHeight+1&&e.scrollWidth>e.clientWidth)))n=e}if(n===H)return;if(H)l(H);H=n;if(H)s(H)},{passive:true})})();</script>";

// 垫片要在页面任何脚本之前跑，又不能插到 <!doctype> 前面（会掉进怪异模式）：
// 优先 <meta charset> 之后（浏览器只在前 1024 字节里找它，垫片不能把它挤出去）→ <head> 之后
// → <html> 之后 → doctype 之后 → 文件开头。按 latin1 找位置、按字节拼接，不动原编码。
function injectShim(buf) {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 64 * 1024));
  const m = /<meta\b[^>]*charset[^>]*>/i.exec(head.slice(0, 1024)) || /<head\b[^>]*>/i.exec(head) || /<html\b[^>]*>/i.exec(head) || /<!doctype[^>]*>/i.exec(head);
  const at = m ? m.index + m[0].length : (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0);
  return Buffer.concat([buf.subarray(0, at), Buffer.from(STORAGE_SHIM + SCROLLBAR_SHIM), buf.subarray(at)]);
}

function fail(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': 'sandbox' });
  res.end(msg);
}

function serve(req, res, url) {
  const rest = url.pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const m = mounts.get(id);
  if (!m || m.exp <= Date.now()) return fail(res, 404, '预览已过期，请重新打开');
  m.exp = Date.now() + TTL;
  let rel = slash < 0 ? '' : rest.slice(slash + 1);
  try { rel = rel.split('/').map(decodeURIComponent).join('/'); } catch { return fail(res, 400, 'bad path'); }
  let file = safeJoin(m.root, rel);
  if (!file) return fail(res, 403, 'forbidden');
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = statSync(file); }
  } catch { return fail(res, 404, 'not found'); }
  if (!st.isFile()) return fail(res, 404, 'not found');
  // 改完文件刷新就能看到：协商缓存（304）而不是固定 max-age；大 app.js 不必每次重下。
  const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  const headers = {
    'Content-Security-Policy': 'sandbox ' + HTML_SITE_SANDBOX,
    'X-Content-Type-Options': 'nosniff',
    'Last-Modified': lastModified,
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (since && since >= Date.parse(lastModified)) { res.writeHead(304, { ...headers, 'Cache-Control': 'private, no-cache' }); res.end(); return; }
  if (isHtmlFile(file) && st.size <= 64 * 1024 * 1024) {
    let body;
    try { body = readFileSync(file); } catch { return fail(res, 404, 'not found'); }
    // 页面自己声明了编码（老 GBK 课件常见）就别在响应头里钉死 utf-8——头的优先级高于 <meta>。
    const declared = /<meta\b[^>]*charset/i.test(body.toString('latin1', 0, Math.min(body.length, 1024)));
    body = injectShim(body);
    res.writeHead(200, { ...headers, 'Content-Type': declared ? 'text/html' : 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  try {
    streamFile(req, res, file, { stat: st, contentType: mimeType(file), cacheControl: 'private, no-cache', headers });
  } catch { if (!res.headersSent) fail(res, 404, 'not found'); }
}

export function registerHtmlSiteRoutes(router) {
  // 动态段：中间件按前缀接管（同 /s/、/w/）。须挂在 CORS 中间件之后——模块脚本 / fetch /
  // 字体在不透明源下走 CORS，要靠那里的 Access-Control-Allow-Origin:*。
  router.use((req, res, url) => {
    if (!url.pathname.startsWith(PREFIX)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'read only'); return false; }
    serve(req, res, url);
    return false;
  });
}
