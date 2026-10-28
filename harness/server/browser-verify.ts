// 浏览器动作的「做完确认」——移植 bridge 的 src/runtime/browser-verify.mjs（2026-10-21）。
// 以前 click / type / key 一律回「Clicked …」——点到视口外、点在空白处、没聚焦输入框就打字，都报成功，模型只能每步
// 再截一张图才知道有没有做对。现在：
//  - 动作前：坐标越界直接报错；查落点上是什么元素（穿透 shadow DOM），ref 目标被遮罩挡住就拒绝（force:true 可硬点）；
//    type 前确认焦点真在可编辑元素上。
//  - 动作后：等页面安定（CdpSession.settle），比对前后——地址、标题、焦点、被点控件的状态（勾选 / 展开 / 选中 / 值）、
//    DOM 变动、滚动、新请求；什么都没变就明说。type 回读输入框内容。
//  - expect：等到预期满足或超时（默认 3 秒），不符合 → 动作失败，batch 停下。
// 页内助手与 bridge 同一份逻辑（挂在 window.__bridgeV，和 cdp.ts 的 MUT_INIT 计数器共用）；给模型的话是英文
// （dimensio 跑的模型不止 Claude）。
import { MUT_INIT, type CdpSession, type DialogEntry } from "./cdp.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const VERIFY_DESC =
  "Coordinates: x,y are pixels of the most recent screenshot image (the tool converts them to CSS pixels itself; full-viewport " +
  "screenshots are 1:1 CSS px, scaled down only when the viewport is wider than 1568). A point outside that image is an error, not a silent miss.\n" +
  "Every click/type/key/scroll/hover/long_press/drag reports what actually happened: which element sat under the pointer and, after the " +
  "page settles, URL/title change, focus moves, the clicked control's state (checked/expanded/selected/value), DOM changes, scrolling and " +
  'new network requests; type reads the field back. "⚠ Nothing on the page changed" means it most likely missed — look before continuing. ' +
  "A ref whose element is covered by an overlay is refused (pass force:true to click anyway). type without ref/selector fails if nothing editable is focused.\n" +
  "expect:{text?, gone?, url?, selector?, focus?, value?, changed?} on any action waits (expect_timeout_ms, default 3000, max 15000) until all " +
  "hold, else the action fails. wait_for(expect:{…}) waits for a condition without acting; wait_for(ms) just sleeps. verify:false skips the checks (faster, blind).\n" +
  "batch(actions:[{action,…}, …]) runs up to 20 steps in ONE call (same fields as single actions), stopping at the first failure — use it for " +
  "predictable sequences like fill-and-submit. screenshot_after:true on any action appends a screenshot taken after the page settled.\n" +
  "Native alert/confirm/prompt dialogs are answered automatically so they never freeze the page (alert → OK, confirm/prompt → Cancel) and " +
  "reported at the end of your next result; to accept a confirm, first Eval window.confirm = () => true.";

