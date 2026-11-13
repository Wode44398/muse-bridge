// 非 Google 方言的内置模型卡（常见模型）：各方言适配器自带 CARDS（{ <模型 id>: 卡 }），这里汇总。
// 卡 id 写成 '<方言>:<模型 id>'；模型条目可显式指定 card（例如手填的 fal 模型套用某张现成的卡）。

const TABLE = new Map();   // dialect → { id → card }
const BY_CARD_ID = new Map();

/** 适配器登记自己的卡（导入时调一次）。 */
export function registerDialectCards(dialect, cards) {
  const m = TABLE.get(dialect) || {};
  for (const [id, card] of Object.entries(cards || {})) {
    const c = { ...card, id: card.id || `${dialect}:${id}` };
    m[id] = c;
    BY_CARD_ID.set(c.id, c);
  }
  TABLE.set(dialect, m);
}

export function dialectCards(dialect, modelId, cardId) {
  if (cardId && BY_CARD_ID.has(cardId)) return BY_CARD_ID.get(cardId);
  return (TABLE.get(dialect) || {})[modelId] || null;
}

/** 方言的内置模型清单（设置页「添加常见模型」、拉不到列表时的兜底）。 */
export function dialectBuiltinModels(dialect) {
  return Object.entries(TABLE.get(dialect) || {}).map(([id, c]) => ({ id, label: c.label || id, kind: c.kind, card: c.id }));
}

/** 方言的内置卡全表 [{ id, card }]（同族继承找父卡用）。 */
export function dialectCardList(dialect) {
  return Object.entries(TABLE.get(dialect) || {}).map(([id, card]) => ({ id, card }));
}
