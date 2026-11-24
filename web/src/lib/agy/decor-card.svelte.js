// 共用卡（悬停头像组 / 触屏长按头像组弹出）的开合状态。
// 鼠标：停 260ms 才开（扫过不弹），移出 180ms 后才关，中间移进卡里就不关——这样能从头像组移进卡里去点。
// 触屏：长按直接开、钉住，点卡外面或按返回才关。
export const decorCard = $state({ open: false, path: '', anchor: null, pinned: false, seq: 0 });

let showT = 0;
let hideT = 0;
const clear = () => { clearTimeout(showT); clearTimeout(hideT); showT = 0; hideT = 0; };

export function cardHoverIn(anchor, path) {
  clearTimeout(hideT); hideT = 0;
  if (decorCard.open && decorCard.path === path) return;
  clearTimeout(showT);
  showT = setTimeout(() => {
    showT = 0;
    Object.assign(decorCard, { open: true, path, anchor, pinned: false, seq: decorCard.seq + 1 });
  }, decorCard.open ? 0 : 260);
}

export function cardHoverOut() {
  clearTimeout(showT); showT = 0;
  if (!decorCard.open || decorCard.pinned) return;
  clearTimeout(hideT);
  hideT = setTimeout(() => { hideT = 0; decorCard.open = false; }, 180);
}

/** 鼠标进了卡：别关。 */
export function cardKeep() {
  clearTimeout(hideT); hideT = 0;
}

export function cardPin(anchor, path) {
  clear();
  Object.assign(decorCard, { open: true, path, anchor, pinned: true, seq: decorCard.seq + 1 });
}

export function closeCard() {
  clear();
  decorCard.open = false;
}