// —— 页内助手：装一次，挂在 window.__bridgeV。所有探针都走它，免得每次塞一大段脚本 ——
const HELPER = `(()=>{${MUT_INIT};
const V={};
const clip=(s,n)=>{s=String(s||'').replace(/\\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s};
const TAGROLE={A:'link',BUTTON:'button',SELECT:'select',TEXTAREA:'textarea',SUMMARY:'summary',LABEL:'label',IMG:'img',IFRAME:'iframe',VIDEO:'video',CANVAS:'canvas'};
V.desc=(el)=>{if(!el||el.nodeType!==1)return '(none)';const t=el.tagName;
 let role=el.getAttribute('role')||(t==='INPUT'?'input['+(el.type||'text')+']':TAGROLE[t])||t.toLowerCase();
 let name=el.getAttribute('aria-label')||(el.labels&&el.labels[0]&&el.labels[0].innerText)||el.getAttribute('placeholder')||el.getAttribute('alt')||el.getAttribute('title')||'';
 if(!name&&t!=='INPUT'&&t!=='TEXTAREA'&&t!=='BODY'&&t!=='HTML'){name=el.innerText||''}
 if(!name&&(t==='INPUT'||t==='BUTTON')&&el.type!=='password')name=el.value||'';
 const cls=typeof el.className==='string'?el.className.trim().split(/\\s+/).find((c)=>c&&!/^svelte-|^css-|^_|^[a-z]{1,3}-[A-Za-z0-9]{5,}$/.test(c)):'';
 const idc=el.id?'#'+el.id:(cls?'.'+cls:'');
 name=clip(name,40);return role+(name?' "'+name+'"':'')+(idc?' '+idc:'')};
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
V.focus=()=>{const f=V.focusEl();if(!f||f===document.body||f===document.documentElement)return {desc:'(the page itself)',editable:false};
 const pw=f.tagName==='INPUT'&&f.type==='password';const val=V.editable(f)?(f.isContentEditable?f.innerText:f.value):undefined;
 return {desc:V.desc(f),editable:V.editable(f),password:pw,value:val==null?undefined:(pw?'•'.repeat(String(val).length):clip(val,300))}};
V.state=()=>{const m=window.__bridgeMut;const h=V.hit;let hit=null;
 if(h){const c=V.ctlOf(h);hit=c&&c.isConnected?{gone:false,s:V.ctl(c)}:{gone:true}}
 const f=V.focusEl();let sel='';try{sel=f&&typeof f.selectionStart==='number'?f.selectionStart+'-'+f.selectionEnd:String(getSelection()).length+''}catch{}
 const st=m.t&&m.t.nodeType===1&&m.t!==document.documentElement&&m.t!==document.body?V.desc(m.t):'';
 return {url:location.href,title:document.title,focus:V.focus(),mut:m.n,scr:m.s,scrEl:st,sel,sx:Math.round(scrollX),sy:Math.round(scrollY),hit}};
const seen=(el)=>{if(!el)return false;try{return el.checkVisibility?el.checkVisibility({visibilityProperty:true}):el.getClientRects().length>0}catch{return el.getClientRects().length>0}};
V.check=(e)=>{const miss=[];const body=(document.body&&document.body.innerText)||'';
 if(e.text!=null&&!body.includes(e.text))miss.push('"'+e.text+'" is not on the page yet');
 if(e.gone!=null&&body.includes(e.gone))miss.push('"'+e.gone+'" is still on the page');
 if(e.url!=null&&!location.href.includes(e.url))miss.push('the URL does not contain "'+e.url+'" (now '+location.href+')');
 if(e.selector!=null){let el=null;try{el=document.querySelector(e.selector)}catch(err){miss.push('invalid selector: '+e.selector)}
  if(el===null&&!miss.length)miss.push('nothing matches '+e.selector);else if(el&&!seen(el))miss.push(e.selector+' exists but is not visible')}
 if(e.focus!=null||e.value!=null){const f=V.focus();
  if(e.focus!=null&&!f.desc.toLowerCase().includes(String(e.focus).toLowerCase()))miss.push('focus is on '+f.desc+', which does not contain "'+e.focus+'"');
  if(e.value!=null&&!(f.value||'').includes(e.value))miss.push('the focused field holds "'+(f.value||'')+'", which does not contain "'+e.value+'"')}
 return miss};
return V})()`;

// 在页面里调助手：expr 是对 V 的一段调用，如 'V.at(10,20)'。
async function V(b: CdpSession, expr: string, timeoutMs = 4000): Promise<any> {
  const r = await b.send(
    "Runtime.evaluate",
    { expression: `(()=>{if(!window.__bridgeV)window.__bridgeV=${HELPER};const V=window.__bridgeV;return ${expr}})()`, returnByValue: true },
    timeoutMs,
  );
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "probe error");
  return r?.result?.value;
}

// 页面正在换文档时探针会报「上下文已销毁」——这类失败当作「看不到」而不是动作失败。
async function softV(b: CdpSession, expr: string): Promise<any> {
  try {
    return await V(b, expr, 2500);
  } catch {
    return null;
  }
}

export interface PointProbe {
  hit: string | null;
  clicky: boolean;
  iframe?: boolean;
  before?: unknown;
}

