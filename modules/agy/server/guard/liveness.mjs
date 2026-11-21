// 守卫探活：成员的 agy 进程里，工具调用守卫是不是真的在把关。
//
// 守卫靠 agy 的钩子机制生效（它每次调用工具前执行我们的脚本，脚本回来问 bridge）。这条链子断了的话——agy 升级后改了
// 钩子的加载位置或名字、钩子文件被别的同名配置顶掉——agy 不会报错，只是不再来问，成员的工具调用就没人管了。
// 所以反过来查：一轮里有工具真的执行完了，bridge 却一次都没被问过，就认定守卫没生效，
// 当场停掉这一轮和这个成员的进程，并且不再给他起（直到 bridge 重启；那时会重装守卫再试）。
//
// 不依赖别的模块：路由（记一次「被问过」）、对话主流程（盯工具事件）、进程管理（拒绝再起）都引它。

const hits = new Map();     // 身份键 -> 守卫被问过的次数
const broken = new Map();   // 身份键 -> 认定失效的说明

export const GUARD_BROKEN_MESSAGE = 'Antigravity 的工具调用守卫没有生效，为安全起见已停用你的 Antigravity。请联系管理员（多半是 Antigravity 升级后需要 bridge 跟着适配）。';

export function noteGuardHit(key) {
  const k = String(key || '');
  if (k) hits.set(k, (hits.get(k) || 0) + 1);
}
export const guardHits = (key) => hits.get(String(key || '')) || 0;
export const guardBroken = (key) => broken.get(String(key || '')) || '';
export function markGuardBroken(key, why = '') {
  const k = String(key || '');
  if (!k) return;
  broken.set(k, why || 'guard not answering');
  console.error(`[agy-guard] ${k} 的工具调用守卫没有生效（${why || '有工具执行完了，守卫却没被问过'}），已停用他的 Antigravity 进程`);
}

/**
 * 盯一轮的工具事件。返回 (evt) => boolean：true = 这一轮里有工具从「开始」走到了「执行完」，守卫却没被问过。
 * 只认这一轮里亲眼看着开始的调用（载入历史时回放的旧调用一上来就是完成态，不算）；
 * 同一个人的另一轮此刻问过也算数（同一个进程、同一份钩子）。
 */
export function makeGuardWatch(key) {
  const base = guardHits(key);
  const started = new Set();
  return (evt) => {
    if (!evt || (evt.type !== 'tool' && evt.type !== 'tool-update')) return false;
    const id = evt.tool?.toolCallId;
    if (!id) return false;
    const st = String(evt.tool.status || '');
    if (st === 'pending' || st === 'in_progress') { started.add(id); return false; }
    return st === 'completed' && started.has(id) && guardHits(key) === base;
  };
}

export function _resetGuardLivenessForTest() { hits.clear(); broken.clear(); }
