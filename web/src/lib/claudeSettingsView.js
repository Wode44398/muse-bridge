// 设置 › Claude 两套外壳（手机 / 网页 iOS 风 Settings.svelte、桌面 SettingsDesktop.svelte；单 agent 模式也用这两套，
// 原 claude.ai 风 settings/SecClaude 已于 2026-10-21 下线）共用的取值、显示与可见性小函数（2026-10-20）。
// 注册表 src/config/claude-settings.mjs，数据面 lib/claudeSettings.svelte.js。
// 外壳只管排版：哪一项出现、叫什么、当前值怎么念、改了往哪写，都从这里拿，两处不会各写各的又写歪。
import { cs, setClaudeSetting, setClaudeDeviceSetting, isClaudeSettingChanged } from './claudeSettings.svelte.js';
import { outputStyleLabel, outputStyleDesc } from './outputStyle.svelte.js';
import { t, tr } from './i18n.js';
import { CLAUDE_SETTING_BY_KEY, BUILTIN_OUTPUT_STYLES, PERMISSION_MODES, PERMISSION_MODES_SANDBOX, claudeSettingVisible } from '../../../src/config/claude-settings.mjs';

export const S = CLAUDE_SETTING_BY_KEY;

/** 当前值（device 级读本机，其余读服务端快照）。权限模式按身份夹紧（与服务端 defaultPermissionModeFor 同口径）。 */
export function val(key) {
  const s = S[key];
  if (!s) return undefined;
  if (key === 'permissionMode') {
    const want = cs.values.permissionMode, modes = cs.permissionModes || [];
    return modes.includes(want) ? want : modes.includes('acceptEdits') ? 'acceptEdits' : modes[0] || 'default';
  }
  return s.scope === 'device' ? cs.device[key] : cs.values[key];
}

/**
 * 这个身份看不看得到这一项：管理员项 / 主机项只给管理员，shell 项只给能跑命令的身份，
 * 服务端快照说这台机器做不到的（cs.unsupported：非 Windows 没有保持唤醒、找不到 Claude Desktop 就没有跟随归档）不出，
 * 依赖项主项关着时不出。规则本体在注册表模块的 claudeSettingVisible（node 单测覆盖）。
 */
export function visible(key) {
  return claudeSettingVisible(key, { admin: cs.admin, shell: cs.shell, unsupported: cs.unsupported, val });
}

/** 写一项（null = 恢复默认）。失败时乐观值已回滚、错误在 cs.err；这里吞掉异常，外壳读 errText() 显示。 */
export function setVal(key, v) {
  const s = S[key];
  if (!s) return Promise.resolve(false);
  if (s.scope === 'device') { setClaudeDeviceSetting(key, v === null ? s.default : v); return Promise.resolve(true); }
  return setClaudeSetting(key, v).then(() => true, () => false);
}
export const resetVal = (key) => setVal(key, null);
export const changed = (key) => isClaudeSettingChanged(key);

export const label = (key) => (S[key] ? t(S[key].label) : key);
export const desc = (key) => (S[key] && S[key].desc ? t(S[key].desc) : '');

/**
 * 枚举 / 整数项的选项：[{ value, label, desc, disabled, note }]。
 * 输出风格：服务端报的可选清单（内置 + ~/.claude/output-styles 里的自定义）；权限模式：这个身份能选的
 *（绕过 / 自动受「安全」组的主机开关管，关着时置灰并给一句状态，不是隐藏——开关在页面底下）。
 */
export function options(key) {
  const s = S[key];
  if (!s) return [];
  if (key === 'outputStyle') {
    const list = Array.isArray(cs.outputStyles) && cs.outputStyles.length ? cs.outputStyles : [...BUILTIN_OUTPUT_STYLES];
    const all = ['default', ...list.filter((x) => x.toLowerCase() !== 'default')];
    const cur = val(key);
    if (cur && !all.some((x) => x.toLowerCase() === String(cur).toLowerCase())) all.push(cur);   // 当前值已不在清单里：照列，免得看不出选的是什么
    return all.map((v) => ({ value: v, label: outputStyleLabel(v), desc: outputStyleDesc(v) }));
  }
  if (key === 'permissionMode') {
    const base = cs.admin ? PERMISSION_MODES : PERMISSION_MODES_SANDBOX;
    return base.map((v) => {
      const i = PERMISSION_MODES.indexOf(v);
      const off = !cs.permissionModes.includes(v);
      return {
        value: v, label: t(s.optionLabels[i]), desc: s.optionDescs && s.optionDescs[i] ? t(s.optionDescs[i]) : '',
        disabled: off,
        note: off && (v === 'bypassPermissions' || v === 'auto') ? t('在下方「安全」里开启') : '',
      };
    });
  }
  if (!Array.isArray(s.options)) return [];
  // 归档天数：英文要分单复数（字典里「7 天」已被别处译成缩写 7d），按数字走一个带 {n} 的键
  if (key === 'autoArchiveDays') return s.options.map((v) => ({ value: v, label: v ? t('{n} 天', { n: v }) : t('从不'), desc: '' }));
  return s.options.map((v, i) => ({
    value: v,
    label: s.optionLabels && s.optionLabels[i] ? t(s.optionLabels[i]) : String(v),
    desc: s.optionDescs && s.optionDescs[i] ? t(s.optionDescs[i]) : '',
  }));
}

/** 行尾显示的当前值。 */
export function valueLabel(key) {
  const v = val(key);
  if (key === 'outputStyle') return outputStyleLabel(v || 'default');
  if (key === 'compactFrac') return typeof v === 'number' ? Math.round(v * 100) + '%' : t('默认');
  if (key === 'branchPrefix') return String(v || S.branchPrefix.default);
  const o = options(key).find((x) => x.value === v);
  return o ? o.label : v == null ? '' : String(v);
}

/** cs.err → 给人看的一句话。 */
export function errText(err = cs.err) {
  if (!err) return '';
  const s = String(err);
  if (/^(admin only|not available|forbidden)/i.test(s) || /HTTP 403/.test(s)) return t('这一项你改不了');
  if (/Failed to fetch|NetworkError|HTTP 50\d/i.test(s)) return t('设置没保存上，检查连接后再试');
  if (/^(unknown setting|expected |not an allowed|bad |mode not available)/i.test(s)) return t('这个版本的服务端还不认这一项，先更新服务端');
  return tr(s) || t('设置没保存上，请重试');
}
