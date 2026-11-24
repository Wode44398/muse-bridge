// 市场下载：索引、签名、插件包都走这里。有签名兜底，下载地址不死守域名：https 任意域，或与索引同源（自建 / 测试市场走 http 回环时用）。
// 手动跟重定向，每一跳都重新校验地址；按字节数封顶，超了立刻停。
import { PluginError } from '../discover.mjs';

export const UA = 'claude-bridge-plugins';
export const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

function allowedUrl(u, sameOrigin) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password) return false;
  return x.protocol === 'https:' || (!!sameOrigin && x.origin === sameOrigin);
}

export async function fetchBytes(url, { max, timeoutMs, sameOrigin }) {
  let cur = String(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowedUrl(cur, sameOrigin)) throw new PluginError(400, '下载地址不合规（要 https）：' + cur.slice(0, 120));
    let res;
    try { res = await fetch(cur, { redirect: 'manual', signal, headers: { 'user-agent': UA, accept: '*/*' } }); }
    catch (e) { throw new PluginError(502, '连不上插件市场：' + String(e?.cause?.code || e?.message || e).slice(0, 120)); }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { try { await res.body?.cancel(); } catch {} cur = new URL(loc, cur).href; continue; }
    if (res.status === 404) throw new PluginError(404, '插件市场上没有这个文件（404）');
    if (!res.ok) throw new PluginError(502, '插件市场回了 HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) throw new PluginError(413, '文件比预期大，没下');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > max) throw new PluginError(413, '文件比预期大，没下');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  throw new PluginError(502, '重定向太多次');
}
