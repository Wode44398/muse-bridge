// 子 agent 调用策略子页里两样「给人看的名字」，子组件一律从这里取（判断本身是 dpUtil.js 里的纯函数，这里只接上翻译层与能力表）：
//   · 策略名——策略签、保存条、确认框、提示条、「复制「…」」；
//   · 推理强度——四档落点的片、行下「普通子 agent」那一句、图上小菜单的标题。
import { caps } from '../../../lib/state.svelte.js';
import { effortChoices } from '../../../lib/claudeProviders.svelte.js';
import { effortName } from '../../../lib/dispatchPolicy.svelte.js';
import { t } from '../../../lib/i18n.js';
import { isCustom, effortLabelIn, strategyLabel as labelOf } from './dpUtil.js';

/** 策略名的显示写法：迁移出来的那一套（存的名字正好是「默认」）跟着界面语言走，用户自己起的原样。和两套外壳入口副标题同一口径。 */
export const strategyLabel = (name) => labelOf(name, t('默认'));

/** 这个模型的推理强度档位表——就是输入栏拉条面板（EffortPanel）取的那一张：Claude = 能力表里的五档；
 *  自定义模型 = 它自己的表（没有默认档时头上多一项「默认」）。model 可以是规范写法（opus / custom:…）或 claude-* 全 id。 */
export const effortTable = (model) => (isCustom(model) ? effortChoices(model, caps.data) : (caps.data?.claude?.efforts || [])).filter((e) => e.id !== 'ultracode');

/** 推理强度的显示名：先按拉条面板那张表（面板里叫 Extra，这里就不写 Extra high）；表里没有（'' = 不指定、表外的档）再退回状态模块的通用叫法。 */
export const effortLabel = (model, effort) => effortLabelIn(effortTable(model), effort) || effortName(model, effort || '');
