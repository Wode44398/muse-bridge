// 内核计时记录与网络等待封顶（现场排障用）。

import { reportUi } from '../uiReport.js';

// —— 内核计时记录（现场排障）——
// 手机上切会话要干等 ~10s 才挂上直播（10-27 维护者录屏），而服务端每个接口都在毫秒级——卡在
// WebView 里悬着的请求上，桌面复现不出来。每步收敛的耗时记进环形缓冲；某一步超过 2s 就把
// 最近的记录随视图上报（/api/ui/state，agent 接口 ui.state 读得到），下次真机再慢直接看卡在哪。
export const _trace = [];
export function trace(what, extra) {
  _trace.push([Date.now(), what, extra === undefined ? null : extra]);
  if (_trace.length > 60) _trace.shift();
}
let _slowReportAt = 0;
export function noteSlow(what, ms) {
  trace('slow:' + what, ms);
  if (Date.now() - _slowReportAt < 5000) return;
  _slowReportAt = Date.now();
  try { reportUi({ kernel: { at: Date.now(), slow: what, ms, trace: _trace.slice(-40) } }); } catch {}
}
// 内核里的每个网络等待都有上限：任何一个请求悬着不回，都不许把唯一的收敛路径卡死
//（_syncing 一直为真 → 之后所有唤醒都只记一笔 _syncAgain，视图就永远停在错的状态）。
// 超时只是「这次不等了」，抛错走各自的失败分支（重试 / 回退缓存）。
export function timed(what, p, ms) {
  const t0 = Date.now();
  let to = 0;
  const limit = new Promise((_, rej) => {
    to = setTimeout(() => rej(Object.assign(new Error(what + ' timeout'), { timeout: true })), ms);
  });
  return Promise.race([p, limit]).finally(() => {
    clearTimeout(to);
    const d = Date.now() - t0;
    if (d > 2000) noteSlow(what, d);
  });
}
