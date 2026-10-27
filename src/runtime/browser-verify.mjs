// 浏览器动作的「做完确认」（2026-10-21，照 localPc 10-20 那轮的思路补到浏览器上）。
// 以前 click/type/key 一律回「已点击 / 已输入」——点到视口外、点在空白处、没聚焦输入框就
// 打字，都报成功，agent 只能每步再截一张图才知道有没有做对。现在：
//  - 动作前：坐标越界直接报错；查落点上是什么元素（穿透 shadow DOM），ref 目标被遮罩挡住
//    就拒绝（force:true 可硬点）；type 前确认焦点真在可编辑元素上。
//  - 动作后：等页面安定（CdpSession.settle），比对前后——地址、标题、焦点、被点控件的状态
//    （勾选/展开/选中/值）、DOM 变动、滚动、新请求；什么都没变就明说。type 回读输入框内容。
//  - expect：等到预期满足或超时（默认 3 秒），不符合 → isError，batch 停下。
// Claude 的 SDK MCP 与 Codex / 远程客户端的 runBrowserAction 共用（同在 browser-actions.mjs 里调）。

import { MUT_INIT } from './cdp.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const VERIFY_DESC = `
Coordinates: x,y are pixels of the most recent screenshot image (the tool converts to CSS pixels itself; screenshots are already scaled to ≤1568px on the long edge). A point outside that image is an error, not a silent miss. screenshot(region:[x,y,w,h]) returns a zoomed crop at device resolution for reading small details — it does NOT change the coordinate basis.
Every click/type/key/scroll/hover reports what actually happened: which element sat under the pointer, and after the page settles — URL/title change, focus moves, the clicked control's state (checked/expanded/selected/value), DOM changes, scrolling, new network requests, plus the input's value read back after type. "⚠ 页面没有任何变化" means it most likely missed: look before continuing. A ref whose element is covered by an overlay is refused (pass force:true to click anyway). type without ref/selector fails if nothing editable is focused.
expect:{text?, gone?, url?, selector?, focus?, value?, changed?} on any action waits (expect_timeout_ms, default 3000, max 15000) until all hold, else the action fails. wait_for(expect…) waits for a condition without doing anything; wait_for(ms) just sleeps. verify:false skips the checks (faster, blind).
batch(actions:[{action,…}, …]) runs up to 20 steps in one call (same fields as single actions), stopping at the first failure. screenshot_after:true on any action appends a screenshot taken after the page settled.`;

// —— 页内助手：装一次，挂在 window.__bridgeV。所有探针都走它，避免每次塞一大段脚本 ——
const HELPER = `(()=>{${MUT_INIT};
const V={};
const clip=(s,n)=>{s=String(s||'').replace(/\\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s};
const TAGROLE={A:'link',BUTTON:'button',SELECT:'select',TEXTAREA:'textarea',SUMMARY:'summary',LABEL:'label',IMG:'img',IFRAME:'iframe',VIDEO:'video',CANVAS:'canvas'};
V.desc=(el)=>{if(!el||el.nodeType!==1)return '(无)';const t=el.tagName;
 let role=el.getAttribute('role')||(t==='INPUT'?'input['+(el.type||'text')+']':TAGROLE[t])||t.toLowerCase();
 let name=el.getAttribute('aria-label')||(el.labels&&el.labels[0]&&el.labels[0].innerText)||el.getAttribute('placeholder')||el.getAttribute('alt')||el.getAttribute('title')||'';
 if(!name&&t!=='INPUT'&&t!=='TEXTAREA'&&t!=='BODY'&&t!=='HTML'){name=el.innerText||''}
 if(!name&&(t==='INPUT'||t==='BUTTON')&&el.type!=='password')name=el.value||'';
 const cls=typeof el.className==='string'?el.className.trim().split(/\\s+/).find((c)=>c&&!/^svelte-|^css-|^_|^[a-z]{1,3}-[A-Za-z0-9]{5,}$/.test(c)):'';
 const idc=el.id?'#'+el.id:(cls?'.'+cls:'');
 name=clip(name,40);return role+(name?'「'+name+'」':'')+(idc?' '+idc:'')};
V.deep=(x,y)=>{let h=document.elementFromPoint(x,y);for(let i=0;h&&h.shadowRoot&&i<20;i++){const n=h.shadowRoot.elementFromPoint(x,y);if(!n||n===h)break;h=n}return h};
const CLICKY='a[href],button,input,select,textarea,summary,label,option,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
V.clicky=(el)=>{if(!el||el.nodeType!==1)return false;if(el.closest(CLICKY))return true;try{return getComputedStyle(el).cursor==='pointer'}catch{return false}};
V.ctl=(el)=>{if(!el||el.nodeType!==1)return null;const a=(k)=>el.getAttribute(k);const s={};
 if('checked' in el&&(el.type==='checkbox'||el.type==='radio'))s.checked=!!el.checked;
 for(const k of ['aria-checked','aria-expanded','aria-selected','aria-pressed']){const v=a(k);if(v!=null)s[k]=v}
 if(el.tagName==='DETAILS'||el.closest('details'))s.open=!!(el.tagName==='DETAILS'?el:el.closest('details')).open;
 if(el.tagName==='SELECT')s.value=clip(el.options[el.selectedIndex]&&el.options[el.selectedIndex].text,40);
 s.disabled=!!el.disabled||a('aria-disabled')==='true';return s};
V.at=(x,y)=>{const inside=x>=0&&y>=0&&x<innerWidth&&y<innerHeight;const h=inside?V.deep(x,y):null;
 V.hit=h;V.hitBefore=h?V.ctl(V.ctlOf(h)):null;
 return {inside,vw:innerWidth,vh:innerHeight,hit:h?V.desc(V.ctlOf(h)):null,raw:h?V.desc(h):null,clicky:V.clicky(h),iframe:!!h&&h.tagName==='IFRAME',before:V.hitBefore}};
V.ctlOf=(el)=>{if(!el||el.nodeType!==1)return el;return el.closest(CLICKY)||el};
V.focusEl=()=>{let f=document.activeElement;for(let i=0;f&&f.shadowRoot&&f.shadowRoot.activeElement&&i<20;i++)f=f.shadowRoot.activeElement;return f};
V.editable=(el)=>!!el&&(el.isContentEditable||(el.tagName==='TEXTAREA'&&!el.readOnly&&!el.disabled)||(el.tagName==='INPUT'&&!el.readOnly&&!el.disabled&&!/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(el.type)));
V.focus=()=>{const f=V.focusEl();if(!f||f===document.body||f===document.documentElement)return {desc:'(页面本身)',editable:false};
 const pw=f.tagName==='INPUT'&&f.type==='password';const val=V.editable(f)?(f.isContentEditable?f.innerText:f.value):undefined;
 return {desc:V.desc(f),editable:V.editable(f),password:pw,value:val==null?undefined:(pw?'•'.repeat(String(val).length):clip(val,300))}};
V.state=()=>{const m=window.__bridgeMut;const h=V.hit;let hit=null;
 if(h){const c=V.ctlOf(h);hit=c&&c.isConnected?{gone:false,s:V.ctl(c)}:{gone:true}}
 const f=V.focusEl();let sel='';try{sel=f&&typeof f.selectionStart==='number'?f.selectionStart+'-'+f.selectionEnd:String(getSelection()).length+''}catch{}
 const st=m.t&&m.t.nodeType===1&&m.t!==document.documentElement&&m.t!==document.body?V.desc(m.t):'';
 return {url:location.href,title:document.title,focus:V.focus(),mut:m.n,scr:m.s,scrEl:st,sel,sx:Math.round(scrollX),sy:Math.round(scrollY),hit}};
const seen=(el)=>{if(!el)return false;try{return el.checkVisibility?el.checkVisibility({visibilityProperty:true}):el.getClientRects().length>0}catch{return el.getClientRects().length>0}};
V.check=(e)=>{const miss=[];const body=(document.body&&document.body.innerText)||'';
 if(e.text!=null&&!body.includes(e.text))miss.push('页面上还没有出现「'+e.text+'」');
 if(e.gone!=null&&body.includes(e.gone))miss.push('页面上仍有「'+e.gone+'」');
 if(e.url!=null&&!location.href.includes(e.url))miss.push('地址不含「'+e.url+'」（现在 '+location.href+'）');
 if(e.selector!=null){let el=null;try{el=document.querySelector(e.selector)}catch(err){miss.push('selector 写错了：'+e.selector)}
  if(el===null&&!miss.length)miss.push('找不到 '+e.selector);else if(el&&!seen(el))miss.push(e.selector+' 存在但不可见')}
 if(e.focus!=null||e.value!=null){const f=V.focus();
  if(e.focus!=null&&!f.desc.toLowerCase().includes(String(e.focus).toLowerCase()))miss.push('焦点在 '+f.desc+'，不含「'+e.focus+'」');
  if(e.value!=null&&!(f.value||'').includes(e.value))miss.push('焦点输入框内容是「'+(f.value||'')+'」，不含「'+e.value+'」')}
 return miss};
return V})()`;

// 在页面里调助手：expr 是对 V 的一段调用，如 'V.at(10,20)'。
async function V(b, expr, timeoutMs = 4000) {
  const r = await b.send('Runtime.evaluate', {
    expression: `(()=>{if(!window.__bridgeV)window.__bridgeV=${HELPER};const V=window.__bridgeV;return ${expr}})()`,
    returnByValue: true,
  }, timeoutMs);
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'probe error');
  return r?.result?.value;
}

// 页面正在换文档时探针会报「上下文已销毁」——这类失败当作「看不到」而不是动作失败。
async function softV(b, expr) {
  try { return await V(b, expr, 2500); } catch { return null; }
}

/** 落点探测（CSS 像素）。越界抛错。返回 { hit, clicky, iframe }。 */
export async function probePoint(b, x, y) {
  const r = await V(b, `V.at(${Number(x)},${Number(y)})`);
  if (!r) return { hit: null, clicky: false };
  if (!r.inside) throw new Error(`坐标 (${Math.round(x)}, ${Math.round(y)}) 在页面视口（${r.vw}×${r.vh}）之外`);
  return r;
}

/** ref 目标：滚进视口、取中心、查有没有被别的元素挡住。被挡且没 force → 抛错。 */
export async function probeRef(b, ref, { force = false } = {}) {
  const c = await b.refCenter(ref);
  await V(b, '0');   // 确保助手已装
  const r = await b.send('Runtime.callFunctionOn', {
    objectId: c.objectId, returnByValue: true, arguments: [{ value: c.x }, { value: c.y }],
    functionDeclaration: `function(x,y){const V=window.__bridgeV;const h=V.deep(x,y);let ok=!!h&&(h===this||this.contains(h));
      if(!ok&&h){let n=this;for(let i=0;n&&i<20;i++){const root=n.getRootNode();if(!root||root===document)break;n=root.host;if(n===h){ok=true;break}}}
      if(!ok&&h&&this.labels)ok=[...this.labels].some((l)=>l===h||l.contains(h));
      if(!ok&&h&&h.tagName==='LABEL'&&h.control===this)ok=true;
      V.hit=this;V.hitBefore=V.ctl(V.ctlOf(this));
      return {ok,target:V.desc(this),cover:h?V.desc(h):null,clicky:V.clicky(this),before:V.hitBefore}}`,
  });
  const v = r?.result?.value || {};
  if (!v.ok && v.cover && !force) {
    throw new Error(`ref${ref} ${v.target} 被 ${v.cover} 挡住了，点下去会落在挡着的东西上——先关掉遮挡（弹窗/遮罩/吸顶栏），或滚动后重新 read_page；确实要点就加 force:true`);
  }
  return { x: c.x, y: c.y, hit: v.target, covered: !v.ok ? v.cover : null, clicky: v.clicky, before: v.before };
}

/** 当前焦点（type 之前用）。 */
export async function focusInfo(b) {
  return softV(b, 'V.focus()');
}

/** 动作前快照。 */
export async function pageState(b) {
  const s = await softV(b, 'V.state()');
  return { s, net: b.netOrder.length, t: Date.now(), tabs: b.tabs.length };
}

// 动作后：等安定，再拿一份快照比对，拼成人话。
// kind：click / key / type / scroll / hover —— 决定「没变化」要不要警告。
export async function afterAction(b, before, kind, { maxMs = 2000 } = {}) {
  let st = await b.settle({ since: before.t, quietMs: 250, maxMs: b.loading ? 8000 : maxMs });
  let r = diffState(b, before, kind, st, await softV(b, 'V.state()'));
  // 一时没反应的点击/按键：页面常有防抖、setTimeout、动画后才改 DOM。再盯 ~0.8 秒，
  // 有动静就重新等安定再比；还是没有才下「没变化」的结论（同 localPc 的做法）。
  if (!r.changed && (kind === 'click' || kind === 'key')) {
    const p = r.after;
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      await delay(100);
      const s = await softV(b, 'V.state()');
      const moved = !s || !p || s.url !== p.url || s.mut !== p.mut || s.focus?.desc !== p.focus?.desc
        || b.netOrder.length > before.net || b.loading;
      if (moved) {
        st = await b.settle({ since: before.t, quietMs: 250, maxMs: b.loading ? 8000 : maxMs });
        r = diffState(b, before, kind, st, await softV(b, 'V.state()'));
        break;
      }
    }
  }
  return r;
}

function diffState(b, before, kind, st, after) {
  const out = [];
  const a = after;
  const p = before.s;
  let changed = false;
  if (a && p) {
    if (a.url !== p.url) { changed = true; out.push(sameDoc(p.url, a.url) ? `页内地址变为 ${a.url}` : `页面跳转到 ${a.url}`); }
    if (a.title !== p.title && a.url === p.url) { changed = true; out.push(`标题变为「${a.title}」`); }
    // 点按钮顺带把焦点给了它自己，是点击的必然结果，不算「页面有反应」，也不啰嗦
    if (a.focus?.desc !== p.focus?.desc && !(kind === 'click' && a.focus?.desc === before.hitDesc)) {
      changed = true; out.push(`焦点到 ${a.focus?.desc || '(无)'}`);
    }
    if (kind === 'key' && a.sel !== p.sel && a.focus?.desc === p.focus?.desc) { changed = true; out.push('选区 / 光标位置变了'); }
    if (kind !== 'type' && a.focus?.editable && a.focus.value !== p.focus?.value && a.focus?.desc === p.focus?.desc) {
      changed = true; out.push(`输入框内容变为「${a.focus.value}」`);
    }
    if (before.hitBefore !== undefined && a.hit && a.url === p.url) {
      if (a.hit.gone) { changed = true; out.push('被点的元素已从页面上移除（关闭按钮、菜单项常见）'); }
      else if (!a.hit.gone) {
        const diff = ctlDiff(before.hitBefore, a.hit.s);
        if (diff) { changed = true; out.push(`该控件 ${diff}`); }
      }
    }
    if (a.url === p.url) {
      const mut = a.mut - p.mut;
      if (mut > 0) { changed = true; out.push(`页面有 ${mut} 处 DOM 变动`); }
      if (a.sy !== p.sy || a.sx !== p.sx) { changed = true; out.push(`页面滚动 ${p.sy}→${a.sy}${a.sx !== p.sx ? `（横向 ${p.sx}→${a.sx}）` : ''}`); }
      else if (a.scr > p.scr) { changed = true; out.push(`页内的滚动区域${a.scrEl ? ` ${a.scrEl} ` : ''}滚动了`); }
    }
  } else if (!a) {
    out.push('页面还在切换，没读到动作后的状态');
    changed = true;
  }
  const reqs = b.netOrder.slice(before.net).filter((e) => e.t >= before.t && !/^(data|blob):/.test(e.url));
  if (reqs.length) {
    changed = true;
    const show = reqs.filter((e) => /xhr|fetch|document/i.test(String(e.resourceType || ''))).slice(0, 3);
    const list = show.map((e) => `${e.method} ${shortUrl(e.url)} → ${e.state === 'pending' ? '进行中' : e.state === 'failed' ? `失败(${e.error})` : e.status ?? '?'}`);
    out.push(`发出 ${reqs.length} 个请求${list.length ? '：' + list.join('；') : ''}`);
  }
  if (b.tabs.length !== before.tabs) changed = true;
  if (!st.settled) out.push(`页面 ${Math.round(st.ms / 100) / 10} 秒内还在变化（动画/轮询），已先返回`);
  const quiet = !changed && kind !== 'hover';
  if (quiet) out.push(kind === 'scroll'
    ? '⚠ 什么都没有滚动——已经到顶/到底，或指针下没有可滚动的区域（换 x,y 指到要滚的区域上）'
    : '⚠ 页面没有任何变化（地址、焦点、控件状态、DOM、网络都没动）——很可能没点中或页面不响应，先 screenshot 看看');
  return { lines: out, changed, after: a };
}

function sameDoc(u1, u2) {
  try { const a = new URL(u1); const c = new URL(u2); return a.origin + a.pathname + a.search === c.origin + c.pathname + c.search; } catch { return false; }
}

function shortUrl(u) {
  try { const x = new URL(u); const s = x.pathname + x.search; return (s.length > 70 ? s.slice(0, 70) + '…' : s) || '/'; } catch { return String(u).slice(0, 70); }
}

const CTL_LABEL = { checked: '勾选', 'aria-checked': '勾选', 'aria-expanded': '展开', 'aria-selected': '选中', 'aria-pressed': '按下', open: '展开', value: '选中项', disabled: '禁用' };
function ctlDiff(p, a) {
  if (!p || !a) return '';
  const bits = [];
  for (const k of new Set([...Object.keys(p), ...Object.keys(a)])) {
    if (String(p[k]) !== String(a[k])) bits.push(`${CTL_LABEL[k] || k} ${fmt(p[k])}→${fmt(a[k])}`);
  }
  return bits.join('，');
}
const fmt = (v) => (v === true || v === 'true' ? '是' : v === false || v === 'false' ? '否' : v == null ? '无' : `「${v}」`);

// —— expect ——
export function hasExpect(e) {
  return !!e && typeof e === 'object' && ['text', 'gone', 'url', 'selector', 'focus', 'value', 'changed'].some((k) => e[k] != null);
}

/**
 * 等预期满足。before：动作前的 pageState（changed 用）；changedNow：afterAction 判的有无变化。
 * 返回 null = 满足；否则返回未满足的描述（数组）。
 */
export async function waitExpect(b, e, { timeoutMs = 3000, changedNow = null } = {}) {
  const limit = Math.max(200, Math.min(15_000, Number(timeoutMs) || 3000));
  const probe = { text: e.text, gone: e.gone, url: e.url, selector: e.selector, focus: e.focus, value: e.value };
  const t0 = Date.now();
  // changed 只看动作后那一刻（afterAction 的结论），等也等不出来，不符合直接判
  if (e.changed != null && changedNow != null && Boolean(e.changed) !== changedNow) {
    return [e.changed ? '预期页面有变化，实际什么都没变' : '预期页面不变，实际变了'];
  }
  const rest = Object.values(probe).some((v) => v != null);
  if (!rest) return null;
  let miss = [];
  for (;;) {
    miss = (await softV(b, `V.check(${JSON.stringify(probe)})`)) ?? ['页面正在切换，读不到内容'];
    if (!miss.length) return null;
    if (Date.now() - t0 >= limit) return miss;
    await delay(120);
  }
}

// —— batch ——
export const BATCH_MAX = 20;

/** 逐步跑 runOne（单步执行器），遇错即停。图片只保留最后 3 张，免得一次塞爆上下文。 */
export async function runBatch(steps, runOne) {
  if (!Array.isArray(steps) || !steps.length) return { content: [{ type: 'text', text: 'batch 需要 actions（动作数组）' }], isError: true };
  if (steps.length > BATCH_MAX) return { content: [{ type: 'text', text: `batch 一次最多 ${BATCH_MAX} 步（给了 ${steps.length} 步）` }], isError: true };
  const lines = [];
  const images = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    if (step.action === 'batch') return fail(`第 ${i + 1} 步：batch 不能嵌套`);
    const r = await runOne(step);
    const txt = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    for (const c of r?.content || []) if (c.type === 'image') images.push(c);
    lines.push(`${i + 1}. ${step.action}${r?.isError ? ' ✗' : ''}：${txt.replace(/\n/g, '\n   ')}`);
    if (r?.isError) {
      const rest = steps.length - i - 1;
      return { content: [...images.slice(-3), { type: 'text', text: lines.join('\n') + (rest ? `\n第 ${i + 1} 步失败，后面 ${rest} 步没有执行。` : '') }], isError: true };
    }
  }
  return { content: [...images.slice(-3), { type: 'text', text: lines.join('\n') }] };

  function fail(t) { return { content: [{ type: 'text', text: [...lines, t].join('\n') }], isError: true }; }
}
