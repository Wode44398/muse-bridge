// 插件市场：不发 bridge 大版本也能上新插件、更新插件（方案：bridge build/design/插件市场方案.md、社区插件市场方案.md）。
//
// 两个通道，各是一个签过名的索引（format 1），bridge 只拉索引就能列全部插件、批量算更新：
//   · 官方：Wode44398/bridge-plugins 滚动 Release「index」的 index.json，官方钥匙签；能盖内置功能（builtin:true，engines.bridge 必须有上界）。
//   · 社区：同仓库 Release「community-index」的 community.json，另一把社区钥匙签（CI 里自动检查通过就上架，没有人工审核）；
//     条目带作者 GitHub 账号、种类（page 纯页面 / server 含服务端代码）、检测到的能力，另有吊销名单（已装的被吊销版本自动停用）。
// 信任链：ed25519 签索引原始字节，公钥写死在 market-keys.mjs；seq 只升不降；zip 按索引里的 sha256 / size 逐字节核对。
// 更新只提示不自动装：正式实例启动 1 分钟后查一次、之后每 6 小时；有变化推总线 plugins.market 给主机，/api/auth 给主机下发数量。
//
// 实现在 market/：fetch（下载）、verify（验签与规整）、channel / channels（缓存与设置）、view、install、revoke、overview。
import { announceUpdates } from './market/overview.mjs';
import { official } from './market/channels.mjs';
import * as install from './market/install.mjs';

export { verifyIndexSignature, normalizeIndex, normalizeCommunityIndex } from './market/verify.mjs';
export { _setTestHooks, communitySettings } from './market/channels.mjs';
export { marketOverview, marketStatus, communityStatus, pendingUpdates, announceUpdates, setUpdatesPublisher, startMarketWatcher } from './market/overview.mjs';
export { isRevoked, applyRevocations, setRevokeNotifier } from './market/revoke.mjs';
export { NeedAck } from './market/install.mjs';
export { official as officialChannel, community as communityChannel } from './market/channels.mjs';

// 拿官方索引（老调用方：测试）
export const getIndex = (opts = {}) => official.getIndex(opts);

// 装 / 回退 / 恢复内置版后重算「有更新」名单
const thenAnnounce = (fn) => async (kernel, ...args) => { const p = await fn(kernel, ...args); announceUpdates(kernel); return p; };
export const installFromMarket = thenAnnounce(install.installFromMarket);
export const rollbackInstalled = thenAnnounce(install.rollbackInstalled);
export const restoreBuiltinVersion = thenAnnounce(install.restoreBuiltinVersion);
