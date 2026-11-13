#!/usr/bin/env node
// 模拟 apk 离线壳 + 局域网直连，检查 Media Studio 的媒体（图 / 视频 / 音频）能不能加载出来。
//   node web/scripts/studio-qa/lanshell.mjs --app <构建好的 public/app> --api http://127.0.0.1:<隔离实例端口> --config <实例的 config.json> --out <目录> [--mode lan|tunnel] [--tag 名字]
//     [--lan-ip <本机虚拟网卡 IP>] [--break]（一半作品的媒体请求强制连不上，看失败态）[--settings]（量设置页体量）
//
// 怎么模拟（2026-11-06，维护者在家 Wi-Fi 下「最近的图像」全是灰块）：
//   · 页面来源 https://appassets.androidplatform.net（离线壳的本地源，isOffline() 认它）：本地 HTTPS 服务出静态前端；
//   · 隧道 https://tunnel.test：同一个 HTTPS 服务按 Host 反代到隔离实例（流式，SSE 也能走）；
//   · 局域网 http://lan.test:<端口>：--host-resolver-rules 解析到 127.0.0.1——它不是 localhost，所以对 https 页面来说
//     和 http://192.168.x.x 一样算混合内容（这正是要模拟的）；
//   · --allow-running-insecure-content ≈ WebView 的 MIXED_CONTENT_ALWAYS_ALLOW（fetch / XHR 这类「主动」混合内容放行）；
//   · 令牌放 localStorage bridge-token，媒体走 ?token=（同 apk）。证书自签，--ignore-certificate-errors。
// 输出：每页截图 + lanshell.json（每个媒体元素的地址、加载结果、网络层失败原因、按主机统计的请求）。
import { createServer as createHttps } from 'node:https';
import { createServer as createTcp, connect as tcpConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchEdge, openPage, sleep } from './cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const APP = path.resolve(String(args.app || 'public/app'));
const API = new URL(String(args.api || 'http://127.0.0.1:8820'));
const TOKEN = JSON.parse(readFileSync(String(args.config), 'utf8')).token;
const OUT = path.resolve(String(args.out || 'lanshell-out'));
const MODE = String(args.mode || 'lan');
const TAG = String(args.tag || MODE);
mkdirSync(OUT, { recursive: true });

// —— 自签证书（openssl；Git Bash 自带）——
const certDir = path.join(os.tmpdir(), 'studio-qa-lanshell-cert');
mkdirSync(certDir, { recursive: true });
const keyF = path.join(certDir, 'key.pem'), crtF = path.join(certDir, 'cert.pem');
if (!existsSync(keyF) || !existsSync(crtF)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=studio-qa', '-keyout', keyF, '-out', crtF], { stdio: 'ignore' });
}

