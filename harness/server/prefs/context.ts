// 上下文与后台任务的偏好项（登记格式见 ../prefs.ts）：后台任务通知、空闲压缩、空闲时整理记忆、工具延迟加载。
import type { PrefSpec } from "../prefs.ts";

export const CONTEXT_PREFS: PrefSpec[] = [
  {
    key: "jobNotify",
    type: "bool",
    default: true,
    group: "chat",
    label: "后台任务跑完自动接着做",
    desc: "dimensio 放到后台的命令跑完（或输出里出现它盯着的内容）而这一轮已经结束时，自动开一轮把结果交给它；你在界面上停掉的不算",
    en: {
      label: "Continue when a background task finishes",
      desc: "When a command dimensio put in the background finishes (or prints a line it is watching for) after its turn has ended, start a turn that hands it the result. Tasks you stop yourself don't count.",
    },
  },
  {
    key: "idleCompact",
    type: "bool",
    default: true,
    group: "chat",
    label: "空闲时赶在缓存过期前压缩",
    desc: "用 Anthropic 官方接口的长对话空闲约 54 分钟、1 小时提示缓存快过期时，先把上下文压缩一次，回来接着聊不用按原价重写整段缓存",
    en: {
      label: "Compact idle conversations before the cache expires",
      desc: "When a long conversation on the official Anthropic API has been idle for about 54 minutes and its one-hour prompt cache is about to expire, compact it first so coming back does not rewrite the whole cache at full price.",
    },
  },
  {
    key: "idleCompactMinTokens",
    type: "number",
    default: 120_000,
    min: 30_000,
    max: 1_000_000,
    group: "chat",
    label: "空闲压缩的起点（token）",
    desc: "上下文至少这么大才做空闲压缩",
    en: { label: "Idle compaction threshold (tokens)", desc: "Only conversations with at least this much context are compacted while idle." },
  },
  {
    key: "memoryDream",
    type: "bool",
    default: true,
    group: "chat",
    label: "空闲时整理记忆",
    desc: "所有对话都停了 20 分钟以上时，dimensio 把还没复核的记忆拿回写它时的原始对话核对一遍：合并重复、改正、退掉错的；只有找得到你亲口说过的原话才让它生效，其余留在记忆面板里等你确认。同一个项目半天最多一次，用的是这个项目最近一次对话的模型",
    en: {
      label: "Tidy up memory while idle",
      desc: "When every conversation has been idle for 20 minutes, dimensio checks memory notes nobody has reviewed against the conversation each was written in: it merges duplicates, corrects or retires wrong ones, and makes a note take effect only when it finds your own words saying so — the rest wait in the memory panel for you. At most once every half day per project, using the model of that project's latest conversation.",
    },
  },
  {
    key: "deferTools",
    type: "bool",
    default: true,
    group: "chat",
    label: "不常用的工具按需加载说明",
    desc: "浏览器、操作电脑、bridge、拉取请求、工作区协同这些工具平时只带一句简介，dimensio 第一次要用时再取完整说明，每轮请求省下约一万 token；只对新会话生效",
    en: {
      label: "Load instructions for rarely used tools on demand",
      desc: "Browser, device control, bridge, pull request and workspace tools carry only a one-line summary until dimensio first needs one and fetches its full instructions, saving about ten thousand tokens per request. Applies to new conversations.",
    },
  },
];
