// 部署形态（开源路线 S1-7）：默认值按「这台服务端是怎么部署的」决定，而不是按 win32 / linux。
//
//   desktop  本机桌面：装在自己日常用的电脑上——桌面客户端托管的本机服务端、源码直跑的主机、
//            有图形界面的 Linux / macOS 上直接跑或 install.sh 装成的用户级服务
//   server   无界面服务器：install.sh 装成的系统服务（systemd）、Windows 计划任务启动器（install-windows.ps1）、
//            pm2、没有图形界面的 Linux
//   docker   容器（docker compose；镜像里写死 BRIDGE_DEPLOY=docker）
//
// 判定顺序（第一条命中就停）：
//   1. 显式：环境变量 BRIDGE_DEPLOY，其次 config.json 的 "deploy"（取值 desktop / server / docker）；
//   2. 托管方声明：BRIDGE_SUPERVISED（desktop → desktop；docker → docker；windows / systemd / pm2 / 其它 → server）；
//   3. Windows → desktop（Windows 上只有前两条能改它：计划任务启动器自己声明 BRIDGE_SUPERVISED=windows）；
//   4. 应用容器标记（/.dockerenv、/run/.containerenv、环境变量 container=docker|podman|oci）→ docker；
//   5. 被 systemd（INVOCATION_ID / JOURNAL_STREAM）或 pm2 拉起 → server；
//   6. 平台兜底：macOS → desktop；其它（Linux）有 DISPLAY / WAYLAND_DISPLAY → desktop，否则 server。
//
// 受它影响的默认值（显式设置一律优先：config.json 的 features.multiUser / claudeInChrome / bindHost、环境变量 BRIDGE_HOST 等）：
//
//                        desktop          server          docker
//   给谁用（多用户）      只给我自己       只给我自己      只给我自己     ← BRIDGE_AUDIENCE=shared 或 features.multiUser:true 打开
//   监听地址             0.0.0.0          127.0.0.1       0.0.0.0        ← BRIDGE_HOST 覆盖；容器对外由宿主端口映射（BRIDGE_BIND）决定
//   Claude in Chrome     开（仅 Windows） 关              关             ← 那是本机已登录的浏览器，服务器上没有
//   保持唤醒的实现       Windows：SetThreadExecutionState；Linux：systemd-inhibit；容器里不做
//   启动日志             简短             打印访问地址、令牌与配对的取法（无界面，只能看终端 / 日志）
//
// 老部署零破坏：「给谁用」与「监听地址」这两项在 S1-7 之前按平台定（Linux 默认开多用户、一律听 0.0.0.0）。
// config.json 里没有 "defaultsVersion": 2 的（这一版之前生成的，或别的工具生成的）照旧按老规矩算，升级后行为一字不变；
// 这一版首次启动新生成的 config.json 带上它，才按上表。Claude in Chrome 的新旧规则在所有现实组合下结果相同，不分新旧。
//
// 本模块是纯函数：不读 config/index.mjs（那边导入即建目录、缺令牌就退出），命令行（src/cli.mjs）与单测都能直接用。

export const DEFAULTS_VERSION = 2;
export const PROFILES = Object.freeze(['desktop', 'server', 'docker']);

export const PROFILE_DEFAULTS = Object.freeze({
  desktop: Object.freeze({ audience: 'self', listenHost: '0.0.0.0', headless: false }),
  server: Object.freeze({ audience: 'self', listenHost: '127.0.0.1', headless: true }),
  docker: Object.freeze({ audience: 'self', listenHost: '0.0.0.0', headless: true }),
});

const PROFILE_LABEL = { desktop: '本机桌面', server: '无界面服务器', docker: 'Docker 容器' };
const PROFILE_LABEL_EN = { desktop: 'desktop', server: 'headless server', docker: 'Docker container' };
const SOURCE_LABEL = {
  env: '环境变量 BRIDGE_DEPLOY', config: 'config.json 的 deploy', supervisor: '托管方 BRIDGE_SUPERVISED',
  container: '容器', systemd: 'systemd 托管', pm2: 'pm2 托管', display: '有图形界面', platform: '平台默认',
};

const str = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** 「给谁用」的写法归一：self（只给我自己）/ shared（也给别人用）；认不出来回 ''。 */
export function normalizeAudience(v) {
  const s = str(v);
  if (['self', 'solo', 'me', 'private', 'single', 'only-me', '0', 'false', 'off', 'no'].includes(s)) return 'self';
  if (['shared', 'share', 'multi', 'multiuser', 'multi-user', 'others', 'team', '1', 'true', 'on', 'yes'].includes(s)) return 'shared';
  return '';
}

export function normalizeProfile(v) {
  const s = str(v);
  if (s === 'desktop' || s === 'local' || s === 'host') return 'desktop';
  if (s === 'server' || s === 'headless' || s === 'vps') return 'server';
  if (s === 'docker' || s === 'container') return 'docker';
  return '';
}

// 应用容器（Docker / Podman）才算 docker 形态。LXC、systemd-nspawn 这类「整机容器」也会设环境变量 container，
// 但它们是当 VPS 用的（便宜 VPS 很多就是 LXC）：按 docker 形态会默认听所有网卡，把明文端口开到公网——不认。
function inContainer(env, exists) {
  const c = str(env.container);
  if (c === 'docker' || c === 'podman' || c === 'oci') return true;
  try { return exists('/.dockerenv') || exists('/run/.containerenv'); } catch { return false; }
}

