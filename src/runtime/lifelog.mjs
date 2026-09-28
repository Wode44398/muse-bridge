// 进程生死留痕：让「服务器又静默没了」不再是无头案。
//
// 2026-08-25 12:41 那次就是无头案的标本：一轮深度研究跑到一半，8787 进程整个消失，
// Windows 事件日志里没有 WER、没有崩溃记录（说明不是硬崩），zombie-reaper 也没动手，
// 唯一的痕迹是 tunnel-watchdog 的一行 `port refused (process gone)`——只知道「几点没的」，
// 不知道「为什么没的」。2026-08-01 给启动器加 stdout 重定向就是为了防这个，但只有重定向
// 不够：node 被 TerminateProcess 或 OOM abort 掉时【什么都不会打】，日志里也就什么都没有。
//
// 所以这里补三件事：
//   ① 启动横幅带 pid + 本地时间：一份日志里能一眼分清这是第几条命、从几点活到几点；
//   ② 每 5 分钟一条 [alive] 心跳带 rss/heap/uptime：就算被瞬杀也留得下「最后一次还活着
//      是几点、内存涨到哪了」——OOM（rss 一路爬到几个 G 后戛然而止）和外力瞬杀
//      （rss 平稳，心跳突然断）就此可分，这正是上次分不出来的那一步；
//   ③ 所有拦得到的退出路径（signal / process.exit）各打一行原因。
// 拦不到的只剩 TerminateProcess 和 OOM abort——那正是 ② 存在的理由。
//
// 注意：这几行必须走 console.log（stdout），因为落盘靠的是启动器的 `>> server.out.log 2>&1`。

const BEAT_MS = 5 * 60_000;

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function mem() {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB`;
}

export function installLifeLog(name = 'bridge') {
  console.log(`[life/${name}] 起 pid=${process.pid} ${localStamp()} node=${process.version} ${mem()}`);

  const beat = setInterval(() => {
    console.log(`[alive/${name}] ${localStamp()} pid=${process.pid} up=${Math.round(process.uptime())}s ${mem()}`);
  }, BEAT_MS);
  // unref：心跳不该成为进程退不出去的理由。
  if (beat.unref) beat.unref();

  let said = false;
  const bye = (why) => {
    if (said) return;
    said = true;
    console.log(`[life/${name}] 落 pid=${process.pid} ${localStamp()} up=${Math.round(process.uptime())}s ${mem()} 原因：${why}`);
  };

  // 'exit' 是同步阶段，console.log 往文件 fd 写是同步的，这一行落得下去。
  process.on('exit', (code) => bye(`process exit code=${code}`));
  // 信号：Windows 下 Stop-Process -Force 是 TerminateProcess（无信号，拦不到），
  // 但 taskkill 不带 /F、Ctrl+C、以及未来若改用优雅停机都会走到这里。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => { bye(`收到 ${sig}`); process.exit(0); });
  }
}