/** 落点探测（CSS 像素）。越界抛错。 */
export async function probePoint(b: CdpSession, x: number, y: number): Promise<PointProbe> {
  const r = await V(b, `V.at(${Number(x)},${Number(y)})`);
  if (!r) return { hit: null, clicky: false };
  if (!r.inside) throw new Error(`(${Math.round(x)}, ${Math.round(y)}) is outside the page viewport (${r.vw}×${r.vh})`);
  return r;
}

/** ref 目标：滚进视口、取中心、查有没有被别的元素挡住。被挡且没 force → 抛错。 */
export async function probeRef(
  b: CdpSession,
  ref: number,
  { force = false }: { force?: boolean } = {},
): Promise<{ x: number; y: number; hit: string; covered: string | null; clicky: boolean; before: unknown }> {
  const c = await b.refCenter(ref);
  await V(b, "0"); // 确保助手已装
  const r = await b.send("Runtime.callFunctionOn", {
    objectId: c.objectId,
    returnByValue: true,
    arguments: [{ value: c.x }, { value: c.y }],
    functionDeclaration: `function(x,y){const V=window.__bridgeV;const h=V.deep(x,y);let ok=!!h&&(h===this||this.contains(h));
      if(!ok&&h){let n=this;for(let i=0;n&&i<20;i++){const root=n.getRootNode();if(!root||root===document)break;n=root.host;if(n===h){ok=true;break}}}
      if(!ok&&h&&this.labels)ok=[...this.labels].some((l)=>l===h||l.contains(h));
      if(!ok&&h&&h.tagName==='LABEL'&&h.control===this)ok=true;
      V.hit=this;V.hitBefore=V.ctl(V.ctlOf(this));
      return {ok,target:V.desc(this),cover:h?V.desc(h):null,clicky:V.clicky(this),before:V.hitBefore}}`,
  });
  const v = r?.result?.value || {};
  if (!v.ok && v.cover && !force) {
    throw new Error(
      `ref${ref} ${v.target} is covered by ${v.cover} — a click would land on that instead. Close the overlay (dialog / backdrop / sticky bar) or scroll, then ReadPage again; pass force:true to click anyway`,
    );
  }
  return { x: c.x, y: c.y, hit: String(v.target ?? ""), covered: !v.ok ? (v.cover ?? null) : null, clicky: Boolean(v.clicky), before: v.before };
}

export interface FocusInfo {
  desc: string;
  editable: boolean;
  password?: boolean;
  value?: string;
}

/** 当前焦点（type 之前用）。 */
export async function focusInfo(b: CdpSession): Promise<FocusInfo | null> {
  return softV(b, "V.focus()");
}

export interface PageState {
  s: any;
  net: number;
  t: number;
  tabs: number;
  hitBefore?: unknown;
  hitDesc?: string | null;
}

/** 动作前快照。 */
export async function pageState(b: CdpSession): Promise<PageState> {
  const s = await softV(b, "V.state()");
  return { s, net: b.networkEntries().length, t: Date.now(), tabs: b.tabs.length };
}

export type ActKind = "click" | "key" | "type" | "scroll" | "hover";

// 动作后：等安定，再拿一份快照比对，拼成人话。kind 决定「没变化」要不要警告。
export async function afterAction(
  b: CdpSession,
  before: PageState,
  kind: ActKind,
  { maxMs = 2000 }: { maxMs?: number } = {},
): Promise<{ lines: string[]; changed: boolean; after: any }> {
  let st = await b.settle({ since: before.t, quietMs: 250, maxMs: b.loading ? 8000 : maxMs });
  let r = diffState(b, before, kind, st, await softV(b, "V.state()"));
  // 一时没反应的点击 / 按键：页面常有防抖、setTimeout、动画后才改 DOM。再盯 ~0.8 秒，有动静就重新等安定再比；
  // 还是没有才下「没变化」的结论。
  if (!r.changed && (kind === "click" || kind === "key")) {
    const p = r.after;
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      await delay(100);
      const s = await softV(b, "V.state()");
      const moved =
        !s || !p || s.url !== p.url || s.mut !== p.mut || s.focus?.desc !== p.focus?.desc || b.networkEntries().length > before.net || b.loading;
      if (moved) {
        st = await b.settle({ since: before.t, quietMs: 250, maxMs: b.loading ? 8000 : maxMs });
        r = diffState(b, before, kind, st, await softV(b, "V.state()"));
        break;
      }
    }
  }
  return r;
}

