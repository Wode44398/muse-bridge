// 隔离等级（开源路线 4.0「隔离分级」、S2-2 / S2-3）：这台服务端能把成员彼此、成员与服务器隔开到什么程度，
// 由此决定「给别人用」时可以放心发哪些档位。控制台按运行环境自动检测并如实展示。
//
//   L1 逻辑隔离：路径围栏 + SDK 禁用命令行 + 账号各自的目录与会话。所有平台都有，也是原生 Windows 能做到的上限。
//                只有「普通档」（没有命令行）的隔离是真的；完全信任档的命令行、终端、浏览器跑在服务进程的同一个系统账户下，
//                能读到服务器上所有人的数据和全部凭据——等同管理员。
//   L2 进程隔离：SDK 自带的 sandbox（Linux bubblewrap / macOS seatbelt），终端与浏览器另行包装。尚未接入（S2-16）。
//   L3 容器隔离：每人一个容器（spawnClaudeCodeProcess），终端和浏览器在同一个容器里。尚未接入（S2-17）。
//
// 今天所有形态都停在 L1：Docker 镜像里所有成员也是同一个 uid，只把成员和宿主隔开了，成员之间并没有隔开。
// 接入 L2 / L3 后在这里按自检结果升级，控制台与档位闸门跟着变，调用方不用改。
// 纯函数（只看平台与容器标记），任何模块都能放心 import。
import { existsSync } from 'node:fs';

export const LEVELS = Object.freeze({
  L1: Object.freeze({ id: 'L1', label: '逻辑隔离', labelEn: 'Logical isolation' }),
  L2: Object.freeze({ id: 'L2', label: '进程隔离', labelEn: 'Process isolation' }),
  L3: Object.freeze({ id: 'L3', label: '容器隔离', labelEn: 'Container isolation' }),
});

function inContainer(env, exists) {
  if (String(env.container || '').trim()) return true;
  try { return exists('/.dockerenv') || exists('/run/.containerenv'); } catch { return false; }
}

/**
 * { level, label, platform, container, fullTrustIsolated, issuable }。
 *   fullTrustIsolated：完全信任档是否在系统层被隔开（L2 / L3 才是）；false = 完全信任等同管理员。
 *   issuable：这一隔离等级下「放心发」的档位。不在里面的档位控制台默认不发，要发得管理员逐个确认。
 */
export function isolationInfo({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const lv = LEVELS.L1;
  return {
    level: lv.id,
    label: lv.label,
    labelEn: lv.labelEn,
    platform,
    container: platform !== 'win32' && inContainer(env, exists),
    fullTrustIsolated: false,
    issuable: ['user'],
  };
}
