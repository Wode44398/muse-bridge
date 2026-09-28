// 工作区「任务」视图的本地状态：跨面板重挂保留（切工具、关开工作区、条目从「进行中」挪到「已完成」都会重挂）。
//  · cleared：「清除」= 本地隐藏已完成的条目，按会话记（切会话不串），后台命令用 `job:<id>` 记；
//  · finishedOpen：「已完成」一节折没折；
//  · open：工作流行展没展开（按工具行 id）。第一次露面时记下默认值（在跑 = 展开），之后跑完挪去「已完成」也不收——
//    正看着的阶段表不会在结束那一刻突然合上。
// 只活在内存里：页面在就在，不落盘。
export const taskView = $state({
  cleared: {} as Record<string, string[]>,
  finishedOpen: true,
  open: {} as Record<string, boolean>,
});
