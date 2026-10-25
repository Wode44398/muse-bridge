// 英文界面文案 · Claude Code 运行组件（安装包不再内嵌，首启由服务端从官方源下载）与号池「上次使用时」的说明
//
// 来源：web/src/components/ClaudeCliStatus.svelte（t() 字面量）；后端下发的状态 / 报错（tr() 运行时匹配，键 = 后端原文）：
// src/runtime/claude-cli.mjs（下载失败的人话、发消息时的错误卡片）、src/runtime/status.mjs classifyError、
// src/routes/claude-cli.mjs；设置页订阅号池的脚注（Settings.svelte / SettingsDesktop.svelte）。
export default {
  // ——— 设置 › Claude：运行组件状态块 ———
  'Claude Code 运行组件': 'Claude Code runtime',
  '正在下载 · {pct}%': 'Downloading · {pct}%',
  '正在校验…': 'Verifying…',
  '没装好': 'Not installed',
  '没找到': 'Not found',
  '在用本机的 {have}': 'Using local {have}',
  '{done} / {total} MB · 来自 {host}': '{done} / {total} MB · from {host}',
  '首次使用要从官方源下载约 {mb} MB（解开后约 {full} MB），只需一次；下载完就能对话。': 'First use downloads about {mb} MB from the official source ({full} MB unpacked), just once. You can chat as soon as it finishes.',
  '首次使用要从官方源下载运行组件（解开后约 {full} MB），只需一次；下载完就能对话。': 'First use downloads the runtime from the official source ({full} MB unpacked), just once. You can chat as soon as it finishes.',
  '需要 {want}，正在用本机的 {have}，个别功能可能不正常。': 'Version {want} is needed, but the local {have} is in use. Some features may not work.',
  '没找到 Claude Code {want}：在运行 bridge 服务端的电脑上安装它，或在服务端 config.json 里用 claudeCliPath 指定位置。': 'Claude Code {want} wasn’t found. Install it on the computer running the Muse Bridge server, or set its location with claudeCliPath in the server’s config.json.',
  '正在重试…': 'Retrying…',
  '重试': 'Try again',

  // ——— 后端：下载失败的原因（runtime/claude-cli.mjs humanError，状态块与错误卡片都显示）———
  '连不上下载源（{host}）': 'Can’t reach the download source ({host})',
  '连接下载源超时（{host}）': 'Timed out connecting to the download source ({host})',
  '下载停住了：{s} 秒没有收到新数据（{host}）': 'The download stalled: no data for {s} seconds ({host})',
  '下载太慢（约 {rate} KB/s，{host}），已换下一个下载源': 'The download was too slow (about {rate} KB/s, {host}), so it switched to the next source',
  '下载源回了 HTTP {status}（{host}）': 'The download source returned HTTP {status} ({host})',
  '下载源上没有 Claude Code 运行组件 {name}（{host}）': 'The download source doesn’t have the Claude Code runtime {name} ({host})',
  '下载的文件校验不通过（可能不完整或被改动过），已丢弃': 'The downloaded file failed verification (it may be incomplete or altered) and was discarded',
  '下载的包里没有 Claude Code 可执行文件': 'The downloaded package doesn’t contain the Claude Code executable',
  '这个平台（{platform}）没有官方的 Claude Code 运行组件': 'There’s no official Claude Code runtime for this platform ({platform})',
  '磁盘空间不够：Claude Code 运行组件需要约 {mb} MB': 'Not enough disk space: the Claude Code runtime needs about {mb} MB',
  '没有权限写入 {dir}': 'No permission to write to {dir}',
  '下载失败：{reason}': 'Couldn’t download: {reason}',
  '找不到 Agent SDK（@anthropic-ai/claude-agent-sdk）：在程序目录运行 npm ci': 'The Agent SDK (@anthropic-ai/claude-agent-sdk) is missing. Run npm ci in the program folder.',
  '指定的 Claude Code 不存在：{path}': 'The specified Claude Code doesn’t exist: {path}',
  '仅管理员可用': 'Admins only',

  // ——— 后端：发消息时运行组件没就绪的错误卡片（claude-cli.mjs notReadyError / status.mjs classifyError）———
  'Claude Code 运行组件还在下载': 'The Claude Code runtime is still downloading',
  'Claude Code 运行组件正在准备': 'The Claude Code runtime is getting ready',
  'Claude Code 运行组件还没就绪': 'The Claude Code runtime isn’t ready',
  '已下载 {pct}%（{done} / {total} MB），完成后再发一次即可。': 'Downloaded {pct}% ({done} / {total} MB). Send again once it finishes.',
  '稍等几秒再发一次。': 'Wait a few seconds, then send again.',
  '{reason}。管理员可以在「设置 › Claude」里重试，或在运行 bridge 服务端的电脑上安装 Claude Code。': '{reason}. An admin can try again in Settings › Claude, or install Claude Code on the computer running the Muse Bridge server.',
  '需要 Claude Code {want}：管理员可以在运行 bridge 服务端的电脑上安装它，或在服务端 config.json 里用 claudeCliPath 指定位置。': 'Claude Code {want} is needed. An admin can install it on the computer running the Muse Bridge server, or set its location with claudeCliPath in the server’s config.json.',
  '服务端会自动下载它；管理员可以在「设置 › Claude」里看进度或重试。': 'The server downloads it automatically. An admin can check progress or try again in Settings › Claude.',
  // 合成整句：title + ' — ' + hint（hint 再过一遍 tr）
  'Claude Code 运行组件还在下载 — {hint}': 'The Claude Code runtime is still downloading. {hint}',
  'Claude Code 运行组件正在准备 — {hint}': 'The Claude Code runtime is getting ready. {hint}',
  'Claude Code 运行组件还没就绪 — {hint}': 'The Claude Code runtime isn’t ready. {hint}',

  // ——— 订阅号池：闲置的号显示上次使用时的额度（account-usage.mjs 标 source:'last-use' 时）———
  '闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。': 'Idle accounts show their usage from when they were last used. An account that hasn’t been used yet shows data after its first use.',
};
