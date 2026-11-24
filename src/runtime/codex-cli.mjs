// Codex 运行组件（OpenAI 官方的独立 codex-app-server 发行包）在哪；没有就去官方源拿。
//
// 给 VPS / Docker 这类没装 Codex 桌面版的 Linux 机器用：Codex 分页要一个能跑 app-server 的程序。Windows 上
// 平时用桌面版自带的 codex.exe，这里也支持 x64 Windows 只是为了离线部署与验证同一条路径。
//   装在 <数据根>/.bin/codex/<版本>-<目标>/（install.json 记着版本、目标、包名、sha256、大小，以及每个文件的大小、mtime 与 sha256），
//   镜像构建时预装的（Dockerfile 的 WITH_CODEX_CLI=1）在 <程序目录>/.bin/codex/ 下，数据根里没有时认它。
//   下载源先 releases.openai.com、后 GitHub Releases（同官方 install.sh），走全局出站代理（net-proxy.mjs 装的
//   全局 dispatcher）。按速度换源同 claude-cli.mjs：后面还有源时，每 15 秒量一次，低于约 300 KB/s 且照这速度
//   还要两分钟以上就换下一个；都不行再回到嫌慢里最快的那个下完。
//   边下边算 sha256（对的是发行方 SHA256SUMS 里压缩包本身的值）、边解到临时目录，校验与 `--version` 自检都过了
//   才整个挪到正式位置；任何一步失败删掉临时目录，不留半截安装。
// 关掉自动下载：BRIDGE_CODEX_CLI_DOWNLOAD=0 或 config.json "codexCliDownload": false。
// 离线部署：把官方压缩包原样放进 <数据根>/.bin/codex/<包名>，它排在所有下载源前面（关了自动下载也认），同样按固定的
// sha256 校验、解开、自检，装好后压缩包被清掉。装好的目录整个拷走或被镜像层截掉 mtime 也认：按记录的每文件哈希重新核对。
// 额外的下载源（镜像站）：BRIDGE_CODEX_CLI_SOURCES，逗号分隔的 URL 模板，{version} / {asset} 会被替换，排在官方源前面。
//
// 注意调用方式：装的是独立的 codex-app-server，不是 codex 本体，起它时不要再传 `app-server` 子命令——
// 用 installedCodexAppServer() 给的 { file, args }（args 为空数组），见 codex-cli/release.mjs 文件头。
//
// 不读 config/index.mjs（那边导入即建目录、缺令牌直接退出）：config.json 按需现读，测试也能单独导入本模块。

import { createCodexCli } from './codex-cli/manager.mjs';

export { createCodexCli };
export { APP_SERVER_ARGS, CODEX_CLI_ASSETS, CODEX_CLI_VERSION, DEFAULT_SOURCES, codexTarget, entrypointOf } from './codex-cli/release.mjs';
export { safeRel } from './codex-cli/install.mjs';

// ── 进程级单例 ────────────────────────────────────────────────────────────────────────────────────
let main = null;
let testOpts = {};
const cli = () => main || (main = createCodexCli(testOpts));

// 装好的程序的绝对路径（同步，只看文件与 install.json，不哈希、不起进程）；没有、对不上或平台不支持 → null。
export function installedCodexCli() { return cli().installed(); }
// 同上，连同起它要用的参数：{ file, args, version, target } 或 null。
export function installedCodexAppServer() { return cli().appServer(); }
// 没装就下（同一时间只下一份）；返回绝对路径，平台不支持或关了自动下载返回 null，下载失败抛错。
export function ensureCodexCli({ onProgress, signal } = {}) { return cli().ensure({ onProgress, signal }); }
// { supported, target, version, installed, path, downloading, progress, error, enabled, asset, size, entrypoint, args, attempts }
export function codexCliStatus() { return cli().status(); }

// 测试注入：换下载源（URL 模板数组）/ 发行信息 / 其余构造参数；_resetForTest 丢掉单例。
export function _setSourcesForTest(list) { testOpts = { ...testOpts, sources: list || undefined }; cli()._setSources(list); }
export function _setReleaseForTest(release) { testOpts = { ...testOpts, release: release || undefined }; cli()._setRelease(release); }
export function _resetForTest(opts = {}) { testOpts = { ...opts }; main = null; }
