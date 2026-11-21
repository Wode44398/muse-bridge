// 「完全放行」模式：bridge 自己加的虚拟运行模式，agy 本身没有（它的 --dangerously-skip-permissions
// 只能整个常驻进程一起开）。做法：对 agy 实际设成 auto，再由 ACP 客户端替用户自动点「允许」
// 所有审批请求；对外（前端、会话元数据）一律显示成 bypass。按会话生效，换回别的模式即恢复审批。

export const BYPASS_MODE = 'bypass';
export const BYPASS_BASE_MODE = 'auto';

const BYPASS_OPTION = Object.freeze({
  value: BYPASS_MODE,
  name: 'Bypass permissions',
  description: 'Auto mode plus every permission request approved automatically',
});

// bridge 侧模式 → 发给 agy 的真实模式
export function toAcpMode(mode) {
  return String(mode || '') === BYPASS_MODE ? BYPASS_BASE_MODE : mode;
}

function isModeOption(c) {
  return !!c && (c.id === 'mode' || c.category === 'mode');
}

// 给 mode 下拉补一项 bypass，并按当前会话是否放行改写 currentValue。幂等，可反复调用。
// agy 的模式列表里没有 auto 时（版本变化）不加，免得出一个落不了地的选项。
export function decorateModeOptions(configOptions, bypassOn = false) {
  if (!Array.isArray(configOptions)) return configOptions;
  return configOptions.map((c) => {
    if (!isModeOption(c)) return c;
    const opts = Array.isArray(c.options) ? c.options : [];
    if (!opts.some((o) => o && String(o.value) === BYPASS_BASE_MODE)) return c;
    const next = {
      ...c,
      options: opts.some((o) => o && String(o.value) === BYPASS_MODE) ? opts : [...opts, { ...BYPASS_OPTION }],
    };
    const cur = String(c.currentValue ?? '');
    if (bypassOn && cur === BYPASS_BASE_MODE) next.currentValue = BYPASS_MODE;
    else if (!bypassOn && cur === BYPASS_MODE) next.currentValue = BYPASS_BASE_MODE;
    return next;
  });
}

export function decorateModes(modes, bypassOn = false) {
  if (!modes || typeof modes !== 'object') return modes;
  const cur = String(modes.currentModeId ?? '');
  if (bypassOn && cur === BYPASS_BASE_MODE) return { ...modes, currentModeId: BYPASS_MODE };
  if (!bypassOn && cur === BYPASS_MODE) return { ...modes, currentModeId: BYPASS_BASE_MODE };
  return modes;
}

// 从审批选项里挑「允许」：优先 allow_once（只放这一次，语义最小），其次 allow_always，再按 id 猜
export function pickAllowOption(options = []) {
  const list = Array.isArray(options) ? options.filter((o) => o && o.optionId) : [];
  return list.find((o) => String(o.kind) === 'allow_once')
    || list.find((o) => String(o.kind).startsWith('allow'))
    || list.find((o) => /^(allow|approve|proceed|accept|yes)/i.test(String(o.optionId)))
    || null;
}
