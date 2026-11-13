// 工具结果里的图片（读图 / 截图 / 浏览器截屏）→ 状态行缩略图条的数据（官方 4.4212 TurnStatus 的 bQ/xQ）。
// 工具条目只带张数（t.images，来自 tool_done / 历史解析），图本身按 /api/tool-image 取：
// 缩略图走 v=thumb（服务端 sharp 出 480px webp），灯箱走原图。
import { apiUrl } from './server.js';
import { getToken } from './api.js';
import { toolVerb } from './toolVerbs.js';

const tok = () => { const t = getToken && getToken(); return t ? '&token=' + encodeURIComponent(t) : ''; };

export function toolImageUrl(sid, toolId, n, thumb) {
  return apiUrl('/api/tool-image?sid=' + encodeURIComponent(sid || '') + '&t=' + encodeURIComponent(toolId) + '&n=' + n + (thumb ? '&v=thumb' : '') + tok());
}

// 一组工具 → 平铺的图片列表（按工具顺序、每个工具内按序号）。caption = 那一步的标题（官方悬停卡同款）。
export function toolShots(tools, sid) {
  const out = [];
  if (!sid) return out;
  for (const t of tools || []) {
    const n = t && t.id && t.images > 0 ? t.images : 0;
    if (!n) continue;
    const v = toolVerb(t);
    const caption = [v.verb, v.meta].filter(Boolean).join(' ');
    for (let i = 0; i < n; i++) {
      out.push({ key: t.id + ':' + i, toolId: t.id, kind: 'image', name: caption, caption, thumb: toolImageUrl(sid, t.id, i, true), url: toolImageUrl(sid, t.id, i, false) });
    }
  }
  return out;
}