/** 只判形态：{ profile, source, supervisor }。参数都可注入（单测在 Windows 上验 Linux 语义）。 */
export function detectProfile({ env = process.env, platform = process.platform, config = {}, exists = () => false } = {}) {
  const supervisor = String(env.BRIDGE_SUPERVISED || '').trim() || null;
  const explicitEnv = normalizeProfile(env.BRIDGE_DEPLOY);
  if (explicitEnv) return { profile: explicitEnv, source: 'env', supervisor };
  const explicitCfg = normalizeProfile(config && config.deploy);
  if (explicitCfg) return { profile: explicitCfg, source: 'config', supervisor };
  if (supervisor) {
    const s = supervisor.toLowerCase();
    return { profile: s === 'desktop' ? 'desktop' : s === 'docker' ? 'docker' : 'server', source: 'supervisor', supervisor };
  }
  // Windows 上只认显式与托管方声明：在自己电脑上用 pm2 起的、终端里继承了奇怪变量的，照旧当本机桌面
  // （S1-7 之前 Windows 一律按桌面算——Claude in Chrome 默认开——这里不让一个环境变量悄悄改掉它）
  if (platform === 'win32') return { profile: 'desktop', source: 'platform', supervisor };
  if (inContainer(env, exists)) return { profile: 'docker', source: 'container', supervisor };
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return { profile: 'server', source: 'systemd', supervisor };
  if (env.pm_id != null || env.PM2_HOME) return { profile: 'server', source: 'pm2', supervisor };
  if (platform === 'darwin') return { profile: 'desktop', source: 'platform', supervisor };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { profile: 'desktop', source: 'display', supervisor };
  return { profile: 'server', source: 'platform', supervisor };
}

/**
 * 形态 + 由它推出的默认值。config 是 config.json 解析后的对象（原样，不改）。
 * 返回值里「Default」结尾的是还没套用 config.json 显式开关前的默认值（config/index.mjs 再按 features.* 等覆盖）。
 */
export function resolveDeployProfile({ env = process.env, platform = process.platform, config = {}, exists = () => false } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const { profile, source, supervisor } = detectProfile({ env, platform, config: cfg, exists });
  const base = PROFILE_DEFAULTS[profile];
  const legacy = !(Number(cfg.defaultsVersion) >= DEFAULTS_VERSION);

  // 给谁用（决定 features.multiUser 的默认值）
  let audienceDefault, audienceSource;
  const envAudience = normalizeAudience(env.BRIDGE_AUDIENCE);
  // BRIDGE_EDITION 只认 server / host 这两个值（其它值不算数）
  const edition = str(env.BRIDGE_EDITION || cfg.edition);
  if (envAudience) { audienceDefault = envAudience; audienceSource = 'env'; }
  else if (edition === 'server') { audienceDefault = 'shared'; audienceSource = 'edition'; }
  else if (edition === 'host') { audienceDefault = 'self'; audienceSource = 'edition'; }
  else if (legacy) { audienceDefault = platform !== 'win32' ? 'shared' : 'self'; audienceSource = 'legacy'; }
  else { audienceDefault = base.audience; audienceSource = 'profile'; }
  const features = cfg.features && typeof cfg.features === 'object' ? cfg.features : {};
  const audience = typeof features.multiUser === 'boolean' ? (features.multiUser ? 'shared' : 'self') : audienceDefault;

  // 监听地址（NO_AUTH 的桌面实例另由 server.mjs 钉在 127.0.0.1）。config.json 的 bindHost 与桌面客户端向导写的是同一个键
  // （client/agent/server-run.mjs 把它翻成 BRIDGE_HOST 交过来）；Windows 计划任务带不了环境变量，靠它改。
  let listenHost, listenSource;
  const envHost = String(env.BRIDGE_HOST || '').trim();
  const cfgHost = typeof cfg.bindHost === 'string' ? cfg.bindHost.trim() : '';
  if (envHost) { listenHost = envHost; listenSource = 'env'; }
  else if (cfgHost) { listenHost = cfgHost; listenSource = 'config'; }
  else if (legacy) { listenHost = '0.0.0.0'; listenSource = 'legacy'; }
  else { listenHost = base.listenHost; listenSource = 'profile'; }

  const keepAwake = profile === 'docker' ? 'none'
    : platform === 'win32' ? 'windows'
      : platform === 'linux' ? 'inhibit'
        : 'none';

  return Object.freeze({
    profile, source, supervisor, legacy,
    headless: base.headless,
    multiUserDefault: audienceDefault === 'shared',
    audienceDefault, audienceSource, audience,
    listenHost, listenSource,
    claudeInChromeDefault: profile === 'desktop' && platform === 'win32',
    keepAwake,
    label: PROFILE_LABEL[profile],
    labelEn: PROFILE_LABEL_EN[profile],
    sourceLabel: SOURCE_LABEL[source] || source,
  });
}

const SUPERVISOR_LABEL = { desktop: '桌面客户端托管', windows: 'Windows 计划任务托管', systemd: 'systemd 托管', pm2: 'pm2 托管', docker: '容器' };

/** 启动日志 / 命令行里的一行说明。 */
export function describeDeploy(d) {
  if (!d) return '';
  // 有托管方就写托管方（install.sh 的单元同时写了 BRIDGE_DEPLOY 与 BRIDGE_SUPERVISED，人想看的是「谁在托管」），否则写形态从哪来
  const how = d.supervisor ? (SUPERVISOR_LABEL[String(d.supervisor).toLowerCase()] || d.supervisor + ' 托管') : d.sourceLabel;
  const who = d.audience === 'shared' ? '也给别人用（多用户开）' : '只给我自己（多用户关）';
  return `${d.label}（${how}）· ${who}`;
}
