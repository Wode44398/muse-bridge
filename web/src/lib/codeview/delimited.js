// CSV / TSV 解析（RFC 4180：双引号包字段、"" 转义、字段内可含分隔符与换行；CRLF / LF / CR 都认）。
// 给表格视图（TableView.svelte）用：只解析不求值，5 万行 3MB 一次过 < 100ms。
//
//   detectDelim(text, ext)                → ',' | '\t' | ';' | '|'
//   parseDelimited(text, { delim, maxRows }) → { rows: string[][], cols, truncated }
//   colWidths(rows, { sample, min, max })   → number[]（px，按字符宽度估算：中日韩全角算 2 个字宽）
//
// 纪律：零依赖、不碰 DOM。

export function detectDelim(text, ext = '') {
  if (ext === 'tsv' || ext === 'tab') return '\t';
  // 前几行里各候选出现次数稳定（每行一样多）且最多的那个；都没有就逗号
  const lines = String(text).slice(0, 16384).split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 12);
  let best = ',', bestN = 0;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const n = Math.min(...counts);
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}
function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

export function parseDelimited(text, { delim = ',', maxRows = Infinity } = {}) {
  const s = String(text);
  const n = s.length, D = delim.charCodeAt(0), Q = 34, CR = 13, LF = 10;
  const rows = [];
  let row = [], i = 0, cols = 0, truncated = false;
  if (s.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    let field;
    if (s.charCodeAt(i) === Q) {
      // 带引号的字段：找配对的结束引号（"" 是转义）
      let j = i + 1, buf = '', from = j;
      for (;;) {
        const k = s.indexOf('"', j);
        if (k < 0) { buf += s.slice(from); j = n; break; }
        if (s.charCodeAt(k + 1) === Q) { buf += s.slice(from, k + 1); j = k + 2; from = j; continue; }
        buf += s.slice(from, k); j = k + 1; break;
      }
      // 结束引号后到分隔符 / 行尾之间的杂字（不规范的 "a"b）照原样接上
      let e = j;
      while (e < n) { const c = s.charCodeAt(e); if (c === D || c === CR || c === LF) break; e++; }
      field = e > j ? buf + s.slice(j, e) : buf;
      i = e;
    } else {
      let e = i;
      while (e < n) { const c = s.charCodeAt(e); if (c === D || c === CR || c === LF) break; e++; }
      field = s.slice(i, e);
      i = e;
    }
    row.push(field);
    const c = s.charCodeAt(i);
    if (c === D) { i++; if (i >= n) row.push(''); continue; }
    // 行尾（或文末）
    if (c === CR) i += s.charCodeAt(i + 1) === LF ? 2 : 1;
    else if (c === LF) i++;
    if (row.length > cols) cols = row.length;
    rows.push(row);
    row = [];
    if (rows.length >= maxRows) { truncated = i < n; break; }
  }
  if (row.length) { rows.push(row); if (row.length > cols) cols = row.length; }
  return { rows, cols, truncated };
}

// 列宽：抽样前 sample 行，按显示宽度（全角 2、半角 1）× 字宽估，夹在 [min, max]
export function colWidths(rows, { sample = 300, min = 64, max = 360, ch = 7.6, pad = 24 } = {}) {
  const w = [];
  const m = Math.min(rows.length, sample);
  for (let r = 0; r < m; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      let dw = 0;
      const lim = Math.min(v.length, 80);
      for (let k = 0; k < lim; k++) dw += v.charCodeAt(k) > 0x2e7f ? 2 : 1;
      const px = dw * ch * (r === 0 ? 1.08 : 1) + pad;   // 表头字重大一点
      if (!(px <= w[c])) w[c] = px;
    }
  }
  return w.map((x) => Math.round(Math.max(min, Math.min(max, x || min))));
}

/** 选区（行列矩形）转 TSV 文本：复制到剪贴板后能直接贴进表格软件 */
export function toTsv(rows, r0, c0, r1, c1) {
  const out = [];
  for (let r = r0; r <= r1; r++) {
    const row = rows[r] || [];
    const cells = [];
    for (let c = c0; c <= c1; c++) {
      const v = row[c] ?? '';
      cells.push(/[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    }
    out.push(cells.join('\t'));
  }
  return out.join('\n');
}
