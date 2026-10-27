// 部署形态（S1-7）：形态判定、由形态推出的默认值，以及「老部署升级后行为一字不变」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProfile, resolveDeployProfile, normalizeAudience, describeDeploy, DEFAULTS_VERSION } from './deploy-profile.mjs';

const NEW = { defaultsVersion: DEFAULTS_VERSION };
const none = () => false;

test('形态判定：显式 > 托管方 > 容器 > systemd / pm2 > 平台', () => {
  const d = (env, platform = 'linux', config = {}, exists = none) => detectProfile({ env, platform, config, exists }).profile;
  assert.equal(d({ BRIDGE_DEPLOY: 'docker', BRIDGE_SUPERVISED: 'systemd' }), 'docker');
  assert.equal(d({}, 'linux', { deploy: 'desktop' }), 'desktop');
  assert.equal(d({ BRIDGE_DEPLOY: 'bogus' }, 'linux', { deploy: 'server' }), 'server', '认不出的显式值当没写');
  assert.equal(d({ BRIDGE_SUPERVISED: 'desktop' }, 'win32'), 'desktop');
  assert.equal(d({ BRIDGE_SUPERVISED: 'windows' }, 'win32'), 'server');
  assert.equal(d({ BRIDGE_SUPERVISED: 'systemd' }), 'server');
  assert.equal(d({}, 'linux', {}, (p) => p === '/.dockerenv'), 'docker');
  assert.equal(d({ container: 'podman' }), 'docker');
  assert.equal(d({ container: 'lxc' }), 'server', 'LXC 是当 VPS 用的整机容器，不当 docker（否则默认听所有网卡）');
  assert.equal(d({ container: 'systemd-nspawn', DISPLAY: ':0' }), 'desktop');
  assert.equal(d({ INVOCATION_ID: 'x' }), 'server');
  assert.equal(d({ pm_id: '0' }), 'server');
  assert.equal(d({}, 'win32'), 'desktop');
  assert.equal(d({}, 'darwin'), 'desktop');
  assert.equal(d({ DISPLAY: ':0' }), 'desktop');
  assert.equal(d({ WAYLAND_DISPLAY: 'wayland-0' }), 'desktop');
  assert.equal(d({}), 'server', '没有图形界面的 Linux');
  assert.equal(d({}, 'win32', {}, () => true), 'desktop', 'Windows 上不认容器标记');
  assert.equal(d({ pm_id: '3', PM2_HOME: 'C:/pm2' }, 'win32'), 'desktop', 'Windows 上 pm2 起的照旧当本机桌面（Claude in Chrome 默认不变）');
  assert.equal(d({ INVOCATION_ID: 'x' }, 'win32'), 'desktop');
  assert.equal(d({ BRIDGE_DEPLOY: 'server' }, 'win32'), 'server', '显式的照样认');
});

test('维护者这台（Windows 源码直跑、老 config、显式开了多用户）：一切照旧', () => {
  const cfg = { port: 8787, features: { multiUser: true }, claudeHost: { allowBypass: true } };
  const r = resolveDeployProfile({ env: {}, platform: 'win32', config: cfg });
  assert.equal(r.profile, 'desktop');
  assert.equal(r.legacy, true);
  assert.equal(r.listenHost, '0.0.0.0');
  assert.equal(r.claudeInChromeDefault, true);
  assert.equal(r.audience, 'shared');
  assert.equal(r.multiUserDefault, false, '默认值仍是 Windows 的老默认，显式 features.multiUser 由 config/index.mjs 套用');
  assert.equal(r.keepAwake, 'windows');
});

test('老部署（没有 defaultsVersion）：多用户与监听地址按 S1-7 之前的老规矩', () => {
  // Docker / Linux 老部署：没写 edition → 非 Windows 默认开多用户、听 0.0.0.0
  const docker = resolveDeployProfile({ env: { BRIDGE_DEPLOY: 'docker' }, platform: 'linux', config: {} });
  assert.equal(docker.multiUserDefault, true);
  assert.equal(docker.listenHost, '0.0.0.0');
  // 老 install.sh 的单元写着 BRIDGE_EDITION=server
  const sysd = resolveDeployProfile({ env: { BRIDGE_EDITION: 'server', BRIDGE_SUPERVISED: 'systemd', BRIDGE_HOST: '127.0.0.1' }, platform: 'linux', config: {} });
  assert.equal(sysd.multiUserDefault, true);
  assert.equal(sysd.listenHost, '127.0.0.1');
  // Windows 计划任务启动器：老默认单人、听 0.0.0.0、不带 Claude in Chrome
  const winSvc = resolveDeployProfile({ env: { BRIDGE_SUPERVISED: 'windows' }, platform: 'win32', config: {} });
  assert.equal(winSvc.profile, 'server');
  assert.equal(winSvc.multiUserDefault, false);
  assert.equal(winSvc.listenHost, '0.0.0.0');
  assert.equal(winSvc.claudeInChromeDefault, false);
  // 桌面安装包的本机服务端：老默认单人；监听地址由壳经 BRIDGE_HOST 显式给
  const desk = resolveDeployProfile({ env: { BRIDGE_SUPERVISED: 'desktop', BRIDGE_HOST: '0.0.0.0' }, platform: 'win32', config: {} });
  assert.equal(desk.profile, 'desktop');
  assert.equal(desk.multiUserDefault, false);
  assert.equal(desk.claudeInChromeDefault, true);
  // 老配置写过 edition:"host"
  assert.equal(resolveDeployProfile({ env: {}, platform: 'linux', config: { edition: 'host' } }).multiUserDefault, false);
});

