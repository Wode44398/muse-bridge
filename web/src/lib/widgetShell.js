// 对话内嵌交互图表的渲染壳（components/claude/WidgetFrame.svelte 用）。
//
// 模型按 read_me 指南（src/mcp/visualize-guide.mjs）写代码，用的是官方 visualize 同名的宿主接口：
// CSS 变量（--surface-*、--text-*、--border-*、--font-*、--radius、--pad-*、--gap-*、短别名 --p/--s/--t/--bg2/--b）、
// SVG 色带类 c-{ramp}、文本类 t/ts/th、box/node/arr/leader、预置箭头 #arrow、全局 sendPrompt / openLink。
// 这里提供同一套名字（bridge 自写，不搬官方 widget 壳）：
//   · widgetCss(scope)    —— 变量默认值 + 元素基样式 + 色带类；iframe 用 :root/body，手机静态渲染用 shadow 根里的 .wroot
//   · buildSrcdoc(…)      —— sandbox="allow-scripts" iframe 的整页：CSP（官方同款 CDN 白名单）+ 壳脚本
//                            （流式时剥脚本做增量渲染、定稿才执行脚本、高度上报、sendPrompt/openLink/下载转给父页）
//   · themeVars(mode)     —— bridge 当前主题（app.css 的 --bg/--card/--text…）折算成图表变量的具体值（iframe 读不到父页变量）
//   · bridgeVarRefs()     —— 同一张映射表的 var() 引用版（shadow 根能继承父页变量，主题切换零代码跟随）
//   · sanitizeStatic(code)—— 手机静态预览：DOMPurify 独立实例剥脚本 / 事件属性 / 链接 / 外部资源
import createDOMPurify from 'dompurify';

// 色带（9 条 × 7 档：50 / 100 / 200 / 400 / 600 / 800 / 900）——与 src/mcp/visualize-guide.mjs RAMPS 同一张表，改一处记得改另一处。
export const RAMPS = {
  purple: ['#F0EEFB', '#D6D1F5', '#B6AEEB', '#8A7FD8', '#5E52B5', '#3F3687', '#29235A'],
  teal: ['#E3F4EE', '#A9DFCB', '#6CC6A6', '#2A9D78', '#157055', '#0B4F3D', '#06342A'],
  coral: ['#FBEDE7', '#F4C8B6', '#EC9F80', '#D86B45', '#A64A27', '#763318', '#4C200F'],
  pink: ['#FBECF1', '#F2C3D3', '#E897B4', '#D25E87', '#9E3B5D', '#712A43', '#49192B'],
  gray: ['#F2F1EC', '#D8D6CE', '#BAB8AF', '#8C8A83', '#63615C', '#464542', '#2D2C2A'],
  blue: ['#E8F1FB', '#BAD5F2', '#89B7E8', '#4189D6', '#1F62A6', '#12467A', '#0A2E51'],
  green: ['#ECF4E2', '#C5DEA2', '#9BC56A', '#69992F', '#426D18', '#2D4F0E', '#1B3407'],
  amber: ['#FBF0DC', '#F6CC85', '#EBA53A', '#BC7A1C', '#8A540F', '#653C08', '#432804'],
  red: ['#FCEDEC', '#F5C5C3', '#EC9995', '#DC5550', '#A93432', '#7C2322', '#521716'],
};

export const CDN = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://esm.sh'];
const FONT_CDN = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const TABLER = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.42.0/dist/tabler-icons.min.css';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';

