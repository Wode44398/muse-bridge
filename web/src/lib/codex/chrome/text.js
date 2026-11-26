// 外框里几处要拼的文案（经 i18n）：逻辑在 logic.js（纯函数），这里只把记号换成字。
import { t, lang } from '../../i18n.js';
import { ago } from './logic.js';

/** 侧栏行尾的时间：刚刚 / 5 分钟 / 3 小时 / 昨天 / 4 天 / 2 周 / 6月1日。 */
export function agoText(mtime, now = Date.now()) {
  const a = ago(mtime, now);
  if (!a) return '';
  switch (a.unit) {
    case 'now': return t('刚刚');
    case 'min': return t('{n} 分钟', { n: a.n });
    case 'hour': return t('{n} 小时', { n: a.n });
    case 'yesterday': return t('昨天');
    case 'day': return t('{n} 天', { n: a.n });
    case 'week': return t('{n} 周', { n: a.n });
    default: {
      const loc = lang() === 'en' ? 'en-US' : 'zh-CN';
      return new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric' }).format(new Date(a.n));
    }
  }
}
