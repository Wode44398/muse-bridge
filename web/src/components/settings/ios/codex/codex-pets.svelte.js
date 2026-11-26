// 设置里「外观」组的吉祥物数据：本机取得到哪些角色、各自的首帧预览图。桌面壳 CodexSection 与手机壳共用。
// 精灵图是官方桌面版的原件，只有装了 Codex 桌面版的服务器才取得到（lib/codex/assets.js）；
// 预览一张图一百多 KB 到两 MB，所以只在角色选择真正露出来时才去取。

import { assetIndex, assetUrl } from '../../../../lib/codex/assets.js';
import { PETS } from '../../../../lib/codex/prefs.svelte.js';

// 角色名是官方的专有名，不翻译
const LABELS = { codex: 'Codex', dewey: 'Dewey', fireball: 'Fireball', hoots: 'Hoots', 'null-signal': 'Null Signal', bsod: 'BSOD', rocky: 'Rocky', seedy: 'Seedy', stacky: 'Stacky' };
export const petLabel = (name) => LABELS[name] || name;

export const pets = $state({ loaded: false, available: [], previews: {} });

let indexP = null;
/** 取一次可用角色（按 PETS 的官方顺序）。 */
export function loadPets() {
  indexP ||= assetIndex().then((idx) => {
    const have = new Set(Array.isArray(idx?.pets) ? idx.pets : []);
    pets.available = PETS.filter((p) => have.has(p));
    pets.loaded = true;
  });
  return indexP;
}

let previewsP = null;
/** 取各角色的精灵图（blob URL），用来画首帧。 */
export function loadPetPreviews() {
  previewsP ||= loadPets().then(() => Promise.all(pets.available.map(async (name) => {
    const url = await assetUrl('pet', name);
    if (url) pets.previews[name] = url;
  })));
  return previewsP;
}

// 精灵图是 8 列 × 11 行的帧：按这个比例放大，0 0 位置就只露出第一帧
export const PET_FRAME_STYLE = 'background-size: 800% 1100%; background-position: 0 0; background-repeat: no-repeat;';
export const petPreviewStyle = (url) => (url ? `background-image: url("${url}"); ${PET_FRAME_STYLE}` : '');
