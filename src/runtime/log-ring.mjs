// 最近的服务日志（三端拆分 P4）：控制台「服务控制」页看日志用。stdout 在 systemd 下进 journald、Docker 下进
// docker logs——远程管理的手机上都够不着，所以进程内自己留一份最近 MAX 行（只在内存，重启即清）。
// 服务端本来就不往日志里打完整令牌（启动横幅只打前 4 位），这里原样照录，只给管理员看。
const MAX = 600;
const lines = [];
let installed = false;

function text(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

export function installLogRing() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const t = Date.now();
        for (const ln of text(args).split('\n')) lines.push({ t, level, text: ln.slice(0, 2000) });
        if (lines.length > MAX) lines.splice(0, lines.length - MAX);
      } catch {}
      orig(...args);
    };
  }
}

export function recentLogs(n = 300) { return lines.slice(-Math.max(1, Math.min(MAX, n))); }
