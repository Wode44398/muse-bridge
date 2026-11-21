// Claude conversation history: the SDK persists every session as a .jsonl log
// under ~/.claude/projects/<cwd-with-non-alnum-replaced-by-dash>/. Because the
// bridge always runs with cwd === VAULT, those logs ARE this app's chat history.
// Any of them can be reopened by passing its id back as `resume`.

import '../plugins/tool-card.mjs';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import 'node:readline';
import 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import * as claudeQuick from '../claude-quick.mjs';
import { collectDeliverables, deliverAnywhere, deliverNav, deliverRoots, isInside, resolveDeliverPath, streamArtifactFile, streamFolderZip, transcriptCwds } from '../runtime/deliverables.mjs';
import { isHtmlFile, respondHtmlSite } from '../runtime/html-site.mjs';
import { sanitizeName } from '../runtime/paths.mjs';
import { getLiveGens, findGenBySession, bridgeSessions, routineSessions, pluginSessions } from '../runtime/gen.mjs';
import { findRewindAnchors, rewindClaudeFiles, pendingRewindAnchor, setPendingRewind } from '../agents/claude-rewind.mjs';
import { releaseWarmClaude } from '../agents/claude.mjs';
import { chatPrefsFor, lastChatPrefs, dropChatPrefs, setChatPrefsOutputStyle } from '../runtime/chat-prefs.mjs';
import { validSessionOutputStyle } from '../runtime/claude-turn-settings.mjs';
import { sessionQuestions } from '../runtime/questions.mjs';
import { getLibrary, applyLibraryOp, dropFromLibrary } from '../runtime/session-library.mjs';
import { claudeSettingsSnapshot, setClaudeSettings, claudeSetting, onClaudeSettings } from '../runtime/claude-settings.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { lineageFor } from '../runtime/desktop-lineage.mjs';
import { sessionOutputs } from '../runtime/session-outputs.mjs';
import { sessionMcp } from '../runtime/session-mcp.mjs';
import { familyMaps, forgetSession, linkedSessions, lastActiveOf, sessionFileOf } from '../runtime/session-family.mjs';
import { sessionCostBaseline } from '../runtime/usage-ledger.mjs';
import { projectState, threadResolved } from '../runtime/project-mode.mjs';
// 会话列表的扫盘 / 标题链 / 归档态 / 全文搜索（2026-10-20，对齐官方 Desktop 的归档与搜索）
import { invalidateSessionFiles, listSessionFilesAsync } from '../runtime/session-list.mjs';
import '../runtime/session-jsonl.mjs';
import { sendJson } from './static-compress.mjs';
import { resolveTitles, resolveTitle, knownUntitled, scheduleTitleWarm } from '../runtime/session-titles.mjs';
import { archiveView, dropStaleInactive, sessionArchiveFlag } from '../runtime/session-archive-auto.mjs';
import { scheduleDesktopMirror, setMirrorResolvers } from '../runtime/desktop-mirror.mjs';
import { forgetArchived, getArchiveState } from '../runtime/session-archive.mjs';
import { sessionLineage, forgetDetached } from '../runtime/session-lineage.mjs';
import { forgetActivity } from '../runtime/session-activity.mjs';
import { scheduleSearchWarm } from '../runtime/session-search.mjs';
import { hasPeerHold } from '../runtime/session-peers.mjs';
import { forgetPrSession, prBrief } from '../runtime/pr-monitor.mjs';
import { VAULT } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import '../runtime/status.mjs';
import { planRecordFor } from '../runtime/permissions.mjs';   // 计划卡的结论 / 批准时选的目标模式（历史里的计划卡）
import '../runtime/tool-images.mjs';   // 工具结果图片张数（状态行缩略图条）
import '../runtime/model-ratings.mjs';   // 工作流 auto:<档> agent 的真实模型与档位
import '../runtime/principal.mjs';
// 工具行/任务卡规则与直播端（agents/claude.mjs）共用一份——直播与重开必须一致。
import '../runtime/tool-summary.mjs';
import '../mcp/visualize.mjs';
import { toClientAtt } from '../runtime/client-atts.mjs';
import { forgetHistory, readSessionHistory } from './sessions/history-cache.mjs';
import { readSessionMessages, sessionMarkdown } from './sessions/history-parse.mjs';
import { displayTitle, locateSession } from './sessions/lookup.mjs';
import { readSessionTitle, sessionFingerprint, trimTitle } from './sessions/transcript-text.mjs';
import { pluginOriginOf } from './sessions/plugin-origin.mjs';
export { sessionFingerprint, trimTitle, readSessionTitle } from './sessions/transcript-text.mjs';
export { sessionMarkdown, readSessionMessages } from './sessions/history-parse.mjs';
export { _historyStats, readSessionHistory } from './sessions/history-cache.mjs';
export { locateSession, searchSessions } from './sessions/lookup.mjs';

// Desktop 侧栏登记用的标题（desktop-mirror.mjs）：bridge 里改过名的优先，其次与列表同一口径
async function mirrorTitleOf(ctx, f) {
  const libT = (getLibrary(ctx).titles || {})[f.id];
  if (libT) return libT;
  if (!f.file) return '';
  return (await resolveTitle(f, { fam: familyMaps(ctx).titles.get(f.id), desktop: undefined, readFirst: readSessionTitle, trim: trimTitle })).title;
}
setMirrorResolvers({
  titleOf: (f) => mirrorTitleOf(f.ctx, f),
  archivedOf: (ctx, f) => !!archiveView(ctx)(f.id, f.mtime, f.size),
});
// 不依赖有人打开 bridge 会话列表：服务起来后定时补登记一遍（11-06 实遇：重启后没人开列表，一条都没登记）。
// 先 lineageFor 踢一轮 Desktop 扫描，扫完的下一拍 scheduleDesktopMirror 才放行。
// 全量补登记的参数：普通会话登记；临时对话的会话行交去撤回（以前登记过的），它们存为工作空间后才登记
const mirrorOpts = (ctx, extra = {}) => ({
  filesFn: () => listSessionFilesAsync(ctx).then((r) => ({ files: r.files, retract: r.quickFiles })),
  titleOf: (f) => mirrorTitleOf(ctx, f),
  archivedOf: (() => { const av = archiveView(ctx); return (f) => !!av(f.id, f.mtime, f.size); })(),
  ...extra,
});
function mirrorTick() {
  try {
    const ctx = contextFor({ kind: 'admin' });
    lineageFor(ctx);
    scheduleDesktopMirror(ctx, mirrorOpts(ctx));
  } catch (e) { console.warn('[desktop-mirror] tick', e && e.message); }
}
if (!process.env.NODE_TEST_CONTEXT && process.env.BRIDGE_DESKTOP_MIRROR !== '0') {
  setTimeout(mirrorTick, 30_000).unref();
  setTimeout(mirrorTick, 90_000).unref();
  setInterval(mirrorTick, 5 * 60_000).unref();
}


// 附件清单的抽取与出口见 runtime/client-atts.mjs（直播插话共用）
export { splitAttachments, parseQuoteFile } from '../runtime/client-atts.mjs';

