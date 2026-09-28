// P7：阻塞卡片上的「几点前没人处理会怎样」——只显示本地时钟的时:分，不跑秒表（每张卡一个定时器不值当）。
export function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
