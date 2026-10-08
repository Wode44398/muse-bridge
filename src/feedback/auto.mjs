// 自动上报：用户事先同意过（安装时 Muse 问一次，或设置 → 反馈里打开）才生效。
// 只管服务端自己能确认的故障——没接住的异常、路由 500——不碰对话内容；同一个指纹每个版本只报一次，
// 每天最多 5 份。更新失败的自动上报在看门狗那边（bootstrap.sh report --auto）。
import { onNewError, recordError } from './errors.mjs';
import { makeDraft, sendDraft, flushOutbox, programVersion } from './report.mjs';
import { getSettings, autoSentFor, autoSentToday, pruneDrafts } from './store.mjs';

const DAILY_MAX = 5;
const pending = new Map();   // fp -> timer

export function startFeedback({ envInfo } = {}) {
  const version = programVersion();
  onNewError((e) => {
    if (e.where !== 'server' || getSettings().auto !== true) return;
    if (pending.has(e.fp) || autoSentFor(e.fp, version) || autoSentToday() >= DAILY_MAX) return;
    // 等一会儿再发：同一阵子里连着出的错能一起算进计数；进程要是马上又崩了，下次启动补发也不迟
    const t = setTimeout(async () => {
      pending.delete(e.fp);
      if (getSettings().auto !== true || autoSentFor(e.fp, version)) return;
      try {
        const d = makeDraft({ kind: 'crash', source: 'auto', fp: e.fp, errors: [e], withServerErrors: false, env: envInfo?.() || {} });
        const r = await sendDraft(d.id);
        console.log(`[feedback] 自动上报 ${e.fp}：${r.status}${r.issue ? ' #' + r.issue.number : ''}`);
      } catch (err) { console.warn('[feedback] 自动上报失败：', err?.message || err); }
    }, 20_000);
    t.unref?.();
    pending.set(e.fp, t);
  });
  // 补发：启动 1 分钟后一次，之后每 10 分钟
  const flush = () => flushOutbox().then((r) => { if (r.length) console.log(`[feedback] 补发 ${r.length} 份：${r.map((x) => x.status).join(',')}`); }).catch(() => {});
  setTimeout(flush, 60_000).unref?.();
  setInterval(() => { flush(); pruneDrafts(); }, 10 * 60_000).unref?.();
}

export { recordError };