// 首页带上「整组都比截断点老」的项目的最新几条：GROUP_HEAD 条；整组剩下不超过 GROUP_HEAD_ALL 条就全给
const GROUP_HEAD = 3, GROUP_HEAD_ALL = 4;
// 临时对话：首页最多带最近这么多条；侧栏「显示更多」用 ?project=@quick 翻页（@ 开头不会撞上项目 id）
const QUICK_HEAD = 20, QUICK_PAGE_ID = '@quick';
// 临时对话的清理方式（设置「清理临时对话」：按时间 / 只留最近 N 条 / 不清理，claude-quick.mjs 的 quickRetention）
const quickRet = (ctx) => claudeSetting(ctx, 'quickRetention');
// rows 里出现的那些桶的到期时刻：按这些桶【全部】对话记录算（某只桶的较新一条可能在别的页里）。不按时间清理时为空表
function quickExpiresFor(ctx, quickFiles, rows) {
  const ids = new Set(rows.map((r) => r.projectId));
  return ids.size ? claudeQuick.quickExpiries(ctx, quickFiles.filter((r) => ids.has(r.projectId)), { retention: quickRet(ctx) }) : {};
}
// 后台回收临时对话（节流见 schedulePruneQuick）。有对话进了回收站、或 announce（刚改了清理方式，quickPolicy 变了）
// 就推一帧 quick.pruned，侧栏当场重拉；老前端不认这个事件，下次刷新时跟上。
function pruneQuickBg(ctx, busy, { force = false, announce = false } = {}) {
  claudeQuick.schedulePruneQuick(ctx, { busy, retention: quickRet(ctx), onDrop: (id) => dropChatPrefs(ctx, id) }, {
    force,
    onDone: (r) => {
      if (!announce && !r.recycled) return;
      invalidateSessionFiles();
      busPublish(ctx.key, { type: 'quick.pruned', recycled: r.recycled });
    },
  });
}