// CSP（meta，srcdoc 文档第一个元素）：脚本 / 样式 / 字体 / 图片 / 连接只放官方同款白名单；
// 帧、表单提交、<base> 一律关。不透明源本身已经碰不到 bridge 的 cookie / 存储 / 同源 /api。
export const WIDGET_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDN.join(' ')}`,
  `style-src 'unsafe-inline' ${CDN.join(' ')} ${FONT_CDN[0]}`,
  `font-src data: ${CDN.join(' ')} ${FONT_CDN[1]}`,
  `img-src data: blob: ${CDN.join(' ')}`,
  `media-src data: blob:`,
  `connect-src data: blob: ${CDN.join(' ')}`,
  'worker-src blob:',
  "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
].join('; ');

// bridge 主题变量 → 图表变量（[图表变量, bridge 变量, 暗色兜底, 亮色兜底]）
const MAP = [
  ['--surface-0', '--bg', '#1f1f1e', '#f8f8f6'],
  ['--surface-1', '--card', '#2c2c2a', '#ffffff'],
  ['--text-primary', '--text', '#f8f8f6', '#121212'],
  ['--text-secondary', '--serif', '#c3c2b7', '#373734'],
  ['--text-muted', '--muted', '#97958c', '#7b7974'],
  ['--border', '--divider', 'rgba(255,255,255,.08)', 'rgba(0,0,0,.10)'],
  ['--font-sans', '--sans', 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', ''],
  ['--font-voice', '--serif-stack', 'Georgia, "Times New Roman", Times, serif', ''],
];

/** 父页当前明暗（bridge：html[data-theme=light] 亮，缺省暗）。 */
export function currentMode() {
  try { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
/** iframe 用：按父页计算样式取具体值。el = 卡片自己（局部覆盖过主题变量的容器里取到的才对），缺省取根元素。 */
export function themeVars(mode = currentMode(), el = null) {
  const out = {};
  let cs = null;
  try { cs = getComputedStyle(el || document.documentElement); } catch {}
  for (const [k, src, dk, lt] of MAP) {
    const v = cs ? cs.getPropertyValue(src).trim() : '';
    out[k] = v || (mode === 'light' ? lt || dk : dk);
  }
  return out;
}
/** shadow 根用：var() 引用，跟着父页主题自动变。 */
export function bridgeVarRefs() {
  const out = {};
  for (const [k, src, dk] of MAP) out[k] = `var(${src}, ${dk})`;
  return out;
}
export const styleText = (vars) => Object.entries(vars || {}).filter(([k]) => /^--[a-z0-9-]+$/.test(k)).map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, '')}`).join(';');

// 角色色（accent = Claude 陶土色，其余取 bridge --crit/--ok/--warn 同色系），明暗各一套，写死在 CSS 里。
const ROLES = {
  dark: {
    '--surface-2': '#353532', '--border-strong': 'rgba(255,255,255,.16)', '--border-stronger': 'rgba(255,255,255,.26)',
    '--text-accent': '#e4906f', '--bg-accent': 'rgba(217,119,87,.16)', '--border-accent': 'rgba(217,119,87,.55)',
    '--text-danger': '#e5867a', '--bg-danger': 'rgba(217,106,90,.15)', '--border-danger': 'rgba(217,106,90,.5)',
    '--text-success': '#7cc08a', '--bg-success': 'rgba(90,164,104,.15)', '--border-success': 'rgba(90,164,104,.5)',
    '--text-warning': '#e3b65c', '--bg-warning': 'rgba(217,164,65,.15)', '--border-warning': 'rgba(217,164,65,.5)',
  },
  light: {
    '--surface-2': '#ffffff', '--border-strong': 'rgba(0,0,0,.18)', '--border-stronger': 'rgba(0,0,0,.30)',
    '--text-accent': '#b4532f', '--bg-accent': 'rgba(217,119,87,.12)', '--border-accent': 'rgba(193,95,60,.5)',
    '--text-danger': '#b23b2e', '--bg-danger': 'rgba(201,64,48,.09)', '--border-danger': 'rgba(178,59,46,.45)',
    '--text-success': '#2f7a3e', '--bg-success': 'rgba(47,122,62,.10)', '--border-success': 'rgba(47,122,62,.45)',
    '--text-warning': '#8f5f0c', '--bg-warning': 'rgba(186,122,28,.12)', '--border-warning': 'rgba(143,95,12,.45)',
  },
};
const decl = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
const fallback = (mode) => Object.fromEntries(MAP.map(([k, , dk, lt]) => [k, mode === 'light' ? lt || dk : dk]));