function diffState(
  b: CdpSession,
  before: PageState,
  kind: ActKind,
  st: { settled: boolean; ms: number },
  after: any,
): { lines: string[]; changed: boolean; after: any } {
  const out: string[] = [];
  const a = after;
  const p = before.s;
  let changed = false;
  if (a && p) {
    if (a.url !== p.url) {
      changed = true;
      out.push(sameDoc(p.url, a.url) ? `in-page URL changed to ${a.url}` : `navigated to ${a.url}`);
    }
    if (a.title !== p.title && a.url === p.url) {
      changed = true;
      out.push(`title changed to "${a.title}"`);
    }
    // 点按钮顺带把焦点给了它自己，是点击的必然结果，不算「页面有反应」
    if (a.focus?.desc !== p.focus?.desc && !(kind === "click" && a.focus?.desc === before.hitDesc)) {
      changed = true;
      out.push(`focus moved to ${a.focus?.desc || "(none)"}`);
    }
    if (kind === "key" && a.sel !== p.sel && a.focus?.desc === p.focus?.desc) {
      changed = true;
      out.push("the selection / caret moved");
    }
    if (kind !== "type" && a.focus?.editable && a.focus.value !== p.focus?.value && a.focus?.desc === p.focus?.desc) {
      changed = true;
      out.push(`the field now holds "${a.focus.value}"`);
    }
    if (before.hitBefore !== undefined && a.hit && a.url === p.url) {
      if (a.hit.gone) {
        changed = true;
        out.push("the clicked element was removed from the page (common for close buttons and menu items)");
      } else {
        const diff = ctlDiff(before.hitBefore as Record<string, unknown> | null, a.hit.s);
        if (diff) {
          changed = true;
          out.push(`the control: ${diff}`);
        }
      }
    }
    if (a.url === p.url) {
      const mut = a.mut - p.mut;
      if (mut > 0) {
        changed = true;
        out.push(`${mut} DOM change(s)`);
      }
      if (a.sy !== p.sy || a.sx !== p.sx) {
        changed = true;
        out.push(`page scrolled ${p.sy}→${a.sy}${a.sx !== p.sx ? ` (horizontally ${p.sx}→${a.sx})` : ""}`);
      } else if (a.scr > p.scr) {
        changed = true;
        out.push(`an inner scroll area${a.scrEl ? ` ${a.scrEl}` : ""} scrolled`);
      }
    }
  } else if (!a) {
    out.push("the page was still switching documents — could not read its state after the action");
    changed = true;
  }
  const reqs = b.networkEntries().slice(before.net).filter((e) => e.t >= before.t && !/^(data|blob):/.test(e.url));
  if (reqs.length) {
    changed = true;
    const show = reqs.filter((e) => /xhr|fetch|document/i.test(String(e.resourceType || ""))).slice(0, 3);
    const list = show.map(
      (e) => `${e.method} ${shortUrl(e.url)} → ${e.state === "pending" ? "pending" : e.state === "failed" ? `failed (${e.error})` : (e.status ?? "?")}`,
    );
    out.push(`${reqs.length} request(s) sent${list.length ? ": " + list.join("; ") : ""}`);
  }
  if (b.tabs.length !== before.tabs) changed = true;
  if (!st.settled) out.push(`the page kept changing for ${Math.round(st.ms / 100) / 10}s (animation / polling) — returned early`);
  if (!changed && kind !== "hover") {
    out.push(
      kind === "scroll"
        ? "⚠ Nothing scrolled — already at the top/bottom, or nothing scrollable under the pointer (point x,y at the area to scroll)"
        : "⚠ Nothing on the page changed (URL, focus, control state, DOM and network all unchanged) — it most likely missed or the page ignores it; take a screenshot before continuing",
    );
  }
  return { lines: out, changed, after: a };
}

