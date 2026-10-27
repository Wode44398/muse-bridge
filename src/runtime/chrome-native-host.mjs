// Claude in Chrome 的本机 native host 看护。
//
// CLI 每次带 --chrome 启动都会把 ~/.claude/chrome/chrome-native-host.bat 改写成【它自己的】
// claude.exe 路径。bridge 的 SDK 内核与桌面 Claude app 的 CLI 因此互相覆盖：谁最后启动，
// Edge 扩展的本机入口就指向谁。任何一方的 exe 消失（桌面 app 升级删掉旧版本目录、SDK 内核被
// 自更新改名成 .old），扩展走本机通道就一起断。
//
// 这里定一个归属：优先指向桌面 app 最新版本的 CLI（它随 app 更新、是扩展最初配对的那个），
// 没装桌面 app 才退回 bridge 自己的 SDK 内核。bridge 启动时、以及每轮开了 Chrome 的 query
// 初始化之后各校正一次。只改引号里的 exe 路径，文件其余内容原样保留；写临时文件再 rename，
// 扩展恰好在这时拉起 .bat 也读不到半截。
//
// 注：会话的 Chrome 工具实际走账号级云中继（wss://bridge.claudeusercontent.com），这个 .bat
// 只是扩展的本机 native messaging 入口；看护的目标是「永远指向一个真实存在的 exe」。

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCliPath } from './claude-cli.mjs';

const BAT = path.join(os.homedir(), '.claude', 'chrome', 'chrome-native-host.bat');
const EXE_LINE = /^"([^"\r\n]+\.exe)"(\s+"--chrome-native-host")/m;

function semverKey(name) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmpKey = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// 桌面 app 自带的 CLI：%APPDATA%\Claude\claude-code\<x.y.z>\claude.exe，取存在的最高版本。
function desktopCliExe() {
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  let names = [];
  try { names = readdirSync(base); } catch { return null; }
  let best = null;
  for (const n of names) {
    const k = semverKey(n);
    if (!k) continue;
    const exe = path.join(base, n, 'claude.exe');
    if (existsSync(exe) && (!best || cmpKey(k, best.k) > 0)) best = { k, exe };
  }
  return best ? best.exe : null;
}

// bridge 自己在用的那份（源码直跑 = SDK 自带的；安装包 = 首启下到数据根的 / 本机已装的，见 claude-cli.mjs）。
// .bat 里那一行只认 .exe 结尾的路径。
function sdkCliExe() {
  const exe = claudeCliPath();
  return exe && /\.exe$/i.test(exe) && existsSync(exe) ? exe : null;
}

export function preferredNativeHostExe() {
  return desktopCliExe() || sdkCliExe();
}

// 返回 { changed, from, to } 或 { skipped: 原因 }。从不抛错（调用点在热路径上）。
// bat / exe 两个参数只给测试用：默认就是真实的 .bat 与 preferredNativeHostExe()。
export function ensureChromeNativeHost({ bat = BAT, exe } = {}) {
  if (process.platform !== 'win32') return { skipped: 'not-windows' };
  let raw;
  try { raw = readFileSync(bat, 'utf8'); } catch { return { skipped: 'no-bat' }; } // 从没开过 Chrome，不越俎代庖去新建
  const m = EXE_LINE.exec(raw);
  if (!m) return { skipped: 'unrecognized' };
  const from = m[1];
  const to = exe === undefined ? preferredNativeHostExe() : exe;
  if (!to) return { skipped: 'no-exe' };
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return { changed: false, from, to };
  const next = raw.replace(EXE_LINE, (_all, _exe, tail) => `"${to}"${tail}`);
  const tmp = bat + '.tmp-' + process.pid;
  try {
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, bat);
  } catch (e) {
    return { skipped: 'write-failed: ' + ((e && e.message) || e) };
  }
  console.log(`[chrome-host] native host -> ${to} (was ${from}${existsSync(from) ? '' : ', missing'})`);
  return { changed: true, from, to };
}
