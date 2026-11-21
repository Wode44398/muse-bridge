// 共享终端各 action 的实现（入口 ../terminal-tools.mjs 只放工具说明与参数表）。

import { getCurrentGen, genEmit } from '../../runtime/gen.mjs';
import { keySeq } from './keys.mjs';
import { ansiToLines, allLines, screenState, screenText, tailText } from './screen.mjs';
import { settle, waitTerm, screenHints } from './wait.mjs';

const NARROW = 80;
const REASONS = {
  match: (r) => `屏幕上出现了目标：${r.match}`,
  quiet: (r, q) => (r.changed ? `屏幕已经 ${q} 秒没有变化（程序停下来了：干完了、在等输入、或出错停住）` : `屏幕 ${q} 秒里一直没变（程序可能早就停着）`),
  timeout: (r, q, w) => `等满 ${w} 秒，屏幕${r.changed ? '还在变化（程序仍在干活）' : '一直没变'}`,
  exit: () => 'shell 已退出',
  aborted: () => '等待被中断',
};

// 尺寸说明：status / read 的页眉，以及窄屏时提醒可以占住尺寸
function sizeLine(svc, t, st) {
  const lock = svc.termLock(t);
  let s = `终端 ${t.cols}×${t.rows}`;
  if (lock) s += '（尺寸由你占用中，用完 resize(release:true) 交还）';
  if (st?.alt) s += ' · 全屏程序占着屏幕（备用屏）';
  if (!lock && t.cols < NARROW) s += `\n（只有 ${t.cols} 列：宽度跟着用户的面板走。驱动 TUI 前可以 resize(cols:120, rows:40) 占住尺寸，读到的就不是窄条）`;
  return s;
}

// 动作事件发去哪：调用方给了 emit 就只走它（null / 空函数 = 不发）。不给才按 Claude 的轮找——
// getCurrentGen() 缺省取 admin 最新一轮 Claude，别的 agent（dimensio 经内部路由）落到那里就把事件发进了不相干的对话。
function termEmitter(getGen, emitIn) {
  if (emitIn !== undefined) return (action) => { if (typeof emitIn === 'function') emitIn({ type: 'term', action, at: Date.now() }); };
  const gen = (getGen && getGen()) || getCurrentGen();
  return (action) => { if (gen) genEmit(gen, { type: 'term', action, at: Date.now() }); };
}

