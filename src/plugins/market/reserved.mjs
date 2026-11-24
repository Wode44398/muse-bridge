// 社区插件不许占的 id：内置功能、agent 扩展，加一组固定的界面 / 品牌名。
// 市场仓库的 scripts/reserved-ids.json 由 scripts/sync-rules.mjs 按同样的口径生成，两边要一致（改这里的固定名单要同步那边的脚本）。
import { BUILTIN_PLUGINS } from '../catalog.mjs';
import { MODULE_CATALOG } from '../../modules/registry.mjs';

export const FIXED_RESERVED = Object.freeze(['claude', 'settings', 'home', 'workspace', 'bridge', 'official', 'community', 'market', 'plugins', 'admin']);

export function reservedIds() {
  return [...new Set([...BUILTIN_PLUGINS.map((e) => e.id), ...MODULE_CATALOG.map((e) => e.id), ...FIXED_RESERVED])];
}
