// 一个市场通道 = 一个签名索引的拉取、验签、缓存与状态。官方与社区各一个实例，互不串：各自的钥匙、缓存目录、seq 记录。
//
// 缓存：<dir>/{index.json, index.json.sig, state.json}，读缓存也验签。state.json：
//   cachedUrl、byUrl[url] = { maxSeq, checkedAt, error, empty }、skipped[id]（回退 / 恢复内置版换下来的版本，不再拿它提示更新）。
// seq 只升不降：拉到比见过的更小的就不采用（防回滚到有漏洞的旧索引）。
// emptyOn404：索引地址 404 当成「还没开张」（社区市场在第一个插件上架前就是这样），不算错误。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PluginError } from '../discover.mjs';
import { fetchBytes, originOf } from './fetch.mjs';
import { verifyIndexSignature } from './verify.mjs';

const MAX_INDEX = 4 * 1024 * 1024;
export const STALE_MS = 6 * 3600_000;

export function createChannel({ name, dir, settings, normalize, emptyOn404 = false }) {
  const FILES = { index: path.join(dir, 'index.json'), sig: path.join(dir, 'index.json.sig'), state: path.join(dir, 'state.json') };
  // mem：{ url, index, checkedAt, error, empty? } —— 当前索引地址验过签的最新一份
  let mem = null;
  let inflight = null;

  function readState() {
    try { const s = JSON.parse(readFileSync(FILES.state, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  }
  function writeState(mutate) {
    const s = readState();
    mutate(s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(FILES.state, JSON.stringify(s, null, 2));
    return s;
  }
  const urlState = (s, url) => (s.byUrl && s.byUrl[url]) || {};
  const noteUrl = (url, patch) => writeState((s) => {
    s.byUrl = s.byUrl && typeof s.byUrl === 'object' ? s.byUrl : {};
    s.byUrl[url] = { ...(s.byUrl[url] || {}), ...patch };
  });
  const emptyIndex = (seq = 0) => normalize({ format: 1, market: name, seq, generatedAt: '', plugins: [], revoked: [] });

  function loadCache(st) {
    if (mem && mem.url === st.index) return mem;
    const s = readState();
    const u = urlState(s, st.index);
    if (emptyOn404 && u.empty && s.cachedUrl !== st.index) {
      mem = { url: st.index, index: emptyIndex(), checkedAt: u.checkedAt || 0, error: u.error || null, empty: true };
      return mem;
    }
    if (s.cachedUrl !== st.index || !existsSync(FILES.index) || !existsSync(FILES.sig)) return null;
    try {
      const raw = readFileSync(FILES.index);
      verifyIndexSignature(raw, readFileSync(FILES.sig, 'utf8'), st.keys);
      mem = { url: st.index, index: normalize(JSON.parse(raw.toString('utf8'))), checkedAt: u.checkedAt || 0, error: u.error || null };
      return mem;
    } catch (e) {
      console.error(`[plugin-market:${name}] 缓存的索引用不了：` + (e?.message || e));
      return null;
    }
  }

  async function refresh(st) {
    if (inflight) return inflight;
    inflight = (async () => {
      const now = Date.now();
      try {
        const sameOrigin = originOf(st.index);
        let raw;
        try { raw = await fetchBytes(st.index, { max: MAX_INDEX, timeoutMs: 20_000, sameOrigin }); }
        catch (e) {
          // 还没开张：没有旧缓存时记成空市场；有旧缓存（下架了索引？）照旧当错误处理，别把已知的吊销名单丢掉
          if (emptyOn404 && e instanceof PluginError && e.status === 404 && readState().cachedUrl !== st.index) {
            noteUrl(st.index, { checkedAt: now, error: null, empty: true });
            mem = { url: st.index, index: emptyIndex(), checkedAt: now, error: null, empty: true };
            return mem;
          }
          throw e;
        }
        const sigText = (await fetchBytes(st.index + '.sig', { max: 4096, timeoutMs: 20_000, sameOrigin })).toString('utf8');
        verifyIndexSignature(raw, sigText, st.keys);
        let parsed;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new PluginError(502, '索引不是合法 JSON'); }
        const index = normalize(parsed);
        const seen = Number(urlState(readState(), st.index).maxSeq || 0);
        if (index.seq < seen) throw new PluginError(502, `拉到的索引比上次见过的旧（第 ${index.seq} 版，见过第 ${seen} 版），没采用`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(FILES.index, raw);
        writeFileSync(FILES.sig, sigText);
        writeState((s) => {
          s.cachedUrl = st.index;
          s.byUrl = s.byUrl && typeof s.byUrl === 'object' ? s.byUrl : {};
          s.byUrl[st.index] = { ...(s.byUrl[st.index] || {}), maxSeq: index.seq, checkedAt: now, error: null, empty: false };
        });
        mem = { url: st.index, index, checkedAt: now, error: null };
        return mem;
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        noteUrl(st.index, { checkedAt: now, error: msg });
        const cached = loadCache(st);
        if (cached) { cached.error = msg; cached.checkedAt = now; return cached; }
        throw e instanceof PluginError ? e : new PluginError(502, msg);
      } finally { inflight = null; }
    })();
    return inflight;
  }

  return {
    name,
    settings,
    // 拿索引：refresh=true 强制重拉；没有缓存或缓存比 maxAgeMs 旧也会拉（拉失败但有缓存时用缓存，error 里带原因）
    async getIndex({ refresh: force = false, maxAgeMs = STALE_MS } = {}) {
      const st = settings();
      if (st.off) throw new PluginError(400, name === 'community' ? '社区插件市场已关闭（config.json 的 pluginMarket.community）' : '插件市场已关闭（config.json 的 pluginMarket）');
      const cached = loadCache(st);
      if (!force && cached && Date.now() - (cached.checkedAt || 0) < maxAgeMs) return cached;
      return refresh(st);
    },
    // 只看缓存（不碰网络）
    cached() {
      const st = settings();
      return st.off ? null : loadCache(st);
    },
    // 当前地址的内存索引（getIndex 之后用）
    current() {
      const st = settings();
      return !st.off && mem && mem.url === st.index ? mem : null;
    },
    status() {
      const st = settings();
      if (st.off) return { off: true };
      const m = loadCache(st);
      const u = urlState(readState(), st.index);
      return {
        off: false, official: st.official, ok: !!m, seq: m?.index.seq ?? null, generatedAt: m?.index.generatedAt || '',
        checkedAt: m?.checkedAt || u.checkedAt || 0, error: m ? m.error : u.error || null, ...(m?.empty ? { empty: true } : {}),
      };
    },
    skipped(id) { return String((readState().skipped || {})[id] || ''); },
    setSkipped(id, version) {
      writeState((s) => {
        s.skipped = s.skipped && typeof s.skipped === 'object' ? s.skipped : {};
        if (version) s.skipped[id] = version; else delete s.skipped[id];
      });
    },
    reset() { mem = null; },
  };
}