/**
 * 壳样式。scope：{ root, dark, body }——
 *   iframe：{ root: ':root', dark: ':root[data-mode="dark"]', body: 'body' }
 *   shadow：{ root: '.wroot', dark: '.wroot[data-mode="dark"]', body: '.wroot' }
 */
export function widgetCss({ root, dark, body }) {
  const light = `${root}[data-mode="light"]`;
  const SHAPES = ['rect', 'circle', 'ellipse', 'polygon'];
  const ramp = Object.entries(RAMPS).map(([k, s]) => {
    const c = `.c-${k}`;
    const shapes = [...SHAPES.map((x) => `${c}>${x}`), ...SHAPES.map((x) => `${x}${c}`)];
    const dk = (sel) => sel.split(',').map((x) => `${dark} ${x}`).join(',');
    return `${shapes.join(',')}{fill:${s[0]};stroke:${s[4]};stroke-width:.5}`
      + `${c}>.t,${c}>.th{fill:${s[5]}}${c}>.ts{fill:${s[4]}}`
      + `${dk(shapes.join(','))}{fill:${s[5]};stroke:${s[2]}}`
      + `${dk(`${c}>.t,${c}>.th`)}{fill:${s[1]}}${dk(`${c}>.ts`)}{fill:${s[2]}}`;
  }).join('\n');
  return `
${root}{${decl(fallback('dark'))};${decl(ROLES.dark)};--radius:8px;--pad-sm:8px;--pad-md:12px;--pad-lg:16px;--pad-xl:24px;--gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;--font-mono:${MONO};--p:var(--text-primary);--s:var(--text-secondary);--t:var(--text-muted);--bg2:var(--surface-1);--b:var(--border);color-scheme:dark}
${light}{${decl(fallback('light'))};${decl(ROLES.light)};color-scheme:light}
${body}{margin:0;padding:0;background:transparent;color:var(--text-primary);font-family:var(--font-sans);font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased;overflow-wrap:break-word;display:flow-root}
${body} *,${body} *::before,${body} *::after{box-sizing:border-box}
${body} h1,${body} h2,${body} h3{font-weight:500;color:var(--text-primary);line-height:1.35;margin:0 0 .5em}
${body} h1{font-size:22px}${body} h2{font-size:18px}${body} h3{font-size:16px}
${body} p{margin:0 0 .75em}
${body} a{color:var(--text-accent);text-decoration:underline;text-underline-offset:2px}
${body} code,${body} pre{font-family:var(--font-mono);font-size:.88em}
${body} code{background:var(--surface-1);border:.5px solid var(--border);border-radius:4px;padding:0 4px}
${body} .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
${body} button,${body} input,${body} select,${body} textarea{font:inherit;font-size:14px;color:var(--text-primary)}
${body} button{background:var(--surface-1);border:.5px solid var(--border-strong);border-radius:var(--radius);padding:6px 12px;line-height:1.4;cursor:pointer}
${body} button:hover{background:var(--surface-2);border-color:var(--border-stronger)}
${body} button.primary{background:var(--text-primary);color:var(--surface-0);border-color:transparent}
${body} button:disabled{opacity:.5;cursor:default}
${body} input:not([type]),${body} input[type=text],${body} input[type=number],${body} input[type=search],${body} input[type=email],${body} input[type=date],${body} select,${body} textarea{background:var(--surface-2);border:.5px solid var(--border-strong);border-radius:var(--radius);padding:6px 10px;outline:none;max-width:100%}
${body} button:focus-visible,${body} input:focus-visible,${body} select:focus-visible,${body} textarea:focus-visible{outline:2px solid var(--border-accent);outline-offset:1px}
${body} input[type=range]{width:100%;accent-color:var(--text-accent)}
${body} input[type=checkbox],${body} input[type=radio]{accent-color:var(--text-accent)}
${body} table{border-collapse:collapse;font-size:14px}
${body} th,${body} td{border-bottom:.5px solid var(--border);padding:6px 8px;text-align:left}
${body} th{font-weight:500;color:var(--text-secondary)}
${body} svg{max-width:100%;overflow:visible}
${body} svg text{font-family:var(--font-sans)}
${body} .t{font-size:14px;fill:var(--text-primary)}
${body} .ts{font-size:12px;fill:var(--text-secondary)}
${body} .th{font-size:14px;font-weight:500;fill:var(--text-primary)}
${body} .box{fill:var(--surface-1);stroke:var(--border-strong);stroke-width:.5}
${body} .node{cursor:pointer}${body} .node:hover{opacity:.82}
${body} .arr{stroke:var(--text-muted);stroke-width:1.5;fill:none}
${body} .leader{stroke:var(--text-muted);stroke-width:.5;stroke-dasharray:3 3;fill:none}
${body} .wf-arrow path{stroke:var(--text-muted);stroke:context-stroke}
${body} .streaming>*,${body} .streaming svg>*:not(defs){animation:wf-in .35s ease-out both}
@keyframes wf-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){${body} .streaming>*,${body} .streaming svg>*{animation:none}}
${ramp}
`;
}

