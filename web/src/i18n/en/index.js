// 英文界面字典：本目录下每个分区文件 export default { '中文原文': 'English', … }，这里合并成一份。
// 只在界面语言为 English 时由 lib/i18n.js 动态加载，中文用户不下载。
// 同一中文键在不同文件里的英文必须一致（不一致由 web/scripts/i18n-check.mjs 报冲突）；
// 同一句中文确需两种译法时用语境键 '语境::中文'，代码里写 tc('语境', '中文')。
const mods = import.meta.glob(['./*.js', '!./index.js'], { eager: true, import: 'default' });

const dict = Object.create(null);
for (const k of Object.keys(mods).sort()) Object.assign(dict, mods[k]);

export default dict;