test('新部署（defaultsVersion 2）：按形态——默认只给我自己；无界面服务器只听本机', () => {
  const docker = resolveDeployProfile({ env: { BRIDGE_DEPLOY: 'docker' }, platform: 'linux', config: NEW });
  assert.equal(docker.multiUserDefault, false);
  assert.equal(docker.listenHost, '0.0.0.0', '容器里必须听所有网卡，对外由端口映射决定');
  assert.equal(docker.keepAwake, 'none');
  assert.equal(docker.headless, true);
  const server = resolveDeployProfile({ env: {}, platform: 'linux', config: NEW });
  assert.equal(server.profile, 'server');
  assert.equal(server.listenHost, '127.0.0.1');
  assert.equal(server.keepAwake, 'inhibit');
  const linuxDesk = resolveDeployProfile({ env: { DISPLAY: ':0' }, platform: 'linux', config: NEW });
  assert.equal(linuxDesk.profile, 'desktop');
  assert.equal(linuxDesk.multiUserDefault, false, 'Linux 桌面上的单人主机不再默认开注册');
  assert.equal(linuxDesk.listenHost, '0.0.0.0');
  assert.equal(linuxDesk.claudeInChromeDefault, false, 'Claude in Chrome 只在 Windows 桌面默认开');
  const mac = resolveDeployProfile({ env: {}, platform: 'darwin', config: NEW });
  assert.equal(mac.multiUserDefault, false);
  assert.equal(mac.keepAwake, 'none');
});

test('给谁用：config 显式 > BRIDGE_AUDIENCE > 老 edition > 老平台规则 / 形态', () => {
  const r = (env, config) => resolveDeployProfile({ env, platform: 'linux', config });
  assert.equal(r({ BRIDGE_AUDIENCE: 'shared' }, NEW).multiUserDefault, true);
  assert.equal(r({ BRIDGE_AUDIENCE: 'self' }, {}).multiUserDefault, false, '显式选择盖过老规矩');
  assert.equal(r({ BRIDGE_AUDIENCE: 'shared' }, { ...NEW, features: { multiUser: false } }).audience, 'self', '控制台开关写进 config 的为准');
  assert.equal(r({ BRIDGE_AUDIENCE: '' , BRIDGE_EDITION: 'public' }, NEW).audienceSource, 'profile', '发行渠道 public 不当老 edition');
  assert.equal(r({ BRIDGE_EDITION: 'server' }, NEW).multiUserDefault, true);
  assert.equal(normalizeAudience('只给我自己'), '');
  assert.equal(normalizeAudience('Solo'), 'self');
  assert.equal(normalizeAudience('multi-user'), 'shared');
});

test('监听地址：BRIDGE_HOST > config.json 的 bindHost > 老规矩 / 形态；说明行带上形态与给谁用', () => {
  const r = resolveDeployProfile({ env: { BRIDGE_HOST: '192.168.1.5', BRIDGE_SUPERVISED: 'systemd' }, platform: 'linux', config: { ...NEW, bindHost: '0.0.0.0' } });
  assert.equal(r.listenHost, '192.168.1.5');
  assert.equal(r.listenSource, 'env');
  const winSvc = resolveDeployProfile({ env: { BRIDGE_SUPERVISED: 'windows' }, platform: 'win32', config: { ...NEW, bindHost: '0.0.0.0' } });
  assert.equal(winSvc.listenHost, '0.0.0.0', '计划任务带不了环境变量，靠 config.json 的 bindHost');
  assert.equal(winSvc.listenSource, 'config');
  assert.equal(resolveDeployProfile({ env: {}, platform: 'linux', config: { bindHost: '  ' } }).listenHost, '0.0.0.0', '空白当没写');
  const line = describeDeploy(r);
  assert.match(line, /无界面服务器/);
  assert.match(line, /systemd 托管/);
  assert.match(line, /只给我自己/);
});

test('hosting（/api/auth 的 hosting，前端「电脑 / 服务器」措辞）：Windows 没显式声明一律算电脑，其余按形态', () => {
  const h = (env, platform, config = NEW) => resolveDeployProfile({ env, platform, config }).hosting;
  assert.equal(h({}, 'win32'), 'host');
  assert.equal(h({ BRIDGE_SUPERVISED: 'windows' }, 'win32'), 'host', '计划任务启动器托管的 Windows 也是自己的电脑');
  assert.equal(h({ BRIDGE_DEPLOY: 'server' }, 'win32'), 'server', '显式声明照形态');
  assert.equal(h({}, 'win32', { ...NEW, deploy: 'server' }), 'server');
  assert.equal(h({ BRIDGE_SUPERVISED: 'systemd' }, 'linux'), 'server', 'Linux 系统服务（Muse 的 VM）');
  assert.equal(h({ container: 'docker' }, 'linux'), 'server');
  assert.equal(h({ DISPLAY: ':0' }, 'linux'), 'host');
  assert.equal(h({}, 'darwin'), 'host');
  assert.equal(h({ BRIDGE_DEPLOY: 'desktop' }, 'linux'), 'host');
});
