// SDK 每次 query() 都对 allowedTools 里的裸名打一条 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 警告（Node 不去重）——
// 我们的裸名只有内嵌图表两件（VIZ_ALLOWED_TOOLS，有意免过 auto 模式分类器，见 mcp/visualize.mjs），
// 每轮一条只会让日志看着像「满处报错」。每个进程只放行第一条，别的警告原样。
{
  const SHADOWED = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
  const orig = process.emitWarning;
  let seen = false;
  process.emitWarning = function emitWarningOnce(warning, opts, ...rest) {
    const code = opts && typeof opts === 'object' ? opts.code : rest[0];
    if (code === SHADOWED) { if (seen) return; seen = true; }
    return orig.call(this, warning, opts, ...rest);
  };
}
