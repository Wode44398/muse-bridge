#!/usr/bin/env node
// 问题反馈的命令行：bootstrap.sh 的 report / feedback-auto 子命令以服务用户身份调它（跟服务进程共用数据目录）。
//   node src/feedback/cli.mjs draft <输入 json 文件> [--lang zh|en]   出草稿，打印预览和草稿编号（不发）
//   node src/feedback/cli.mjs send <草稿编号> [--lang zh|en]          用户同意后发出去
//   node src/feedback/cli.mjs auto on|off|status                       自动上报开关
//   node src/feedback/cli.mjs list [--json]                            发过的报告
//   node src/feedback/cli.mjs flush                                    补发没发出去的
//   node src/feedback/cli.mjs host                                     提交通道的主机名（allow-sites 用）
import { readFileSync } from 'node:fs';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { makeDraft, sendDraft, flushOutbox, feedbackHost } from './report.mjs';
import { getSettings, setAuto, listSent, listOutbox } from './store.mjs';

// Node 的 fetch 不认 HTTPS_PROXY：Muse 上只能经代理出站
if (process.env.HTTPS_PROXY || process.env.https_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());

const args = process.argv.slice(2);
const cmd = args[0] || '';
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const en = (flag('--lang') || process.env.UI_LANG) === 'en';
const L = (zh, e) => (en ? e : zh);
const ops = process.env.MB_OPS_CMD || 'bash /home/hatch/bridge-ops/bootstrap.sh';

function showResult(r) {
  if (r.status === 'sent') {
    if (r.private) console.log(L('已私下报告给项目维护者（安全问题不公开）。', 'Reported privately to the maintainers (security issues are not public).'));
    else if (r.duplicate) console.log(L(`已经有人报告过同一个问题，已在原 Issue 上 +1：${r.issue?.url || ''}`, `Someone already reported this; added a +1 to the existing issue: ${r.issue?.url || ''}`));
    else console.log(L(`已提交：${r.issue?.url || '(没拿到地址)'}`, `Submitted: ${r.issue?.url || '(no address returned)'}`));
    if (r.issue?.number) console.log(`ISSUE=${r.issue.number}`);
    return 0;
  }
  if (r.status === 'queued') {
    console.log(L(`暂时发不出去（${r.reason}），报告已存好，服务会在联网后自动补发。`, `Could not send right now (${r.reason}); the report is saved and the server will retry automatically.`));
    console.log(L('想马上提交，也可以让用户自己打开这个预填好的链接（要有 GitHub 账号）：', 'To submit now, the user can open this prefilled link (needs a GitHub account):'));
    console.log(r.fallbackUrl);
    return 0;
  }
  if (r.status === 'rejected') {
    console.log(L(`提交通道拒收了：${r.reason}`, `The feedback service declined it: ${r.reason}`));
    console.log(L('可以让用户自己打开这个预填好的链接提交（要有 GitHub 账号）：', 'The user can submit it through this prefilled link instead (needs a GitHub account):'));
    console.log(r.fallbackUrl);
    return 1;
  }
  console.log(L('找不到这份草稿（过期了或编号不对），重新跑一次 report 出草稿。', 'Draft not found (expired or wrong id); run report again to make a new one.'));
  return 1;
}

