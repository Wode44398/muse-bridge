// Media Studio 的「种类」三套叫法统一在这里换算（纯函数，有单测）。
//   创作页 id（界面、草稿、agentUi 的 module）：image / video / voice / music
//   目录与任务的 kind（§3.2 / §3.3）：          image / video / speech / music
//   作品的 kind（§3.4 Asset.kind）：            image / video / audio / music

export const PAGES = ['image', 'video', 'voice', 'music'];

const TO_CAT = { image: 'image', video: 'video', voice: 'speech', music: 'music' };
const FROM_ANY = {
  image: 'image', video: 'video', music: 'music',
  voice: 'voice', speech: 'voice', audio: 'voice', tts: 'voice',
};

/** 创作页 id → 目录 / 任务的 kind */
export const catKind = (page) => TO_CAT[page] || page;
/** 任意一种叫法（目录 kind、作品 kind、旧 Vertex func）→ 创作页 id；认不出回 null */
export const pageOf = (kind) => FROM_ANY[String(kind || '')] || null;
/** 作品 kind → 有没有画面（缩略图） */
export const visual = (assetKind) => assetKind === 'image' || assetKind === 'video';

/** 「<provider>/<model>」拆开；模型 id 本身可以含斜杠（OpenRouter 的 openai/gpt-image），只按第一个斜杠切 */
export function splitKey(key) {
  const s = String(key || '');
  const i = s.indexOf('/');
  return i < 0 ? { provider: '', model: s } : { provider: s.slice(0, i), model: s.slice(i + 1) };
}
export const joinKey = (provider, model) => (provider ? provider + '/' + model : String(model || ''));

/** 文件名 → 能拿来干什么（拖进创作页时判断落点）：image / video / audio / text / null */
const EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'],
  video: ['mp4', 'mov', 'webm', 'm4v', 'mkv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
  text: ['txt', 'md', 'markdown', 'srt', 'lrc'],
};
export function fileKind(name) {
  const e = String(name || '').split('.').pop().toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(e)) return k;
  return null;
}

/** 本机上传素材的 upload 字段只发 uploads 里的相对名。/api/upload、/api/files/to-upload 回的是服务器上的绝对路径
 *  （<uploads>/<时刻>-<原名>，平铺一层），原样发过去后端会拼错（2026-11-05 真机「素材文件不存在」）——取最后一段即可。 */
export function uploadRel(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(s)) return s.replace(/\\/g, '/');   // 本来就是相对名
  return s.split(/[\\/]+/).filter(Boolean).pop() || '';
}
