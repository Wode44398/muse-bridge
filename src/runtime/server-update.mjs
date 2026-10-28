// 服务端自己的更新：设置「连接与更新 / 关于 › 服务端更新」、控制台「服务控制」、agent 操作 server.update.*（管理员）。
//
// 10-28 维护者：「服主在更新的时候没法点『获取更新』来更新版本，直接改成在 GitHub 对应仓库检查版本，在设置里可以一键更新。」
// 以前服主只能在「服务端所在那台电脑的桌面客户端」里点「检查更新」，而那一下读的是 6 小时的缓存（见 client-release.mjs 文件头）；
// 手机 / 网页 / 另一台电脑上根本没有服务端更新的入口。现在：
//   · 版本：打包形态的打包号（bridge-build.json）对 GitHub 发布仓库（client-release.mjs releaseRepo）的 latest；
//     设置里点「检查更新」不看缓存（refresh），GitHub 连不上就照实说原因。
//   · 一键更新按部署形态（serverUpdateForm）：
//     desktop  Windows 安装包里的本机服务端（壳设 BRIDGE_SUPERVISED=desktop）：让这台电脑上的桌面客户端更新自己
//              （设备 op client.update，见 client/desktop/main.cjs remoteUpdate）——安装包里带着服务端，装完服务端一起换。
//              客户端那头先下好，再等所有人的对话跑完才装（服务端以 reason:'update' 空闲重启，所有设备收到提示）；
//              服务器用的是临时地址时客户端拒绝（重启后地址会换，远程点的人连不回来），原样回给界面。
//              客户端不在线（没开 / 没连上设备通道）时一键不了，说清去那台电脑上更新。
//     script   git 部署 + 守护进程（Linux systemd / pm2，Windows bridge-service 计划任务）：跑 update.sh / update.ps1
//              （service-control.mjs startUpdate：拉代码、装依赖、重建前端），有新代码就等空闲重启。版本看 git 远端，不看发布仓库。
//     docker   镜像要在宿主机上重建：只说怎么做。
//     distro   发行版在服务单元里写了 BRIDGE_UPDATE_HINT（如 Muse Bridge 由部署方管更新）：照原话显示，不越权。
//     manual   其余（维护者主机那种 admin.ps1 部署、没有守护进程的源码部署…）：service-control.mjs updateAvailability 说的原因。
import { APP_VERSION_NAME } from '../config/versions.mjs';
import { checkClientFeed, serverBuildVersion, serverUpdateInfo, releasePageUrl } from './client-release.mjs';
import { supervisor, updateAvailability, updateState, startUpdate, restartState } from './service-control.mjs';
import { serverHostDevice, deviceDispatch } from './devices.mjs';
import { deviceRuntime } from './device-control.mjs';

export const HOW_DESKTOP_OFFLINE = '这台服务器由那台电脑上的桌面客户端托管，但客户端现在没连上：在那台电脑上打开桌面客户端，「设置 › 连接与更新 › 软件更新」里更新（服务端随客户端安装包一起换）';
const JOB_TTL_MS = 2 * 3600_000;

/** 部署形态：desktop | script | docker | distro | manual（见文件头）。 */
export function serverUpdateForm() {
  if (String(process.env.BRIDGE_UPDATE_HINT || '').trim()) return 'distro';
  const sup = supervisor();
  if (sup === 'desktop') return serverBuildVersion() ? 'desktop' : 'manual';
  if (sup === 'docker') return 'docker';
  if (!updateAvailability()) return 'script';
  return 'manual';
}

// 最近一次经这里发起的更新（desktop：交给客户端去下了；script：更新脚本的状态在 service-control 里）
let lastJob = null;   // { via, at, version, result }
const freshJob = () => (lastJob && Date.now() - lastJob.at < JOB_TTL_MS ? lastJob : null);

function restartLine() {
  const r = restartState();
  if (!r.pending && !r.going) return null;
  return { phase: r.going ? 'going' : 'pending', reason: r.reason, version: r.version, live: r.live, deadline: r.deadline };
}