// 预置箭头（官方指南让模型 marker-end="url(#arrow)"；箭头吃线条自己的颜色 context-stroke，不支持的回落 muted）
export const ARROW_DEFS = '<svg class="wf-arrow" aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs></svg>';

// —— 纯函数（父页静态渲染用；同时原样嵌进 iframe 壳脚本：函数自包含，toString 后照样能跑）——
/** 剥掉 <script>（含没写完的尾巴）与 <meta>/<base>：流式阶段不跑脚本（官方同款），定稿再执行。 */
export function stripScripts(code) {
  return String(code || '').replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, '').replace(/<(meta|base)\b[^>]*>?/gi, '');
}
/** 有没有看得见的东西（只有 <style>/<defs>/<title>/读屏标题时不渲染，免得闪一个空框）。 */
export function visibleMarkup(code) {
  const s = String(code || '')
    .replace(/<(style|defs|title|desc|script)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<(\w+)\b[^>]*\bclass=["'][^"']*\bsr-only\b[^"']*["'][^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, '');
  if (/<(?!\/|svg\b|g\b)[a-z]/i.test(s)) return true;
  return /\S/.test(s.replace(/<[^>]*>?/g, ''));
}
/** SVG 模式：代码以 <svg 开头（官方同判据）。 */
export const isSvgCode = (code) => /^\s*<svg\b/i.test(String(code || ''));

// 壳脚本：流式增量渲染（template 解析 + 就地对比更新，不整块重建、新元素淡入）、定稿后按序执行脚本（带 src 的等它
// 加载完再跑下一个）、ResizeObserver 上报高度、sendPrompt / openLink / <a download> 转给父页、表单 submit 补发
//（sandbox 不给 allow-forms：原生提交连 submit 事件都不派，这里合成一个，提交本身仍被 CSP form-action 拦下）。
// 存储垫片与服务端 html-site.mjs STORAGE_SHIM 同一段（不透明源里 localStorage 一读就抛）。
// 高度按 body 的小数高度向上取整：SVG 按栏宽缩放常出小数，只用 scrollHeight（取整）会少半像素、iframe 冒滚动条。
// 纵向滚动条只在内容超过父页上限（M = maxH，父页把 iframe 夹在这个高度）时才开，平时 overflow-y:hidden——经典滚动条
// 一出来就吃掉 15px 宽，SVG 跟着变矮、滚动条又消失，高度来回振荡停不下来（实测）。横向滚动条的高度另外算进去。
// 父页发 ping（iframe load 后还没等到 ready）时再报一次 ready。
// 截图（父页卡下「复制为图片 / 下载为 PNG」发 snap）：把 #vis 克隆进 foreignObject（壳样式换成 .wsnap 作用域、
// canvas 换成当下的位图、表单写回当前值、去掉脚本），走 data: URL 画到 canvas 出 PNG——blob: URL 在不透明源里
// 会把 canvas 污染（无头 Edge 实测 SecurityError），data: 不会。外部图片 / 图标字体进不了 SVG 图像，截出来缺就缺。
const SHELL_HEAD = String.raw`(function(){function m(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){for(var k in d)delete d[k]},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}});try{document.cookie}catch(e){var c="";try{Object.defineProperty(document,"cookie",{get:function(){return c},set:function(){},configurable:true})}catch(_){}}})();`;
const SHELL_BODY = String.raw`
var P=window.parent,vis=document.getElementById("vis"),fin=null,lastSrc="",H=-1;
function post(m){m.bw="w1";m.n=N;try{P.postMessage(m,"*")}catch(e){}}
function same(a,b){return a.nodeType===b.nodeType&&a.nodeName===b.nodeName}
function patch(a,b){if(a.nodeType!==1){if(a.nodeValue!==b.nodeValue)a.nodeValue=b.nodeValue;return}var i,at;for(i=a.attributes.length-1;i>=0;i--){at=a.attributes[i];if(!b.hasAttributeNS(at.namespaceURI,at.localName))a.removeAttributeNS(at.namespaceURI,at.localName)}for(i=0;i<b.attributes.length;i++){at=b.attributes[i];if(a.getAttributeNS(at.namespaceURI,at.localName)!==at.value)a.setAttributeNS(at.namespaceURI,at.name,at.value)}kids(a,b)}
function kids(from,to){var a=from.firstChild,b=to.firstChild,nb,na;while(b){nb=b.nextSibling;if(!a){from.appendChild(b)}else if(same(a,b)){patch(a,b);a=a.nextSibling}else{na=a.nextSibling;from.replaceChild(b,a);a=na}b=nb}while(a){na=a.nextSibling;from.removeChild(a);a=na}}
function parse(s){var t=document.createElement("template");t.innerHTML=s;return t.content}
function size(){var r=document.documentElement,b=document.body,h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height))+Math.max(0,innerHeight-r.clientHeight);r.style.overflowY=h>M?"auto":"hidden";if(h!==H){H=h;post({type:"size",h:h})}}
function partial(code){if(fin!==null)return;var s=strip(code);if(s===lastSrc)return;lastSrc=s;if(!visible(s))return;kids(vis,parse(s));size()}
function run(list,i){if(i>=list.length){size();post({type:"done"});return}var o=list[i],s=document.createElement("script"),k,src=o.getAttribute("src");for(k=0;k<o.attributes.length;k++)s.setAttribute(o.attributes[k].name,o.attributes[k].value);var next=function(){run(list,i+1)};if(src){s.onload=next;s.onerror=function(){post({type:"error",msg:"script failed to load: "+src});next()}}else s.textContent=o.textContent;if(!o.parentNode){next();return}o.parentNode.replaceChild(s,o);if(!src)next()}
function finish(code){code=String(code||"");if(fin===code)return;if(fin!==null)vis.textContent="";fin=code;vis.classList.remove("streaming");kids(vis,parse(code.replace(/<(meta|base)\b[^>]*>?/gi,"")));run([].slice.call(vis.querySelectorAll("script")),0)}
function theme(mode,vars){var r=document.documentElement;r.setAttribute("data-mode",mode==="light"?"light":"dark");if(vars)for(var k in vars)if(/^--[a-z0-9-]+$/.test(k))r.style.setProperty(k,String(vars[k]))}
window.sendPrompt=function(t){t=String(t==null?"":t).trim().slice(0,4000);if(!t)return;post({type:"prompt",text:t,act:!!(navigator.userActivation&&navigator.userActivation.isActive)})};
window.openLink=function(u){u=String(u||"");if(/^https?:\/\//i.test(u))post({type:"link",url:u})};
window.open=function(u){if(u)window.openLink(String(u));return null};
function dl(href,name){fetch(href).then(function(r){return r.blob()}).then(function(b){if(b.size>2e7)return;var fr=new FileReader();fr.onload=function(){post({type:"download",name:String(name||"download").slice(0,120),url:String(fr.result)})};fr.readAsDataURL(b)}).catch(function(){})}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var href=a.getAttribute("href")||"";if(href.charAt(0)==="#")return;e.preventDefault();if(a.hasAttribute("download")&&/^(blob|data):/i.test(a.href)){dl(a.href,a.getAttribute("download"));return}window.openLink(a.href)},true);
document.addEventListener("click",function(e){if(e.defaultPrevented)return;var b=e.target&&e.target.closest?e.target.closest("button,input[type=submit],input[type=image]"):null;if(!b||!b.form)return;if(b.tagName==="BUTTON"&&(b.getAttribute("type")||"submit").toLowerCase()!=="submit")return;e.preventDefault();var ev=new Event("submit",{bubbles:true,cancelable:true});try{Object.defineProperty(ev,"submitter",{value:b})}catch(_){}b.form.dispatchEvent(ev)});
document.addEventListener("keydown",function(e){if(e.defaultPrevented||e.key!=="Enter")return;var t=e.target;if(!t||t.tagName!=="INPUT"||!t.form)return;if(/^(checkbox|radio|button|range|color|file|submit)$/i.test(t.type||""))return;e.preventDefault();t.form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))});
window.addEventListener("error",function(e){post({type:"error",msg:String(e&&e.message||"error").slice(0,300)})});
function freeze(a,b){var x=a.querySelectorAll("canvas,input,textarea,select"),y=b.querySelectorAll("canvas,input,textarea,select"),i,k,s,t,im,q;for(i=0;i<x.length&&i<y.length;i++){s=x[i];t=y[i];if(s.tagName==="CANVAS"){try{q=s.getBoundingClientRect();im=document.createElement("img");im.setAttribute("src",s.toDataURL("image/png"));im.setAttribute("style",(s.getAttribute("style")||"")+";width:"+q.width+"px;height:"+q.height+"px");t.parentNode.replaceChild(im,t)}catch(e){}}else if(s.tagName==="TEXTAREA")t.textContent=s.value;else if(s.tagName==="SELECT"){for(k=0;k<s.options.length&&k<t.options.length;k++){if(s.options[k].selected)t.options[k].setAttribute("selected","");else t.options[k].removeAttribute("selected")}}else if(s.type==="checkbox"||s.type==="radio"){if(s.checked)t.setAttribute("checked","");else t.removeAttribute("checked")}else if(s.type!=="file")t.setAttribute("value",s.value)}}
function snap(q){var done=function(u,e){post({type:"snap",req:q,url:u||"",err:e||""})};try{var r=document.documentElement,b=vis.getBoundingClientRect(),w=Math.ceil(b.width),h=Math.ceil(Math.max(vis.scrollHeight,b.height));if(!w||!h)return done("","empty");var c=vis.cloneNode(true);freeze(vis,c);[].slice.call(c.querySelectorAll("script")).forEach(function(n){n.parentNode.removeChild(n)});c.classList.remove("streaming");var wrap=document.createElement("div"),st=document.createElement("style"),hs=document.head.querySelector("style"),ar=document.querySelector(".wf-arrow");wrap.setAttribute("class","wsnap");wrap.setAttribute("data-mode",r.getAttribute("data-mode")||"dark");wrap.setAttribute("style",(r.getAttribute("style")||"")+";width:"+w+"px");st.textContent=hs?hs.textContent.replace(/:root/g,".wsnap").replace(/\bbody\b/g,".wsnap"):"";wrap.appendChild(st);if(ar)wrap.appendChild(ar.cloneNode(true));wrap.appendChild(c);var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject x="0" y="0" width="100%" height="100%">'+new XMLSerializer().serializeToString(wrap)+"</foreignObject></svg>",img=new Image();img.onload=function(){try{var k=Math.min(2,8192/w,8192/h,Math.sqrt(16e6/(w*h))),cv=document.createElement("canvas"),g;cv.width=Math.max(1,Math.round(w*k));cv.height=Math.max(1,Math.round(h*k));g=cv.getContext("2d");g.fillStyle=getComputedStyle(r).getPropertyValue("--surface-0").trim()||"#fff";g.fillRect(0,0,cv.width,cv.height);g.scale(k,k);g.drawImage(img,0,0,w,h);done(cv.toDataURL("image/png"))}catch(e){done("",String(e&&e.name||e))}};img.onerror=function(){done("","image")};img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)}catch(e){done("",String(e&&e.message||e))}}
window.addEventListener("message",function(e){if(e.source!==P)return;var d=e.data;if(!d||d.bw!=="w1")return;if(d.type==="code"){if(d.final)finish(d.code);else partial(d.code)}else if(d.type==="theme")theme(d.mode,d.vars);else if(d.type==="ping")post({type:"ready"});else if(d.type==="snap")snap(d.req)});
try{new ResizeObserver(size).observe(document.body)}catch(e){setInterval(size,500)}
post({type:"ready"});
`;

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** iframe 整页（srcdoc）。nonce：本卡的随机标识，壳发出的每条消息都带上，父页据此只认自己这一帧；maxH：父页给 iframe 的高度上限。 */
export function buildSrcdoc({ nonce, mode = 'dark', vars = null, maxH = 1800 }) {
  const n = String(nonce || '').replace(/[^A-Za-z0-9]/g, '');
  const m = Math.max(100, Math.floor(Number(maxH) || 1800));
  const script = `${SHELL_HEAD}\n(function(){"use strict";var N="${n}",M=${m};var strip=${stripScripts};var visible=${visibleMarkup};${SHELL_BODY}})();`;
  return '<!doctype html><html data-mode="' + (mode === 'light' ? 'light' : 'dark') + '" style="' + escAttr(styleText(vars)) + '"><head>'
    + '<meta http-equiv="Content-Security-Policy" content="' + escAttr(WIDGET_CSP) + '">'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="' + TABLER + '">'
    + '<style>' + widgetCss({ root: ':root', dark: ':root[data-mode="dark"]', body: 'body' }) + '</style>'
    + '</head><body>' + ARROW_DEFS + '<div id="vis" class="streaming"></div>'
    + '<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
}

/** 下载用的独立文件：SVG 补 xmlns + 内联亮色样式与箭头；HTML 包成完整页（脚本保留，sendPrompt 是空操作）。 */
/** 下载文件名（不含扩展名）：标题里只留字母数字下划线连字符。 */
export const fileStem = (title) => String(title || 'visual').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'visual';
export function standaloneFile(code, title) {
  const css = widgetCss({ root: ':root', dark: ':root[data-mode="dark"]', body: 'body' });
  const name = fileStem(title);
  if (isSvgCode(code)) {
    let svg = stripScripts(code).trim();
    if (!/^<svg\b[^>]*\bxmlns=/i.test(svg)) svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const defs = '<style>' + css.replace(/:root\[data-mode="light"\]/g, 'svg').replace(/:root/g, 'svg').replace(/\bbody\b/g, 'svg') + '</style>'
      + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#8C8A83" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';
    svg = svg.replace(/^(<svg\b[^>]*>)/i, (m) => m.replace(/>$/, ' data-mode="light">') + defs);
    return { name: name + '.svg', mime: 'image/svg+xml', text: svg };
  }
  const html = '<!doctype html><html data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escAttr(name) + '</title>'
    + '<link rel="stylesheet" href="' + TABLER + '"><style>' + css + 'body{max-width:720px;margin:24px auto;padding:0 16px}</style>'
    + '<script>window.sendPrompt=function(){};window.openLink=function(u){window.open(u,"_blank","noopener")};</script>'
    + '</head><body>' + ARROW_DEFS + '<div id="vis">' + code + '</div></body></html>';
  return { name: name + '.html', mime: 'text/html', text: html };
}

// —— 手机静态预览的清洗（DOMPurify 独立实例：钩子不串到 md.js 用的全局实例）——
// 去掉：脚本、事件属性、javascript: 链接（DOMPurify 本职）；另外 <a> 的 href/target（点了会把 WebView 整页导走）、
// 表单 / 帧 / 音视频 / <link>/<meta>/<base>、非 data: 的外部图片（src / poster / background、SVG 属性里的 url()）与
// CSS 里的取图写法（url() / image-set() / @import，含反斜杠转义的写法）——主文档没有 CSP，别让图表往外发请求。
// 样式隔离的硬边界在 WidgetFrame 模板里 shadow 宿主外面那层（contain + overflow 裁剪，shadow 里的样式够不着）；
// 这里再把能改到宿主的 :host / ::part / ::slotted 选择器作废、position:fixed 改成 absolute，作第二道防线。
let purifier = null;
export const cleanCss = (s) => String(s || '')
  .replace(/[^;{}]*\\[^;{}]*;?/g, '')   // 带反斜杠转义的声明（u\72l( 之类）整条去掉：下面的字面匹配认不出转义写法
  .replace(/@import[^;]*;?/gi, '')
  .replace(/url\(\s*(['"]?)(?!data:|#)[^)]*\)/gi, 'none')
  .replace(/(?:-webkit-)?image-set\([^)]*\)?|cross-fade\([^)]*\)?|\bimage\([^)]*\)?|\bsrc\([^)]*\)?/gi, 'none')   // 不写 url( 也能取图的函数（裸字符串）
  .replace(/:host-context\b|:host\b|::part\b|::slotted\b/gi, ':not(*)')
  .replace(/position\s*:\s*fixed/gi, 'position:absolute');
// SVG 里按 CSS 解析、能带 url() 的展示属性：外部引用或带转义的值一律去掉
const URL_ATTRS = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
function getPurifier() {
  if (purifier) return purifier;
  purifier = createDOMPurify(window);
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!node.getAttribute) return;
    if ((node.nodeName || '').toLowerCase() === 'a') { node.removeAttribute('href'); node.removeAttribute('xlink:href'); node.removeAttribute('target'); }
    for (const at of ['href', 'xlink:href']) { const v = node.getAttribute(at); if (v && !/^#/.test(v) && !/^data:image\//i.test(v)) node.removeAttribute(at); }
    const src = node.getAttribute('src'); if (src && !/^data:image\//i.test(src)) node.removeAttribute('src');
    for (const at of [...node.attributes]) {
      if (URL_ATTRS.has(at.name.toLowerCase()) && (at.value.includes('\\') || /url\s*\(\s*['"]?(?!#)/i.test(at.value))) node.removeAttribute(at.name);
    }
    const st = node.getAttribute('style'); if (st) node.setAttribute('style', cleanCss(st));
  });
  return purifier;
}
export function sanitizeStatic(code) {
  return getPurifier().sanitize(stripScripts(code), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['form', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'script', 'noscript', 'video', 'audio', 'source', 'track'],
    FORBID_ATTR: ['action', 'formaction', 'target', 'srcset', 'ping', 'poster', 'background', 'lowsrc', 'dynsrc'],
    FORCE_BODY: true,
  });
}
