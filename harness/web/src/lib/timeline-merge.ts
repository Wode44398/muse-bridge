// 时间线合并：把「服务端记录重建出来的那份」并进现有时间线，只动分叉的尾巴。
// 与 stream-turn.ts 同理，刻意不依赖 Svelte/浏览器全局，好在 Node 里直接测。
//
// 为什么不能整表替换：断线对账（每次重连、回前台、别的设备跑过一轮）都会走
// applyRecord。整表替换 = 整个会话的 markdown 全量重解析、DOM 全量重建、
// 工具/思考行的展开态归位、视口跳底 —— 会话越长手机上越卡，而且绝大多数
// 时候前面那些回合一个字都没变。共同前缀原地不动，只 splice 尾巴。
//
// 沿用 bridge Claude 分页的语义指纹思路：指纹只看内容，不看纯 UI 态（open）与
// 直播派生字段，否则「直播渲染出来的」和「记录重建出来的」永远不相等，每次
// 对账都从第 0 条全量替换，等于没合并。

// 指纹刻意省掉 open（用户展开的工具/思考行）：它是本地 UI 态，记录里没有，
// 计入的话每条展开过的行都会被判成"有变化"而被折叠版覆盖掉。
export function itemFp(it: any): string {
  switch (it?.kind) {
    case "user":
      // N45：召回清单也算内容（直播里后到的召回、记录里带着的召回要对得上）；引用的对话也算（只有引用、没打字的一条也要认得出）
      return `u|${it.steer ? 1 : 0}|${it.text}|${(it.attachments ?? []).map((a: any) => a.path).join(",")}|${(it.recall ?? []).length}|${(it.refs ?? []).map((r: any) => r.id).join(",")}`;
    case "text":
      return `t|${it.text}|${(it.artifacts ?? []).map((a: any) => a.path).join(",")}`;
    case "thinking":
      return `k|${it.text}`;
    case "tool":
      return `o|${it.id}|${it.name}|${it.status}|${it.summary}|${(it.output ?? "").length}`;
    case "ask":
      return `a|${it.id}|${it.answered ? 1 : 0}|${JSON.stringify(it.selected ?? {})}`;
    case "permission":
      return `p|${it.id}|${it.decided ?? ""}`;
    case "plan":
      return `l|${it.id}|${it.decided ?? ""}|${it.plan}`;
    case "error":
      return `e|${it.text}`;
    case "notice":
      return `n|${it.text}`;
    case "screenshot":
      return `s|${it.url}|${it.asset ?? (it.dataUri ?? "").length}`;
    default:
      return JSON.stringify(it);
  }
}

// 原地合并 —— 必须 splice 而不是赋值：调用方（Svelte $state 数组）的引用与
// 前缀元素身份都要保住，前缀元素身份没了就等于整表替换，白合并一场。
// 返回是否有变化（没变就一个字节都别动）。
export function mergeTimeline<T>(cur: T[], next: T[]): boolean {
  let i = 0;
  while (i < cur.length && i < next.length && itemFp(cur[i]) === itemFp(next[i])) i++;
  if (i === cur.length && i === next.length) return false;
  cur.splice(i, cur.length - i, ...next.slice(i));
  return true;
}