/**
 * 现状：{ form, current, app, latest, newer, notes, page, feed, oneClick, how, device, job, script, restart }。
 * refresh：不看缓存，现在去 GitHub 查（最多等 15 秒）。只有 desktop 形态看发布仓库；script 形态的「有没有新代码」要跑脚本才知道。
 */
export async function serverUpdateStatus({ refresh = false } = {}) {
  const form = serverUpdateForm();
  const out = { form, app: APP_VERSION_NAME, current: null, latest: null, newer: false, notes: '', page: '', feed: null,
    oneClick: false, how: '', device: null, job: freshJob(), script: null, restart: restartLine() };
  if (form === 'desktop') {
    await checkClientFeed(refresh ? { maxAgeMs: 30_000, waitMs: 15_000 } : { waitMs: 6_000, maxAgeMs: 30 * 60_000 });
    const info = serverUpdateInfo();
    Object.assign(out, { current: info.current, latest: info.latest, newer: info.newer, notes: info.notes, page: info.page || releasePageUrl(), feed: info.feed });
    const host = serverHostDevice();
    if (host) {
      const rt = deviceRuntime(host.id);
      out.device = { id: host.id, name: host.name, version: (rt.info && rt.info.version) || '' };
      out.oneClick = true;
    } else out.how = HOW_DESKTOP_OFFLINE;
    return out;
  }
  if (form === 'script') {
    out.current = APP_VERSION_NAME;
    out.oneClick = true;
    out.script = updateState();
    return out;
  }
  out.current = serverBuildVersion() || APP_VERSION_NAME;
  out.how = form === 'distro' ? String(process.env.BRIDGE_UPDATE_HINT).trim()
    : form === 'docker' ? 'Docker 部署：在服务器上重建镜像（git pull && docker compose up -d --build），设置里没法替你做'
    : updateAvailability() || '这台服务器的部署方式不支持在设置里更新';
  return out;
}

/**
 * 一键更新。回 { ok, form, via, ... } 或 { error, status }。
 *   desktop：{ via:'desktop', device, result }，result 是客户端的回答：status = downloading（下好后等对话跑完自动装）| latest | refused（临时地址）| busy | unsupported。
 *   script：{ via:'script', update }（脚本在后台跑，进度看 serverUpdateStatus().script 与服务端日志）。
 */
export async function startServerUpdate({ drain = null } = {}) {
  const form = serverUpdateForm();
  if (form === 'desktop') {
    const host = serverHostDevice();
    if (!host) return { error: HOW_DESKTOP_OFFLINE, status: 409 };
    try {
      const result = await deviceDispatch({ kind: 'admin', key: 'admin' }, host.id, 'client.update', {}, { timeoutMs: 45_000, by: 'admin', anyOwner: true });
      lastJob = { via: 'desktop', at: Date.now(), version: String(result?.latest || ''), result: { status: String(result?.status || ''), reason: String(result?.reason || ''), idle: !!result?.idle } };
      console.log(`[server-update] 让本机桌面客户端（${host.name}）更新：${result?.status || '?'}${result?.latest ? ' → ' + result.latest : ''}${result?.reason ? '（' + result.reason + '）' : ''}`);
      return { ok: true, form, via: 'desktop', device: { id: host.id, name: host.name }, result: lastJob.result, latest: lastJob.version || null };
    } catch (e) {
      return { error: String(e?.message || e), status: 409 };
    }
  }
  if (form === 'script') {
    const r = startUpdate({ drain });
    if (r.error) return { error: r.error, status: 400 };
    lastJob = { via: 'script', at: Date.now(), version: '', result: { status: 'running' } };
    return { ok: true, form, via: 'script', update: r.update };
  }
  const st = await serverUpdateStatus();
  return { error: st.how, status: 400 };
}

export const _resetServerUpdateJob = () => { lastJob = null; };