async function main() {
  switch (cmd) {
    case 'host': console.log(feedbackHost()); return 0;
    case 'draft': {
      const input = JSON.parse(readFileSync(args[1], 'utf8'));
      if (input.source === 'auto') {
        // 看门狗来的自动上报：用户没同意过就不发；同一件事一天只报一次
        if (getSettings().auto !== true) { console.log(L('自动上报没开，没有发送。', 'Auto-report is off; nothing was sent.')); console.log('AUTO=off'); return 0; }
        const dup = listSent().some((s) => s.source === 'auto' && s.title === input.title && Date.now() - Date.parse(s.at) < 86400_000);
        if (dup) { console.log(L('同一件事今天已经自动报过了。', 'This was already reported automatically today.')); console.log('AUTO=dup'); return 0; }
      }
      let d;
      try { d = makeDraft({ ...input, source: input.source || 'muse' }); }
      catch (e) {
        if (e?.message === 'empty report') { console.log(L('报告是空的：请把用户说的情况写进描述里再跑一次。', 'The report is empty: put what the user described into the description and run it again.')); return 1; }
        throw e;
      }
      if (input.source === 'auto') {   // 看门狗的自动上报：用户事先同意过，不再给人看，直接发
        const r = await sendDraft(d.id);
        console.log('AUTO=' + r.status);
        return showResult(r);
      }
      console.log(L('==================== 问题报告草稿（还没发） ====================', '==================== PROBLEM REPORT DRAFT (not sent yet) ===================='));
      console.log(d.preview.title);
      console.log('----------------------------------------------------------------');
      console.log(d.preview.body.replace(/\n<!-- muse-fp:[0-9a-f]+ -->$/, ''));
      console.log('----------------------------------------------------------------');
      console.log(L(`会提交到公开的 GitHub 仓库 Wode44398/muse-bridge 的 Issues${input.kind === 'security' ? '（安全问题：改为私下报告，不公开）' : ''}。`,
        `This goes to the public GitHub issues of Wode44398/muse-bridge${input.kind === 'security' ? ' (security issue: reported privately instead)' : ''}.`));
      console.log(L(`草稿编号 ${d.id}（24 小时内有效）。用户同意后发送：${ops} report --send ${d.id}`, `Draft ${d.id} (valid for 24 hours). Once the user agrees, send it: ${ops} report --send ${d.id}`));
      console.log(`DRAFT_ID=${d.id}`);
      return 0;
    }
    case 'send': return showResult(await sendDraft(args[1]));
    case 'auto': {
      const v = args[1];
      if (v === 'on' || v === 'off') setAuto(v === 'on');
      else if (v !== 'status') { console.error('usage: auto on|off|status'); return 2; }
      const a = getSettings().auto;
      console.log(a === true ? L('自动上报：开（服务出错时自动发送匿名错误报告，不含对话、文件、key、地址）', 'Auto-report: on (sends anonymous error reports when the server fails; no chats, files, keys or addresses)')
        : a === false ? L('自动上报：关（出错时不会自动发送，用户可以随时手动报告）', 'Auto-report: off (nothing is sent automatically; the user can still report problems manually)')
        : L('自动上报：还没问过用户（按关处理）', 'Auto-report: not asked yet (treated as off)'));
      return 0;
    }
    case 'list': {
      const sent = listSent();
      if (args.includes('--json')) { console.log(JSON.stringify({ auto: getSettings().auto, pending: listOutbox().length, sent })); return 0; }
      if (!sent.length) console.log(L('还没有发过报告。', 'No reports sent yet.'));
      for (const s of sent.slice(-15)) console.log(`${s.at?.slice(0, 16).replace('T', ' ')}  ${s.issue ? '#' + s.issue.number : s.private ? 'private' : '-'}  ${s.duplicate ? '+1 ' : ''}${s.title}`);
      const n = listOutbox().length;
      if (n) console.log(L(`另有 ${n} 份在等联网补发。`, `${n} more waiting to be retried.`));
      return 0;
    }
    case 'flush': {
      const r = await flushOutbox();
      console.log(L(`补发 ${r.length} 份：`, `Retried ${r.length}: `) + r.map((x) => x.status).join(', '));
      return 0;
    }
    default:
      console.error('usage: cli.mjs draft <file> | send <id> | auto on|off|status | list [--json] | flush | host');
      return 2;
  }
}

// 不直接 process.exit：代理连接池还在收尾时硬退，Windows 上的 libuv 会断言崩溃（Linux 上没事）。
// 设好退出码让进程自然结束；连接池迟迟不放就 5 秒后强退。
const done = (c) => { process.exitCode = c || 0; setTimeout(() => process.exit(process.exitCode), 5000).unref(); };
main().then(done, (e) => { console.error(e?.stack || e); done(1); });
