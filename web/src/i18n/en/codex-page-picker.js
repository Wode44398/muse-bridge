// Codex 分页：模型选择器与强度滑杆、上下文与额度卡、权限 / 项目 / 账号菜单。
export default {
  // 模型与强度
  '模型与强度': 'Model and effort',
  '强度': 'Effort',
  'Fast：同样的模型更快出结果，用量消耗更多': 'Fast: same model, faster results, uses more of your limits',
  '这个型号只有这一档': 'This model has a single effort level',
  '先选一个型号': 'Pick a model first',
  '号池 {n} 个号': '{n} accounts in pool',
  '搜索型号或服务': 'Search models or services',
  '还有 {n} 个': '{n} more',
  '还没拿到模型目录': 'Model catalog not loaded yet',
  '管理模型中心…': 'Manage Model Hub…',

  // 上下文与额度
  '上下文与额度': 'Context and limits',
  '已用 {used} · 共 {total}': '{used} used · {total} total',
  '已用 {used}': '{used} used',
  '刚腾出 {n}': '{n} just freed',
  '压缩没成功，稍后再试': 'Compaction failed. Try again later.',
  '快满时 Codex 会自动压缩。也可以现在就压：前面的对话整理成一段摘要，腾出窗口，这条线程接着用。':
    'Codex compacts automatically when the window is nearly full. You can also compact now: earlier conversation is summarized to free up the window, and the thread carries on.',
  '正在压缩': 'Compacting',
  '已压缩': 'Compacted',
  '压缩上下文': 'Compact context',
  '这条线程还没报过上下文用量，跑完一轮就有了。': 'This thread hasn’t reported context usage yet. It will after the next turn.',
  '新线程还没开始，发出第一句话后这里会显示用了多少。': 'This thread hasn’t started. Usage shows up here after your first message.',
  '换号': 'Switch account',
  '正在读取额度…': 'Loading limits…',
  '暂时读不到这个号的额度。': 'Limits for this account are unavailable right now.',
  '这个号的 Codex 还没启动，跑过一轮后再看。': 'Codex hasn’t started for this account yet. Check back after a turn.',
  '剩': 'Left',
  '这是上次读到的数，可能不是最新。': 'Showing the last known values; they may be out of date.',
  '马上重置': 'Resets momentarily',
  '{w} {hm} 重置': 'Resets {w} {hm}',
  '{mo} 月 {d} 日重置': 'Resets {mo}/{d}',

  // 权限
  '每次询问': 'Ask every time',
  '只读；改文件、跑命令之前都先问你': 'Read-only; asks before editing files or running commands',
  '工作区内自动': 'Auto in workspace',
  '在项目里随便改、随便跑；联网或越出项目才问': 'Edits and runs freely in the project; asks for network access or anything outside it',
  '完全访问': 'Full access',
  '不再询问，也不限网络': 'Never asks, no network restrictions',

  // 项目
  '找项目': 'Find a project',
  '没有匹配的项目': 'No matching projects',
  '还没有项目': 'No projects yet',
  '添加项目…': 'Add project…',

  // 账号
  '每一轮按各号剩余额度自动挑号，这里不用手动切。在 Codex 设置里可以关掉。':
    'Each turn picks the account with the most remaining limits, so there’s no need to switch here. You can turn this off in Codex settings.',
  '5 小时剩 {n}%': '5h: {n}% left',
  'Codex 设置': 'Codex settings',
  '回到 bridge 主页': 'Back to bridge home',
};