function sameDoc(u1: string, u2: string): boolean {
  try {
    const a = new URL(u1);
    const c = new URL(u2);
    return a.origin + a.pathname + a.search === c.origin + c.pathname + c.search;
  } catch {
    return false;
  }
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const s = x.pathname + x.search;
    return (s.length > 70 ? s.slice(0, 70) + "…" : s) || "/";
  } catch {
    return String(u).slice(0, 70);
  }
}

const CTL_LABEL: Record<string, string> = {
  checked: "checked",
  "aria-checked": "checked",
  "aria-expanded": "expanded",
  "aria-selected": "selected",
  "aria-pressed": "pressed",
  open: "open",
  value: "selected option",
  disabled: "disabled",
};

function ctlDiff(p: Record<string, unknown> | null, a: Record<string, unknown> | null): string {
  if (!p || !a) return "";
  const bits: string[] = [];
  for (const k of new Set([...Object.keys(p), ...Object.keys(a)])) {
    if (String(p[k]) !== String(a[k])) bits.push(`${CTL_LABEL[k] || k} ${fmt(p[k])}→${fmt(a[k])}`);
  }
  return bits.join(", ");
}

const fmt = (v: unknown) => (v === true || v === "true" ? "yes" : v === false || v === "false" ? "no" : v == null ? "none" : `"${v}"`);

// —— expect ——
export interface Expect {
  text?: string;
  gone?: string;
  url?: string;
  selector?: string;
  focus?: string;
  value?: string;
  changed?: boolean;
}

export function hasExpect(e: unknown): e is Expect {
  return !!e && typeof e === "object" && ["text", "gone", "url", "selector", "focus", "value", "changed"].some((k) => (e as Record<string, unknown>)[k] != null);
}

/**
 * 等预期满足。changedNow：afterAction 判的有无变化（expect.changed 只看动作后那一刻）。
 * 返回 null = 满足；否则返回未满足的描述。
 */
export async function waitExpect(
  b: CdpSession,
  e: Expect,
  { timeoutMs = 3000, changedNow = null }: { timeoutMs?: number; changedNow?: boolean | null } = {},
): Promise<string[] | null> {
  const limit = Math.max(200, Math.min(15_000, Number(timeoutMs) || 3000));
  const probe = { text: e.text, gone: e.gone, url: e.url, selector: e.selector, focus: e.focus, value: e.value };
  const t0 = Date.now();
  if (e.changed != null && changedNow != null && Boolean(e.changed) !== changedNow) {
    return [e.changed ? "expected the page to change, but nothing changed" : "expected no change, but the page changed"];
  }
  if (!Object.values(probe).some((v) => v != null)) return null;
  for (;;) {
    const miss: string[] = (await softV(b, `V.check(${JSON.stringify(probe)})`)) ?? ["the page is switching documents — could not read it"];
    if (!miss.length) return null;
    if (Date.now() - t0 >= limit) return miss;
    await delay(120);
  }
}

// —— 原生对话框回报：上次回报之后弹过的，拼成一句挂到这次结果末尾（成功、失败都挂），每个只报一次 ——
export function dialogNote(b: CdpSession | undefined | null): string {
  if (!b) return "";
  const list: DialogEntry[] = b.dialogsSince(b.dialogReported || 0);
  b.dialogReported = b.dialogSeq;
  if (!list.length) return "";
  const one = (d: DialogEntry) =>
    `${d.type} "${d.message.length > 160 ? d.message.slice(0, 160) + "…" : d.message}" (auto-${d.accepted ? "accepted" : "dismissed"})`;
  const tail = list.some((d) => d.type === "confirm" && !d.accepted) ? "; to confirm instead, Eval window.confirm = () => true and redo that step" : "";
  return `\nThe page opened native dialog(s): ${list.map(one).join("; ")}${tail}`;
}

// —— batch ——
export const BATCH_MAX = 20;
