// 固定的 Codex 发行版本与各目标的包、哈希。换版本只改这里：版本号、三个 sha256 与大小一起换。
//
// 选 codex-app-server-package-<目标>.tar.gz，不选 codex-package-<目标>.tar.gz：两种包由同一个打包脚本
// （openai/codex .github/scripts/build-codex-package-archive.sh → scripts/codex_package/layout.py）按同一套布局产出，
// 都带 bin/codex-exec-server、bin/codex-code-mode-host、codex-path/rg，Linux 带 codex-resources/bwrap（沙箱），
// Windows 带 codex-resources/codex-command-runner.exe 与 codex-windows-sandbox-setup.exe；差别只在入口程序
// （bin/codex-app-server 对 bin/codex）和 codex-package 多带的语音运行库（app-server 用不上）。app-server 包小约 45MB。
// 代价是调用方式不同：独立的 codex-app-server 本身就是 app-server（stdio 是默认传输、会话来源同为 vscode、
// 同样先做 arg0 分派以便沙箱与 apply_patch 重入），**不认 `app-server` 子命令**——多传一个位置参数 clap 会直接报错。
// 所以对外给的是 { file, args: APP_SERVER_ARGS }，调用方照 spawn(file, [...args, ...其余参数]) 起，别再写死 'app-server'。
// `-c key=value` 配置覆盖、`--listen`、`--version` 两者都认。
//
// 哈希来源：0.171.0 的 codex-package_SHA256SUMS（releases.openai.com/codex/releases/0.171.0/ 与 GitHub rust-v0.171.0
// 同名资产，两边逐字一致）原文抄录；大小取自 GitHub 该版本的资产列表，两个源 HEAD 的 content-length 与之一致。
// 官方 install.sh 也是这两个源、这份 SHA256SUMS，先 releases.openai.com 后 GitHub。

export const CODEX_CLI_VERSION = '0.171.0';

export const CODEX_CLI_ASSETS = {
  'x86_64-unknown-linux-musl': {
    asset: 'codex-app-server-package-x86_64-unknown-linux-musl.tar.gz',
    sha256: 'fbb41f283b22a161905a3849354ce7b7dd70c553ae422451aef908220fcabc8e',
    size: 152605351,
  },
  'aarch64-unknown-linux-musl': {
    asset: 'codex-app-server-package-aarch64-unknown-linux-musl.tar.gz',
    sha256: '73a7153f002d025db50fca0e11d43856bb726a732296818030ecb2e4a0cf0318',
    size: 154014771,
  },
  'x86_64-pc-windows-msvc': {
    asset: 'codex-app-server-package-x86_64-pc-windows-msvc.tar.gz',
    sha256: '9b20001daac4387f94315013382c6853e40c8f63de0603be021e4a5e983c329c',
    size: 176008428,
  },
};

// 独立 app-server 不要子命令（见文件头）。
export const APP_SERVER_ARGS = Object.freeze([]);

export const entrypointOf = (target) => (String(target).includes('-windows-') ? 'bin/codex-app-server.exe' : 'bin/codex-app-server');

// 下载源：{version} / {asset} 换成实际值。顺序同官方 install.sh。
export const DEFAULT_SOURCES = [
  'https://releases.openai.com/codex/releases/{version}/{asset}',
  'https://github.com/openai/codex/releases/download/rust-v{version}/{asset}',
];

// Linux 只有 musl 静态包：glibc 发行版、Alpine 都能直接跑，不用分辨 libc。其余平台没有对应的包，返回 null（不算错）。
export function codexTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  return null;
}
