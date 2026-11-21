// 服务端自己监听的本机地址。bridge 拉起的 agent 和服务端在同一台机器上，自测插件 / 应用要的就是它；
// 不给的话 agent 只能扫本机端口去猜，而一台机器上常同时开着好几个 bridge 实例，容易测到别的实例上。
// 只听某一块网卡（BRIDGE_HOST 写了具体 IP）时回环连不上，就用那个地址。
import { PORT, LISTEN_HOST } from '../config/index.mjs';

export function localOrigin() {
  const h = String(LISTEN_HOST || '');
  const any = !h || h === '0.0.0.0' || h === '::' || h === 'localhost' || /^127\./.test(h) || h === '::1';
  return 'http://' + (any ? '127.0.0.1' : h.includes(':') ? '[' + h + ']' : h) + ':' + PORT;
}
