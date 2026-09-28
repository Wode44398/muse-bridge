// dimensio（harness）子进程的存活看门狗（S9 / #24）。
//
// 以前 bridge 只在 harness 子进程【退出】时才重拉。一次灾难性正则（或任何同步死循环）把 harness
// 主线程冻住时，进程还活着、端口还占着：ensureHarness 每次探活 1.5 秒超时、轮询 20 秒后回 503，
// 永远不会换人——手机上只剩 503，直到有人手动杀进程。
//
// 判据：子进程早已过了启动期（bootGraceMs），却在连续 hungWindowMs 里一次探活都没答上，才算冻住，
// 整树杀掉后重拉。窗口刻意给宽（默认 30 秒）：harness 里有合法的短时同步阻塞（spawnSync 查进程表
// 最长 20 秒），不能一卡就杀——重拉会腰斩所有在跑的轮次。
//
// 纯逻辑与依赖注入，便于用假时钟测；harness.mjs 负责真实的 probe / spawn / 杀进程。

import { killChildTreeSafe } from './proc-tree.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} d
 * @param {() => Promise<boolean>} d.probe      一次探活（自带短超时）
 * @param {() => boolean} d.hasChild            托管的子进程还活着吗
 * @param {() => number} d.childAgeMs           当前子进程拉起多久了
 * @param {() => void} d.spawn                  拉起一个新子进程
 * @param {() => Promise<void>} d.killChild     整树杀掉当前子进程，等它真的退了再返回
 * @returns {Promise<boolean>} 最终能否应答
 */
export async function ensureHarnessUp(d) {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m) => console.error(m));
  const bootGraceMs = d.bootGraceMs ?? 30_000;
  const hungWindowMs = d.hungWindowMs ?? 30_000;
  const probeEveryMs = d.probeEveryMs ?? 3_000;
  const readyPolls = d.readyPolls ?? 40;
  const readyEveryMs = d.readyEveryMs ?? 500;

  if (await d.probe()) return true;
  if (d.hasChild() && d.childAgeMs() >= bootGraceMs) {
    const until = now() + hungWindowMs;
    while (now() < until && d.hasChild()) {
      await sleep(probeEveryMs);
      if (await d.probe()) return true;
    }
    if (d.hasChild()) {
      log(`[harness] alive but unresponsive for ${Math.round(hungWindowMs / 1000)}s — killing its process tree and restarting`);
      await d.killChild();
    }
  }
  if (!d.hasChild()) d.spawn();
  for (let i = 0; i < readyPolls; i++) {
    await sleep(readyEveryMs);
    if (await d.probe()) return true;
  }
  return false;
}

// M8（K27 / N36）：计划内的停（bridge 收到退出信号）先让 harness 自己排空——在跑的轮按「服务重启」
// 中止并落盘、收掉 job / 预览 / 浏览器，再自行退出。以前直接 child.kill()：Windows 上是 TerminateProcess，
// harness 的清理一行都不执行。请求发不出去、或 graceMs 内没退，才整树强杀。永不 reject。
/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} d
 * @param {() => Promise<boolean>} d.requestDrain  让 harness 排空退出（POST /api/admin/retire/commit）
 * @param {number} [d.graceMs]
 * @returns {Promise<'gone' | 'drained' | 'killed'>}
 */
export async function stopHarnessGracefully(child, d) {
  const sleep = d.sleep ?? realSleep;
  if (!child || child.exitCode !== null || child.signalCode !== null) return 'gone';
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  let asked = false;
  try {
    asked = await d.requestDrain();
  } catch {
    asked = false;
  }
  if (asked) {
    const done = await Promise.race([exited, sleep(d.graceMs ?? 15_000).then(() => false)]);
    if (done) return 'drained';
  }
  await (d.killTree ?? killTreeAndWait)(child);
  return 'killed';
}

// 整树杀（Windows 上 child.kill 只打得到直接子进程，harness 下面还挂着浏览器、预览服务、后台 job），
// 等 'exit' 真的来了再返回——新子进程要接着绑同一个端口。最多等 waitMs，永不 reject。
// #77：不用 taskkill /T——它会顺着悬空的父 PID 杀到不相干的进程（包括 bridge 自己的启动链），见 proc-tree.mjs。
export function killTreeAndWait(child, waitMs = 10_000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(done, waitMs);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', done);
    killChildTreeSafe(child).catch(() => { try { child.kill('SIGKILL'); } catch {} });
  });
}
