// 只许连公网：给「普通成员自带 Key 的模型服务」用（2026-10-27，claude-providers*.mjs）。
//
// 成员填的接口地址由主机替他去连——不拦就是 SSRF：127.0.0.1 上的 bridge 控制台、局域网路由器、云厂商元数据
// 169.254.169.254 都能被他借主机的网络摸到。所以：
//   · assertPublicUrl(url)  保存 / 测试前查一遍：IP 字面量直接判；域名解析出的【每个】地址都得是公网；
//   · publicDispatcher()    真正发请求用的 undici 连接器：连接时再解析、再判一次（防 DNS rebinding——查时公网、
//                           连时换成内网）。走出站代理时 DNS 在代理那边解析，只能靠前一道检查。
// 主机管理员不走这里（他本来就能连本机模型、局域网服务）。
import net from 'node:net';
import dns from 'node:dns';
import { Agent } from 'undici';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(a, p, 'ipv6');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** 这个 IP 是不是内网 / 本机 / 保留地址（IPv4 映射的 IPv6 按里面的 IPv4 判）。认不出的一律当内网。 */
export function isPrivateIp(ip) {
  let s = String(ip || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  const fam = net.isIP(s);
  if (!fam) return true;
  return blocked.check(s, fam === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|intranet|lan|home|corp|arpa)$/i;

/** 地址只许指向公网：不是就抛 400（人话）。 */
export async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw bad('接口地址不是合法网址'); }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw bad('接口地址缺主机名');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw bad(`接口地址 ${host} 是内网 / 本机地址，只有主机管理员能接`);
    return;
  }
  if (LOCAL_NAMES.test(host) || !host.includes('.')) throw bad(`接口地址 ${host} 是内网 / 本机地址，只有主机管理员能接`);
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch (e) { throw Object.assign(new Error(`解析不了域名 ${host}（${(e && e.code) || e}）`), { status: 502 }); }
  const hit = addrs.find((a) => isPrivateIp(a.address));
  if (hit) throw bad(`接口地址 ${host} 解析到内网地址 ${hit.address}，只有主机管理员能接`);
}

// 连接时的 DNS 查询：解析结果里有内网地址就整个拒掉（不挑公网的那个用——宁可不连）。
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options && options.family }];
    const hit = list.find((a) => isPrivateIp(a.address));
    if (hit || !list.length) return cb(Object.assign(new Error(`拒绝连接内网地址 ${hit ? hit.address : hostname}`), { code: 'EPRIVATEADDR' }));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

let agent = null;
/** 直连且连接时再查一遍地址的 undici dispatcher（只用于成员的服务；IP 字面量地址不过 lookup，靠 assertPublicUrl 拦）。 */
export function publicDispatcher() {
  return (agent ||= new Agent({ connect: { timeout: 30_000, lookup: guardedLookup } }));
}