export function registerSessionRoutes(router, { authOk, identify }) {
  // 改了「清理临时对话」：不等 5 分钟节流，按新方式马上回收一轮（改成只留 N 条时，超出的当场进回收站）
  onClaudeSettings((ctx, keys) => {
    if (!keys.includes('quickRetention') || !ctx?.key) return;
    const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
    pruneQuickBg(ctx, busy, { force: true, announce: true });
  });
  router.on('GET', '/api/sessions', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    // 扫盘（所有项目目录 + worktree + 全部临时对话桶）见 runtime/session-list.mjs。
    // 归档与分页（2026-10-20，对齐官方 Desktop 的 Archive）：
    //   默认（活跃视图）：已归档的不进列表、不占 60 条名额；另回 archivedCount（已归档总数，侧栏「已归档」入口用）、
    //     projectCounts（各项目活跃会话总数——前端组内「显示更多」据此知道服务端还有多少）、more（活跃会话超出这一页）、
    //     cutoff（这 60 条里最旧那条的 mtime：组内翻页从这里往下要。收藏 / 一家子补进来的老行不算，它们不连续）。
    //   ?project=<id>&before=<mtime>&limit=N：某项目里比 before 更早的活跃会话（组内「显示更多」翻页，老会话找得回来）；
    //     另回 cursor（这一页最旧那条的 mtime，含被滤掉的无标题文件——下一页从这里接着要，整页都是噪声也不会停）。
    //   ?view=archived&offset=&limit=：已归档会话，按归档时间倒序（跟随 Desktop 来的没有归档时间，按活动时间）。
    //   默认视图另回 archiveRev（bridge 归档记录的版本，前端对不上就拉 GET /api/claude/archive）；
    //   带 ?keep=id,id（前端组内翻页拿回来的老行）时回 gone：其中已经不在活跃列表里的（别处删了、归档了、
    //   跟随 Desktop 归档了）——整表刷新只覆盖最新 60 条，这些老行靠它对账，不然会一直挂着幽灵行。
    // 计数（projectCounts / archivedCount / total）不算确定没标题的文件（列表会滤掉它们，见 session-titles.mjs
    // 的 knownUntitled；没解析过的先算上，后台 scheduleTitleWarm 把全集过一遍之后就准了）。
    //   临时对话（S1-6）：带 quick=2 的是认得「多条临时对话」的新前端——默认视图回最近 QUICK_HEAD 条 + quickCount /
    //     quickMore / quickCursor（侧栏「显示更多」用 ?project=@quick&before= 翻页）+ quickOrphans（只有文件、
    //     没有对话的桶）；不带的是还没更新的老前端（手机安装包里打包的界面），照旧只给一只桶的最新一条
    //    （claude-quick.mjs 的 legacyQuickSlot）。
    const sp = url ? url.searchParams : new URLSearchParams();
    const view = sp.get('view') === 'archived' ? 'archived' : 'active';
    const pageProject = view === 'active' ? sp.get('project') || '' : '';
    const quickV2 = sp.get('quick') === '2';
    const before = Number(sp.get('before')) || 0;
    const offset = Math.max(0, Number(sp.get('offset')) || 0);
    const limit = Math.max(1, Math.min(200, Number(sp.get('limit')) || (view === 'archived' ? 30 : 60)));
    // 异步扫盘 + 2s 短缓存 + 单飞（10-21：以前每个请求同步扫一遍，开一次 Claude 页首页 + 各项目翻页同时到，整台服务冻 0.7–2.4s）
    const { files: allFiles, quickFiles } = await listSessionFilesAsync(ctx);
    // Which sessions have a generation in flight on THIS server（多对话并发：可能多个）。
    const liveGens = getLiveGens(ctx.key);
    const liveIds = new Set(liveGens.map((g) => g.sessionId).filter(Boolean));
    // 官方 Desktop 子会话树（desktop-lineage.mjs）与 bridge 自己派生的子会话（session-family.mjs）并成一张表，
    // 再扣掉「移到顶层」过的（session-lineage.mjs）：parentId = 顶层祖先，前端据此把子行缩进挂在根下。
    const desktop = lineageFor(ctx);
    const fam = familyMaps(ctx);
    const lineage = sessionLineage(ctx, { desktop, fam }).rootOf;
    const listable = (f) => liveIds.has(f.id) || sessionQuestions.hasFor(f.id, ctx.key) || !knownUntitled(f, { fam: fam.titles.get(f.id), desktop: desktop.titles.get(f.id) });
    // 自动归档之后又在别处（Desktop / CLI）聊过的：记录清掉、回到活跃列表（runtime/session-archive-auto.mjs）
    if (view === 'active' && !pageProject) dropStaleInactive(ctx, allFiles);
    // 归档态（bridge 记录优先，其次跟随 Desktop）。在跑 / 在问的会话一律算活跃：在 Desktop 里归档过、
    // 又在 bridge 里接着聊的那条不能从侧栏消失（真人发消息时 claude.mjs 也会顺手取消归档）。
    const arch = archiveView(ctx);
    const files = [], archived = [];
    for (const f of allFiles) {
      const busy = liveIds.has(f.id) || sessionQuestions.hasFor(f.id, ctx.key);
      // Desktop 的侧边对话（/btw）：官方侧栏不列，这里也不列——活跃、归档、计数都不算（在跑 / 在问的照旧显示）
      if (!busy && desktop.btw && desktop.btw.has(f.id)) continue;
      const a = busy ? null : arch(f.id, f.mtime, f.size);
      if (a) archived.push({ ...f, arch: a }); else files.push(f);
    }
    let capped, more = false;
    const extra = {};
    if (view === 'archived') {
      const list = archived.filter(listable).sort((a, b) => (b.arch.at || b.mtime) - (a.arch.at || a.mtime));
      capped = list.slice(offset, offset + limit);
      more = list.length > offset + limit;
      extra.total = list.length;
    } else if (pageProject === QUICK_PAGE_ID) {
      // 临时对话区「显示更多」翻页：比 before 更早的临时对话，带上这些桶的到期时刻
      const list = quickFiles.filter((f) => !before || f.mtime < before);
      capped = list.slice(0, limit);
      more = list.length > limit;
      extra.cursor = capped.length ? capped[capped.length - 1].mtime : 0;
      extra.quickExpires = await quickExpiresFor(ctx, quickFiles, capped);
    } else if (pageProject) {
      const list = files.filter((f) => f.projectId === pageProject && (!before || f.mtime < before));
      capped = list.slice(0, limit);
      more = list.length > limit;
      extra.cursor = capped.length ? capped[capped.length - 1].mtime : 0;
    } else {
      // 临时对话【不占也不吃】60 条上限：侧栏单独一区，聊得再久也不该被新会话挤出列表（挤掉了就等于凭空消失）。
      // 但一条一只桶、30 天才回收，数量能攒到几百：首页只带最近 QUICK_HEAD 条，其余侧栏「显示更多」翻页要。
      // 与普通会话按 mtime 合并成一列（列表恒按 mtime 倒序，lib/sessionsOrder.js 的不变量；前端预取最新几条也靠它）。
      let quickHead;
      if (quickV2) {
        const qList = quickFiles.filter(listable);
        quickHead = qList.slice(0, QUICK_HEAD);
        extra.quickCount = qList.length;
        extra.quickMore = qList.length > QUICK_HEAD;
        extra.quickCursor = extra.quickMore ? quickHead[quickHead.length - 1].mtime : 0;
        // 只有文件、没有对话的桶（最近一轮回收扫出来的）：侧栏单独列，不让它们无声地走完两轮 30 天
        extra.quickOrphans = claudeQuick.quickOrphans(ctx).filter((o) => !quickFiles.some((f) => f.projectId === o.id));
      } else {
        const slot = claudeQuick.legacyQuickSlot(ctx, quickFiles);
        const head = slot ? quickFiles.find((f) => f.projectId === slot) : null;
        quickHead = head ? [head] : [];
      }
      capped = [...quickHead, ...files.slice(0, limit)].sort((a, b) => b.mtime - a.mtime);   // 标题有缓存（session-titles.mjs），但响应体积仍要有上界
      more = files.length > limit;
      extra.cutoff = more ? files[limit - 1].mtime : 0;
      // 临时对话的回收时间表（S1-6）：首页这些桶的到期时刻 + 策略天数 + 回收站里有几只。界面上的「n 天后清理」与
      // 回收站入口都按它显示——到期时刻与 pruneQuick 同一算法，写的天数就是真实回收的时候。
      extra.quickExpires = await quickExpiresFor(ctx, quickFiles, quickHead);
      const qr = claudeQuick.quickRetention(quickRet(ctx));
      extra.quickPolicy = { ttlDays: claudeQuick.QUICK_TTL_DAYS, warnDays: claudeQuick.QUICK_WARN_DAYS, trashDays: claudeQuick.QUICK_TRASH_DAYS, mode: qr.mode, ...(qr.max ? { max: qr.max } : {}) };
      extra.quickRecycled = claudeQuick.recycledQuickCount(ctx);
      const projectCounts = {};
      for (const f of files) if (listable(f)) projectCounts[f.projectId] = (projectCounts[f.projectId] || 0) + 1;
      extra.archivedCount = archived.filter(listable).length;
      extra.projectCounts = projectCounts;
      extra.archiveRev = getArchiveState(ctx).rev;
      const keep = String(sp.get('keep') || '').split(',').filter((x) => /^[0-9a-fA-F-]{8,64}$/.test(x)).slice(0, 300);
      if (keep.length) {
        // 翻页拿回来的老行也可能是临时对话（侧栏「显示更多」），它们还在就不算 gone
        const alive = new Set([...files, ...quickFiles].filter(listable).map((f) => f.id));
        extra.gone = keep.filter((id) => !alive.has(id));
      }
      // 全文搜索索引与标题缓存：有人打开 Claude 页就在后台把它们建起来（节流、延后，首个搜索就快、计数就准）
      scheduleSearchWarm(ctx, () => listSessionFilesAsync(ctx).then((r) => [...r.quickFiles, ...r.files]));
      scheduleTitleWarm(ctx, () => listSessionFilesAsync(ctx).then((r) => r.files), () => {
        const fm = familyMaps(ctx);
        return { famTitles: fm.titles, desktopTitles: lineageFor(ctx).titles, readFirst: readSessionTitle, trim: trimTitle };
      });
      // 旧会话 / 漏掉的补登记进官方 Desktop 侧栏（desktop-mirror.mjs，节流 60s、只给主机本人；新会话在 claude.mjs 当场登记）
      scheduleDesktopMirror(ctx, mirrorOpts(ctx));
    }
    // 一家子不被 60 条截断拆散：列进来的根带上它所有子会话，列进来的子会话也把根补上（只在活跃会话里补）。
    if (view === 'active' && !pageProject && lineage.size && files.length > limit) {
      const inIds = new Set(capped.map((f) => f.id));
      const roots = new Set();
      for (const f of capped) roots.add(lineage.get(f.id) || f.id);
      for (const f of files.slice(limit)) {
        if (inIds.has(f.id) || !roots.has(lineage.get(f.id) || f.id)) continue;
        capped.push(f); inIds.add(f.id);
      }
    }
    // 收藏的会话同理不被 60 条挤掉：侧栏「收藏」区是常驻的，老会话收藏了也要一直在（官方 Pinned 同款）
    if (view === 'active' && !pageProject && files.length > limit) {
      const stars = new Set(getLibrary(ctx).stars || []);
      if (stars.size) {
        const inIds = new Set(capped.map((f) => f.id));
        for (const f of files.slice(limit)) if (stars.has(f.id) && !inIds.has(f.id)) { capped.push(f); inIds.add(f.id); }
      }
    }
    // 首页 60 条里一条都没有的项目（整组都比截断点老）：每组顺带最新几条（10-21）。以前前端进页就替这些组各发一个
    // ?project= 翻页（本机 5 个并发、各扫一遍盘），现在首页一次给齐；剩得不多就整组给完，免得组下孤零零挂一行「显示更多」。
    // 组内翻页的游标照旧从 cutoff 往下要，这几条前端按 id 去重。
    if (view === 'active' && !pageProject && files.length > limit) {
      const stars = new Set(getLibrary(ctx).stars || []);
      const shownIn = new Set(capped.filter((f) => !stars.has(f.id)).map((f) => f.projectId));
      const inIds = new Set(capped.map((f) => f.id));
      const rest = new Map();   // projectId → 该组截断点之后的活跃会话（mtime 倒序）
      for (const f of files.slice(limit)) {
        if (shownIn.has(f.projectId) || inIds.has(f.id) || stars.has(f.id) || !listable(f)) continue;
        let l = rest.get(f.projectId);
        if (!l) rest.set(f.projectId, (l = []));
        l.push(f);
      }
      for (const l of rest.values()) capped.push(...(l.length <= GROUP_HEAD_ALL ? l : l.slice(0, GROUP_HEAD)));
    }
    // 已归档视图带上 bridge 的归档记录（前端据此判断「当前打开的会话已归档」，显示横条）
    if (view === 'archived') extra.archive = getArchiveState(ctx);
    // 顺手回收临时对话（按设置：默认 30 天没动进回收站、回收站再放 30 天才删；节流、后台跑，不拖慢本次列表）。
    if (view === 'active' && !pageProject) pruneQuickBg(ctx, liveIds);
    // 还躺在临时对话目录里的「存好的工作空间」（10-21 前存的 / 存时有会话在跑）补挪到固定位置（节流、后台）。
    claudeProjects.scheduleRelocateSavedQuicks(ctx.claudeProjects, ctx, { busy: liveIds, release: (sid) => releaseWarmClaude(ctx.key, sid) });
    const newest = liveGens[liveGens.length - 1] || null;
    const active = newest ? (newest.sessionId || null) : null;
    // 侧栏工作点只认真正在生成的轮：done 已发、只剩收尾（effort 定局、上下文用量，1–13s）的 gen 带
    // finalizing，还算 live 但界面上这轮已经结束。不排除它会撞时序：前端在 done 那一刻（busy→false）
    // 拉列表，服务端此刻还在收尾 → 回 thinking:true；而 run.end 推送比这次全量扫盘的响应先到，
    // 被迟到的响应盖回去，点就一直亮到下一次整表刷新（10-21 实测，常常是下一轮）。
    const workingIds = new Set(liveGens.filter((g) => !g.finalizing).map((g) => g.sessionId).filter(Boolean));
    // 标题链（runtime/session-titles.mjs）：jsonl 尾部 custom-title > bridge 派生名 / Desktop 标题 > ai-title > 首条消息；
    // 用户在 bridge 里改过名的由前端 titleFor() 用 library 覆盖（清掉自定义名就回到这条链）。按 size+mtime 缓存。
    const titles = await resolveTitles(capped, { famTitles: fam.titles, desktopTitles: desktop.titles, readFirst: readSessionTitle, trim: trimTitle });
    const built = capped.map((f) => ({
      id: f.id,
      mtime: f.mtime,
      size: f.size,
      projectId: f.projectId,
      ...(f.wt ? { wt: f.wt } : {}),
      ...(lineage.has(f.id) ? { parentId: lineage.get(f.id) } : {}),
      // 直接父（bridge 派生的才有）：会话信息面板的「相关会话」卡、工具行的跳转用；parentId 是顶层祖先（侧栏只缩进一级）
      ...(fam.parentOf.has(f.id) ? { spawnedBy: fam.parentOf.get(f.id) } : {}),
      // 项目对话（runtime/project-mode.mjs）：侧栏行换项目图标，它下面的子会话叫讨论串
      ...(chatPrefsFor(ctx, f.id)?.shape === 'project' ? { shape: 'project' } : {}),
      title: titles.get(f.id)?.title || '',
      ...(f.arch ? { archived: true, archivedReason: f.arch.reason, ...(f.arch.at ? { archivedAt: f.arch.at } : {}) } : {}),
    }));
    // Drop sessions whose title we can't read — those are .jsonl files currently
    // locked by other live claude.exe processes (the desktop Claude Code session,
    // sub-agents, etc.) or with no user text. They're unreadable noise here.
    // Always keep the in-flight session, labeled.
    const sessions = built
      .filter((s) => s.title || liveIds.has(s.id) || sessionQuestions.hasFor(s.id, ctx.key))
      .map((s) => ({
        ...s,
        title: s.title || '（进行中…）',
        thinking: workingIds.has(s.id),      // a turn is generating in this conversation
        pending: sessionQuestions.hasFor(s.id, ctx.key) || hasPeerHold(ctx.key, s.id), // an AskUserQuestion is waiting here（或跨会话消息等你确认）
        origin: routineSessions.has(s.id) ? 'routine' : pluginSessions.has(s.id) ? 'plugin' : (bridgeSessions.has(s.id) ? 'phone' : 'desktop'),
        ...(pluginSessions.has(s.id) ? pluginOriginOf(pluginSessions.get(s.id)) : {}),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // prefsLast：最近一次发送用的 model/effort/fast——前端「新对话」的选择器默认（跨设备）。
    res.end(JSON.stringify({ sessions, active, actives: [...liveIds], pending: [...sessionQuestions.keysFor(ctx.key)], prefsLast: lastChatPrefs(ctx), library: getLibrary(ctx), ...extra, more }));   // library：收藏 + 自定义标题（按身份落服务端，换设备照样在）
  });

  // —— Claude 项目（路径制，与 codex projects 同构）：列表 / 浏览目录 / 新建 / 重命名 / 删除 ——
  const projCtx = (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
    return contextFor(who);
  };
  const projJson = (res, fn) => {
    try {
      const data = fn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(e?.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || '操作失败' }));
    }
  };
  // 「位置」列表 —— agent 中立（Claude / Codex / dimensio 的新建项目选择器共用一份）。
  // 远程端的选择器基底是工作空间文件管理器，它锁在身份工作空间根内；这条给它一层根切换，
  // 把 admin 的可达范围补回到与旧自建选择器等价的「整机」。dimensio 的默认项目库
  // （~/Dimensio Projects）也当成一个位置摆进去，取消「新建空白项目」后不丢那条路。
  router.on('GET', '/api/project/locations', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const dimensio = path.join(os.homedir(), 'Dimensio Projects');
    projJson(res, () => ({
      locations: claudeProjects.projectLocations(ctx, [{ id: 'dimensio', name: 'Dimensio Projects', path: dimensio }]),
    }));
  });
  // 临时对话桶一只一枚 quick 项目，全部列出（带 quick=2 的新前端）；还没更新的老前端（不带）只认一只「快照」，
  // 照旧只给一只——与 /api/sessions 同一个挑法（claude-quick.mjs 的 legacyQuickSlot），两边对得上。
  router.on('GET', '/api/claude/projects', async (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const quickV2 = !!url && url.searchParams.get('quick') === '2';
    let slot = null;
    if (!quickV2) {
      try { slot = claudeQuick.legacyQuickSlot(ctx, (await listSessionFilesAsync(ctx)).quickFiles); } catch {}
    }
    projJson(res, () => {
      let projects = claudeProjects.listProjects(ctx.claudeProjects, ctx);
      if (!quickV2) {
        const keep = projects.find((p) => p.quick && p.id === slot) || projects.find((p) => p.quick && p.current) || null;
        projects = projects.filter((p) => !p.quick || p === keep);
      }
      return { projects, order: claudeProjects.projectOrder(ctx.claudeProjects) };
    });
  });
  // 侧栏拖放排序：{ ids: [项目 id…] } 整表覆盖（只存显示顺序，不动项目本身）
  router.on('POST', '/api/claude/project/order', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, order: claudeProjects.setProjectOrder(ctx.claudeProjects, ctx, body && body.ids) }));
  });
  router.on('POST', '/api/claude/project/create', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, project: claudeProjects.createProject(ctx.claudeProjects, ctx, body) }));
  });
  router.on('POST', '/api/claude/project/rename', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, project: claudeProjects.renameProject(ctx.claudeProjects, ctx, body.id, body.name) }));
  });
  router.on('POST', '/api/claude/project/delete', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: claudeProjects.deleteProject(ctx.claudeProjects, ctx, body.id) }));
  });
  // 「新建临时对话」：给一只没用过的空桶（当前桶没用过就是它，用过了就现铸一只；用过的旧桶照常列出、按时间回收）。
  // 前端拿到 project 后直接以它为上下文开一条空对话——新桶=新 cwd=新自动记忆目录，前尘不带。
  router.on('POST', '/api/claude/quick/new', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => ({ ok: true, project: claudeQuick.newQuickProject(ctx) }));
  });
  // 「存为工作空间」：某只临时对话桶登记成普通项目（不再按时间回收），随后挪到固定位置。
  // { id: 那条临时对话所在的桶（会话行的 projectId；老前端传的是当前桶 id）, label: 显示名（那条对话的标题，可空）,
  //   base: 没有 label 时的显示名前缀（按界面语言，后面接编号）}
  // → { project: 存好的工作空间（id 沿用桶 id）, quick: 当前的空桶 }
  router.on('POST', '/api/claude/quick/save', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    let saved;
    try { saved = claudeProjects.saveQuickProject(ctx.claudeProjects, ctx, { id: body && body.id, base: body && body.base, label: body && body.label }); }
    catch (e) { projJson(res, () => { throw e; }); return; }
    // 老前端（body 不带 quick:2）存完，它的「快照」位换上的是当前空桶：记一笔，老前端的列表照旧语义（legacyQuickSlot）
    if (!body || body.quick !== 2) claudeQuick.markQuickHanded(ctx);
    // 当场挪出快照目录（固定位置，任何回收都不扫那里）；有会话在跑就先原地，会话列表接口稍后补挪。
    try {
      const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
      const moved = await claudeProjects.relocateSavedQuicks(ctx.claudeProjects, ctx, { busy, release: (sid) => releaseWarmClaude(ctx.key, sid) });
      const hit = moved.find((m) => m.id === saved.project.id);
      if (hit) saved.project = { ...saved.project, path: hit.path };
    } catch (e) { console.warn('[quick] relocate on save failed:', e?.message || e); }
    // 存成工作空间了：这时才把它的会话登记进官方 Desktop 侧栏（不等 60s 节流；没挪成的等挪完后定时那路补）
    try { scheduleDesktopMirror(ctx, mirrorOpts(ctx, { force: true })); } catch {}
    projJson(res, () => ({ ok: true, ...saved }));
  });
  // 「继续保留」：给这只临时对话桶记一次活动，回收时钟从头算。{ id } → { id, expiresAt }
  router.on('POST', '/api/claude/quick/keep', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, ...claudeQuick.keepQuick(ctx, body && body.id, { retention: quickRet(ctx) }) }));
  });
  // 临时对话回收站：到期的桶整只挪在这里（对话记录留在原处），再放 30 天才永久删除。
  // → { items: [{ id, sessionId（最新那条对话，前端据此套用户改过的标题）, title, sessions, items, recycledAt, purgeAt, lastActive }] }（新回收的在前）
  router.on('GET', '/api/claude/quick/recycled', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    try {
      const list = await claudeQuick.listRecycledQuick(ctx);
      const heads = list.map((x) => x.files[0]).filter(Boolean);
      const titles = await resolveTitles(heads, { famTitles: new Map(), desktopTitles: new Map(), readFirst: readSessionTitle, trim: trimTitle });
      const items = list.map((x) => ({
        id: x.id, sessionId: x.files[0]?.id || null, title: (x.files[0] && titles.get(x.files[0].id)?.title) || '', sessions: x.files.length, items: x.items,
        recycledAt: x.recycledAt, purgeAt: x.purgeAt, lastActive: x.lastActive,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || '读取回收站失败' }));
    }
  });
  // 从回收站恢复：整只桶挪回列表，对话与产物原样接上。{ id } → { project }
  router.on('POST', '/api/claude/quick/restore', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const project = claudeQuick.restoreQuick(ctx, body && body.id);
      invalidateSessionFiles();   // 会话列表的 2s 缓存里还没有它
      // 没有对话记录、只有文件的那种：马上重扫一遍，侧栏「只有文件」那一行不用等 5 分钟才出来
      const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
      pruneQuickBg(ctx, busy, { force: true });
      return { ok: true, project };
    });
  });

  // 会话收藏 / 自定义标题（跨设备）：{op:'star'|'title'|'merge', …} → { library }。
  // 有变化就推总线 {type:'library'}，同账号其它在线设备即刻跟上。快照访客（ctx.snap）不开放。
  router.on('POST', '/api/claude/library', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const { library, changed } = applyLibraryOp(ctx, body);
      if (changed) busPublish(ctx.key, { type: 'library', library });
      return { ok: true, library };
    });
  });

  // Claude 分页设置（注册表 src/config/claude-settings.mjs；按身份存服务端，主机级仅管理员）。
  // GET → { settings }；POST { patch:{key:value|null} } → 校验后落盘、推总线 {type:'claude.settings'}。
  router.on('GET', '/api/claude/settings', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => ({ ok: true, settings: claudeSettingsSnapshot(ctx) }));
  });
  router.on('POST', '/api/claude/settings', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const followBefore = claudeSetting(ctx, 'followDesktopArchive');
      const { settings, changed, hostChanged } = setClaudeSettings(ctx, body && body.patch);
      if (changed) busPublish(ctx.key, { type: 'claude.settings', settings });
      // 「跟随 Claude Desktop 的归档」一切换，哪些会话算已归档就整批变了（bridge 的归档记录本身没变、不会有 archive 事件）：
      // 推一帧 archive（basis），侧栏活跃列表 / 已归档计数 / 开着的已归档视图当场重拉
      if (changed && claudeSetting(ctx, 'followDesktopArchive') !== followBefore) busPublish(ctx.key, { type: 'archive', archive: getArchiveState(ctx), basis: true });
      // 主机级改动影响所有身份的快照（如 allowBypass 裁剪权限模式）；管理员自己的设备立即跟上，其余身份下次拉取时拿到。
      else if (hostChanged) busPublish(ctx.key, { type: 'claude.settings', settings });
      return { ok: true, settings };
    });
  });

  // 会话级输出风格（官方会话菜单「Output style」同款，输入栏加号菜单里选）：只影响这一个会话，下一轮起生效。
  // GET ?session=<id> → { style（这个会话的覆盖，null = 跟随默认）, def（设置里的默认）, styles }；
  // POST { session, style|null } → 记进 chat-prefs，推总线 {type:'output_style'} 让同账号别的设备的菜单跟上。
  router.on('GET', '/api/claude/output-style', async (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '');
    projJson(res, () => {
      const s = claudeSettingsSnapshot(ctx);
      return { ok: true, style: sid ? (chatPrefsFor(ctx, sid)?.outputStyle || null) : null, def: s.values.outputStyle, styles: s.outputStyles };
    });
  });
  router.on('POST', '/api/claude/output-style', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const sid = String((body && body.session) || '');
    projJson(res, () => {
      if (!/^[0-9a-fA-F-]{8,80}$/.test(sid)) throw Object.assign(new Error('bad session'), { status: 400 });   // 同其它会话接口（不放过 __proto__ 之类）
      const v = validSessionOutputStyle(ctx, body.style);
      if (!v.ok) throw Object.assign(new Error('没有这个输出风格'), { status: 400 });
      setChatPrefsOutputStyle(ctx, sid, v.value);
      busPublish(ctx.key, { type: 'output_style', sessionId: sid, style: v.value });
      return { ok: true, style: v.value };
    });
  });

  // 会话信息面板（官方 Session rail）要的两样服务端数据：「输出内容」（transcript 推算，session-outputs.mjs）
  // 与「连接器」（最近一轮 init 帧的 MCP 状态，session-mcp.mjs）。环境 / 上下文 / 更改前端已有现成来源。
  router.on('GET', '/api/claude/session-rail', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return; }
    const p = await locateSession(ctx, id);
    if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    // 所属项目就是 transcript 所在的那个 scope（locateSessionProject 再逐目录同步找一遍也是它）
    const cwd = (p.project && p.project.path) || ctx.cwd;
    let outputs = [];
    try { outputs = await sessionOutputs(p.file, { cwd, linkRoots: deliverRoots(ctx, cwd, VAULT), anywhere: deliverAnywhere(ctx) }); } catch {}
    // 相关会话（session-family.mjs）：父 / 子 / 兄弟，带状态与各自最新汇报的开头
    let family = null;
    try { const f = await linkedSessions(ctx, id, { reports: true }); if (f.parent || f.children.length || f.siblings.length) family = f; } catch {}
    // 项目对话：子会话就是讨论串，卡片按讨论串的状态点画（等你 = 有审批卡 / 提问在等）
    if (family && chatPrefsFor(ctx, id)?.shape === 'project') {
      // 概览按状态分组：resolved = 标过已解决（或空闲满 7 天），at = 最后改动时间（runtime/project-mode.mjs）
      const st = projectState(ctx, id);
      // 用量按讨论串拆分：transcript 里 CLI 记的累计 cost-state（按 API 价折算；订阅号只是参考值）
      const costOf = async (sid, file) => { try { return file ? await sessionCostBaseline(file, sid) : 0; } catch { return 0; } };
      const costs = await Promise.all(family.children.map((c) => costOf(c.id, sessionFileOf(ctx, c.id))));
      const coordCost = await costOf(id, p.file);
      family = { ...family, project: true, paused: st.paused, cost: { coordinator: coordCost, threads: costs.reduce((a, b) => a + b, 0) }, children: family.children.map((c, i) => {
        const at = lastActiveOf(ctx, c.id);
        // 讨论串绑定的 PR（待评审 / 合并中两组看它；合并了算已解决）
        let pr = null;
        try { pr = prBrief(ctx, c.id); } catch {}
        return { ...c, at, cost: costs[i] || 0, ...(pr ? { pr } : {}), ...(sessionQuestions.hasFor(c.id, ctx.key) ? { waiting: true } : {}), ...(threadResolved(st, c.id, { lastAt: at, working: c.state === 'working', merged: !!pr && pr.state === 'merged' }) ? { resolved: true } : {}) };
      }) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ outputs, mcp: sessionMcp(ctx.key, id), family }));
  });

  router.on('GET', '/api/session', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad id');
      return;
    }
    // 项目制：transcript 可能在任一项目目录，跨目录定位（含防穿越；先查会话列表的扫盘缓存）。
    const p = await locateSession(ctx, id);
    if (!p) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    // 对账短路：这个响应完全由「transcript 文件 + 回滚锚点 + prefs sidecar」决定，
    // 三者都没变，重建出来的消息就必然逐字节一致。客户端把上次拿到的 fp 带回来，
    // 命中就回一个几十字节的 unchanged，连 transcript 都不读。
    //
    // 为什么值得做：Claude 分页每收到一个 session.touch 总线事件就 freshen 一次整份
    // transcript。CLI / 桌面 Claude Code 在跑的时候那个 jsonl 一直在长，实测手机端
    // 大约每 8 秒重拉一次整份记录（长会话几百 KB），纯属白烧流量和电。harness 那边
    // 早就用 recordFp 把这条短路了（319KB→53B），Claude 分页一直没有。
    const fp = sessionFingerprint(p.file, id, ctx);
    if (fp && url.searchParams.get('fp') === fp) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, unchanged: true, fp }));
      return;
    }
    // 大会话走增量解析缓存（readSessionHistory：只读新增的行，结果与整份重建一致）
    const all = await readSessionHistory(p.file, { key: ctx.key, cutAfterUuid: pendingRewindAnchor(id), planRecord: (tid) => planRecordFor(ctx, tid) });
    // 助手侧产物附件：与 live 轮（agents/claude.mjs done 事件）同一套提取——从该轮最终
    // 文本的 markdown 链接重建，重开会话与直播看到的一致；transcript 即真相，无需 sidecar。
    const roots = deliverRoots(ctx, p.project.path, VAULT);
    // nav：文件夹卡「在工作空间里打开」的定位（ctx.cwd = 身份文件根，项目 path = 会话工作空间）。
    const nav = { fileRoot: ctx.cwd, ws: p.project.path, shell: !!ctx.shell };
    const messages = all.slice(-80).map((m) => {
      if (m.role === 'user') return m.attachments ? { ...m, attachments: m.attachments.map((a) => toClientAtt(a, ctx)) } : m;
      const { cwds, ...rest } = m;
      // 插话段里的附件同用户气泡一样出口（绝对路径不出服务器），前端据此画缩略图
      if (rest.segments && rest.segments.some((s) => s.kind === 'steer' && s.atts)) {
        rest.segments = rest.segments.map((s) => (s.kind === 'steer' && s.atts ? { ...s, atts: s.atts.map((x) => toClientAtt(x, ctx)) } : s));
      }
      // 基准：该轮落盘的 cwd（最近的优先）→ 项目根；roots 不变，根守卫不放宽。
      const bases = [...(cwds || []).slice().reverse(), p.project.path];
      let atts = [];
      try { atts = collectDeliverables(m.text, { cwd: bases, roots, nav, anywhere: deliverAnywhere(ctx) }); } catch {}
      return atts.length ? { ...rest, attachments: atts } : rest;
    });
    // prefs：这个会话上次用的 model/effort/fast（sidecar）——前端恢复选择器。
    // wt：worktree 会话的 cwd 与分支（工作台/归属芯片据此指向 worktree 而不是主检出）。
    // archived / archivedReason：与侧栏列表同一口径（含跟随 Desktop）——冷启动恢复、直接打开
    // 一条已归档的会话时，前端靠它亮「此会话已归档」横条（lib/sessionArchive.svelte.js）
    let arc = {}; try { const st = statSync(p.file); arc = sessionArchiveFlag(ctx, id, st.mtimeMs, st.size); } catch {}
    // 长会话的响应能有 ~1MB：超过 64KB 且客户端收 gzip 就压（LAN 直连收益最大）。消息对象与解析缓存共用，sendJson 当场序列化。
    await sendJson(req, res, { id, projectId: p.project.id, ...(p.project.worktree ? { wt: { cwd: p.project.path, branch: p.project.worktree.branch } } : {}), messages, truncated: all.length > messages.length, prefs: chatPrefsFor(ctx, id), fp, ...arc, ...(sessionMcp(ctx.key, id) ? { mcp: sessionMcp(ctx.key, id).servers } : {}) });
  });

  // —— 检查点回滚：文件恢复到某条用户消息发出前的状态（可选把对话也截回同一处）——
  // 文件 = 临时 resume query 调 SDK rewindFiles（零 token；机制与坑见 claude-rewind.mjs 头注）；
  // 对话 = 记 pending 锚点，下一轮 query 以 resumeSessionAt 在 transcript 里分叉，
  //        /api/session 在 pending 生效前就按锚点截断视图。
  // mode: 'both'（默认，文件+对话）| 'files'（只回滚文件）| 'chat'（只回滚对话锚点，文件一概不动——
  //       安全栅门横条「Edit prompt and retry」用：把被拒的那条用户消息撤回输入框改了重发，工作区里
  //       已经做好的活不能被顺带回滚掉；也不起 SDK 临时 query，零 token、零文件改动）。
  // 会话正在生成时拒绝——transcript 只能有一个写入者，SDK 子进程也会锁文件。
  router.on('POST', '/api/claude/rewind', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const id = String(body.sessionId || '');
    const uuid = String(body.uuid || '');
    const mode = body.mode === 'files' ? 'files' : (body.mode === 'chat' ? 'chat' : 'both');
    if (!/^[0-9a-fA-F-]{8,}$/.test(id) || !/^[0-9a-fA-F-]{8,}$/.test(uuid)) return json(400, { error: '参数不合法' });
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
    if (!p) return json(404, { error: '会话不存在' });
    const live = findGenBySession(ctx.key, id);
    if (live && !live.done) return json(409, { error: '这个会话正在生成中，先「停止」再回滚。' });
    const anchors = findRewindAnchors(p.file, uuid);
    if (!anchors) return json(400, { error: '找不到这条消息的回滚锚点（会话记录可能已变化，重新打开会话再试）' });
    // 上一轮停放着的 CLI（agents/claude.mjs 的会话常驻）内存里还是回滚前的历史，文件回滚还要另起一个
    // resume 进程——先关掉它（一份 transcript 一个写入者），下一轮按锚点冷起分叉。
    await releaseWarmClaude(ctx.key, id);
    if (mode === 'chat') {
      // 纯对话回滚：只记 pending 锚点（与 both 分支的对话部分同一条路），跳过 rewindFiles。
      // 目标是会话首条消息时锚点为 null——对话没有更早处可回，直说。
      if (!anchors.convAnchor) return json(409, { error: '这是会话的第一条消息，对话没有更早处可回。' });
      setPendingRewind(id, anchors.convAnchor);
      return json(200, { ok: true, conv: true, files: false, note: '仅回滚了对话，文件未改动。' });
    }
    // 文件回滚。检查点缺失是【软失败】：开检查点之前的旧会话轮 / 该消息之后没改过文件，
    // 都会报 "No file checkpoint found"——mode both 时仍可只回滚对话。
    let files = { ok: false, changed: [], note: '' };
    try {
      const r = await rewindClaudeFiles({ sessionId: id, cwd: p.project.path, ctx, userUuid: uuid });
      if (r && r.canRewind !== false) files = { ok: true, changed: r.filesChanged || [], note: '' };
      else files.note = (r && r.error) || '没有可回滚的文件检查点';
    } catch (e) { files.note = String((e && e.message) || e); }
    const noCheckpoint = /no file checkpoint|not enabled/i.test(files.note);
    if (!files.ok && !noCheckpoint) return json(500, { error: '文件回滚失败：' + files.note });
    const conv = mode === 'both' && !!anchors.convAnchor;
    if (!files.ok && !conv) {
      return json(409, { error: '没有可回滚的内容：这条消息之后没有文件改动的检查点（回滚功能上线前的旧轮，或这轮没改过文件）' + (mode === 'both' ? '，而且它是会话的第一条消息，对话没有更早处可回' : '') + '。' });
    }
    if (conv) setPendingRewind(id, anchors.convAnchor);
    return json(200, {
      ok: true,
      conv,
      files: { ok: files.ok, changed: files.ok ? files.changed.length : 0 },
      note: !files.ok ? '这条消息之后没有文件改动的检查点，仅回滚了对话。' : (mode === 'both' && !conv ? '这是会话的第一条消息，对话没有更早处可回，仅回滚了文件。' : ''),
    });
  });

  // Claude 轮产物下发（与 /api/codex/artifact 同构）：会话必须在本人某个项目目录下
  // （locateSessionPaths 即所有权证明），项目路径现场重授权（沙箱用户篡改自己的
  // claude-projects.json 也翻不出自己的空间），请求路径须落在该会话的交付根内。
  // 文件走 Range 流；文件夹现打 zip 下发。<img>/下载链接带 ?token=（auth.mjs 白名单）。
  router.on('GET', '/api/claude/artifact', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = String(url.searchParams.get('id') || '');
    const requested = String(url.searchParams.get('path') || '');
    if (!requested) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('missing path'); return; }
    try {
      const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
      if (!p) throw Object.assign(new Error('not found'), { status: 404 });
      const projRoot = claudeProjects.authorizeProjectPath(ctx, p.project.path);
      const roots = deliverRoots(ctx, projRoot, VAULT);
      // 正文链接点开时前端把链接原文当 path 传来，可能是相对路径：与 collectDeliverables
      // 同一套解析（cwd → 各交付根回退），别再靠 realpathSync 拿进程 cwd 碰运气。
      let file = resolveDeliverPath(requested, projRoot, roots);
      // 解析不到：模型可能在那一轮 cd 进了子目录、按新目录写的相对链接——拿这个会话 transcript
      // 里出现过的工作目录（最近的优先）再试一遍。只在兜底时扫，卡片点开（绝对路径）不走这里。
      if (!file && !path.isAbsolute(requested)) file = resolveDeliverPath(requested, [...await transcriptCwds(p.file), projRoot], roots);
      if (!file) throw Object.assign(new Error('not found'), { status: 404 });
      if (!deliverAnywhere(ctx) && !roots.some((root) => isInside(file, root))) throw Object.assign(new Error('forbidden'), { status: 403 });
      // locate=1：正文链接对不上附件卡时，前端先问「这在工作空间里哪」——能定位就在右侧工作区的
      // 文件页打开（与附件卡同一套 deliverNav），算不出（无 shell 又在根外）nav 为 null，前端才回落全屏。
      if (url.searchParams.get('locate') === '1') {
        const dir = statSync(file).isDirectory();
        const where = deliverNav(dir ? file : path.dirname(file), { fileRoot: ctx.cwd, ws: projRoot, shell: !!ctx.shell });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ path: file, name: path.basename(file), kind: dir ? 'folder' : 'file', nav: where && !dir ? { ...where, open: path.basename(file) } : where }));
        return;
      }
      if (statSync(file).isDirectory()) {
        await streamFolderZip(req, res, file, { name: url.searchParams.get('name') || '' });
        return;
      }
      if (url.searchParams.get('site') === '1' && isHtmlFile(file)) return respondHtmlSite(res, file, roots.filter((root) => isInside(file, root)));
      streamArtifactFile(req, res, file, url.searchParams.get('name') || path.basename(file), url.searchParams.get('dl') === '1');
    } catch (error) {
      if (res.headersSent) { try { res.destroy(error); } catch {} return; }
      res.writeHead(error?.status || 404, { 'Content-Type': 'text/plain' });
      res.end(error?.status === 403 ? 'forbidden' : 'not found');
    }
  });

  router.on('POST', '/api/session/delete', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, String(parsed.id || ''));
    if (!p) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return; }
    try {
      await releaseWarmClaude(ctx.key, String(parsed.id));   // 停放着的 CLI 先关（它还开着这份 transcript）
      // Thorough local removal: main transcript + subagent-transcript subdir.
      rmSync(p.file, { force: true });
      rmSync(p.subdir, { recursive: true, force: true });
      invalidateSessionFiles();   // 会话列表的扫盘缓存（session-list.mjs）与这条的增量解析缓存一起作废
      forgetHistory(p.file);
      dropChatPrefs(ctx, String(parsed.id));   // 选择器记忆 sidecar 同步清
      { const lib = dropFromLibrary(ctx, String(parsed.id)); if (lib) busPublish(ctx.key, { type: 'library', library: lib }); }   // 收藏 / 自定义标题同步清
      { const a = forgetArchived(ctx, String(parsed.id)); if (a) busPublish(ctx.key, { type: 'archive', archive: a }); }   // 归档记录同步清
      forgetDetached(ctx, String(parsed.id));   // 「移到顶层」记录同步清
      forgetActivity(ctx, String(parsed.id));   // bridge 轮次时刻 / 自动归档时的大小同步清
      forgetSession(ctx, String(parsed.id));   // 父子关系同步清：它派生的子会话升为顶层
      // 别的设备：侧栏翻页拿回来的老会话、已归档列表里的这一行就地摘掉（整表刷新只管最新那 60 条）
      busPublish(ctx.key, { type: 'session.gone', sessionId: String(parsed.id) });
      forgetPrSession(ctx, String(parsed.id));   // 拉取请求台账同步清：后台别再为它读 GitHub、唤醒不存在的会话
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  // 引用对话：侧栏把一条会话拖进另一个对话（输入栏 / 侧栏另一条会话）松手——把被引的那条整理成
  // 一份 Markdown 落进调用者自己的 uploads，当附件挂进输入栏，发送时走既有附件链路（路径进提示词、
  // 模型按需 Read，历史里照样回显成一张卡）。不把全文直接塞进提示词：长对话动辄几十万字，按需读才不烧上下文。
  // 只收自己看得到的会话（locateSessionPaths 按身份的项目目录找）；标题优先用前端给的（侧栏可能改过名）。
  router.on('POST', '/api/session/quote', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const id = String(parsed.id || '');
    const p = /^[0-9a-fA-F-]{36}$/.test(id) ? claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id) : null;
    if (!p) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到这个对话' })); return; }
    try {
      const msgs = await readSessionMessages(p.file, { cutAfterUuid: pendingRewindAnchor(id) });
      if (!msgs.length) { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这个对话还没有内容' })); return; }
      const given = trimTitle(String(parsed.title || '').replace(/\s+/g, ' ').trim());
      const title = given || trimTitle(await readSessionTitle(p.file)) || ('会话 ' + id.slice(0, 8));
      const lines = sessionMarkdown(msgs, {
        id, title, at: new Date(), source: 'claude-bridge 引用对话',
        note: '这是用户从另一段对话里拖过来的【引用】，下面是那段对话的完整记录（只含双方正文，工具调用过程已略去）。'
          + '把它当作这次对话的背景材料，结合用户这条消息作答；用户没问到的部分不必复述。',
      });
      mkdirSync(ctx.uploads, { recursive: true });
      // 斜杠先换掉：sanitizeName 按路径取末段，「A/B 方案对比」会只剩「B 方案对比」
      const safeTitle = sanitizeName(title.replace(/[\\/]+/g, ' ')).replace(/[.\s]+$/, '').slice(0, 60) || 'conversation';
      const file = Date.now() + '-chatref-' + id + '-' + safeTitle + '.md';
      const dest = path.join(ctx.uploads, file);
      await writeFile(dest, lines.join('\n'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // name 回存盘名里的那份标题（清洗/截断过）：重开历史时 parseQuoteFile 解出来的就是它，
      // 直播气泡与历史的附件名一致，前端合并时不会把这条用户消息当成变了而整条重建。
      res.end(JSON.stringify({ ok: true, path: dest, name: safeTitle, file, count: msgs.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  router.on('POST', '/api/session/export', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, String(parsed.id || ''));
    if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const id = String(parsed.id);
    try {
      const msgs = await readSessionMessages(p.file, { cutAfterUuid: pendingRewindAnchor(id) }); // 与会话视图一致（不截尾窗，但尊重回滚）
      const title = (await displayTitle(ctx, id, p.file)) || ('会话 ' + id.slice(0, 8));   // 与侧栏同一条标题链（含改过的名）
      const now = new Date();
      const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const lines = sessionMarkdown(msgs, { id, title, at: now, source: 'claude-bridge（手机端远程会话）', note: '从手机端 bridge 导出的完整对话。读完即可无缝接续这个话题。' });
      const exportDir = ctx.sandbox ? path.join(ctx.cwd, 'exports') : path.join(VAULT, 'Remote Space', 'conversations');
      mkdirSync(exportDir, { recursive: true });
      const safeTitle = sanitizeName(title).replace(/\.+$/, '').slice(0, 60) || 'conversation';
      const dest = path.join(exportDir, stamp + '_' + safeTitle + '_' + id.slice(0, 8) + '.md');
      await writeFile(dest, lines.join('\n'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: dest, count: msgs.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
}
