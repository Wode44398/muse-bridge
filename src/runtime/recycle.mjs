// 把文件/文件夹送进 Windows 回收站（可在电脑上还原）——服务端版的 shell.trashItem。
//
// 为什么不是 rmSync：手机工作空间放开「电脑位置」（整机任意目录）以后，删除的爆炸半径从
// vault（有 git 台账兜底）变成了整台电脑；桌面版删除本来就进回收站，手机版在这些位置对齐它。
// 顺带一个好处：rmSync 递归删到一半撞上占用/无权限的文件会停在半截、留下一棵残树；回收站在
// 同一个卷上是整体挪进 $Recycle.Bin，要么整个进去、要么原封不动。
//
// 实现：PowerShell 里 Add-Type 一段 C#，调 shell32 的 SHFileOperation(FO_DELETE + FOF_ALLOWUNDO)，
// 并带齐 FOF_NO_UI（不确认、不显示进度、不弹错误框）——服务跑在主机用户的桌面会话里，任何弹框都会
// 挂在电脑屏幕上等人点，请求就一直卡着。一次调用约 0.6s（多半是 Add-Type 现编译），所以多选
// 删除必须合成一次调用。
//   · 路径经 stdin 传 base64(UTF-8 JSON)：PowerShell 按控制台代码页（GBK）读 stdin，中文路径
//     直接传会乱码；输出只有「序号:返回码」的纯 ASCII 行，同样不经过代码页。
//   · 已知边界（系统行为）：卷上没有回收站（网络盘、部分移动盘/虚拟盘），或单项超过该卷回收站
//     的容量上限时，FOF_ALLOWUNDO 在 FOF_NOCONFIRMATION 下会直接永久删除、不报错。能拦住它的
//     只有 FOF_WANTNUKEWARNING，而那是一个弹框——上一条说了为什么不行。

import { execFile } from 'node:child_process';

const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd().Trim()
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Send(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3;
    op.pFrom = path + "\\0";
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x0200);
    int rc = SHFileOperation(ref op);
    if (rc == 0 && op.fAnyOperationsAborted) return 1223;
    return rc;
  }
}
'@
$i = 0
foreach ($p in $paths) { '{0}:{1}' -f $i, [BridgeRecycle]::Send([string]$p); $i++ }
`;

// SHFileOperation 的返回码是 Win32 错误码与一组历史遗留的 DE_* 码的混合（MSDN「Return Values」）。
const CODE_TEXT = new Map([
  [2, '文件不存在'], [3, '路径不存在'], [5, '没有权限'], [32, '正被其他程序占用'], [33, '正被其他程序占用'],
  [0x78, '没有权限'], [0x7c, '路径无效（可能太长）'], [0x7e, '路径无效（可能太长）'], [0x4c7, '操作被取消'],
]);
export const recycleErrorText = (code) => CODE_TEXT.get(code)
  || (code == null ? '回收站没有返回结果' : `移到回收站失败（代码 0x${Number(code).toString(16)}）`);

// 「序号:返回码」逐行解析成按序号排的数组；缺的位置留 null（进程中途被杀/没跑到）。
export function parseRecycleOutput(text, count) {
  const codes = Array(count).fill(null);
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+):(-?\d+)\s*$/.exec(line);
    if (!m) continue;
    const i = Number(m[1]);
    if (i < count) codes[i] = Number(m[2]);
  }
  return codes;
}

// paths：绝对路径数组。结果与入参同序：[{ path, ok, code?, error? }]。
// 整个调用都起不来（不是 Windows、PowerShell 起不来/超时且一条结果都没有）才 reject。
export function recyclePaths(paths, { timeoutMs = 120_000 } = {}) {
  const list = (paths || []).map(String);
  if (!list.length) return Promise.resolve([]);
  if (process.platform !== 'win32') return Promise.reject(new Error('回收站只在 Windows 上可用'));
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const codes = parseRecycleOutput(stdout, list.length);
        if (err && codes.every((c) => c == null)) {
          reject(new Error('回收站调用失败：' + String(stderr || err.message || err).replace(/\s+/g, ' ').trim().slice(0, 200)));
          return;
        }
        resolve(list.map((p, i) => (codes[i] === 0
          ? { path: p, ok: true }
          : { path: p, ok: false, code: codes[i], error: recycleErrorText(codes[i]) })));
      });
    child.stdin.on('error', () => {});   // 进程先死了（超时/起不来）时写 stdin 会 EPIPE，结果由上面的回调交代
    child.stdin.end(Buffer.from(JSON.stringify(list), 'utf8').toString('base64'));
  });
}
