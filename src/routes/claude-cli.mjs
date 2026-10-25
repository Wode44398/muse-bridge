// Claude Code 运行组件的状态与重试（设置 › Claude 页的那一块，见 web/src/components/ClaudeCliStatus.svelte）。
// 安装包不再内嵌它，首次启动由服务端去拿（runtime/claude-cli.mjs）。只给管理员：状态里有本机路径。
//   GET  /api/claude-cli         → { state, source, version, want, platform, progress, error, attempts, download, size, path }
//        progress = { done, total, host, packed }：packed=true 时按网络上下载的压缩包字节算，否则按解开的字节；
//        size = 解开后的可执行文件大小（磁盘占用）
//   POST /api/claude-cli/retry   → 立刻重试（下载失败、或正在用版本不一致的本机 Claude Code 时）；回当前状态，不等下载完
import { claudeCliStatus, retryClaudeCli } from '../runtime/claude-cli.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

export function registerClaudeCliRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: '仅管理员可用' });
    return false;
  };
  router.on('GET', '/api/claude-cli', (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, { ok: true, ...claudeCliStatus() });
  });
  router.on('POST', '/api/claude-cli/retry', (req, res) => {
    if (!gate(req, res)) return;
    retryClaudeCli();
    json(res, 200, { ok: true, ...claudeCliStatus() });
  });
}
