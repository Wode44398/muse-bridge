// 文档查看 / 编辑器（DocViewer）的保存与冲突：按发出那一刻的快照写盘、在途合并、冲突横幅的两种选择、返回前落盘、笔记栈回退。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { api } from '../../../lib/api.js';
import { localReadText, localWrite } from '../../../lib/localfs.js';
import { pushBackLayer } from '../../../lib/nav.js';
import { nativeWorkspaceWriteText } from '../../../lib/nativeDesktop.js';
import { merge3, textHash } from '../../../lib/textmerge.js';
import { t, tr } from '../../../lib/i18n.js';
import { uiConfirm } from '../../../lib/dialogs.js';
import { decodeBytes, encLabel, isUtf8 } from '../../../lib/codeview/encoding.js';

export function createDocSave(P) {
  // —— 保存：以发出那一刻的快照为准（验收 e2e-4 / e2e-3）——
  // 写请求在途时用户还会打字、跳去别的笔记、甚至关掉查看器：await 之后不再读 cur/draftKey/dirty 这些
  // 派生量（那时它们可能已指向另一篇，组件也可能已卸载），只认发出时拍下的那篇、那份文本——
  // 只把真正写出去的那份记为已保存；草稿只在恰好等于那份时才删。同一篇同时只发一个请求：
  // 在途期间又要存的记一笔，回来后按那时的最新内容补发；已经跳走/关掉的，拿草稿（每次改动都记）补发。
  // 写入按篇串行（SAVEQ），旧稿不会后到盖新稿。
  let saveT = null, saveFails = 0, alive = true;
  const inflight = new Map();          // 本实例在途的写：文件键 → { again }
  let saveTick = $state(0);            // inflight 变了 → saving 重算
  const saving = $derived((saveTick, inflight.has(P.draftKey)));
  const topItem = () => P.stack[P.stack.length - 1];   // 当前文档（直接读状态，卸载后读也不触发派生量告警）

  // 写前校验：base=这次保存基于的那份磁盘原文。磁盘已经不是它（别处改过）→ 抛 conflict（带磁盘现状），
  // 由 saveDoc 走三方合并，不覆盖。云端交给服务端比指纹（409）；电脑客户端本地文件壳没有读接口，
  // 拿加载时那个地址现读一次；手机本地 SAF 现读比对（后两者读写之间有极小窗口，够用）
  function conflictErr(current) { const e = new Error('conflict'); e.conflict = true; e.current = current; return e; }
  const noBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
  // 现读磁盘全文（跟盘 / 写前校验）：按这篇加载时识别的编码解（GBK 文件拿 r.text() 读出来是乱码，会被当成「别处改过」）
  async function readDisk(c) {
    const e = P.ENCS.get(P.draftKeyOf(c));
    const r = await fetch(c.url, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    if (!e || isUtf8(e.encoding)) return noBom(await r.text());
    return decodeBytes(new Uint8Array(await r.arrayBuffer()), e.encoding);
  }
  async function writeDoc(c, text, base) {
    const st = c.saveTarget, guard = typeof base === 'string';
    // 编码：一律写 UTF-8。原文带 UTF-8 BOM 的补回 BOM（指纹仍按去掉 BOM 的算，同服务端）；
    // 非 UTF-8 的必须先经 save() 里用户确认转码（确认后这里记成 UTF-8）——兜底：没确认的不写，免得静默改了编码
    const enc = P.ENCS.get(P.draftKeyOf(c));
    if (enc && !isUtf8(enc.encoding)) throw new Error(t('需要先确认转成 UTF-8'));
    const out = enc?.bom ? '\uFEFF' + text : text;
    if (st.origin === 'cloud' && st.nativeLocation) {
      if (guard && c.url) {
        let cur = null;
        try { cur = await readDisk(c); } catch {}
        if (cur != null && cur !== base) throw conflictErr(cur);
      }
      return nativeWorkspaceWriteText(st.rel, out, st.nativeLocation);
    }
    if (st.origin === 'cloud') {
      try { return await api.saveFileGuarded(st.rel, out, st.ws, guard ? textHash(base) : undefined); }
      catch (e) { if (e?.status === 409 && typeof e.body?.current === 'string') throw conflictErr(e.body.current); throw e; }
    }
    if (guard) { const cur = noBom(localReadText(st.rel)); if (cur && cur !== base) throw conflictErr(cur); }
    const r = localWrite(st.rel, out);
    if (!r || r.error) throw new Error(r && r.error || t('写入失败'));
  }
  function queueWrite(key, c, text, base) {
    const p = (P.SAVEQ.get(key) || Promise.resolve()).then(() => writeDoc(c, text, base));
    const tail = p.then(() => {}, () => {});
    P.SAVEQ.set(key, tail);
    tail.then(() => { if (P.SAVEQ.get(key) === tail) P.SAVEQ.delete(key); });
    return p;
  }

  function save(quiet = false) {
    P.cv?.flush();   // CodeView 大文档的改动是防抖回调的：存之前把最后一拍拿回来
    if (!P.editable || P.content === P.original || P.conflict) return;
    const c = topItem(), key = P.draftKeyOf(c), enc = P.ENCS.get(key);
    if (enc && !isUtf8(enc.encoding)) {
      // 原文不是 UTF-8（GBK / Big5 / UTF-16…）：保存只能写 UTF-8，先说清楚再存；自动 / 静默保存不替用户做这个决定
      if (quiet || asking) return;
      const text = P.content;
      asking = true;
      return uiConfirm(t('这个文件是 {enc} 编码，保存后会转成 UTF-8（其他只认 {enc} 的程序可能读成乱码）。', { enc: encLabel(enc.encoding) }), { okLabel: t('转成 UTF-8 并保存') })
        .then((ok) => {
          if (!ok || !alive || P.draftKeyOf(topItem()) !== key) return;
          const e = { encoding: 'utf-8', bom: false, eol: enc.eol };
          P.ENCS.set(key, e);
          P.encInfo = { key, ...e };
          // 不带写前校验：磁盘上是旧编码的字节，服务端按 UTF-8 算的指纹必然对不上；用户已明确确认覆盖
          return saveDoc(c, text, false, undefined);
        })
        .finally(() => { asking = false; });
    }
    return saveDoc(c, P.content, quiet, P.original);
  }
  // base：这次写入基于的磁盘原文（当前文档=original；补存草稿=草稿记的 base）
  async function saveDoc(c, text, quiet, base) {
    const key = P.draftKeyOf(c);
    const f = inflight.get(key);
    if (f) { f.again = true; return; }
    inflight.set(key, { again: false }); saveTick++;
    let ok = false, clash = null;
    try {
      await queueWrite(key, c, text, base);
      ok = true;
      const d = P.DRAFTS.get(key);
      if (d?.text === text) P.DRAFTS.delete(key);
      else if (d) P.DRAFTS.set(key, { text: d.text, base: text });   // 在途期间又改了：草稿留着兜底，它现在基于刚写下的这份
      if (P.draftKeyOf(topItem()) === key) {
        P.original = text; P.restored = false; saveFails = 0;
        P.justSaved = true; clearTimeout(P.savedT); P.savedT = setTimeout(() => (P.justSaved = false), 2200);
      }
      if (alive) P.syncLinks(c, text);   // 出链集合变了才重算索引（见 syncLinks）
      if (!quiet && alive) P.showToast(t('已保存'));
    } catch (e) {
      if (e?.conflict) clash = e.current;
      else {
        if (P.draftKeyOf(topItem()) === key) saveFails++;
        if (alive) P.showToast(t('保存失败：{reason}', { reason: tr(e?.body?.error || e?.message || '') }));
      }
    } finally {
      const again = inflight.get(key)?.again;
      inflight.delete(key); saveTick++;
      const isCur = alive && P.draftKeyOf(topItem()) === key;
      if (clash != null) onConflict(c, key, text, base, clash);
      else if (isCur) resave(again);
      else if (ok) {
        // 已跳去别的笔记 / 查看器已关：这篇离开时的最新内容在草稿里，比刚写的新就接着补存
        const d = P.DRAFTS.get(key);
        if (d && d.text !== text) saveDoc(c, d.text, true, d.base);
      }
      if (P.pendingFs && isCur) { P.pendingFs = false; P.refreshFromDisk(); }
    }
  }
  // 保存时发现磁盘已被别处改过：三方合并「基准 → 我这次要写的」「基准 → 磁盘现状」。
  //   · 合得上：磁盘现状成为新原文，正文并入对方的修改（写请求在途期间又打的字也一并保留），接着照常保存；
  //   · 合不上：当前文档停掉自动保存、出冲突横幅；已跳走/已关的那篇把草稿留着原基准，下次打开时
  //     restoreDraft 会发现磁盘≠基准，再合并一次或进冲突区——两种情况都不覆盖别处的修改。
  function onConflict(c, key, text, base, theirs) {
    const m = typeof base === 'string' ? merge3(base, text, theirs) : null;
    if (!(alive && P.draftKeyOf(topItem()) === key)) {
      if (m != null) { P.DRAFTS.set(key, { text: m, base: theirs }); saveDoc(c, m, true, theirs); }
      else P.DRAFTS.set(key, { text, base });
      return;
    }
    if (m != null) {
      const next = P.content === text ? m : merge3(text, P.content, m);
      if (next != null) {
        P.original = theirs;
        P.applyText(next);
        P.showToast(t('已合并别处对这篇的修改'));
        resave(true);
        return;
      }
    }
    P.conflict = { key, theirs };
    clearTimeout(saveT);
  }
  // 冲突横幅：保留我的 = 以磁盘现状为基准写下编辑器里的版本（用户明确选择覆盖别处这次修改）；
  // 用最新版 = 正文换成磁盘版本（编辑器里是一个事务，想要回自己的字可以撤销）
  function keepMine() {
    const cf = P.conflict;
    if (!cf || cf.key !== P.draftKeyOf(P.cur)) return;
    P.conflict = null;
    saveDoc(topItem(), P.content, false, cf.theirs);
  }
  function takeTheirs() {
    const cf = P.conflict;
    if (!cf || cf.key !== P.draftKeyOf(P.cur)) return;
    P.conflict = null;
    P.original = cf.theirs;
    P.applyText(cf.theirs, true);
    P.DRAFTS.delete(cf.key);
  }
  // 写完之后当前文档仍有没存的：失败按 3s 重试（限 3 次，草稿始终兜底）；在途期间有人要过保存就立刻补发；
  // md 编辑态照常 1.2s 自动保存（文本文件仍是手动保存，不替它自动存）
  function resave(again) {
    if (P.content === P.original || !P.editable || P.conflict) return;
    clearTimeout(saveT);
    if (saveFails > 0) { if (saveFails < 3) saveT = setTimeout(() => save(true), 3000); return; }
    if (again || (P.mdAuto && P.mode !== 'preview')) saveT = setTimeout(() => save(true), again ? 0 : 1200);
  }

  // md 编辑态：停笔 1.2s 自动落盘（Obsidian 无保存键心智）；文本文件仍手动保存
  $effect(() => {
    P.content;
    if (P.loading || !P.mdAuto || P.mode === 'preview' || !P.dirty || P.conflict) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => save(true), 1200);
    return () => clearTimeout(saveT);
  });

  // md 可保存 → 离开时静默落盘（失败有草稿兜底）；只有不可自动保存时才弹确认。
  // 确认走应用内弹窗（异步），所以改成「把离开后要做的事 go 交进来」：
  //   干净 / 已自动保存 → 当场同步执行（返回键、点链接的手感不变）；
  //   要问 → 等用户答完，且这期间还停在同一篇、查看器也没被关掉，才执行。
  // 系统返回的层回调（popNote）因此仍是同步的：先把这次返回吃掉，再异步问。
  let asking = false, gone = false;
  $effect(() => () => { gone = true; });
  function guardDirty(go) {
    if (!P.dirty) { go(); return; }
    if (P.mdAuto) { save(true); go(); return; }
    if (asking) return;   // 已经在问了（连点返回 / 连按返回键）：不排第二个同样的确认
    asking = true;
    const at = P.cur;
    uiConfirm(t('有未保存的修改，确定离开？（草稿会临时保留）'), { okLabel: t('离开') })
      .then((ok) => { if (ok && !gone && P.cur === at) go(); })
      .finally(() => { asking = false; });
  }
  // 外框的关闭钮 / Esc 先问这里：true = 自己消费了（未保存且用户取消、或退回上一篇笔记），false = 交给外框关查看器
  function back() {
    if (leaving) return false;                     // 已经问过并确认离开：放行给外框关
    P.cv?.flush();                                   // 代码编辑器的最后一笔（防抖还没回写 content）先收进来再判脏
    if (!P.dirty || P.mdAuto) {            // 干净 / 可静默落盘：同步决定，手感不变
      if (P.dirty) save(true);
      if (P.stack.length > 1) { P.stack = P.stack.slice(0, -1); return true; }
      return false;
    }
    guardDirty(() => {                             // 要问：先吃掉这次关闭，答「离开」后再退一篇或关查看器
      if (P.stack.length > 1) P.stack = P.stack.slice(0, -1);
      else { leaving = true; P.viewer.close(); }
    });
    return true;
  }
  let leaving = false;
  function popNote() {
    if (P.stack.length > 1) guardDirty(() => { if (P.stack.length > 1) P.stack = P.stack.slice(0, -1); });
  }
  $effect(() => { if (P.stack.length > 1) return pushBackLayer(popNote); });   // 系统返回：先弹笔记栈，再轮到关查看器

  return {
    get alive() { return alive; }, set alive(v) { alive = v; },
    get back() { return back; },
    get guardDirty() { return guardDirty; },
    get keepMine() { return keepMine; },
    get readDisk() { return readDisk; },
    get resave() { return resave; },
    get save() { return save; },
    get saveDoc() { return saveDoc; },
    get saveT() { return saveT; }, set saveT(v) { saveT = v; },
    get saving() { return saving; },
    get takeTheirs() { return takeTheirs; },
    get topItem() { return topItem; },
  };
}
