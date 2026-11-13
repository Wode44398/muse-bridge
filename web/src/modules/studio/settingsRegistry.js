// 设置 › Media Studio 的设置项注册表：真身是后端的 src/config/studio-settings.mjs（纯数据，studio-backend 维护），
// 这里只 re-export，外加前端自己的一两个口径。label / desc / optionLabels 是中文原文，界面上经 tr() 显示
// （英文在 i18n/en/studio-settings.js）。
export {
  STUDIO_SETTING_GROUPS, STUDIO_SETTINGS, STUDIO_SETTING_BY_KEY, STUDIO_PERSONAL_KEYS, studioSettingDefaults, studioSettingVisible,
} from '../../../../src/config/studio-settings.mjs';
import { STUDIO_SETTING_BY_KEY } from '../../../../src/config/studio-settings.mjs';

/** 成员也能为自己改的键（scope 'both'：主机给默认、个人可覆盖）。 */
export const isPersonal = (key) => STUDIO_SETTING_BY_KEY[key]?.scope === 'both';
