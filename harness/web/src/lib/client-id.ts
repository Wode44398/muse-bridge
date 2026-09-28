// P10（D9）：这台设备的身份——落定卡片（批准 / 拒绝 / 回答 / 审计划）时带上，别的设备据此在回执上写「在手机上拒绝了」。
// 只用来显示，不做鉴权（鉴权在 bridge）。存不进 localStorage（隐私模式、被清）就每次打开页面换一个，只是认不出「是我」。

const KEY = "dimensio.clientId";
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
let cached: string | null = null;

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function clientId(): string {
  if (cached) return cached;
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    /* 隐私模式 / 存储被禁 */
  }
  if (!id || !ID_RE.test(id)) {
    id = randomId();
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* 同上：这次打开页面内有效 */
    }
  }
  cached = id;
  return id;
}

// 给人看的设备名：手机 / 平板 / 电脑（bridge 的安卓壳 UA 带 Android + Mobile，桌面壳是 Electron）
export function clientLabel(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "平板";
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return "手机";
  return "电脑";
}

export function thisDevice(): { id: string; label: string } {
  return { id: clientId(), label: clientLabel() };
}

// 回执上的「在哪定的」：别的设备定的才写（这台设备自己点的不啰嗦）
export function decidedElsewhere(by: { id: string; label: string } | undefined): string {
  return by && by.id !== clientId() ? `在${by.label}上` : "";
}
