// 官方插件市场的签名公钥（ed25519，SPKI DER 的 base64）。索引 index.json 的签名 index.json.sig 里写着用的是哪把（keyId）。
// 私钥只在发布机上（bridge-private/plugin-market/signing-key.pem，永不进 git）。换钥匙：新钥匙加进来、发一版 bridge，
// 等大家都升上来以后再用新钥匙签，旧钥匙留一段时间再删。
export const MARKET_KEYS = Object.freeze([
  { id: 'official-2026-10', spki: 'MCowBQYDK2VwAyEA0SpZtklGaAb+2OgItiA1p/elrZFTwtkH6Zob9MSpx6o=' },
]);

// 官方市场的索引地址：Wode44398/bridge-plugins 仓库滚动 Release「index」上的资产。
export const OFFICIAL_INDEX_URL = 'https://github.com/Wode44398/bridge-plugins/releases/download/index/index.json';
