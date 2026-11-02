// 定时任务的自定义频率：标准 5 段 cron（分 时 日 月 周，不带秒），按服务器本地时区算。
// 规则照官方 Claude Desktop 的「Custom」：只认数字（不认 JAN / MON 这类名字），周几 0 = 周日、不收 7，
// 最多每小时跑一次（分钟段必须是单个数字）。日与周都受限时按标准 cron 取并集（任一满足即触发）。

const FIELDS = [
  { name: '分钟', lo: 0, hi: 59 },
  { name: '小时', lo: 0, hi: 23 },
  { name: '日', lo: 1, hi: 31 },
  { name: '月', lo: 1, hi: 12 },
  { name: '周', lo: 0, hi: 6 },
];

function fail(msg) { throw Object.assign(new Error(msg), { status: 400 }); }

// 一段 → 允许值的有序数组；star = 这一段是不是「全部」（* 或 */1），日/周的并集规则要用。
function parseField(src, f) {
  const out = new Set();
  let star = false;
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) {
      if (/[a-z]/i.test(part)) fail('只能用数字（例如周一写 1），不支持英文缩写');
      fail(`「${f.name}」段写法不对：${part}`);
    }
    const step = m[4] != null ? Number(m[4]) : 1;
    if (!(step >= 1)) fail(`「${f.name}」段的步长要大于 0`);
    let a, b;
    if (m[1] === '*') { a = f.lo; b = f.hi; if (step === 1) star = true; }
    else {
      a = Number(m[2]); b = m[3] != null ? Number(m[3]) : (m[4] != null ? f.hi : a);
      if (f.name === '周' && (a === 7 || b === 7)) fail('周日请写 0（这里不支持 7）');
      if (a < f.lo || b > f.hi || a > b) fail(`「${f.name}」段超出范围（${f.lo}–${f.hi}）：${part}`);
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return { values: [...out].sort((x, y) => x - y), star };
}

/** 解析并校验。返回 { minute, hour, dom, month, dow }（各为 { values, star }）；不合法抛 400。 */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) fail('cron 要写 5 段：分 时 日 月 周（例如 0 9 * * 1-5）');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (minute.values.length !== 1) fail('最多每小时运行一次：分钟段只能写一个数字');
  return { minute, hour, dom, month, dow };
}

/** 合法就返回规范化的表达式（段间单空格），否则抛 400。 */
export function normalizeCron(expr) {
  parseCron(expr);
  return String(expr).trim().split(/\s+/).join(' ');
}

const dayOk = (c, d) => {
  const domHit = c.dom.values.includes(d.getDate());
  const dowHit = c.dow.values.includes(d.getDay());
  if (c.dom.star && c.dow.star) return true;
  if (c.dom.star) return dowHit;
  if (c.dow.star) return domHit;
  return domHit || dowHit;   // 标准 cron：两段都受限时任一满足
};

/** from 之后（不含）下一次触发的毫秒时间戳；五年内都不触发（如 2 月 30 日）返回 null。 */
export function nextCron(expr, from = Date.now()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const min = c.minute.values[0];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 366 * 5; i++) {
    if (c.month.values.includes(d.getMonth() + 1) && dayOk(c, d)) {
      for (const h of c.hour.values) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, 0, 0);
        // 夏令时跳过的钟点：Date 会顺延到别的钟点，不算命中
        if (t.getHours() !== h) continue;
        if (t.getTime() > from) return t.getTime();
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}
