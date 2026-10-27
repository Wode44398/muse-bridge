import { t } from './i18n.js';
export const LOCAL_IMAGE_DEFAULTS = Object.freeze({
  imageSteps: 40, imageSeed: -1, imageWidth: 2048, imageHeight: 2048, imageCfg: 1, imageNegative: '', imageCount: 1,
  imageKvCache: true, imageReferenceResolution: 1024, imageSigmas: '', imageTransparent: false,
});
const STORAGE = 'bridge-local-image-settings';
export function storedLocalImageSettings() {
  const result = { ...LOCAL_IMAGE_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    for (const [key, value] of Object.entries(result)) if (typeof saved[key] === typeof value) result[key] = saved[key];
  } catch {}
  return result;
}
export function saveLocalImageSettings(state) {
  const value = {};
  for (const key of Object.keys(LOCAL_IMAGE_DEFAULTS)) value[key] = state[key];
  value.layout = { imageSize: state.imageSize || '2K', imageAspect: state.imageAspect };
  try { localStorage.setItem(STORAGE, JSON.stringify(value)); } catch {}
}
export function localImageLayout() {
  try {
    const layout = JSON.parse(localStorage.getItem(STORAGE) || '{}').layout;
    if (['1K', '2K', '4K', 'custom'].includes(layout?.imageSize) && /^(auto|\d+:\d+)$/.test(layout?.imageAspect)) return layout;
  } catch {}
  return { imageSize: '2K', imageAspect: 'auto' };
}
export function localImageError(state) {
  if (state.imageSize === 'custom' && (![state.imageWidth, state.imageHeight].every(v => Number.isInteger(v) && v >= 256 && v <= 6144 && v % 32 === 0) || state.imageWidth * state.imageHeight > 17_000_000)) return t('宽高须为 256–6144 间的 32 倍数，总像素不能超过 1700 万');
  if (!Number.isInteger(state.imageSeed) || state.imageSeed < -1 || state.imageSeed >= 2 ** 32) return t('随机种子须为 -1 或 0–4294967295 的整数');
  if (!Number.isInteger(state.imageSteps) || state.imageSteps < 1 || state.imageSteps > 100 || !Number.isFinite(state.imageCfg) || state.imageCfg < 1 || state.imageCfg > 10) return t('请检查采样步数和 CFG 强度');
  const text = state.imageSigmas.trim();
  if (text) {
    const sigmas = text.split(/[\s,，]+/).map(Number);
    if (sigmas.length !== state.imageSteps || sigmas.some((v, i) => !Number.isFinite(v) || v <= 0 || v > 1 || (i > 0 && v >= sigmas[i - 1]))) return t('自定义 Sigma 须与采样步数一致，并在 (0, 1] 内严格递减');
  }
  return '';
}