/** 执行一次终端工具调用。ws：终端池引用；svc 可注入（测试用），默认 runtime/claude-term.mjs；emit 见 termEmitter。 */
export async function runTerminalAction({ getGen, ws, svc: svcIn, emit: emitIn } = {}, args, extra) {
  const a = String(args?.action || '');
  const svc = svcIn || await import('../../runtime/claude-term.mjs');
  const emit = termEmitter(getGen, emitIn);
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  const screenOf = async (t) => { const st = await screenState(svc, t); return { st, txt: screenText(st) || '（屏幕是空的）' }; };
  try {
    if (a === 'status') {
      const t = svc.getTerm(ws);
      if (!t) return text('终端尚未启动（用户没开过面板、你也还没写过）。run/write/keys 会自动启动它。');
      const { st } = await screenOf(t);
      return text(`${sizeLine(svc, t, st)}\n用户侧观看连接 ${t.subs.size} 个${t.exited ? '，⚠ shell 已退出（restart 可重开）' : ''}。`);
    }
    if (a === 'read') {
      const t = svc.getTerm(ws);
      if (!t) return text('终端尚未启动，没有可读内容。（run/write 会自动启动它）');
      svc.touchTermLock(t);
      if (args?.screen) { const { st, txt } = await screenOf(t); return text(`${sizeLine(svc, t, st)}\n${txt}`); }
      const n = Math.max(10, Math.min(3000, Number(args?.lines) || 200));
      const lines = await allLines(svc, t);
      if (!lines.length) return text('（终端屏幕当前是空的）');
      return text(`[${sizeLine(svc, t)}]\n${tailText(lines, n)}`);
    }
    if (a === 'restart') {
      svc.killTerm(ws);
      const t = svc.ensureTerm(ws, args?.cols, args?.rows);
      emit('restart');
      await settle(svc, t, { quietMs: 500, minMs: 600, maxMs: 4000 });   // 等 shell 出提示符
      return text(`终端已重启（${t.cols}×${t.rows}，全新 shell，滚回已清空）。\n${(await screenOf(t)).txt}`);
    }
    if (a === 'resize') {
      if (args?.release || (args?.cols === 0)) {
        const t = svc.getTerm(ws);
        if (!t) return err('终端尚未启动');
        const had = svc.unlockTermSize(ws);
        return text(had ? '已交还尺寸：用户的面板会按自己的大小重新适配。' : '尺寸本来就没被占用。');
      }
      if (!args?.cols || !args?.rows) return err('resize 需要 cols 和 rows（交还用 resize(release:true)）');
      svc.ensureTerm(ws, args.cols, args.rows);
      const t = svc.lockTermSize(ws, args.cols, args.rows);
      if (!t) return err('终端尚未启动');
      emit('resize');
      await settle(svc, t, { quietMs: 400, minMs: 300, maxMs: 2500 });   // 全屏程序按新尺寸重画
      return text(`已占住尺寸 ${t.cols}×${t.rows}：用户面板改为缩放显示，不再把它缩回去。用完 resize(release:true) 交还（15 分钟不碰自动交还）。\n${(await screenOf(t)).txt}`);
    }
    if (a === 'wait') {
      const t = svc.getTerm(ws);
      if (!t) return err('终端尚未启动，没有可等的');
      svc.touchTermLock(t);
      emit('wait');
      const quietSec = args?.quietSec == null ? 5 : Math.max(0, Math.min(600, Number(args.quietSec) || 0));
      const waitSec = Math.max(1, Math.min(600, Number(args?.waitSec) || 120));
      const r = await waitTerm(svc, t, { until: args?.until, quietMs: quietSec * 1000, timeoutMs: waitSec * 1000, signal: extra?.signal });
      svc.touchTermLock(t);
      const h = screenHints(r.st);
      const hint = [
        h.attention && `⚠ 末尾像是在等人确认 / 输入：「${h.attention}」`,
        h.error && `⚠ 末尾像是出错了：「${h.error}」`,
      ].filter(Boolean).join('\n');
      return text(`${REASONS[r.reason](r, quietSec, waitSec)}。${hint ? '\n' + hint : ''}\n当前屏幕：\n${screenText(r.st) || '（屏幕是空的）'}`);
    }
    if (a === 'run' || a === 'write' || a === 'keys') {
      if (a === 'run' && (!args?.command || !String(args.command).trim())) return err('run 需要 command');
      if (a === 'write' && args?.text == null) return err('write 需要 text');
      let keyPayload = '';
      if (a === 'keys') {
        const names = String(args?.keys || '').split(/\s+/).filter(Boolean);
        if (!names.length) return err('keys 需要键名序列，如 "ctrl+c" 或 "esc up enter"');
        const seqs = names.map((n) => { const s = keySeq(n); if (s == null) throw Object.assign(new Error(`不认识的键名 ${n}`), { friendly: true }); return s; });
        keyPayload = seqs.join('').repeat(Math.max(1, Math.min(50, Number(args?.repeat) || 1)));
      }
      const prev = svc.getTerm(ws);
      const live = svc.ensureTerm(ws, args?.cols, args?.rows);   // 已退出的旧壳会原地重生
      // 刚开出来的壳：等它出了提示符再敲，否则 run 收输出的窗口在 shell 启动期间就安静结束了，命令输出全落在窗口外
      if (live !== prev) await settle(svc, live, { quietMs: 500, minMs: 600, maxMs: 6000 });
      svc.touchTermLock(live);
      emit(a);

      if (a === 'keys') {
        svc.writeTerm(ws, keyPayload);
        await settle(svc, live, { quietMs: 300, minMs: 150, maxMs: 2500 });
        return text(`已发送。当前屏幕：\n${(await screenOf(live)).txt}`);
      }

      if (a === 'write') {
        const raw = String(args.text);
        const st0 = await screenState(svc, live);
        // 多行文本：程序开了括号粘贴就按粘贴发——不然中间的换行会被当成一次次回车，半截就提交了
        const multi = /\r?\n/.test(raw);
        svc.writeTerm(ws, multi && st0.modes.bracketedPasteMode ? `\x1b[200~${raw.replace(/\r?\n/g, '\r')}\x1b[201~` : raw);
        await settle(svc, live, { quietMs: 300, minMs: 150, maxMs: 2000 });
        const st1 = await screenState(svc, live);
        const notes = [];
        // 回显核对：只查非 ASCII（ASCII 字符屏幕上到处都是，查了也说明不了什么）。有的程序会悄悄丢掉
        // 某些字符（实测 agy 的输入框收不进 ①②③ 这类带圈数字），不提醒的话 agent 以为发出去了
        const shown = st1.rows.join('\n');
        const wide = [...new Set([...raw].filter((ch) => ch.codePointAt(0) > 0x7f && !/\s/.test(ch)))];
        const missing = wide.filter((ch) => !shown.includes(ch));
        if (missing.length) notes.push(`⚠ 屏幕上找不到你输入的这些字符：${missing.join('')}——目标程序可能不收它们（换成普通字符再发），也可能只是不回显（密码框）`);
        if (args?.enter) {
          // 回车单独发：和正文挤在一块时，不少 TUI 会把整块当成粘贴，回车成了换行
          svc.writeTerm(ws, '\r');
          await settle(svc, live, { quietMs: 700, minMs: 400, maxMs: 6000 });
          const st2 = await screenState(svc, live);
          const tail = raw.replace(/\s+/g, '').slice(-12);
          const cur = (st2.rows[st2.cursorY] || '').replace(/\s+/g, '');
          if (tail.length >= 4 && cur.includes(tail)) notes.push('⚠ 回车后光标所在行还是你刚输入的文字，可能没提交（程序也许把回车当成了换行，或在等别的按键）——看清屏幕再决定要不要再按 enter');
          else if (st2.rows.join('\n') === shown) notes.push('⚠ 回车后屏幕没有任何变化');
          else notes.push('回车后输入行已清空、屏幕有变化，看起来已提交。');
          return text(`${notes.join('\n')}\n当前屏幕：\n${screenText(st2) || '（屏幕是空的）'}`);
        }
        return text(`已输入（未回车）。${notes.length ? '\n' + notes.join('\n') : ''}\n当前屏幕：\n${screenText(st1) || '（屏幕是空的）'}`);
      }

      // run：从写入起收集新输出，安静 0.8s 或超时即返回（渲染成纯文本）。
      const payload = String(args.command).replace(/\r?\n$/, '') + '\r';
      const waitMs = Math.max(2, Math.min(300, Number(args?.waitSec) || 20)) * 1000;
      const QUIET_MS = 800;
      const CAP = 512 * 1024;
      let collected = '';
      let exited = null;
      await new Promise((resolve) => {
        let quietTimer = null;
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(quietTimer); clearTimeout(hardTimer); untap(); resolve(); };
        const untap = svc.tapTerm(live, (d, code) => {
          if (d == null) { exited = code; finish(); return; }
          collected += d;
          if (collected.length > CAP) collected = collected.slice(-CAP);
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, QUIET_MS);
        });
        const hardTimer = setTimeout(finish, waitMs);
        svc.writeTerm(ws, payload);
        quietTimer = setTimeout(finish, Math.min(waitMs, 5000));   // 一直无输出也别干等到超时
      });
      const lines = await ansiToLines(collected, live.cols, live.rows);
      const out = lines.length ? tailText(lines, 500) : '（该命令没有产生新输出）';
      const note = exited != null ? `\n（shell 已退出，code ${exited}）` : '';
      return text(out + note + '\n\n（这些内容用户在终端面板里同步看到了；还没跑完的话用 wait() 接着等）');
    }
    return err(`未知 action: ${a}`);
  } catch (e) {
    if (e && e.friendly) return err(String(e.message));
    return err(`终端操作失败：${String(e?.message || e)}`);
  }
}
