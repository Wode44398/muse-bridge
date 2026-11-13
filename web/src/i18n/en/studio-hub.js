// 英文界面文案 · studio-hub（Media Studio 的媒体服务面板里、模型中心托管的那几行 / 卡：标签、无障碍名、说明）（键 = 中文原文，见 lib/i18n.js）
// 同一句中文在别的文件里的英文必须一致（i18n-check 查冲突）：「模型中心」与 settings-model-hub.js 同为 Model Hub
export default {
  '模型中心': 'Model Hub',
  '在模型中心打开 {name}': 'Open {name} in Model Hub',
  '这个服务由模型中心管理，请到 设置 › 模型中心 里改': 'This provider is managed by Model Hub. Change it in Settings › Model Hub.',
  // 模型中心接管后 Studio 设置页「媒体服务」组里留下的那行（Google 云凭据、媒体服务沿用 studio-settings.js 的英文）
  '添加 Vertex / 本机服务…': 'Add Vertex / local provider…',
  // 一键导入跳过已收编服务时的原因（服务端 migrate.mjs 原样回的中文）
  '由模型中心管理': 'Managed by Model Hub',
};
