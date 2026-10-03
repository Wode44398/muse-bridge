// HtmlView 渲染前的预处理：让 agent 写的网页在「无 allow-same-origin 的沙箱 srcdoc」里照常跑起来。
//
// 沙箱 srcdoc 是不透明源，两类常见页面会「显示出来但一动不动」：
//   ① 脚本一碰 localStorage / sessionStorage / document.cookie 就抛 SecurityError，整段脚本死在第一行；
//   ② 同目录的 app.js / style.css / 图片按相对路径引用——srcdoc 的基址是 bridge 页面本身，全都 404。
// 对策：① 头部注入垫片，存储不可用时换成内存版（页内 #锚点 链接顺带改成就地滚动，否则会把
//      bridge 页面导航进 iframe）；② 相对路径资源经原文件接口（同一条 URL 换 path）取回内联：
//      脚本/样式内联成文本，图片/字体/媒体转 data: URL。沙箱隔离不放松。
// 接口都靠 ?path= 定位（/api/file、/api/claude/artifact、dimensio artifact），没有 path 的条目
// （本地 SAF 文件）只注入垫片。取不到的资源原样保留，不影响其余部分。

const SHIM = `(function(){
function mem(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{document.cookie}catch(e){var jar={};try{Object.defineProperty(document,'cookie',{configurable:true,get:function(){return Object.keys(jar).map(function(k){return k+'='+jar[k]}).join('; ')},set:function(v){var p=String(v).split(';')[0],i=p.indexOf('=');if(i>0)jar[p.slice(0,i).trim()]=p.slice(i+1).trim()}})}catch(_){}}
document.addEventListener('click',function(e){if(e.defaultPrevented||e.button)return;var a=e.target&&e.target.closest&&e.target.closest('a[href^="#"]');if(!a||(a.target&&a.target!=='_self'))return;e.preventDefault();var id=a.getAttribute('href').slice(1);try{id=decodeURIComponent(id)}catch(_){}if(!id||id==='top'){window.scrollTo(0,0);return}var el=document.getElementById(id)||document.getElementsByName(id)[0];if(el)el.scrollIntoView()});
})();`;

const ASSET_MAX = 8 * 1024 * 1024;     // 单个资源上限（data: URL 会撑大 srcdoc，大视频不内联）
const TOTAL_MAX = 32 * 1024 * 1024;    // 整页内联总量上限

// 服务端为了安全把 svg/js/css 等按 text/plain 下发；转 data: URL 时按扩展名补回真实类型
const MIME = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4',
  webm: 'video/webm', json: 'application/json', css: 'text/css', js: 'text/javascript',
};

// 外链 / 协议 / 根路径 / 纯锚点都不是「同目录资源」
const isRelative = (ref) => !!ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref.trim());

