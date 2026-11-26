// 工作记录里「编辑了 …」展开后的改动片段、回答下面改动卡的那几样小算术（纯函数，有单测）。

/**
 * 一个文件的 diff → 逐行 { n, s, t }：s 是 '+' / '-' / ' '，'@' 是两段之间的分隔（t 为空）。
 * n 是新文件里的行号（删掉的行用旧文件行号）。Codex 新建 / 删除文件时给的是整份内容而不是 unified diff。
 * max：最多出这么多行，多出来的只计数（长 diff 展开时不一次塞几千个节点）。
 */
export function diffLines(diff, type = 'update', max = 400) {
  const src = String(diff || '').replace(/\r\n?/g, '\n');
  const out = [];
  let more = 0;
  if (!src) return { lines: out, more };
  const lines = src.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const push = (l) => { if (out.length < max) out.push(l); else more++; };
  const unified = /^@@/m.test(src) || /^(---|\+\+\+) /m.test(src);
  if (!unified) {
    const s = type === 'delete' ? '-' : '+';
    lines.forEach((t, i) => push({ n: i + 1, s, t }));
    return { lines: out, more };
  }
  let oldN = 0, newN = 0, seen = false;
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git') || l.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      if (seen) push({ n: null, s: '@', t: '' });
      seen = true;
      oldN = +h[1];
      newN = +h[2];
      continue;
    }
    if (l.startsWith('\\')) continue;   // \ No newline at end of file
    const c = l[0];
    if (c === '+') push({ n: newN++, s: '+', t: l.slice(1) });
    else if (c === '-') push({ n: oldN++, s: '-', t: l.slice(1) });
    else { push({ n: newN, s: ' ', t: l.slice(1) }); oldN++; newN++; }
  }
  return { lines: out, more };
}

/** 路径拆成目录和文件名（改动卡里目录淡、文件名实）。只留最后两级目录，长路径别把一行挤满。 */
export function splitPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop() || String(p || '');
  const dir = parts.slice(-2).join('/');
  return { dir: dir ? dir + '/' : '', name };
}

/** 增删比例画成五格（GitHub 那种）：全是增就五格绿。 */
export function bar5(a, d) {
  const total = (a || 0) + (d || 0);
  if (!total) return ['', '', '', '', ''];
  const na = Math.round((a / total) * 5);
  const nd = Math.min(5 - na, Math.round((d / total) * 5));
  return Array.from({ length: 5 }, (_, i) => (i < na ? 'a' : i < na + nd ? 'd' : ''));
}
