// 05: 部品の数量の上限（桁あふれ・打ち間違い防止）。在庫数・安全在庫・1回の入出庫数に共通
export const MAX_PART_QTY = 1_000_000;
export const PART_QTY_MESSAGE = `数量は${MAX_PART_QTY.toLocaleString('en-US')}以下で指定してください。`;
