// Codex 分页的外观偏好：吉祥物、完成提示音、吐字震动。
// 跟着设备走（存 localStorage）：震动只在手机上有意义，提示音和吉祥物各台机器各有各的习惯，
// 不该从电脑上的选择带到手机上。设置页（桌面 CodexSection、手机 ios/codex）和分页读写同一份。

const KEY = 'bridge-codex-prefs';

// 官方桌面版带的吉祥物角色（精灵图名），顺序照官方设置里的排法
export const PETS = ['codex', 'dewey', 'fireball', 'hoots', 'null-signal', 'bsod', 'rocky', 'seedy', 'stacky'];

const DEFAULTS = {
  pet: false,          // 吉祥物默认关（维护者 11-25 定：做，但默认关）
  petName: 'codex',
  sound: true,         // 后台跑完时响官方提示音
  haptics: true,       // 吐字、步骤、完成时的轻震（旧版克隆页就有）
};

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k];
    }
    if (!PETS.includes(out.petName)) out.petName = DEFAULTS.petName;
    return out;
  } catch { return { ...DEFAULTS }; }
}

export const codexPrefs = $state(read());

export function setCodexPref(key, value) {
  if (!(key in DEFAULTS)) return;
  codexPrefs[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify({ ...codexPrefs })); } catch {}
}

// 另一个标签页 / 设置窗口改了：这一页跟着换
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const next = read();
    for (const k of Object.keys(next)) codexPrefs[k] = next[k];
  });
}
