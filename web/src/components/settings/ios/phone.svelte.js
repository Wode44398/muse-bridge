// 这台手机的原生能力（iOS 外壳）：手机操控、无障碍 / 输入法 / 后台运行授权、悬浮外壳、挖孔诊断——都靠离线 apk 壳的 window.AndroidStore。
import { nativeInfo } from '../../../lib/appUpdate.js';

export function createPhone(S) {
  // —— 手机操控（Phone Control · 实验性）：仅离线 apk 壳（有 window.AndroidStore 原生桥）里可用 ——
  const hasPhoneCtrl = typeof window !== 'undefined' && !!(window.AndroidStore && window.AndroidStore.startPhoneControl);
  function readPhoneCtrl() { try { return !!(window.AndroidStore && window.AndroidStore.isPhoneControlRunning && window.AndroidStore.isPhoneControlRunning()); } catch { return false; } }
  let phoneCtrlOn = $state(readPhoneCtrl());
  function togglePhoneCtrl() {
    if (!hasPhoneCtrl) return;
    try { if (phoneCtrlOn) window.AndroidStore.stopPhoneControl(); else window.AndroidStore.startPhoneControl(); } catch {}
    phoneCtrlOn = !phoneCtrlOn;
  }
  function readAcc() { try { return !!(window.AndroidStore && window.AndroidStore.isAccessibilityEnabled && window.AndroidStore.isAccessibilityEnabled()); } catch { return false; } }
  let accOn = $state(hasPhoneCtrl ? readAcc() : false);
  function grantAccessibility() { try { window.AndroidStore && window.AndroidStore.openAccessibilitySettings(); } catch {} }
  function readImeEnabled() { try { return !!(window.AndroidStore && window.AndroidStore.isBridgeImeEnabled && window.AndroidStore.isBridgeImeEnabled()); } catch { return false; } }
  function readImeDefault() { try { return !!(window.AndroidStore && window.AndroidStore.isBridgeImeDefault && window.AndroidStore.isBridgeImeDefault()); } catch { return false; } }
  let imeEnabled = $state(hasPhoneCtrl ? readImeEnabled() : false);
  let imeDefault = $state(hasPhoneCtrl ? readImeDefault() : false);
  function openImeSettings() { try { window.AndroidStore && window.AndroidStore.openImeSettings(); } catch {} }
  function showImePicker() { try { window.AndroidStore && window.AndroidStore.showImePicker(); } catch {} }
  function onImeRow() { if (!imeEnabled) openImeSettings(); else showImePicker(); }
  function readBattery() { try { return !!(window.AndroidStore && window.AndroidStore.isIgnoringBattery && window.AndroidStore.isIgnoringBattery()); } catch { return false; } }
  // 后台运行（电池优化白名单）不只是手机操控要：任务通知栏也靠它在后台活着——「通用」里也给一行
  const hasBatteryApi = typeof window !== 'undefined' && !!window.AndroidStore?.isIgnoringBattery;
  let batteryOk = $state(hasPhoneCtrl || hasBatteryApi ? readBattery() : false);
  function grantBattery() { try { window.AndroidStore && window.AndroidStore.requestIgnoreBattery(); } catch {} }
  function openAppDetails() { try { window.AndroidStore && window.AndroidStore.openAppDetails(); } catch {} }
  const hasFloatShell = typeof window !== 'undefined' && !!(window.AndroidStore && window.AndroidStore.startFloatingShell);
  function readFloatShell() { try { return !!(window.AndroidStore && window.AndroidStore.isFloatingShellRunning && window.AndroidStore.isFloatingShellRunning()); } catch { return false; } }
  let floatShellOn = $state(hasFloatShell ? readFloatShell() : false);
  function toggleFloatShell() {
    if (!hasFloatShell) return;
    try { if (floatShellOn) window.AndroidStore.stopFloatingShell(); else window.AndroidStore.startFloatingShell(); } catch {}
    floatShellOn = !floatShellOn;
  }
  let cutoutDbgOn = $state(false);
  try { cutoutDbgOn = localStorage.getItem('cutoutDebug') === '1'; } catch {}
  function toggleCutoutDbg() {
    cutoutDbgOn = !cutoutDbgOn;
    try { localStorage.setItem('cutoutDebug', cutoutDbgOn ? '1' : '0'); } catch {}
    try { window.dispatchEvent(new Event('cutout-debug')); } catch {}
  }
  function startCutoutCal() { try { window.dispatchEvent(new Event('cutout-calibrate')); } catch {} }
  // 从系统设置页返回时刷新各状态（visibilitychange）；授权回来事件即时翻开关。
  // 「关于」页的安装权限（去系统设置里开「安装未知应用」再回来）也在这里重读。
  $effect(() => {
    if (!hasPhoneCtrl && !hasFloatShell && !hasBatteryApi) return;
    const refresh = () => {
      accOn = readAcc(); batteryOk = readBattery(); phoneCtrlOn = readPhoneCtrl(); floatShellOn = readFloatShell(); imeEnabled = readImeEnabled(); imeDefault = readImeDefault();
      if (S.plat === 'android' && !document.hidden) S.about.appInfo = nativeInfo();
    };
    const onGranted = () => { floatShellOn = true; };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('bridge-overlay-granted', onGranted);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('bridge-overlay-granted', onGranted); };
  });
  return {
    hasPhoneCtrl, get phoneCtrlOn() { return phoneCtrlOn; }, togglePhoneCtrl, get accOn() { return accOn; }, grantAccessibility,
    get imeEnabled() { return imeEnabled; }, onImeRow, hasBatteryApi, get batteryOk() { return batteryOk; }, grantBattery, openAppDetails,
    hasFloatShell, get floatShellOn() { return floatShellOn; }, toggleFloatShell, get cutoutDbgOn() { return cutoutDbgOn; }, toggleCutoutDbg, startCutoutCal,
  };
}
