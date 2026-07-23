// 類似トラブル事例の検索（あいまい検索）。
//   トラブル記録の「現象」テキストから、過去の似たトラブルを最大 limit 件返す。
//   - 常時無料の類似事例一覧（GET /api/troubles/similar）
//   - AI提案（ai/suggest-trouble.js）が参照する過去事例
//   の両方から呼ばれる共通ロジック。AIは使わず D1 の LIKE あいまい検索のみ。
//
// 戻り値は行の配列（HTTPレスポンスにはしない）。try/catch はこの関数には持たせず、
// 呼び出し側がそれぞれの流儀で失敗時処理する（一覧は非表示で継続／AIはAIのみで継続）。

import { buildKeywordClauses } from './fuzzy.js';

const MIN_LEN = 2;      // 1文字だとノイズだらけになるため、2文字未満は検索しない
const MAX_TOKENS = 3;   // D1のbind上限(100)対策: 3列 × 最大8バリアント × 3キーワード = 72 < 100

export async function findSimilarTroubles(db, phenomenonText, { excludeId, equipmentId, limit = 5 } = {}) {
  const text = (phenomenonText || '').trim();
  if (text.length < MIN_LEN) return [];

  // 現象は説明文（散文）なので、空白区切りの各語を OR で当てる（再現率重視。
  // AND だと複数概念を含む現象文が0件になりやすい）。トークン数は bind 上限のため3語まで。
  const tokens = text.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  const cols = ['tr.phenomenon', 'tr.cause', 'tr.countermeasure'];
  const { clauses, binds } = buildKeywordClauses(tokens, cols);
  if (clauses.length === 0) return [];

  let sql = `
    SELECT tr.id, tr.occurred_at, tr.phenomenon, tr.cause, tr.countermeasure, tr.equipment_id,
           tc.name AS category_name, e.name AS equipment_name, e.code AS equipment_code
    FROM trouble_record tr
    LEFT JOIN trouble_category tc ON tc.id = tr.category_id
    LEFT JOIN equipment_ledger  e ON e.id = tr.equipment_id
    WHERE tr.deleted_at IS NULL AND (${clauses.join(' OR ')})`;
  const params = [...binds];

  // 編集中のレコード自身は「類似」に出さない
  if (excludeId) { sql += ' AND tr.id != ?'; params.push(excludeId); }

  // 同じ設備の事例を優先して上に出す（現象欄に設備名が無くても関連履歴が拾える）
  if (equipmentId) {
    sql += ' ORDER BY (CASE WHEN tr.equipment_id = ? THEN 0 ELSE 1 END), tr.occurred_at DESC';
    params.push(equipmentId);
  } else {
    sql += ' ORDER BY tr.occurred_at DESC';
  }

  sql += ' LIMIT ?';
  params.push(Math.min(Number(limit) || 5, 20));

  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}
