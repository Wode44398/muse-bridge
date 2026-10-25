#!/usr/bin/env node
// SDK 契约体检——升级 @anthropic-ai/claude-agent-sdk 后、重启服务之前跑：
//   node scripts/sdk-contract.mjs            静态：版本三处一致 + sdk.d.ts / sdk.mjs / claude.exe 里每个依赖点都在
//   node scripts/sdk-contract.mjs --live     再加实打：把 bridge 依赖的运行时行为真跑一遍（小模型，几分钱）
//        [--model claude-haiku-5-5]
// 任何 fail 级不通过 → 退出码 1：不许重启上线，先查清楚（清单与每条的来由见 src/runtime/sdk-contract.mjs）。
// 实打与正式轮同一个号：bridge 当前激活的账号（claude-account.mjs，号池/切号后的那个）；没有就用环境里的登录。
// 在临时目录里跑、不加载任何用户设置。号额度用尽时实打结果记为「无法验证」（退出码 2），不算 SDK 坏了。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { versionReport, surfaceReport } from '../src/runtime/sdk-contract.mjs';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const MODEL = (() => { const i = args.indexOf('--model'); return i >= 0 ? args[i + 1] : 'claude-haiku-5-5'; })();
const rows = [];
let quotaBlocked = false;
const add = (r) => { rows.push(r); console.log(`${r.ok ? '  ok ' : r.level === 'warn' ? ' WARN' : ' FAIL'}  ${r.item}${r.ok ? '' : '  —— ' + r.detail}`); };

console.log('== 静态 ==');
for (const r of [...versionReport(), ...surfaceReport()]) add(r);

