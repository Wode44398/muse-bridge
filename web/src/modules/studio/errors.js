// 生成失败的原因怎么显示：上游原话常是几行中英混排（「上游返回 400：The prompt could not be submitted … request id …」），
// 卡片 / 任务托盘上只出一句中文短语，原话收进「详情」（2026-11-06 复核：错误卡是五行原始报错，维护者嫌乱）。
// policy：被内容安全拦下——这时同一句提示词重试注定再失败，按钮换成「改提示词」。
import { t, tr } from '../../lib/i18n.js';

const POLICY = /safety|polic(y|ies)|guideline|violat|blocked|prohibit|sensitive|moderat|recitation|responsible ai|拦下|违规|不安全/i;

export function errBrief(raw) {
  const s = String(raw || '').trim();
  if (!s) return { head: t('生成失败'), detail: '', policy: false };
  const policy = POLICY.test(s);
  const m = s.match(/(?:^|\D)([45]\d\d)(?=\D|$)/);
  const code = m ? Number(m[1]) : 0;
  let head = '';
  if (policy) head = t('提示词或素材被拦下');
  else if (code === 401 || code === 403) head = t('Key 无效或没有权限');
  else if (code === 404) head = t('模型或接口不存在');
  else if (code === 408 || code === 504 || /time(d)? ?out|超时/i.test(s)) head = t('请求超时');
  else if (code === 413) head = t('素材太大');
  else if (code === 429 || /quota|exhausted|rate.?limit|额度/i.test(s)) head = t('额度用完或请求太频繁');
  else if (code >= 500) head = t('服务暂时不可用');
  else if (code === 400) head = t('请求被拒绝');
  // 本来就是一句短中文（本地校验、「服务重启，任务中断」）：原样当标题，不出详情
  if (!head) {
    if (s.length <= 40 && !/[a-z]{4,}/i.test(s)) return { head: tr(s), detail: '', policy };
    head = t('生成失败');
  }
  return { head, detail: s, policy };
}
