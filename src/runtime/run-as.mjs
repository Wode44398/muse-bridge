// 子进程与凭据的统一入口（开源路线 C7 / C8）。今天只透传，行为与直接调用一字不差。
//
// 为什么现在就要有：所有成员的进程今天都以服务进程的同一个系统账号运行（软隔离），号池是全服唯一的激活号。
// 将来按人降权（每人一个 uid 或容器）、按人 / 按组发凭据，都得有一个「起子进程」和「取凭据」的收口点；
// 等子进程散落在几十个文件里各自 spawn、凭据各处直接读激活号之后再收，就是全仓改写。
//
//   spawnFor(ctx, command, args, options)  新增的子进程一律经它起。今天 = child_process.spawn 原样。
//   spawnOptionsFor(ctx, options)          不走 child_process 的（node-pty、SDK 的 spawn 钩子）拿同一份选项。今天原样返回。
//   credentialFor(actor, scope)            这一轮用哪份 Claude 凭据。今天 = 全服当前激活号（与 claudeEngineEnv 同一个取法），
//                                          actor / scope 不参与选择；返回值里有令牌，不许写日志、不许回给前端。
//   accountGroups(account)                 号池账号的 groups 字段（预留：[组 id]，缺省 = 所有人可用）。今天不参与选号。

import { spawn } from 'node:child_process';
import { activeAccountId, activeToken } from './claude-account.mjs';
import { validGroupId } from './principal.mjs';

export function spawnOptionsFor(_ctx, options = {}) {
  return options;
}

export function spawnFor(ctx, command, args = [], options = {}) {
  return spawn(command, args, spawnOptionsFor(ctx, options));
}

export function credentialFor(_actor, _scope) {
  return { accountId: activeAccountId(), token: activeToken() };
}

export function accountGroups(account) {
  return account && Array.isArray(account.groups) ? account.groups.map(String).filter(validGroupId) : [];
}
