// 官方插件市场的签名公钥（ed25519，SPKI DER 的 base64）。索引 index.json 的签名 index.json.sig 里写着用的是哪把（keyId）。
// 私钥只在发布机上（bridge-private/plugin-market/signing-key.pem，永不进 git）。换钥匙：新钥匙加进来、发一版 bridge，
// 等大家都升上来以后再用新钥匙签，旧钥匙留一段时间再删。
export const MARKET_KEYS = Object.freeze([
  { id: 'official-2026-10', spki: 'MCowBQYDK2VwAyEA0SpZtklGaAb+2OgItiA1p/elrZFTwtkH6Zob9MSpx6o=' },
]);

// 官方市场的索引地址：Wode44398/bridge-plugins 仓库滚动 Release「index」上的资产。
export const OFFICIAL_INDEX_URL = 'https://github.com/Wode44398/bridge-plugins/releases/download/index/index.json';

// 社区市场：另一把钥匙。私钥在市场仓库的 GitHub Actions（environment community-signing），只签社区索引；
// 官方私钥仍只在发布机上，社区这把泄露也碰不到官方插件和内置功能（社区条目永远不能盖内置功能）。
export const COMMUNITY_KEYS = Object.freeze([
  { id: 'community-2026-11', spki: 'MCowBQYDK2VwAyEAONT+n/tFjGICw1EsviILLew2slQP3KJY9hOOHYDaxyM=' },
]);
export const COMMUNITY_REPO = 'Wode44398/bridge-plugins';
export const COMMUNITY_INDEX_URL = 'https://github.com/Wode44398/bridge-plugins/releases/download/community-index/community.json';
// 「发布到社区」的 GitHub 设备码登录用的 OAuth App（Wode44398 名下的「bridge 社区发布」，开了 Device Flow、令牌不过期——
// bridge 不做令牌续期；client id 是公开的，不是机密）。空 = 不提供这种登录，
// 作者用这台电脑上 gh 登录的账号或粘贴令牌。
export const COMMUNITY_GITHUB_CLIENT_ID = 'Ov23liTfmzrRWupz20Kp';
