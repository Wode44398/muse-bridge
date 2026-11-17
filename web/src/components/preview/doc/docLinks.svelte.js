// 文档查看 / 编辑器（DocViewer）的md 双链数据：出链 / 反链（/api/file/mdlinks）、笔记属性与统计、[[ 补全名单、嵌入的地址与回退。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { api } from '../../../lib/api.js';
import { mediaFallbackUrl } from '../../../lib/server.js';
import { localFileUrl, localList, localReadText } from '../../../lib/localfs.js';
import { cloudFileUrl, normalizeItem } from '../../../lib/preview.svelte.js';
import { nativeLocLocalOnly } from '../../../lib/nativeDesktop.js';
import { EMBED_SRC_OK, MD_EXT_RE, noteStats, parseNote } from '../../../lib/obsmd.js';
import { siblingDesc } from '../../../lib/docres.js';

export function createDocLinks(P) {
  // —— md 双链数据（/api/file/mdlinks；按 rel 缓存，返回导航秒出，后台刷新）——
  const LINKS_CACHE = (window.__bridgeMdLinks ||= new Map());
  let links = $state(null);
  // 当前文档的出链索引在路上、手上又没有缓存可先用：![[图]] 先占位（embedUrl 给 ''），不按「笔记同目录/名字」
  // 猜一个地址发请求——猜错就是每张图一次 404 加一闪裂图，索引到了再换真地址
  let linksPending = $state(false);
  let linksFor = '';   // links 属于哪篇（linksKeyOf）：同一篇刷新时旧索引留到新的到货，换篇才清空（不然阅读态整篇重渲两次、图先掉回兜底地址再换回）
  async function loadLinks(c) {
    const cacheKey = P.linksKeyOf(c);
    if (linksFor !== cacheKey) { links = null; linksFor = cacheKey; }
    linksPending = false;
    // primary 的双链/反链仍由服务端算（它就在 vault 根上）；服务端不认识的位置（额外位置 / 连远端时这台电脑的文件）才跳过。
    if (c.kind !== 'markdown' || c.saveTarget?.origin !== 'cloud' || nativeLocLocalOnly(c.saveTarget?.nativeLocation)) return;
    const rel = c.saveTarget.rel;
    if (LINKS_CACHE.has(cacheKey)) links = LINKS_CACHE.get(cacheKey);
    else if (!links) linksPending = true;
    try {
      const r = await api.mdLinks(rel, c.saveTarget.ws);
      LINKS_CACHE.set(cacheKey, r);
      if (P.linksKeyOf(P.cur) === cacheKey) links = r;
    } catch {}
    finally { if (P.linksKeyOf(P.cur) === cacheKey) linksPending = false; }   // 失败也收：退回按名单/同目录解析
  }
  // 保存/跟盘后要不要重算出链：只看正文里的出链集合（[[ ]] / ![[ ]] / 相对 md 链接）变没变——反链是别的
  // 笔记链过来的，跟这篇怎么改无关。以前每次自动保存（≥10s 一次）都整篇重算，服务端每次读整棵树的 md。
  // 变了也按 10s 限频合并（连着改几个链接只算最后一次）
  const linkSigs = new Map();   // linksKeyOf → 上次拉索引时的出链集合
  let linksT = null, lastLinksAt = 0;
  const linkSigOf = (text) => [...new Set(Array.from(String(text).matchAll(/(!?)\[\[([^[\]\n]+?)\]\]|\]\(([^()\s]+?\.md)\)/gi),
    (m) => (m[2] != null ? m[1] + m[2].split(/[|#]/)[0].trim().toLowerCase() : 'md:' + m[3].toLowerCase())))].sort().join('\n');
  function syncLinks(c, text) {
    const key = P.linksKeyOf(c), sig = linkSigOf(text);
    if (linkSigs.get(key) === sig) return;
    linkSigs.set(key, sig);
    clearTimeout(linksT);
    linksT = setTimeout(() => {
      lastLinksAt = Date.now();
      LINKS_CACHE.delete(key);
      if (P.alive && P.linksKeyOf(P.topItem()) === key) loadLinks(P.topItem());
    }, Math.max(0, lastLinksAt + 10_000 - Date.now()));
  }
  const outLinks = $derived(links?.outgoing?.filter((o) => !o.embed) || []);
  const blCount = $derived(links?.backlinks?.reduce((n, b) => n + b.count, 0) || 0);

  // —— 笔记结构：frontmatter 属性 + 正文渲染 + 统计 ——
  const note = $derived(P.isMd ? parseNote(P.content) : null);
  // 词数/字符数只在尾栏显示，不必逐键重算（长文档每键整篇扫一遍）：打开/换篇/存盘后当场算，编辑中停笔 400ms 再算
  let stats = $state(null), statsT = null, statsFor = '';
  $effect(() => {
    const body = note?.body, key = P.draftKey;
    clearTimeout(statsT);
    if (body == null) { stats = null; return; }
    if (statsFor !== key || P.loading || !P.dirty) { statsFor = key; stats = noteStats(body); return; }
    statsT = setTimeout(() => { stats = noteStats(body); }, 400);
    return () => clearTimeout(statsT);
  });
  let propsOpen = $state(true);

  const dirOf = (rel) => String(rel || '').split('/').slice(0, -1).join('/');
  function joinRel(dir, p) {
    const segs = (dir ? dir.split('/') : []).concat(String(p).split('/'));
    const out = [];
    for (const s of segs) { if (!s || s === '.') continue; s === '..' ? out.pop() : out.push(s); }
    return out.join('/');
  }

  // —— [[ 补全名单（/api/file/mdnames，与 mdlinks 同一棵目录树）——
  // 编辑器补全用；resolveWiki / embedUrl 也拿它兜底：出链只在保存后重算，编辑时新写的 [[X]]
  // 在那之前点开会报「未找到笔记」。按「位置 + 目录」缓存 30s，过期先给旧名单、后台换新。
  // 本地（手机 SAF）没有服务端遍历，退化成同目录；分享只读页/接口不可用时给空表（补全不弹）。
  const NAMES_CACHE = (window.__bridgeMdNames ||= new Map());
  const ATTACH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|ico|pdf|mp3|wav|m4a|ogg|flac|aac|opus|mp4|webm|mov|mkv|ogv|m4v|canvas|base)$/i;
  const namesKeyOf = (c) => (c.saveTarget?.origin || '') + ':' + (c.saveTarget?.ws || c.saveTarget?.nativeLocation || '') + ':' + dirOf(c.saveTarget?.rel || '');
  let namesNow = null;   // 当前笔记最近拿到的名单（embedUrl 同步查；换文档即清）
  $effect(() => { P.cur; namesNow = null; });
  async function fetchNames(c) {
    const st = c.saveTarget;
    if (c.kind !== 'markdown' || !st) return [];
    const dir = dirOf(st.rel);
    if (st.origin === 'local') {
      let l; try { l = localList(dir); } catch {}
      const arr = Array.isArray(l?.items) ? l.items : Array.isArray(l) ? l : [];
      return arr.filter((f) => f && !f.isDir && f.name && (MD_EXT_RE.test(f.name) || ATTACH_RE.test(f.name))).map((f) => {
        const md = MD_EXT_RE.test(f.name);
        return { name: md ? f.name.replace(/\.[^.]+$/, '') : f.name, md, path: joinRel(dir, f.name), rel: f.name };
      });
    }
    if (nativeLocLocalOnly(st.nativeLocation)) return [];   // 服务端不认识的位置（同 loadLinks）
    try {
      const r = await api.mdNames(st.rel, st.ws);
      const base = dir ? dir + '/' : '';
      const names = (r?.names || []).map((n) => ({ ...n, rel: base && n.path.startsWith(base) ? n.path.slice(base.length) : n.path }));
      names.truncated = !!r?.truncated;
      return names;
    } catch { return []; }
  }
  function linkNames(c = P.cur) {
    const key = namesKeyOf(c), hit = NAMES_CACHE.get(key);
    let p = hit?.p;
    if (!hit || Date.now() - hit.at >= 30_000) {
      const fresh = fetchNames(c).then((names) => (names.length || !hit ? names : hit.p));   // 刷新失败别拿空表盖掉旧的
      NAMES_CACHE.set(key, { at: Date.now(), p: fresh });
      p = hit ? hit.p : fresh;
    }
    return p.then((names) => {
      if (namesKeyOf(P.cur) === key && namesNow !== names) { namesNow = names; P.refreshEmbeds(); }   // 名单到货：编辑态的嵌入可能解析得出了
      return names;
    });
  }
  // 在名单里认一个 [[名字]]：带路径的按相对路径后缀认（同服务端 mdlinks），裸名先笔记后附件；
  // 名单已按离当前笔记的远近排好，取第一个就是最浅的那个（与 mdlinks「同名取最浅」一致）
  function findInNames(names, target) {
    const k = String(target || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!k || !names?.length) return null;
    const noExt = k.replace(/\.(md|markdown|mdown|mkd)$/, '');
    if (k.includes('/')) {
      return names.find((n) => {
        const s = (n.md ? n.path.replace(/\.[^./]+$/, '') : n.path).toLowerCase();
        const want = n.md ? noExt : k;
        return s === want || s.endsWith('/' + want);
      }) || null;
    }
    return names.find((n) => n.md && n.name.toLowerCase() === noExt) || names.find((n) => !n.md && n.name.toLowerCase() === k) || null;
  }
  // [[笔记#标题 补全：认出那篇笔记、取原文（标题由补全侧抽取并缓存）
  async function readNote(name) {
    const c = P.cur, st = c.saveTarget;
    if (!st) return null;
    const k = String(name).toLowerCase();
    const o = links?.outgoing?.find((x) => x.path && x.name.toLowerCase() === k);
    const rel = o?.path || findInNames(await linkNames(c), name)?.path;
    if (!rel || !MD_EXT_RE.test(rel)) return null;
    if (rel === st.rel) return P.content;
    if (st.origin === 'local') { try { return localReadText(rel); } catch { return null; } }
    try {
      const r = await fetch(cloudFileUrl(rel, { ws: st.ws, nativeLocation: st.nativeLocation }), { cache: 'no-store', credentials: 'same-origin' });   // 同 load()：别拿 30s 缓存里的旧标题
      return r.ok && +(r.headers.get('content-length') || 0) < 2_000_000 ? await r.text() : null;
    } catch { return null; }
  }

  // ![[嵌入]] / 相对资源 → 可加载 URL：mdlinks 已解析的路径优先，回落同目录拼接。
  // wiki=true（![[名字]]，按全库名字解析）且出链索引还在路上、名单里也没有 → ''（占位，见 linksPending）
  // media：这些地址落在 <img> 上，局域网直连时要走 mediaUrl（手机 WebView 的 <img> 经 LAN 会整批裂图，见 server.js）
  const fileUrlOf = (st, rel) => (st.origin === 'cloud' ? cloudFileUrl(rel, { ws: st.ws, nativeLocation: st.nativeLocation, media: true }) : localFileUrl(rel));
  const resolvedEmbed = (name) => {
    const k = String(name).toLowerCase();
    return links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k)?.path
      || findInNames(namesNow, name)?.path || null;   // 编辑时新插的 ![[附件]]：出链还没重算，先认补全名单
  };
  // 改写出去的 URL → 工作区相对路径：阅读态里 [附件](x.pdf) 的 href 已换成可加载 URL，点它时据此认回原文件，
  // 压一层进查看器（不让浏览器直接跳到裸 URL——网页版会离开 bridge，桌面壳会丢给系统浏览器）
  const embedBack = new Map();
  function embedUrl(name, wiki = false) {
    const st = P.cur.saveTarget;
    // Claude / Codex / dimensio 产物（没有 saveTarget）：按这篇在本机的路径解析同目录资源，走各家产物接口（lib/docres.js）
    if (!st) { const d = siblingDesc(P.cur, name); return d ? normalizeItem(d).url : null; }
    const rel = resolvedEmbed(name);
    if (!rel && wiki && linksPending) return '';
    const r = rel || joinRel(dirOf(st.rel), name);
    const u = fileUrlOf(st, r);
    if (u) { embedBack.set(u, r); if (embedBack.size > 400) embedBack.delete(embedBack.keys().next().value); }
    return u;
  }
  // 主地址只是猜的（索引和名单里都没有：额外授权位置、手机本地、索引失败）时的备选：<笔记目录>/attachments/<名字>
  //（bridge 插图的落盘处，同 saveAttachment）。阅读态/编辑态的图加载失败时按序换上
  function embedAlts(name) {
    const st = P.cur.saveTarget;
    if (!st || String(name).includes('/') || resolvedEmbed(name)) return [];
    return [fileUrlOf(st, joinRel(dirOf(st.rel), P.ATTACH_DIR + '/' + name))];
  }
  // 阅读态（与编辑态 callout 卡里的 HTML）：img 带 data-alt 的，加载失败换下一个备选（error 不冒泡，挂捕获）
  function embedFallback(e) {
    const img = e.target;
    if (img?.tagName !== 'IMG') return;
    const viaTunnel = mediaFallbackUrl(img.src);   // 走的局域网：先换隧道重试同一张，不算失败
    if (viaTunnel !== img.src) { img.src = viaTunnel; return; }
    if (!img.dataset?.alt) return;
    const [next, ...rest] = img.dataset.alt.split('\n');
    if (rest.length) img.dataset.alt = rest.join('\n'); else img.removeAttribute('data-alt');
    if (EMBED_SRC_OK.test(next)) img.src = next;
  }

  return {
    get ATTACH_RE() { return ATTACH_RE; },
    get blCount() { return blCount; },
    get dirOf() { return dirOf; },
    get embedAlts() { return embedAlts; },
    get embedBack() { return embedBack; },
    get embedFallback() { return embedFallback; },
    get embedUrl() { return embedUrl; },
    get findInNames() { return findInNames; },
    get joinRel() { return joinRel; },
    get linkNames() { return linkNames; },
    get linkSigOf() { return linkSigOf; },
    get linkSigs() { return linkSigs; },
    get links() { return links; }, set links(v) { links = v; },
    get linksPending() { return linksPending; }, set linksPending(v) { linksPending = v; },
    get linksT() { return linksT; }, set linksT(v) { linksT = v; },
    get loadLinks() { return loadLinks; },
    get namesNow() { return namesNow; }, set namesNow(v) { namesNow = v; },
    get note() { return note; },
    get outLinks() { return outLinks; },
    get propsOpen() { return propsOpen; }, set propsOpen(v) { propsOpen = v; },
    get readNote() { return readNote; },
    get stats() { return stats; }, set stats(v) { stats = v; },
    get statsT() { return statsT; }, set statsT(v) { statsT = v; },
    get syncLinks() { return syncLinks; },
  };
}
