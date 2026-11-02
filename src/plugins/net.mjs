// ctx.net（插件接口四期）：插件访问外网用的几样小东西。
//
// bridge 进程里的 fetch 本来就走出站代理（runtime/net-proxy.mjs 设了全局 dispatcher），之后拉起的子进程也继承
// HTTPS_PROXY——但插件托管的程序常常要把代理地址写进它自己的配置（gemini-webapi、NapCat……），所以给出当前出口：
//   ctx.net.proxy()            → 当前出站代理地址，直连 / 没探到时 ''
//   ctx.net.onProxyChange(fn)  → 出口变了调 fn(新地址, 旧地址)（30 秒查一次；停用时自动撤）
//   ctx.net.fetch(url, init)   → 全局 fetch + 默认 30 秒时限（init.timeoutMs 改；init.signal 照样认）
import { outboundProxyStatus } from '../runtime/net-proxy.mjs';

const currentProxy = () => { try { return String(outboundProxyStatus().proxy || ''); } catch { return ''; } };

export function makeNet(ctx) {
  return {
    proxy: currentProxy,
    onProxyChange(fn) {
      if (typeof fn !== 'function') throw new Error('ctx.net.onProxyChange 要一个函数 (now, before) => …');
      let last = currentProxy();
      ctx.setInterval(() => {
        const now = currentProxy();
        if (now === last) return;
        const before = last;
        last = now;
        try { const r = fn(now, before); r?.catch?.((e) => ctx.warn('出口变化处理出错：', e?.message || e)); }
        catch (e) { ctx.warn('出口变化处理出错：', e?.message || e); }
      }, 30_000);
    },
    async fetch(url, init = {}) {
      const { timeoutMs = 30_000, signal, ...rest } = init || {};
      const t = AbortSignal.timeout(Math.max(1000, Math.min(Number(timeoutMs) || 30_000, 10 * 60_000)));
      return fetch(url, { ...rest, signal: signal ? AbortSignal.any([signal, t]) : t });
    },
  };
}
