// 把 dimensio 自建的模型服务搬进模型中心。模型中心是唯一的配置入口（2026-11-11）：dimensio 自己的服务不再在 dimensio 里改，
// 设置 › 模型中心 首页点它那一行、dimensio「模型服务」面板卡片上的铅笔，都走这里——确认 → 照抄成模型中心服务 → 删掉原来那份。
import { api } from './api.js';
import { hubPost, loadHub, adoptReach } from './modelHub.svelte.js';
import { ds, loadDimensio, catalog, setProvider } from './dimensioSettings.svelte.js';
import { uiConfirm, uiAlert } from './dialogs.js';
import { t, tr } from './i18n.js';

let running = false;

/**
 * { id, name, proto } = dimensio 的自定义服务（custom-<hex>）。
 * 返回 null（取消 / 失败，已提示）或 { service, newId }：service 是模型中心的新服务，newId 是它在 dimensio 里的新服务 id（没给 dimensio 时为空）。
 * dimensio 的默认服务正好是被搬走的那个时，默认跟到新服务上。
 */
export async function adoptDimensioService({ id, name, proto = '' }) {
  if (running || !id) return null;
  running = true;
  try {
    // 文案与后端 adopt 实际做的一致（src/routes/model-hub.mjs）：Gemini 接口给不了 Claude，照抄过去仍只有 dimensio 能选
    const both = adoptReach('dimensio', proto) === 'both';
    const ok = await uiConfirm(both ? t('把「{name}」改为两边共用？', { name }) : t('把「{name}」交给模型中心管理？', { name }), {
      okLabel: both ? t('改为共用') : t('交给模型中心'),
      detail: both
        ? t('地址、型号和 Key 会照抄成一个共用服务，Claude 里也能选；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。')
        : t('地址、型号和 Key 会照抄成一个模型中心服务，模型照旧只给 dimensio（Gemini 接口给不了 Claude）；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。'),
    });
    if (!ok) return null;
    try { await loadDimensio({ quiet: true }); } catch { /* 读不到默认服务：不跟随，其余照做 */ }
    const wasDefault = ds.config?.provider === id;
    const res = await hubPost('adopt', { from: 'dimensio', id });
    // 原来那份经 dimensio 自己的接口删（它的注册表在 harness 进程里）；删不掉不算失败，模型中心的那份已经建好
    try { await api.post('/api/harness/api/custom-providers/' + encodeURIComponent(id) + '/delete', {}); }
    catch {
      await uiAlert(t('模型中心服务已经建好，但 dimensio 里原来那份没删掉'),
        { type: 'warning', detail: t('请到 dimensio 的「模型服务」里手动删一下，免得出现两张一样的卡。') });
    }
    ds.rev++;
    try { await loadDimensio({ quiet: true }); } catch { /* 下面按拿得到的来 */ }
    await loadHub(true);
    const sid = res?.service?.id || '';
    const next = sid ? catalog().find((p) => p.custom?.ref === sid) : null;
    if (wasDefault && next) await setProvider(next.id);
    // 服务端的提醒（比如模型太多只先加了一部分）：说一声，再继续
    const warn = Array.isArray(res?.warnings) ? res.warnings.find((w) => typeof w === 'string' && w) : '';
    if (warn) await uiAlert(tr(warn));
    return { service: res?.service || null, newId: next?.id || '' };
  } catch (e) {
    uiAlert(e?.message || t('没改成'), { type: 'error' });
    return null;
  } finally {
    running = false;
  }
}
