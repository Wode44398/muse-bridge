// 把工具调用守卫装进某个注册用户的 agy 配置目录（<他的 gemini 目录>/config/）。
// agy 把这个目录当「全局配置」：里面的 hooks.json 对这个进程的每个会话、每个子代理都生效，
// 用户自己工作目录里的东西改不到它（它在服务器数据目录里，不在任何人的文件夹里）。
// 每次起进程前都重写一遍：脚本升级、令牌换了（主机密钥轮换）、端口变了都跟着更新。

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SRC = fileURLToPath(new URL('./guard-hook.cjs', import.meta.url));
export const GUARD_HOOK_NAME = 'bridge-guard';

/**
 * configDir  <gemini 目录>/config
 * api        bridge 的本机地址（http://127.0.0.1:端口）
 * token      这个用户的按人令牌（runtime/agent-device-token.mjs）：守卫出示它，bridge 据此认出是谁的会话
 * nodePath   跑守卫脚本的 node（默认就是 bridge 自己这个）
 */
export function installGuard({ configDir, api, token, nodePath = process.execPath, platform = process.platform } = {}) {
  if (!configDir || !api || !token) throw new Error('installGuard: 缺少 configDir / api / token');
  mkdirSync(configDir, { recursive: true });
  copyFileSync(HOOK_SRC, path.join(configDir, 'guard-hook.cjs'));
  writeFileSync(path.join(configDir, 'guard.json'), JSON.stringify({ api, token }), { encoding: 'utf8', mode: 0o600 });

  // agy 用 cmd /c（Windows）或 sh -c 跑钩子命令，工作目录是 hooks.json 所在目录。
  // node 的路径常带空格（Program Files），直接写进命令行要过两层引号规则；包一层同目录的启动脚本最省事。
  let command;
  if (platform === 'win32') {
    writeFileSync(path.join(configDir, 'guard.cmd'), `@echo off\r\n"${nodePath}" "%~dp0guard-hook.cjs"\r\n`, 'utf8');
    // 带上 .\：环境里设了 NoDefaultCurrentDirectoryInExePath 时 cmd 不在当前目录里找可执行文件，
    // 光写文件名会报「不是内部或外部命令」——钩子失败，注册用户的每一次工具调用都被拒（实测）
    command = '.\\guard.cmd';
  } else {
    writeFileSync(path.join(configDir, 'guard.sh'), `#!/bin/sh\nexec "${nodePath}" "$(dirname "$0")/guard-hook.cjs"\n`, { encoding: 'utf8', mode: 0o700 });
    command = './guard.sh';
  }
  const hooks = {
    [GUARD_HOOK_NAME]: {
      // matcher "*" = 所有工具；超时给足（冷启动一个 node 进程 + 一次本机请求），超时同样算失败 = 拒绝
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }],
    },
  };
  writeFileSync(path.join(configDir, 'hooks.json'), JSON.stringify(hooks, null, 2), 'utf8');
  return { command };
}
