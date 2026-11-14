// 文档里的相对资源（md 的 ![](img/a.png)、[附件](../x.pdf)、[另一篇](b.md)）按「这篇文档所在目录」解析成
// 可打开的来源描述符——工作空间 / 手机本地 / 各家 agent 产物（Claude / Codex / dimensio）各走各自的文件接口。
//
//   artifactRef(item)              → { origin, id, path } | null   产物条目（没有 saveTarget）的来源与本机路径
//   resolveRelPath(base, rel)      → string | null                  rel 相对 base 文件所在目录（保留 base 的分隔符风格）
//   siblingDesc(item, rel, name?)  → 来源描述符 | null              openPreview / normalizeItem 认的那种
//
// 纪律：零依赖，不碰 DOM（node --test 直接跑）。

const ART = new Set(['claude', 'codex', 'harness']);

/** 产物条目：origin + 会话 id + 本机路径（id 不在归一化结果上，从它自己的 url 里取） */
export function artifactRef(item) {
  if (!item || !ART.has(item.origin)) return null;
  let id = '', path = item.absPath || '';
  try {
    const u = new URL(item.url || '', 'http://x/');
    path ||= u.searchParams.get('path') || '';
    if (item.origin === 'harness') id = decodeURIComponent((/\/sessions\/([^/]+)\/artifact/.exec(u.pathname) || [])[1] || '');
    else id = u.searchParams.get('id') || '';
  } catch { return null; }
  if (!path || (item.origin === 'harness' && !id)) return null;
  return { origin: item.origin, id, path };
}

const isAbsLike = (p) => /^([a-z][a-z0-9+.-]*:|\/|\\)/i.test(p);   // URL、盘符、/、\ 开头

/** rel 相对 base（一个文件路径）所在目录；rel 是绝对路径 / URL → null（不归这里管） */
export function resolveRelPath(base, rel) {
  const r = String(rel || '').trim();
  if (!r || isAbsLike(r)) return null;
  const b = String(base || '');
  const win = /^[a-z]:[\\/]/i.test(b) || (b.includes('\\') && !b.includes('/'));
  const sep = win ? '\\' : '/';
  const parts = b.split(/[\\/]/);
  parts.pop();                        // 去掉文件名
  // 锚点段（posix 绝对路径开头的空段 / Windows 盘符）不参与 .. 回退，退到根就停在根
  const keep = parts[0] === '' || /^[a-z]:$/i.test(parts[0] || '') ? 1 : 0;
  const head = parts.slice(0, keep), out = parts.slice(keep).filter(Boolean);
  for (const s of r.split(/[\\/]/)) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return head.concat(out).join(sep);
}

/** 文档 item 旁边的 rel → 来源描述符（工作空间 / 本地按 saveTarget，产物按会话接口） */
export function siblingDesc(item, rel, name = '') {
  const nm = name || String(rel).split(/[\\/]/).pop() || '';
  const st = item?.saveTarget;
  if (st) {
    const dir = String(st.rel || '').split('/').slice(0, -1).join('/');
    const segs = (dir ? dir.split('/') : []).concat(String(rel).split(/[\\/]/));
    const out = [];
    for (const s of segs) { if (!s || s === '.') continue; s === '..' ? out.pop() : out.push(s); }
    const r = out.join('/');
    if (!r) return null;
    return st.origin === 'local'
      ? { origin: 'local', rel: r, name: nm }
      : { origin: 'cloud', rel: r, name: nm, ws: st.ws || '', nativeLocation: st.nativeLocation || '' };
  }
  const a = artifactRef(item);
  if (!a) return null;
  const path = resolveRelPath(a.path, rel);
  return path ? { origin: a.origin, id: a.id, path, name: nm } : null;
}
