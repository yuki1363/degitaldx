// 類似トラブル事例の検索（あいまい検索）。
//   トラブル記録の「現象」テキストから、過去の似たトラブルを最大 limit 件返す。
//   - 常時無料の類似事例一覧（GET /api/troubles/similar）
//   - AI提案（ai/suggest-trouble.js）が参照する過去事例
//   の両方から呼ばれる共通ロジック。AIは使わず D1 の LIKE あいまい検索のみ。
//
// 戻り値は行の配列（HTTPレスポンスにはしない）。try/catch はこの関数には持たせず、
// 呼び出し側がそれぞれの流儀で失敗時処理する（一覧は非表示で継続／AIはAIのみで継続）。

import { keywordVariants } from './fuzzy.js';

const MIN_LEN = 2;        // 1文字だとノイズだらけになるため、2文字未満は検索しない
const MAX_TOKENS = 5;     // 1語あたり最大8バリアント × 5語 = 40 bind（+設備・自分・件数＝43。D1の上限100に収まる）

// 検索対象の列（つないで1つの文字列として LIKE で当てる＝列が増えても bind 数が増えない）。
//   現象・原因・対策に加え、設備名・設備番号・ライン名・ジャンル・報告者・帳票入力も対象にする
//   （横断検索11と同じ範囲。現象に設備名を書いていない記録も設備名で見つかる）。
//   form_values_json / reporter_name が無い旧DBでは後ろの列を外して再試行する。
const HAY_FULL = ['tr.phenomenon', 'tr.cause', 'tr.countermeasure', 'e.name', 'e.code', 'e.line_name',
  'e.equipment_name', 'tc.name', 'tr.reporter_name', 'tr.form_values_json'];
const HAY_BASIC = ['tr.phenomenon', 'tr.cause', 'tr.countermeasure', 'e.name', 'e.code', 'tc.name'];
const hayExpr = (cols) => `(${cols.map((c) => `COALESCE(${c}, '')`).join(` || ' ' || `)})`;

export async function findSimilarTroubles(db, phenomenonText, { excludeId, equipmentId, limit = 5 } = {}) {
  const text = (phenomenonText || '').trim();
  if (text.length < MIN_LEN) return [];

  // 現象は説明文（散文）なので、空白区切りの各語のどれかを含む記録を拾い（OR・再現率重視）、
  // 「一致した語の数 → 同じ設備 → 新しい順」で並べて上位 limit 件を返す。
  // 一致数はDB側（SQL）で数える。新しい順などで先に件数を切ってから並べ替えると、よくある語
  // （例「異音」）だけに一致する新しい記録が多いとき、全部の語に一致する古い記録が候補から落ちて
  // 表示されなかった。
  const tokens = [...new Set(text.split(/\s+/).filter(Boolean))].slice(0, MAX_TOKENS);
  if (tokens.length === 0) return [];
  const tokenVariants = tokens.map((t) => keywordVariants(t));
  const max = Math.min(Math.max(1, Math.trunc(Number(limit)) || 5), 20);

  const run = async (cols) => {
    const binds = [];
    const bind = (v) => { binds.push(v); return `?${binds.length}`; }; // 番号つき（?1, ?2…）で、書く順に関係なく対応づける
    // 語ごとに「いずれかの表記ゆれが含まれれば1点」。点数が1以上の記録だけを残す
    const score = tokenVariants
      .map((vs) => `(CASE WHEN ${vs.map((v) => `x.hay LIKE ${bind(`%${v}%`)}`).join(' OR ')} THEN 1 ELSE 0 END)`)
      .join(' + ');
    const sameEq = equipmentId ? `(CASE WHEN x.equipment_id = ${bind(Number(equipmentId))} THEN 1 ELSE 0 END)` : '0';
    const exclude = excludeId ? `AND tr.id != ${bind(Number(excludeId))}` : ''; // 編集中のレコード自身は出さない
    const sql = `
      SELECT s.id, s.occurred_at, s.phenomenon, s.cause, s.countermeasure, s.equipment_id,
             s.category_name, s.equipment_name, s.equipment_code
        FROM (
          SELECT x.*, (${score}) AS score, ${sameEq} AS same_eq
            FROM (
              SELECT tr.id, tr.occurred_at, tr.phenomenon, tr.cause, tr.countermeasure, tr.equipment_id,
                     tc.name AS category_name, e.name AS equipment_name, e.code AS equipment_code,
                     ${hayExpr(cols)} AS hay
                FROM trouble_record tr
                LEFT JOIN trouble_category tc ON tc.id = tr.category_id
                LEFT JOIN equipment_ledger  e ON e.id = tr.equipment_id
               WHERE tr.deleted_at IS NULL ${exclude}
            ) x
        ) s
       WHERE s.score > 0
       ORDER BY s.score DESC, s.same_eq DESC, s.occurred_at DESC
       LIMIT ${bind(max)}`;
    const { results } = await db.prepare(sql).bind(...binds).all();
    return results || [];
  };

  try {
    return await run(HAY_FULL);
  } catch (err) {
    if (!/no such column/i.test(String(err?.message))) throw err;
    return await run(HAY_BASIC);
  }
}
