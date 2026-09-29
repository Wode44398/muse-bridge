// 扫码配对登录的前端两半：
//   网页端（未登录）：startPairLogin() 领票 → 出二维码 → 长轮询 → approved 即 claim 落登录态。
//   手机端（已登录）：parsePairPayload() 解二维码内容，PairScan.svelte 再调 /api/pair/scan|approve。
// 二维码内容 = 本站地址 + ?pair=<id>.<key>：PairScan 只解参数；若被系统相机扫到则会打开网页，
// 网页 boot 时识别 ?pair= 走同一套确认流程（见 App.svelte）。
// 服务端语义见 src/routes/pair.mjs（key 只能扫/确认，claim 只能领凭据，两把钥匙分工）。

import { api, setToken } from './api.js';
import { applyMe } from './state.svelte.js';
import { t } from './i18n.js';

export function pairPayload(id, key) {
  let origin = '';
  try { origin = location.origin; } catch {}
  return `${origin}/?pair=${encodeURIComponent(id)}.${encodeURIComponent(key)}`;
}

// 接受完整网址（?pair=）或裸 `bridge-pair:<id>.<key>`；不是登录码返回 null。
export function parsePairPayload(text) {
  const s = String(text || '').trim();
  let v = '';
  const m = /[?&#]pair=([^&#\s]+)/.exec(s);
  if (m) { try { v = decodeURIComponent(m[1]); } catch { v = m[1]; } }
  else if (/^bridge-pair:/i.test(s)) v = s.slice('bridge-pair:'.length);
  if (!v) return null;
  const i = v.indexOf('.');
  if (i <= 0) return null;
  const id = v.slice(0, i), key = v.slice(i + 1);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return null;
  return { id, key };
}

// 生成二维码 SVG（懒加载 qrcode，只有走到扫码登录页才付这份体积）。透明底、深色码点，
// 尺寸不写死——容器给多大就多大（viewBox 自适应）。
export async function qrSvg(text) {
  const mod = await import('qrcode');
  const QR = mod.default || mod;
  return QR.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#15171cff', light: '#00000000' } });
}

function selfLabel() {
  try { return String(navigator.userAgentData?.platform || navigator.platform || '').slice(0, 40); } catch { return ''; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网页侧状态机。onUpdate({ status, svg?, expiresAt?, error?, me? })
//   status: 'loading' | 'pending' | 'scanned' | 'approved'(领取中) | 'done' | 'rejected' | 'expired' | 'error'
// 返回 { refresh(), stop() }：refresh 作废当前码另领一张；stop 结束整个流程（组件卸载/切模式时调）。
export function startPairLogin(onUpdate) {
  let stopped = false, gen = 0;
  const emit = (u) => { if (!stopped) onUpdate(u); };
  async function run() {
    const my = ++gen;
    const dead = () => stopped || my !== gen;
    emit({ status: 'loading' });
    try {
      const tk = await api.post('/api/pair/new', { label: selfLabel() });
      if (dead()) return;
      const svg = await qrSvg(pairPayload(tk.id, tk.key));
      if (dead()) return;
      emit({ status: 'pending', svg, expiresAt: tk.expiresAt });
      let status = 'pending', fails = 0;
      while (!dead()) {
        let r;
        try { r = await api.post('/api/pair/wait', { id: tk.id, claim: tk.claim, status }); fails = 0; }
        catch (e) {
          if (dead()) return;
          if (e?.status === 404 || e?.status === 410) { emit({ status: 'expired' }); return; }
          if (++fails > 6) { emit({ status: 'error', error: t('连不上服务器，点击重试') }); return; }
          await sleep(1500 * fails);
          continue;
        }
        if (dead()) return;
        if (!r || r.status === status) continue;   // 长轮询到点、状态没变：接着等
        status = r.status;
        if (status === 'scanned') { emit({ status: 'scanned', svg, expiresAt: tk.expiresAt }); continue; }
        if (status === 'approved') {
          emit({ status: 'approved' });
          const c = await api.post('/api/pair/claim', { id: tk.id, claim: tk.claim });
          if (dead()) return;
          // 拿到凭据即存为 Bearer（与账号密码登录同一课）
          if (c.token) setToken(c.token);
          let a;
          try { a = await api.auth(); } catch { a = { kind: c.kind, user: c.user }; }
          applyMe(a);
          emit({ status: 'done', me: a });
          return;
        }
        if (status === 'rejected') { emit({ status: 'rejected' }); return; }
        emit({ status: 'expired' });   // expired / claimed / 其它终态
        return;
      }
    } catch (e) {
      if (dead()) return;
      emit({ status: 'error', error: e?.body?.error || (e?.status === 429 ? t('请求过多，请稍后再试') : t('二维码生成失败，点击重试')) });
    }
  }
  // 首次 run 推到微任务：调用方多半在 $effect 里起我们，同步回调会让 effect 把回调里碰到的
  // 状态都记成依赖；错开一拍，effect 体内只剩「起」这一件事。
  queueMicrotask(() => { if (!stopped) run(); });
  return {
    refresh: () => { if (!stopped) run(); },
    stop: () => { stopped = true; gen++; },
  };
}