// base 文件接口 URL（带 ?path=）+ 相对引用 → 兄弟文件的接口 URL；不适用返回 null
export function siblingUrl(baseUrl, ref) {
  if (!baseUrl || !isRelative(ref)) return null;
  let u;
  try { u = new URL(baseUrl, location.href); } catch { return null; }
  const p = u.searchParams.get('path');
  if (!p) return null;
  const clean = ref.trim().split(/[?#]/)[0];
  if (!clean) return null;
  const enc = p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  let resolved;
  try {
    const r = new URL(clean, 'http://h/' + enc);
    resolved = r.pathname.split('/').map((s) => decodeURIComponent(s)).join('/').slice(1);
  } catch { return null; }
  const out = new URL(u);
  out.searchParams.set('path', resolved);
  for (const k of ['dl', 'name', 'thumb', 'mt']) out.searchParams.delete(k);
  return out.toString();
}

const extOf = (url) => {
  try { return (new URL(url).searchParams.get('path') || '').split('.').pop().toLowerCase(); } catch { return ''; }
};

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function makeFetcher() {
  const cache = new Map();
  let total = 0;
  async function blob(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob();
    if (b.size > ASSET_MAX || total + b.size > TOTAL_MAX) throw new Error('too large');
    total += b.size;
    return b;
  }
  const once = (kind, url, fn) => {
    const key = kind + ' ' + url;
    if (!cache.has(key)) cache.set(key, fn().catch(() => null));
    return cache.get(key);
  };
  return {
    text: (url) => once('t', url, async () => (await blob(url)).text()),
    dataUrl: (url) => once('d', url, async () => {
      let b = await blob(url);
      const type = MIME[extOf(url)];
      if (type && (!b.type || /^(text\/plain|application\/octet-stream)/.test(b.type))) b = new Blob([b], { type });
      return blobToDataUrl(b);
    }),
  };
}

// CSS 里的 url(...)：相对 cssBase 取回转 data: URL
async function inlineCssUrls(css, cssBase, f) {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const refs = new Set();
  for (const m of css.matchAll(re)) if (isRelative(m[2]) && !m[2].startsWith('data:')) refs.add(m[2]);
  if (!refs.size) return css;
  const map = new Map();
  await Promise.all([...refs].map(async (ref) => {
    const u = siblingUrl(cssBase, ref);
    const d = u && await f.dataUrl(u);
    if (d) map.set(ref, d);
  }));
  return css.replace(re, (all, q, ref) => (map.has(ref) ? `url("${map.get(ref)}")` : all));
}

// 主入口：html 源码 + 该文件的接口 URL → 可直接塞进 srcdoc 的 html
export async function prepareHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const f = makeFetcher();
  const canFetch = !!baseUrl && (() => { try { return !!new URL(baseUrl, location.href).searchParams.get('path'); } catch { return false; } })();
  const jobs = [];
  const late = [];   // defer/async 外链脚本，文档序

  if (canFetch) {
    // 脚本：外链改内联。defer/async 的外链脚本原本在解析完才跑，内联后挪到 body 末尾保持时序
    // （type=module 的内联脚本本来就延后执行，原地即可）。
    for (const s of doc.querySelectorAll('script[src]')) {
      const u = siblingUrl(baseUrl, s.getAttribute('src'));
      if (!u) continue;
      const slot = s.type !== 'module' && (s.hasAttribute('defer') || s.hasAttribute('async')) ? late.push({ s, ok: false }) - 1 : -1;
      jobs.push(f.text(u).then((code) => {
        if (code == null) return;
        s.removeAttribute('src'); s.removeAttribute('defer'); s.removeAttribute('async');
        s.removeAttribute('integrity'); s.removeAttribute('crossorigin');
        s.textContent = code.replace(/<\/script/gi, '<\\/script');
        if (slot >= 0) late[slot].ok = true;
      }));
    }
    // 样式表：<link rel=stylesheet> → <style>（保留 media），其中的 url() 相对 css 文件解析
    for (const l of doc.querySelectorAll('link[href]')) {
      const rel = (l.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const u = siblingUrl(baseUrl, l.getAttribute('href'));
      if (!u) continue;
      if (rel.includes('stylesheet')) {
        jobs.push(f.text(u).then(async (css) => {
          if (css == null) return;
          const st = doc.createElement('style');
          if (l.media) st.media = l.media;
          st.textContent = (await inlineCssUrls(css, u, f)).replace(/<\/style/gi, '<\\/style');
          l.replaceWith(st);
        }));
      } else if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
        jobs.push(f.dataUrl(u).then((d) => { if (d) l.setAttribute('href', d); }));
      }
    }
    // <style> 块与 style 属性里的 url()：相对 html 文件
    for (const st of doc.querySelectorAll('style')) {
      jobs.push(inlineCssUrls(st.textContent, baseUrl, f).then((css) => { st.textContent = css; }));
    }
    for (const el of doc.querySelectorAll('[style*="url("]')) {
      jobs.push(inlineCssUrls(el.getAttribute('style'), baseUrl, f).then((css) => el.setAttribute('style', css)));
    }
    // 图片 / 媒体
    for (const [sel, attr] of [['img[src]', 'src'], ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'], ['video[poster]', 'poster'], ['input[type=image][src]', 'src'], ['image[href]', 'href']]) {
      for (const el of doc.querySelectorAll(sel)) {
        const u = siblingUrl(baseUrl, el.getAttribute(attr));
        if (u) jobs.push(f.dataUrl(u).then((d) => { if (d) el.setAttribute(attr, d); }));
      }
    }
    // srcset 里有相对候选就整个去掉，退回已内联的 src（逐个内联多倍图不划算）
    for (const el of doc.querySelectorAll('[srcset]')) {
      if (el.getAttribute('srcset').split(',').some((c) => isRelative(c.trim().split(/\s+/)[0]))) el.removeAttribute('srcset');
    }
    await Promise.all(jobs);
    for (const { s, ok } of late) if (ok) doc.body.appendChild(s);
  }

  const shim = doc.createElement('script');
  shim.textContent = SHIM;
  doc.head.insertBefore(shim, doc.head.firstChild);
  const dt = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : '';
  return dt + doc.documentElement.outerHTML;
}
