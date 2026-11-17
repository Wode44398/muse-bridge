// 智能分派的状态落盘：学到的计量速率、各会话绑的号与段大小估计。服务重启后续聊回到原号、估计不用从头学。
// 写盘去抖：请求一个接一个地来，状态每次都在变，攒 3 秒写一次；进程退出前最后一次没写上也只是少几次学习样本。

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function createStore(file, { delay = 3000 } = {}) {
  let timer = null;
  let source = null;
  function read() {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }
  function flush() {
    timer = null;
    if (!source) return;
    try {
      const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
      writeFileSync(tmp, JSON.stringify(source()));
      renameSync(tmp, file);
    } catch (e) { console.error('[account-router] 分派状态写盘失败：', (e && e.message) || e); }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, delay);
    if (timer.unref) timer.unref();
  }
  return { read, schedule, flush, bind(fn) { source = fn; } };
}
