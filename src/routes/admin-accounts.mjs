// 控制台「用户」页里和账号生命周期、开放范围有关的接口（开源路线 S2-2 / S2-3 / S2-4）。
// 由 routes/admin.mjs 在用户管理那一段里挂上，闸门、审计、改完推 me.changed 都复用那边的。
//
//   GET  /api/admin/access            「给别人用」开关：运行中 / 已保存（重启后）的取值、部署形态、隔离等级与可放心发的档位、
//                                     待确认的完全信任账号
//   POST /api/admin/access            { multiUser } 写进 config.json 的 features.multiUser（与 S1-7「给谁用」是同一个设置），
//                                     重启后生效——FEATURES 启动时冻结，运行中切换会让一半的路由看到旧值
//                                     部署方接管时（见 audienceManaged）一律拒绝，GET 带 managed:{ hint }，控制台只读显示
//   POST /api/admin/user/trust-ack    { name } 确认保留完全信任（N12：老账号逐个确认，不自动降级）
//   POST /api/admin/user/rename       { name, newName } 改登录名（账号 id、目录、会话、设备都不动）
//   POST /api/admin/invite/revoke     { code } 作废一张还没用的邀请码
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import * as cfg from '../config/index.mjs';
import * as users from '../users.mjs';
import { isolationInfo } from '../runtime/isolation.mjs';
import { supervisor } from '../runtime/service-control.mjs';

const { FEATURES, CONFIG_PATH } = cfg;

function readConfigRaw() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 不是一个 JSON 对象');
  return raw;
}

// config.json 里 features.multiUser 显式写的值；没写 null。
function savedMultiUser() {
  try { const f = readConfigRaw().features; return f && typeof f.multiUser === 'boolean' ? f.multiUser : null; } catch { return null; }
}

// 只改 features.<name> 这一个键，其余原样；读不出来就拒绝（绝不拿空对象覆盖整份配置）。临时档 + 改名，防写一半。
export function writeFeature(name, value) {
  let raw;
  try { raw = readConfigRaw(); } catch (e) { return { error: '读不了 config.json，没有改：' + (e?.message || e) }; }
  raw.features = { ...(raw.features && typeof raw.features === 'object' ? raw.features : {}), [name]: value };
  try {
    const tmp = CONFIG_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    renameSync(tmp, CONFIG_PATH);
  } catch (e) { return { error: '写 config.json 失败：' + (e?.message || e) }; }
  return { ok: true };
}

// 「给谁用」由部署方接管（2026-10-27，Muse 同步第 20 条）：部署脚本自己管多人 / 单人（比如 Muse Bridge 的 bootstrap.sh
// set-users 直接改 features.multiUser，界面上改了会被下次 install / update 盖掉），就声明一句「该怎么切换」：
//   环境变量 BRIDGE_AUDIENCE_HINT（写在服务单元里，同 BRIDGE_UPDATE_HINT），其次 config.json 的 "audienceHint"。
// 值是给管理员看的一句中文原话（如「要切换，在 Muse 里说『改成多人用』或『改成自己用』。」），英文界面由前端字典 tr() 翻译。
// 声明了：GET 带 managed:{ hint }，控制台把开关换成徽标 + 这句话；POST 拒绝改动。没声明 = null，照旧可切换。
export function audienceManaged({ env = process.env, config = null } = {}) {
  let hint = String(env.BRIDGE_AUDIENCE_HINT || '').trim();
  if (!hint) {
    let c = config;
    if (!c) { try { c = readConfigRaw(); } catch { c = {}; } }
    hint = typeof c.audienceHint === 'string' ? c.audienceHint.trim() : '';
  }
  return hint ? { hint } : null;
}

export function accessState() {
  const saved = savedMultiUser();
  const deploy = cfg.DEPLOY || null;
  const fallback = deploy && typeof deploy.multiUserDefault === 'boolean' ? deploy.multiUserDefault : FEATURES.multiUser;
  const next = typeof saved === 'boolean' ? saved : fallback;
  const pending = users.listUsers().filter((u) => u.trustPending).map((u) => ({ id: u.id, name: u.name }));
  return {
    multiUser: FEATURES.multiUser,            // 现在生效的
    next,                                     // 重启后生效的
    pendingRestart: next !== FEATURES.multiUser,
    saved,
    deploy: deploy ? { profile: deploy.profile, label: deploy.label, labelEn: deploy.labelEn } : null,
    isolation: isolationInfo(),
    trustPending: pending,
    supervisor: supervisor() || null,
    managed: audienceManaged(),               // 部署方接管时 { hint }，否则 null
  };
}

// userAction / touched 来自 routes/admin.mjs：闸门 + 解析请求体 + 审计（成功的动作按路由名落 _system/audit）；改完推 me.changed。
export function registerAccountAdminRoutes(router, { gate, userAction, touched }) {
  const J = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

  router.on('GET', '/api/admin/access', (req, res) => {
    if (!gate(req, res)) return;
    J(res, 200, accessState());
  });

  router.on('POST', '/api/admin/access', userAction((b) => {
    const m = audienceManaged();
    if (m) return { error: '「给别人用」由部署方管理，这里改不了：' + m.hint, managed: m };
    if (typeof b.multiUser !== 'boolean') return { error: '缺少 multiUser（true / false）' };
    const w = writeFeature('multiUser', b.multiUser);
    if (w.error) return w;
    return { ok: true, ...accessState() };
  }));

  router.on('POST', '/api/admin/user/trust-ack', userAction((b) => touched(b, users.ackTrust(String(b.name || '')))));

  router.on('POST', '/api/admin/user/rename', userAction((b) => {
    const r = users.renameUser(String(b.name || ''), String(b.newName || ''));
    // owner 键认的是 id，改名不换键：推一条 me.changed 让他在线的页面刷新显示的名字。
    if (!r.error) touched({ name: r.id }, r);
    return r;
  }));

  router.on('POST', '/api/admin/invite/revoke', userAction((b) => users.revokeInvite(String(b.code || ''))));
}
