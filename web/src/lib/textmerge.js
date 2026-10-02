// 三方合并（行级）—— DocViewer 恢复过期草稿用：草稿记着它基于的那份磁盘原文（base），
// 重开时磁盘若已被别处（Claude 的 Edit / 其他端）改过，就拿 base → 草稿、base → 磁盘两份改动
// 合在一起，两边的新内容都留下。只做保守的「干净合并」：两边改动的行区间重叠或紧挨着
// （git 同口径，紧挨着也算冲突）一律判冲突返回 null，交给调用方以磁盘为准、让用户自己决定——
// 宁可不合，也不能合出一篇谁都没写过的文字。

// 行级 diff：base 行数组 → 目标行数组，返回改动块 [{ b0, b1, lines }]（把 base[b0, b1) 换成 lines），
// 按 b0 升序。先剥公共首尾（笔记改动通常只在一两处，剩下的中段很短），中段走 LCS；
// 中段仍大到算不动时返回 null（调用方按冲突处理）。
const LCS_CELLS = 2_000_000;
function diffHunks(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf, m = b.length - pre - suf;
  if (!n && !m) return [];
  if (!n || !m) return [{ b0: pre, b1: pre + n, lines: b.slice(pre, pre + m) }];
  if ((n + 1) * (m + 1) > LCS_CELLS) return null;
  const W = m + 1, dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const out = [];
  let cur = null, i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) { if (cur) { out.push(cur); cur = null; } i++; j++; continue; }
    cur ||= { b0: pre + i, b1: pre + i, lines: [] };
    if (j < m && (i === n || dp[i * W + j + 1] >= dp[(i + 1) * W + j])) { cur.lines.push(b[pre + j]); j++; }
    else { i++; cur.b1 = pre + i; }
  }
  if (cur) out.push(cur);
  return out;
}

const sameHunk = (x, y) => x.b0 === y.b0 && x.b1 === y.b1 && x.lines.length === y.lines.length && x.lines.every((l, k) => l === y.lines[k]);

// base：两边共同的祖先；ours：草稿；theirs：磁盘现状。干净合并返回合并后的全文，冲突返回 null。
export function merge3(base, ours, theirs) {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const B = base.split('\n');
  const ho = diffHunks(B, ours.split('\n')), ht = diffHunks(B, theirs.split('\n'));
  if (!ho || !ht) return null;
  const out = [];
  let pos = 0, i = 0, j = 0;
  while (i < ho.length || j < ht.length) {
    const x = ho[i], y = ht[j];
    let h;
    if (x && y && x.b0 <= y.b1 && y.b0 <= x.b1) {   // 区间重叠或紧挨（含同一处插入）
      if (!sameHunk(x, y)) return null;               // 两边改成了一样的才算不冲突
      h = x; i++; j++;
    } else if (x && (!y || x.b0 < y.b0)) { h = x; i++; }
    else { h = y; j++; }
    for (let k = pos; k < h.b0; k++) out.push(B[k]);
    for (const l of h.lines) out.push(l);
    pos = h.b1;
  }
  for (let k = pos; k < B.length; k++) out.push(B[k]);
  return out.join('\n');
}

// 文本指纹（cyrb53 + 长度）：保存时告诉服务端「这次基于的是哪份磁盘原文」，服务端对不上就回 409 而不是覆盖。
// 与服务端 src/routes/file-core.mjs 的 textHash 同一算法、同一输入口径（UTF-16 码元，已去 BOM——
// fetch().text() 本就会剥掉 BOM），改一边必须两边一起改。
export function textHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}