// —— 本地 HTTPS：appassets → 静态前端；tunnel.test → 反代隔离实例 ——
const CT = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', json: 'application/json', webmanifest: 'application/manifest+json', woff2: 'font/woff2', wasm: 'application/wasm', jpg: 'image/jpeg', ico: 'image/x-icon', txt: 'text/plain' };
const srv = createHttps({ key: readFileSync(keyF), cert: readFileSync(crtF) }, (req, res) => {
  const host = String(req.headers.host || '').split(':')[0];
  if (host === 'tunnel.test') {
    const p = httpRequest({ host: API.hostname, port: API.port, method: req.method, path: req.url, headers: { ...req.headers, host: API.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(p);
    return;
  }
  // appassets：/app/<文件>；找不到的路径回 index.html（同 WebViewAssetLoader + SPA）
  const u = new URL(req.url, 'https://x');
  let rel = decodeURIComponent(u.pathname.replace(/^\/app\/?/, ''));
  let f = path.join(APP, rel || 'index.html');
  if (!f.startsWith(APP) || !existsSync(f) || statSync(f).isDirectory()) f = path.join(APP, 'index.html');
  res.writeHead(200, { 'Content-Type': CT[path.extname(f).slice(1)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
// 局域网地址：--lan-ip 给了就用真 IP 字面量（真机 /api/lan 学到的就是 IP；Chromium 对 IP 字面量不做混合内容自动升级，
// 对域名才做——两者表现不同，判断真机问题一律用 IP），在那个地址上开一个转发口转到隔离实例。
// 建议用只在本机可见的虚拟网卡地址（Hyper-V / WSL 的 vEthernet），别把实例暴露到物理局域网。
const LAN_IP = args['lan-ip'] ? String(args['lan-ip']) : '';
let fwd = null, LAN = `http://lan.test:${API.port}`;
if (LAN_IP) {
  fwd = createTcp((c) => { const u = tcpConnect(Number(API.port), API.hostname); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); });
  await new Promise((r) => fwd.listen(0, LAN_IP, r));
  LAN = `http://${LAN_IP}:${fwd.address().port}`;
}

const edge = await launchEdge({ extraArgs: [
  `--host-resolver-rules=MAP appassets.androidplatform.net 127.0.0.1:${PORT}, MAP tunnel.test 127.0.0.1:${PORT}, MAP lan.test 127.0.0.1`,
  '--ignore-certificate-errors', '--allow-running-insecure-content',
] });
const result = { tag: TAG, mode: MODE, lan: LAN, pages: {}, hosts: {}, failures: [] };
try {
  const pg = await openPage(edge);
  await pg.send('Network.enable');
  const reqs = new Map();
  pg.conn.on('Network.requestWillBeSent', (p, sid) => {
    if (sid !== pg.sessionId) return;
    const u = new URL(p.request.url); const h = u.protocol + '//' + u.host;
    reqs.set(p.requestId, { url: p.request.url, type: p.type, host: h, t: Date.now(), done: false });
    if (/^\/api\//.test(u.pathname)) result.hosts[h] = (result.hosts[h] || 0) + 1;
  });
  pg.conn.on('Network.loadingFinished', (p, sid) => { if (sid === pg.sessionId && reqs.has(p.requestId)) reqs.get(p.requestId).done = true; });
  // --break：模拟「真加载不出来」——作品 id 末位是 0-7 的那一半媒体请求一律连不上（LAN 和隧道都断），看失败态是不是可重试的
  if (args.break) {
    pg.conn.on('Fetch.requestPaused', (p, sid) => {
      if (sid !== pg.sessionId) return;
      const id = new URL(p.request.url).searchParams.get('id') || '';
      const kill = /[0-7]$/i.test(id);
      pg.send(kill ? 'Fetch.failRequest' : 'Fetch.continueRequest', kill ? { requestId: p.requestId, errorReason: 'ConnectionFailed' } : { requestId: p.requestId }).catch(() => {});
    });
    await pg.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/vertex/media*', requestStage: 'Request' }] });
  }
  pg.conn.on('Network.loadingFailed', (p, sid) => {
    if (sid !== pg.sessionId) return;
    const r = reqs.get(p.requestId) || {};
    r.done = true;
    if (/\/api\/vertex\/media/.test(r.url || '')) result.failures.push({ url: String(r.url).replace(/token=[^&]+/, 'token=…'), type: r.type, error: p.errorText, blocked: p.blockedReason || '', cors: p.corsErrorStatus?.corsError || '' });
  });
  await pg.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 873, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 873 });
  await pg.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    try {
      if (!localStorage.getItem('__qa_seeded')) {
        localStorage.setItem('bridge-server', 'https://tunnel.test');
        ${MODE === 'lan' ? `localStorage.setItem('bridge-server-lan', ${JSON.stringify(LAN)});` : `localStorage.removeItem('bridge-server-lan');`}
        localStorage.setItem('bridge-token', ${JSON.stringify(TOKEN)});
        localStorage.setItem('bridge-theme', 'light');
        localStorage.setItem('__qa_seeded', '1');
      }
    } catch {}
    let d = false; const ap = () => { const de = document.documentElement; if (!de || d) return; d = true; de.style.setProperty('--sat', '40px'); de.style.setProperty('--sab', '20px');
      const st = document.createElement('style'); st.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}'; (document.head || de).appendChild(st); };
    ap(); if (!d) document.addEventListener('readystatechange', ap);
  })();` });
  await pg.send('Page.navigate', { url: 'https://appassets.androidplatform.net/app/index.html' });
  // 等首页
  await pg.eval(`(async () => { for (let i = 0; i < 300; i++) { if (document.readyState === 'complete' && !document.documentElement.hasAttribute('data-booting') && [...document.querySelectorAll('img')].some((x) => x.src.includes('/icons/studio-') && x.getBoundingClientRect().width > 0)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`, { timeout: 40000 });
  if (MODE === 'lan') {
    // 等局域网探活通过（后续 /api 请求开始走 lan.test）
    for (let i = 0; i < 60 && !result.hosts[LAN]; i++) await sleep(250);
  }
  await sleep(1500);
  // 进 Media Studio：点主页上的入口
  // 用真实触摸点主页上的入口（主页方块认的是指针手势，element.click() 只会让 Studio 在后台预挂载、不会真打开）
  const tile = await pg.eval(`(() => { const i = [...document.querySelectorAll('img')].find((x) => x.src.includes('/icons/studio-') && x.getBoundingClientRect().width > 0); const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const open = () => pg.eval(`(() => document.elementsFromPoint(innerWidth / 2, 70).some((e) => e.classList && (e.classList.contains('sd-top') || e.classList.contains('sd-cbar'))))()`);
  for (let k = 0; k < 3 && !(await open()); k++) {
    await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tile.x, y: tile.y, id: 1 }] });
    await sleep(80);
    await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (let i = 0; i < 40 && !(await open()); i++) await sleep(150);
  }
  if (!(await open())) throw new Error('没能打开 Media Studio');
  const inspect = async (name) => {
    await sleep(3500);
    const media = await pg.eval(`(() => [...document.querySelectorAll('.studio-root img, .studio-root video, .studio-root audio')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0 || m.tagName === 'AUDIO'; }).map((m) => {
      const src = m.currentSrc || m.src || ''; let host = ''; try { const u = new URL(src); host = u.protocol + '//' + u.host; } catch {}
      const ok = m.tagName === 'IMG' ? m.complete && m.naturalWidth > 0 : m.readyState >= 1 && !m.error;
      // 视口外、还没轮到加载的懒加载图不算坏（作品流滚到下面才加载）
      const r = m.getBoundingClientRect();
      const lazyIdle = m.tagName === 'IMG' && m.loading === 'lazy' && !m.complete && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || m.closest('[inert],[aria-hidden="true"]'));
      return { tag: m.tagName.toLowerCase(), cls: (m.parentElement?.className || '').toString().split(' ')[0], host, ok, lazyIdle, state: m.dataset.media || '', err: m.error ? m.error.code : null };
    }).filter((m) => !m.lazyIdle))()`);
    const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
    writeFileSync(path.join(OUT, `${TAG}-${name}.jpg`), Buffer.from(r.data, 'base64'));
    // 还挂着没完成的媒体请求（发出超过 3 秒）：按类型计数——HTTP/1.1 每主机 6 条连接被占满时，后来的图就一直排队
    const pend = [...reqs.values()].filter((q) => !q.done && q.url.includes('/api/vertex/media') && Date.now() - q.t > 3000);
    const pending = pend.reduce((o, q) => { const k = q.type + ' ' + q.host; o[k] = (o[k] || 0) + 1; return o; }, {});
    result.pages[name] = { pending, total: media.length, ok: media.filter((m) => m.ok).length, broken: media.filter((m) => !m.ok).length, byHost: media.reduce((o, m) => { const k = m.host + (m.ok ? ' ok' : ' 坏'); o[k] = (o[k] || 0) + 1; return o; }, {}), media };
    process.stdout.write(`  ${TAG} ${name.padEnd(14)} 媒体 ${media.length}，好 ${result.pages[name].ok}，坏 ${result.pages[name].broken}  ${JSON.stringify(result.pages[name].byHost)}${pend.length ? '  挂着的请求 ' + JSON.stringify(pending) : ''}\n`);
  };
  const tab = (i) => pg.eval(`(async () => { document.querySelectorAll('.studio-root .sd-cbar .seg button, .studio-root .sd-tabs-row .seg button')[${i}].click(); await new Promise((r) => setTimeout(r, 500)); return 1; })()`);
  if (args.settings) {
    // —— 设置 › Media Studio 的体量：条目数、说明小字总字数、手机主页面高度（几屏）；服务编辑器各区说明字数 ——
    // 「说明小字」= 行下面的副文（.r-sub / .r-dsub / .ts）、分组脚注（.gfoot / .dgfoot）、导入卡里的说明（.iwhat / .why / .ivc p）、
    // 头图副标题（.hero-sub）、段落（p）；值（.r-d、行尾状态）不算。修前修后同一口径。
    const shot = async (n) => { const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }); writeFileSync(path.join(OUT, `${TAG}-${n}.jpg`), Buffer.from(r.data, 'base64')); };
    await pg.eval(`(async () => { const bs = document.querySelectorAll('.studio-root .sd-top-r .sd-ib, .studio-root .sd-cbar-r .sd-ib'); bs[bs.length - 1].click(); for (let i = 0; i < 80; i++) { const s = document.querySelector('.pg.top .sst'); if (s && s.querySelectorAll('button').length > 3) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`, { timeout: 15000 });
    await sleep(1500);
    const EXPL = '.r-sub, .r-dsub, .gfoot, .iwhat, .why, .hero-sub, .ivc p, .ts, p';
    const measure = (rootSel) => pg.eval(`(() => {
      const root = document.querySelector(${JSON.stringify(rootSel)}); if (!root) return null;
      const sc = root.closest('.pg-scroll') || root;
      const seen = new Set(); let chars = 0; const samples = [];
      for (const e of root.querySelectorAll(${JSON.stringify(EXPL)})) {
        if ([...seen].some((s) => s.contains(e))) continue; seen.add(e);
        const tx = (e.textContent || '').replace(/\\s+/g, ''); if (!tx) continue;
        chars += [...tx].length; if (samples.length < 40) samples.push(tx.slice(0, 30));
      }
      const rows = root.querySelectorAll('.r, .it, .drow, .row').length;
      return { rows, chars, samples, screens: +(sc.scrollHeight / sc.clientHeight).toFixed(2), scrollH: sc.scrollHeight, viewH: sc.clientHeight };
    })()`);
    result.settings = { main: await measure('.pg.top .pg-body') };
    process.stdout.write(`  ${TAG} 设置主页面：条目 ${result.settings.main?.rows}，说明小字 ${result.settings.main?.chars} 字，高 ${result.settings.main?.screens} 屏\n`);
    const sh = result.settings.main?.screens || 1;
    for (let k = 0; k < Math.ceil(sh); k++) {
      await pg.eval(`(() => { const s = document.querySelector('.pg.top .pg-scroll'); s.scrollTop = ${k} * s.clientHeight * 0.9; return 1; })()`);
      await sleep(400); await shot('settings-' + (k + 1));
    }
    // 服务编辑器：点第一个服务
    const opened = await pg.eval(`(async () => { const b = [...document.querySelectorAll('.pg.top .sst button.r')].find((x) => /Google Vertex AI/.test(x.textContent)); if (!b) return false; b.click(); for (let i = 0; i < 60; i++) { if (document.querySelector('.sst-layer .ed')) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`, { timeout: 10000 });
    if (opened) {
      await sleep(1200);
      result.settings.editor = {};
      const navs = await pg.eval(`document.querySelectorAll('.sst-layer nav.side button.nav').length`);
      for (let i = 0; i < navs; i++) {
        await pg.eval(`(async () => { document.querySelectorAll('.sst-layer nav.side button.nav')[${i}].click(); await new Promise((r) => setTimeout(r, 700)); return 1; })()`);
        const m = await pg.eval(`(() => { const b = document.querySelector('.sst-layer .ed .body'); const seen = new Set(); let chars = 0; const samples = [];
          for (const e of b.querySelectorAll('.fh, .lead, .note, .hint, .gfoot, p, small, .sub')) { if ([...seen].some((s) => s.contains(e))) continue; seen.add(e); const tx = (e.textContent || '').replace(/\\s+/g, ''); if (!tx) continue; chars += [...tx].length; if (samples.length < 20) samples.push(tx.slice(0, 30)); }
          return { chars, samples }; })()`);
        result.settings.editor['区' + (i + 1)] = m;
        await shot('editor-' + (i + 1));
      }
      const tot = Object.values(result.settings.editor).reduce((a, x) => a + x.chars, 0);
      process.stdout.write(`  ${TAG} 服务编辑器：说明小字共 ${tot} 字（${Object.entries(result.settings.editor).map(([k, v]) => k + ' ' + v.chars).join('，')}）\n`);
    }
    writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(result, null, 1));
    await edge.close(); srv.close(); fwd?.close();
    process.exit(0);
  }
  await inspect('image');
  // 打开最近一张图 → 画布
  await pg.eval(`(async () => { document.querySelector('.studio-root .cv-thumb')?.click(); return 1; })()`);
  await inspect('image-canvas');
  await tab(1); await pg.eval(`(async () => { document.querySelector('.studio-root .cv-thumb')?.click(); return 1; })()`); await inspect('video');
  // 点画布上的视频 → 全屏播放器：<video> 能不能读到元数据（播放器挂在 .studio-root 外面，单独查）
  await pg.eval(`(async () => { document.querySelector('.studio-root .fc-media')?.click(); return 1; })()`);
  await sleep(4000);
  {
    const vids = await pg.eval(`(() => [...document.querySelectorAll('video')].filter((v) => !v.closest('.studio-root')).map((v) => { let host = ''; try { const u = new URL(v.currentSrc || v.src); host = u.protocol + '//' + u.host; } catch {} return { tag: 'video', host, ok: v.readyState >= 1 && !v.error, err: v.error ? v.error.code : null, state: v.dataset.media || '' }; }))()`);
    const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
    writeFileSync(path.join(OUT, `${TAG}-video-play.jpg`), Buffer.from(r.data, 'base64'));
    result.pages['video-play'] = { total: vids.length, ok: vids.filter((m) => m.ok).length, broken: vids.filter((m) => !m.ok).length, byHost: vids.reduce((o, m) => { const k = m.host + (m.ok ? ' ok' : ' 坏'); o[k] = (o[k] || 0) + 1; return o; }, {}), media: vids };
    process.stdout.write(`  ${TAG} ${'video-play'.padEnd(14)} 播放器 <video> ${vids.length}，好 ${result.pages['video-play'].ok}，坏 ${result.pages['video-play'].broken}  ${JSON.stringify(result.pages['video-play'].byHost)}\n`);
    for (const type of ['keyDown', 'keyUp']) await pg.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(800);
  }
  await tab(2); await inspect('voice');
  await tab(3); await inspect('music');
  await tab(0);
  await pg.eval(`(async () => { document.querySelector('.studio-root .sd-rail-btn')?.click(); return 1; })()`);
  await inspect('drawer');
} finally {
  await edge.close();
  srv.close();
  fwd?.close();
}
writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(result, null, 1));
const all = Object.values(result.pages).reduce((a, p) => ({ t: a.t + p.total, b: a.b + p.broken }), { t: 0, b: 0 });
process.stdout.write(`${TAG}：/api 请求按主机 ${JSON.stringify(result.hosts)}；媒体 ${all.t} 个，坏 ${all.b} 个；媒体网络层失败 ${result.failures.length} 条\n`);
const errs = {}; for (const f of result.failures) { const k = f.type + ' ' + f.error + (f.blocked ? ' blocked=' + f.blocked : '') + (f.cors ? ' cors=' + f.cors : '') + ' ' + f.url.slice(0, 40); errs[k] = (errs[k] || 0) + 1; }
for (const [k, n] of Object.entries(errs)) process.stdout.write(`  ${n} × ${k}\n`);
process.exitCode = all.b ? 1 : 0;
