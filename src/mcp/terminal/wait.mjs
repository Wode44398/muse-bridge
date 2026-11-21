// 共享终端的「等」：agent 驱动 TUI / 长命令时不必反复 read 轮询，也不必绕道 sleep。
// 判据看的是镜像里结算后的屏幕，不是字节流：有的程序会原样重画同一帧，字节在动、屏幕没变，算安静；
// 转圈、计时器在走，屏幕在变，算还在干活。

import { screenState, bufferLines } from './screen.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等输出告一段落：最后一块输出之后安静 quietMs 就返回（最短 minMs、最长 maxMs）。
 * write / keys 发完用它代替固定的一小拍——回显慢的程序（远端、TUI 重排）那一拍拍到的还是旧屏幕。
 */
export function settle(svc, t, { quietMs = 400, minMs = 0, maxMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let last = t0, done = false;
    const finish = () => { if (done) return; done = true; clearInterval(iv); untap(); resolve(); };
    const untap = svc.tapTerm(t, (d) => { last = Date.now(); if (d == null) finish(); });
    const iv = setInterval(() => {
      const now = Date.now();
      if (now - t0 >= maxMs || (now - t0 >= minMs && now - last >= quietMs)) finish();
    }, 40);
  });
}

/** until：普通字符串按字面匹配；写成 /…/flags 按正则。 */
export function toMatcher(until) {
  const s = String(until ?? '');
  if (!s) return null;
  const m = /^\/(.+)\/([a-z]*)$/s.exec(s);
  if (m) {
    const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
    return new RegExp(m[1], flags);
  }
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}
const countIn = (re, text) => { re.lastIndex = 0; return (text.match(re) || []).length; };
function lineOf(re, text) {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  const a = text.lastIndexOf('\n', m.index) + 1;
  const b = text.indexOf('\n', m.index);
  return text.slice(a, b < 0 ? undefined : b).trim();
}

const sigOf = (st) => `${st.alt ? 'A' : 'N'}${st.cursorX},${st.cursorY}\n${st.rows.join('\n')}`;

/**
 * 等到：屏幕上出现 until（新出现的才算）、屏幕连续 quietMs 不变、shell 退出、或超时。
 * 「新出现」两种情形：普通屏上等待开始那一行之后写出来的；或可见屏幕上它出现的次数比开始时多
 * （原地重画的 TUI 没有「之后的行」）。返回 { reason, match?, changed, st }。
 */
export async function waitTerm(svc, t, { until, quietMs = 5000, timeoutMs = 120000, signal } = {}) {
  const re = toMatcher(until);
  const t0 = Date.now();
  let st = await screenState(svc, t);
  let sig = sigOf(st), lastChange = t0, changed = false;
  const count0 = re ? countIn(re, st.rows.join('\n')) : 0;
  // 开始那一刻光标所在行打个标记：滚回被裁时标记跟着走，行号不会错位
  const marker = re && st.term && !st.alt ? st.term.registerMarker(0) : null;
  let exited = false;
  const untap = svc.tapTerm(t, (d) => { if (d == null) exited = true; });
  try {
    for (;;) {
      if (signal?.aborted) return { reason: 'aborted', changed, st };
      if (exited || t.exited) return { reason: 'exit', changed, st };
      await sleep(300);
      st = await screenState(svc, t);
      const s = sigOf(st);
      if (s !== sig) { sig = s; lastChange = Date.now(); changed = true; }
      if (re) {
        const vis = st.rows.join('\n');
        let hit = countIn(re, vis) > count0 ? lineOf(re, vis) : null;
        if (!hit && marker && !marker.isDisposed && marker.line >= 0) {
          const b = st.term.buffer.normal;
          // 从标记的下一行起：标记那行是发命令的提示符行，等提示符时不能拿它自己算数
          hit = lineOf(re, bufferLines(b, marker.line + 1, b.length).join('\n'));
        }
        if (hit) return { reason: 'match', match: hit, changed: true, st };
      }
      const now = Date.now();
      if (quietMs > 0 && now - lastChange >= quietMs) return { reason: 'quiet', changed, st };
      if (now - t0 >= timeoutMs) return { reason: 'timeout', changed, st };
    }
  } finally {
    untap();
    try { marker?.dispose(); } catch { /* 镜像已收 */ }
  }
}

// 屏幕末尾像在等人确认 / 像出了错：只是提示 agent 去看，不替它下结论（输出里本来就常有 error 字样）。
const ATTENTION = [
  /\[(?:y\/n|Y\/n|y\/N|yes\/no)\]/, /\((?:y\/n|yes\/no)\)/i, /\b(?:y\/n|yes\/no)\s*[:?]?\s*$/im,
  /press (?:enter|any key|return)/i, /enter\s+(?:to\s+)?confirm/i, /↑\/↓|arrow keys/i,
  /\b(?:do you (?:want|trust|wish)|would you like|are you sure|allow (?:this|once|always)\b|approve\?|proceed\?|continue\?)/i,
  /^\s*[>❯›]\s*(?:\d+[.)]\s*)?(?:yes|no|allow|deny|approve|reject)\b/im,
  /password|passphrase|口令|密码/i, /是否|确认|继续吗|按回车/,
];
const ERROR = [
  /\berror\b|\bfailed\b|\bfailure\b|exception|traceback|panic:/i,
  /unavailable|not available|overloaded|model .*not (?:found|supported)/i,
  /timed? ?out|ECONN\w*|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed/i,
  /rate.?limit|quota|too many requests|\b429\b|\b50[0234]\b/i,
  /失败|错误|超时|不可用|无法连接|拒绝/,
];
function firstHit(patterns, rows) {
  for (let i = rows.length - 1; i >= 0; i--) if (patterns.some((p) => p.test(rows[i]))) return rows[i].trim();
  return null;
}

/** 屏幕末尾十来行里像「等确认」/「出错」的那一行（没有为 null）。 */
export function screenHints(st) {
  const rows = st.rows.filter((r) => r.trim()).slice(-12);
  return { attention: firstHit(ATTENTION, rows), error: firstHit(ERROR, rows) };
}
