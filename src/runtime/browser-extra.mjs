// 浏览器 MCP 的三个补充动作（2026-09-01，对齐 Claude Code 桌面端 Browser 面板的
// find / read_network_requests / file_upload）：Claude 的 SDK MCP（mcp/browser-tools.mjs）
// 与 Codex 的 loopback（runtime/browser-actions.mjs）共用这一份实现，别再各抄一遍。
//
// - find(text)：在 a11y 树里按词找元素（每个词都得出现，大小写不敏感），返回带 [refN]
//   句柄的行，最多 20 条；比 read_page 全量翻要省提示词。refs 随本次快照重建。
// - network(query?, lines?, id?)：CDP Network 域早就在录（cdp-events.mjs），这里露出来：
//   不带 id 列最近的请求（可按 url 子串过滤），带 id 取该请求的响应体。
// - upload(files, ref?|selector?)：DOM.setFileInputFiles 往 <input type=file> 塞 bridge
//   所在电脑上的文件（隐藏的 input 也行，会触发 input/change）。沙箱身份限制在其可达
//   目录内；快照访客在 MCP 层直接拒。
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const EXTRA_ACTIONS = ['find', 'network', 'upload', 'set_value', 'page_text'];

export const EXTRA_DESC = `
find(text) locates elements: every word must appear in the accessibility line (case-insensitive); returns up to 20 lines with fresh [refN] handles — cheaper than paging through read_page.
network(query?, lines?) lists recent requests captured on this tab (method, status, mime, size, id; filter by url substring); network(id) returns that request's response body (JSON/text shown, binary summarized) — use it to inspect API calls and payloads instead of guessing.
set_value(ref | selector, value) sets a form control directly — native <select> (option text or value; array for multi-select; its popup is invisible in screenshots and cannot be clicked), checkbox / radio (true/false), date / time / range / color / number / text inputs, textarea, contenteditable — firing input + change like a real edit; the result reads the control back.
page_text(maxChars?) returns the readable text of the page (article / main first, else body) — far cheaper than read_page for reading articles, docs and long lists.
upload(files[], ref? | selector?) puts local files (absolute paths on the bridge machine, e.g. attachments under uploads/) into an <input type=file> (hidden inputs work too; default target = the first file input in the part of the page that is currently shown, ignoring inputs of hidden/background views — the result names the input it chose); then submit the form normally.
Native alert / confirm / prompt dialogs are answered automatically so they never freeze the page: alert → OK, confirm / prompt → Cancel. Every dialog (including ones a page timer opens between your actions) is reported once, at the end of your next action's result; to accept a confirm, first eval window.confirm = () => true.`;

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const err = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : (n || 0) + 'B');

// ── find ────────────────────────────────────────────────────────────────
export async function browserFind(b, args = {}) {
  const q = String(args.text ?? args.query ?? '').trim();
  if (!q) return err('find 需要 text（要找的文字/角色，多个词用空格分开）');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const snap = await b.axSnapshot({ filter: 'all', maxChars: 80_000 });
  const lines = String(snap.text || '').split('\n').filter((l) => l.trim() && !l.startsWith('…'));
  const scored = [];
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    if (!words.every((w) => low.includes(w))) return;
    let score = 0;
    if (/\[ref\d+\]/.test(line)) score += 2;                       // 可交互的排前
    if (low.includes(`"${q.toLowerCase()}"`)) score += 3;           // 名字整词命中最靠前
    scored.push({ score, i, line: line.trimStart() });
  });
  scored.sort((a, c) => c.score - a.score || a.i - c.i);
  if (!scored.length) return text(`url: ${b.url}\n没有匹配「${q}」的元素——换个词，或用 read_page 看整棵树。`);
  const top = scored.slice(0, 20).map((s) => s.line);
  const more = scored.length > 20 ? `\n… 共 ${scored.length} 处命中，只列前 20——把词再收窄` : '';
  return text(`url: ${b.url}\n${top.join('\n')}${more}\n(refs 已按本次快照重建；无 [refN] 的行不可直接点击，先 read_page 找它附近的可交互元素)`);
}