if (LIVE) {
  console.log(`\n== 实打（${MODEL}）==`);
  for (const k of Object.keys(process.env)) if (/^CLAUDE/.test(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN' && k !== 'CLAUDE_CONFIG_DIR') delete process.env[k];
  let acct = 'environment login';
  try {
    const { claudeEngineEnv } = await import('../src/runtime/claude-account.mjs');
    const env = claudeEngineEnv(null);
    if (env && env.CLAUDE_CODE_OAUTH_TOKEN) { process.env.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN; acct = 'bridge active account'; }
  } catch {}
  console.log(`（实打用 ${acct}）`);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cwd = mkdtempSync(path.join(tmpdir(), 'sdk-contract-'));
  const killer = setTimeout(() => { console.log('实打超时（6 分钟）'); process.exit(2); }, 6 * 60_000);
  killer.unref?.();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const live = (ok, item, detail, level = 'fail') => add({ ok, level, item, detail });

  // 一个流式输入会话：第一条可以先不给（同 bridge 的 deferFirst 预热）；push 随时追加。
  function session(options, { deferFirst = false, first = '' } = {}) {
    const queue = [];
    let wake = null, closed = false;
    const msg = (text, uuid) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] }, ...(uuid ? { uuid } : {}) });
    if (!deferFirst) queue.push(msg(first));
    async function* input() {
      while (!closed) {
        while (queue.length) yield queue.shift();
        await new Promise((w) => { wake = w; });
      }
    }
    const q = query({ prompt: input(), options: { cwd, model: MODEL, settingSources: [], systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false }, ...options } });
    const it = q[Symbol.asyncIterator]();
    open.add(q);
    let pending = null;
    return {
      q,
      push(text, uuid) { queue.push(msg(text, uuid)); if (wake) wake(); },
      // 读到满足条件的帧为止（顺手收集），超时回 null
      async until(pred, ms = 90_000) {
        const seen = [];
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          pending = pending || it.next();
          const r = await Promise.race([pending, sleep(deadline - Date.now()).then(() => null)]);
          if (!r) return { hit: null, seen };
          pending = null;
          if (r.done) return { hit: null, seen, ended: true };
          seen.push(r.value);
          if (pred(r.value)) return { hit: r.value, seen };
        }
        return { hit: null, seen };
      },
      close() { closed = true; if (wake) wake(); try { q.close(); } catch {} },
    };
  }
  const open = new Set();   // 所有探针会话：finally 里统一关，异常中止也不留 claude.exe 孤儿
  const isResult = (m) => m.type === 'result';
  const resultText = (m) => String(m?.result || '');
  // 号额度用尽：模型根本没答，后面的行为探针都无从判断——收手，记为无法验证。
  const QUOTA = /hit your .{0,20}limit|usage limit|rate[ _-]?limit|额度/i;
  class QuotaBlocked extends Error {}
  const guardQuota = (r) => { if (r?.hit && QUOTA.test(resultText(r.hit))) throw new QuotaBlocked(resultText(r.hit).slice(0, 80)); return r; };

  try {
    // L1 预热前提：第一条消息之前 CLI 就能完成初始化，且不会先吐任何帧
    {
      let stopEffort = null;
      const s = session({
        effort: 'low',
        hooks: { Stop: [{ hooks: [async (input) => { stopEffort = input && input.effort; return {}; }] }] },
      }, { deferFirst: true });
      const t0 = Date.now();
      const init = await Promise.race([s.q.initializationResult(), sleep(60_000).then(() => null)]);
      live(!!init, '预热：第一条消息之前 initializationResult 能完成', `等了 ${Date.now() - t0}ms 仍未完成（新会话预热的前提）`);
      const early = await s.until(() => true, 1500);
      live(!early.hit, '预热：第一条消息之前 CLI 不吐帧', `提前来了 ${early.hit?.type}/${early.hit?.subtype || ''}（parkSpare 会把它存进 earlyMsgs，影响不大）`, 'warn');
      const t1 = Date.now();
      s.push('只回复一个字：好');
      const a = await s.until((m) => m.type === 'system' && m.subtype === 'init');
      live(!!a.hit, '预热：送出第一条后出 system/init', '没等到 init 帧');
      if (a.hit) {
        live(Date.now() - t1 < 1000, '预热：送出到 init 不再等 spawn', `用了 ${Date.now() - t1}ms`, 'warn');
        const m = a.hit;
        live(typeof m.session_id === 'string' && m.session_id.length > 10, 'init 帧带 session_id', JSON.stringify(m.session_id));
        live(Array.isArray(m.mcp_servers), 'init 帧带 mcp_servers 数组', typeof m.mcp_servers);
        live(Array.isArray(m.slash_commands), 'init 帧带 slash_commands', typeof m.slash_commands);
        live('fast_mode_state' in m, 'init 帧带 fast_mode_state', '缺字段（Fast 实况芯片读它）', 'warn');
      }
      const r1 = guardQuota(await s.until(isResult));
      live(!!r1.hit && !r1.hit.is_error, '第一轮正常出 result', r1.hit ? resultText(r1.hit).slice(0, 80) : '没等到 result');
      live(!!stopEffort && typeof stopEffort === 'object' && stopEffort.level === 'low', 'Stop hook 带实际生效 effort {level}', `收到 ${JSON.stringify(stopEffort)}（effort 芯片实况）`, 'warn');
      // L2 挂起接力：同一输入流推第二条（带 uuid），result 的 user_message_uuids 带回它
      const uuid = randomUUID();
      s.push('只回复一个字：行', uuid);
      const r2 = await s.until(isResult);
      live(!!r2.hit && Array.isArray(r2.hit.user_message_uuids) && r2.hit.user_message_uuids.includes(uuid), '接力：第二条的 result 带回 user_message_uuids', `收到 ${JSON.stringify(r2.hit?.user_message_uuids)}`);
      // L3 控制方法：result 后进程还活着时能取上下文分布与设置
      const cu = await Promise.race([s.q.getContextUsage({ detail: 'full' }), sleep(15_000).then(() => null)]).catch((e) => ({ err: e.message }));
      live(!!cu && Array.isArray(cu.categories), 'getContextUsage(full) 返回 categories', JSON.stringify(cu).slice(0, 120));
      const st = typeof s.q.getSettings === 'function' ? await Promise.race([s.q.getSettings(), sleep(10_000).then(() => null)]).catch((e) => ({ err: e.message })) : null;
      live(!!st && typeof st === 'object' && 'applied' in st, 'getSettings() 返回 applied（Ultracode 实况）', JSON.stringify(st).slice(0, 120));
      s.close();
    }

    // L4 systemPrompt snapshot:false：resume 时新的 append 必须生效（bridge 逐轮现拼 append）
    {
      const s1 = session({ systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: '本轮口令：AAA。用户问口令时只回复口令本身。' } }, { first: '口令是什么？只回复口令。' });
      const a = guardQuota(await s1.until(isResult));
      const sid = a.hit?.session_id;
      s1.close();
      await sleep(1500);
      if (!sid) live(false, 'snapshot:false 探针第一轮', '没拿到 session_id');
      else {
        const s2 = session({ resume: sid, systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: '本轮口令：BBB。用户问口令时只回复口令本身。' } }, { first: '现在口令是什么？只回复口令。' });
        const b = guardQuota(await s2.until(isResult));
        s2.close();
        const t = resultText(b.hit);
        live(/BBB/.test(t), 'resume 后新的 systemPrompt append 生效（snapshot:false）', `第二轮回答「${t.slice(0, 40)}」——若仍是 AAA，逐轮注入的身份/能力/手机 nudge 全会冻在首轮`);
      }
    }

    // L5 PostToolUse 按工具名 matcher 触发（pushHook 靠它接 PushNotification）
    {
      const seen = [];
      const s = session({
        canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
        hooks: { PostToolUse: [{ matcher: 'Glob', hooks: [async (input) => { seen.push(input?.tool_name); return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'probe-ok' } }; }] }] },
      }, { first: '用 Glob 工具查找当前目录下的 *.md 文件（可能一个也没有），然后只回复 done。' });
      guardQuota(await s.until(isResult));
      s.close();
      live(seen.includes('Glob'), 'PostToolUse 的 matcher 钩子按工具名触发', `钩子收到 ${JSON.stringify(seen)}（模型没调 Glob 时也会落空——看一眼即可）`, 'warn');
    }

    // L6 输入建议：result 之后 prompt_suggestion 帧才到（bridge 停放期收）
    {
      const s = session({ promptSuggestions: true }, { first: '用一句话介绍一下 JSON 是什么。' });
      guardQuota(await s.until(isResult));
      const sg = await s.until((m) => m.type === 'prompt_suggestion', 30_000);
      s.close();
      live(!!sg.hit, 'result 之后 30s 内收到 prompt_suggestion', '没收到（CLI 对短对话可能抑制，偶发不算坏）', 'warn');
    }
  } catch (e) {
    if (e instanceof QuotaBlocked) {
      quotaBlocked = true;
      console.log(`  ——  实打中止：这个号额度用尽（${e.message}），行为探针无法验证。换个有额度的号再跑。`);
    } else live(false, '实打过程异常', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    clearTimeout(killer);
    for (const q of open) { try { q.close(); } catch {} }
    await sleep(1000);
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

const fails = rows.filter((r) => !r.ok && r.level !== 'warn');
const warns = rows.filter((r) => !r.ok && r.level === 'warn');
console.log(`\n共 ${rows.length} 项：失败 ${fails.length}，需人工看一眼 ${warns.length}${quotaBlocked ? '；实打因额度中止（未验证）' : ''}`);
process.exit(fails.length ? 1 : quotaBlocked ? 2 : 0);
