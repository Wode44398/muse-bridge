// 公网地址变化 → 推给所有在线设备（S1-1）。server.mjs 把公网访问（runtime/public-access.mjs）的总线事件转到这里：
//   {type:'public-access', url}        地址生效（含快速隧道换了新地址、关掉公网访问恢复配置地址）
//   {type:'public-access.next', url}   先接后拆：新隧道已连上、旧的还没拆——提前把新地址推出去
// 推的是 {type:'server.address', id, publicOrigin | next, kind, at}，不带任何凭据；所有身份的总线都收（公网地址本来就是
// 大家正在用的那个，换了谁都要知道）。设备收到后的处理见 web/src/lib/serverAddress.js。
import { busPublishAll } from './bus.mjs';
import { serverAddress } from './server-address.mjs';
import { PUBLIC_ORIGIN } from '../config/index.mjs';

export function onPublicAccessEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  let out = null;
  try {
    if (ev.type === 'public-access.next' && ev.url) out = serverAddress().noteOrigin(ev.url, { mode: ev.mode || '', next: true });
    // 'public-access' 的 url 为空（关掉、外部托管）时运行态回落到配置里的地址：推那个
    else if (ev.type === 'public-access') out = serverAddress().noteOrigin(ev.url || PUBLIC_ORIGIN, { mode: ev.mode || '' });
  } catch (e) { console.warn('[address] 记录地址失败：' + (e?.message || e)); }
  if (out) { try { busPublishAll(out); } catch {} }
}