// ── network ─────────────────────────────────────────────────────────────
export async function browserNetwork(b, args = {}) {
  const id = args.id != null ? String(args.id).trim() : '';
  if (id) {
    const entry = (b.networkEntries() || []).find((e) => e.id === id);
    if (!entry) return err(`没有 id=${id} 的请求——先 network() 列表拿 id（列表只保留最近的请求）`);
    if (entry.state === 'pending') return err(`请求 ${entry.method} ${entry.url} 还没完成，稍后再取`);
    let body;
    try { body = await b.responseBody(id); } catch (e) { return err(`取不到响应体（${String(e?.message || e)}）——重定向/缓存/已被页面释放的响应拿不到`); }
    const head = `${entry.method} ${entry.status ?? '?'} ${entry.url}\nmime: ${entry.mime || '?'} · size: ${fmtSize(entry.size)}`;
    const mime = String(entry.mime || '');
    const textual = /json|text|xml|javascript|x-www-form-urlencoded|svg/i.test(mime);
    if (body.base64 && !textual) return text(`${head}\n(二进制响应，${Buffer.from(body.body, 'base64').length} 字节，不展示内容)`);
    let out = body.base64 ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    if (/json/i.test(mime)) { try { out = JSON.stringify(JSON.parse(out), null, 1); } catch {} }
    const max = Math.max(500, Math.min(30_000, Number(args.maxChars) || 8000));
    if (out.length > max) out = out.slice(0, max) + `\n…(truncated ${out.length - max} chars; maxChars 最多 30000)`;
    return text(`${head}\n\n${out}`);
  }
  const q = String(args.query || '').toLowerCase();
  const n = Math.max(1, Math.min(200, Number(args.lines) || 30));
  let entries = b.networkEntries() || [];
  if (q) entries = entries.filter((e) => String(e.url || '').toLowerCase().includes(q));
  entries = entries.slice(-n);
  if (!entries.length) return text(q ? `没有 url 含「${q}」的请求（本标签共录得 ${b.networkEntries().length} 条）` : '(还没有捕获到请求——navigate 之后再看)');
  const rows = entries.map((e) => {
    const st = e.state === 'failed' ? `FAILED(${e.error})` : e.state === 'pending' ? 'pending' : String(e.status ?? '?');
    return `${st.padEnd(7)} ${String(e.method).padEnd(5)} ${e.url}  · ${e.mime || e.resourceType || ''} ${fmtSize(e.size)} · id=${e.id}`;
  });
  return text(`url: ${b.url}\n最近 ${entries.length} 条请求（旧→新）：\n${rows.join('\n')}\n(network(id) 取某条的响应体)`);
}

