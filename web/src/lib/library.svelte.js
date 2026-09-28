// Client-side session library: stars (favorites) and custom titles. The backend
// derives titles from the first message and has no star/rename endpoint, so these
// live in localStorage (per-device — noted as a tradeoff vs server-synced stars).
const LS_STAR = 'bridge-stars';
const LS_TITLE = 'bridge-titles';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

export const library = $state({
  stars: load(LS_STAR, []),    // [sessionId, …] (most-recently-starred first)
  titles: load(LS_TITLE, {}),  // { sessionId: customTitle }
});

const saveStars = () => { try { localStorage.setItem(LS_STAR, JSON.stringify(library.stars)); } catch {} };
const saveTitles = () => { try { localStorage.setItem(LS_TITLE, JSON.stringify(library.titles)); } catch {} };

export const isStarred = (id) => library.stars.includes(id);
export function toggleStar(id) {
  library.stars = isStarred(id) ? library.stars.filter((x) => x !== id) : [id, ...library.stars];
  saveStars();
}

export const titleFor = (id, fallback) => library.titles[id] || fallback;
export function renameSession(id, name) {
  const t = (name || '').trim();
  if (t) { library.titles = { ...library.titles, [id]: t }; saveTitles(); }
}