// ── upload ──────────────────────────────────────────────────────────────
function insideAny(file, roots) {
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const f = real(file);
  return roots.some((r) => {
    const root = real(r);
    const rel = path.relative(root, f);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export async function browserUpload(b, args = {}, { roots = null } = {}) {
  const raw = Array.isArray(args.files) ? args.files : (args.files ? [args.files] : []);
  const files = raw.map((f) => path.resolve(String(f || '').trim())).filter(Boolean);
  if (!files.length) return err('upload 需要 files（本机文件绝对路径数组）');
  for (const f of files) {
    let st;
    try { st = statSync(f); } catch { return err(`文件不存在：${f}`); }
    if (!st.isFile()) return err(`不是文件：${f}`);
    if (Array.isArray(roots) && !insideAny(f, roots)) return err(`不允许上传该路径（越出你的可达目录）：${f}`);
  }
  let r;
  try { r = await b.setInputFiles(files, { ref: args.ref ?? undefined, selector: args.selector || undefined }); }
  catch (e) { return err(`upload 失败：${String(e?.message || e)}`); }
  const note = r.dropped ? `（该输入框不接受多选，只塞了第一个文件）` : '';
  return text(`已塞入 ${r.names.length} 个文件到 ${r.target}：${r.names.join(', ')}${note}\n页面已收到 input/change 事件；接下来按页面流程提交即可。`);
}

// ── 原生对话框回报 ─────────────────────────────────────────────────────────
// CdpSession.onDialog 当场替页面应答了 alert/confirm/prompt；这里把「上次回报之后弹过的」拼成
// 一句话挂到下一个动作结果的末尾（成功、失败都挂）——动作期间弹的、页面定时器在两次动作之间
// 弹的都不漏，每个只报一次。回报游标记在会话上：Claude / Codex 两条通道共用同一个页面。
export function dialogNote(b) {
  if (!b?.dialogsSince) return '';
  const list = b.dialogsSince(b.dialogReported || 0);
  b.dialogReported = b.dialogSeq;
  if (!list.length) return '';
  const one = (d) => `${d.type}「${d.message.length > 160 ? d.message.slice(0, 160) + '…' : d.message}」（已自动${d.accepted ? '点确定' : '取消'}）`;
  const tail = list.some((d) => d.type === 'confirm' && !d.accepted) ? '；要确认请先 eval window.confirm = () => true 再重做这一步' : '';
  return `\n页面弹出了原生对话框：${list.map(one).join('；')}${tail}`;
}

/** 给 MCP 结果（成功或 isError）的最后一段文字补上对话框回报。 */
export function withDialogNote(result, b) {
  const note = dialogNote(b);
  if (!note || !result?.content) return result;
  const last = [...result.content].reverse().find((c) => c.type === 'text');
  if (last) last.text += note; else result.content.push({ type: 'text', text: note.trim() });
  return result;
}

// ── set_value ───────────────────────────────────────────────────────────
export async function browserSetValue(b, args = {}) {
  if (args.ref == null && !args.selector) return err('set_value 需要 ref 或 selector（目标控件）');
  if (args.value === undefined) return err('set_value 需要 value');
  let r;
  try { r = await b.setValue({ ref: args.ref ?? undefined, selector: args.selector || undefined }, args.value); }
  catch (e) { return err(`set_value 失败：${String(e?.message || e)}`); }
  if (!r.ok) return err(`没设上：${r.why || '未知原因'}${r.options ? `\n可选项：${r.options.join(' | ')}` : ''}`);
  return text(`已设 ${r.desc}（${r.kind}）→ 现在是「${r.now}」\n已派发 input / change 事件。${r.why ? `\n⚠ ${r.why}` : ''}`);
}

// ── page_text ───────────────────────────────────────────────────────────
export async function browserPageText(b, args = {}) {
  const r = await b.pageText(args.maxChars);
  if (!r.text) return text(`url: ${b.url}\n（页面没有可读文字——可能全是图片 / canvas，或还没渲染完）`);
  const more = r.truncated ? `\n… 共 ${r.total} 字，只给了前 ${r.text.length} 字（maxChars 可调大，或用 read_page(query) 找具体位置）` : '';
  return text(`url: ${b.url}\ntitle: ${r.title}\n取自 <${r.from}>\n\n${r.text}${more}`);
}

// 统一入口：两条 MCP 通道的 switch 里 default 前各调一次。snap=快照访客（upload 拒）。
export async function runExtraAction(b, action, args, { roots = null, snap = false } = {}) {
  if (action === 'find') return browserFind(b, args);
  if (action === 'network') return browserNetwork(b, args);
  if (action === 'set_value') return browserSetValue(b, args);
  if (action === 'page_text') return browserPageText(b, args);
  if (action === 'upload') {
    if (snap) return err('快照里不提供 upload——访客无权把服务器文件送往任何站点。');
    return browserUpload(b, args, { roots });
  }
  return null;
}
