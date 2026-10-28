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
const MAX_TOKENS = 5;     // 1語あたり最大8バリアント × 5語 = 40 bind（D1の上限100に収まる）
const CANDIDATES = 200;   // 一致した語の数で並べ直すための候補の上限

// 検索対象の列（つないで1つの文字列として LIKE で当てる＝列が増えても bind 数が増えない）。
//   現象・原因・対策に加え、設備名・設備番号・ライン名・ジャンル・報告者・帳票入力も対象にする
//   （横断検索11と同じ範囲。現象に設備名を書いていない記録も設備名で見つかる）。
//   form_values_json / reporter_name が無い旧DBでは後ろの列を外して再試行する。
const HAY_FULL = ['tr.phenomenon', 'tr.cause', 'tr.countermeasure', 'e.name', 'e.code', 'e.line_name',
  'e.equipment_name', 'tc.name', 'tr.reporter_name', 'tr.form_values_json'];
const HAY_BASIC = ['tr.phenomenon', 'tr.cause', 'tr.countermeasure', 'e.name', 'e.code', 'tc.name'];
const hayExpr = (cols) => `(${cols.map((c) => `COALESCE(${c}, '')`).join(` || ' ' || `)})`;

// 1語がこの文字列に含まれるか（LIKE と同じく英字の大小は区別しない・バリアントのどれか）
const containsToken = (hay, variants) => variants.some((v) => hay.includes(v.toLowerCase()));

export async function findSimilarTroubles(db, phenomenonText, { excludeId, equipmentId, limit = 5 } = {}) {
  const text = (phenomenonText || '').trim();
  if (text.length < MIN_LEN) return [];

  // 現象は説明文（散文）なので、空白区切りの各語のどれかを含む記録を候補にし（OR・再現率重視）、
  // 一致した語の多い順に並べる。新しい順だけで件数を切ると、よくある語（例「異音」）だけに一致する
  // 新しい記録に押し出されて、全部の語に一致する古い記録が表示されなかった。
  const tokens = [...new Set(text.split(/\s+/).filter(Boolean))].slice(0, MAX_TOKENS);
  const tokenVariants = tokens.map((t) => keywordVariants(t));
  if (tokens.length === 0) return [];
  const max = Math.min(Math.max(1, Math.trunc(Number(limit)) || 5), 20);

  const run = async (cols) => {
    const hay = hayExpr(cols);
    const where = tokenVariants.map((vs) => `(${vs.map(() => `${hay} LIKE ?`).join(' OR ')})`).join(' OR ');
    const params = tokenVariants.flatMap((vs) => vs.map((v) => `%${v}%`));
    let sql = `
      SELECT tr.id, tr.occurred_at, tr.phenomenon, tr.cause, tr.countermeasure, tr.equipment_id,
             tc.name AS category_name, e.name AS equipment_name, e.code AS equipment_code,
             ${hay} AS hay
      FROM trouble_record tr
      LEFT JOIN trouble_category tc ON tc.id = tr.category_id
      LEFT JOIN equipment_ledger  e ON e.id = tr.equipment_id
      WHERE tr.deleted_at IS NULL AND (${where})`;
    // 編集中のレコード自身は「類似」に出さない
    if (excludeId) { sql += ' AND tr.id != ?'; params.push(excludeId); }
    sql += ' ORDER BY tr.occurred_at DESC LIMIT ?';
    params.push(CANDIDATES);
    const { results } = await db.prepare(sql).bind(...params).all();
    return results || [];
  };

  let rows;
  try {
    rows = await run(HAY_FULL);
  } catch (err) {
    if (!/no such column/i.test(String(err?.message))) throw err;
    rows = await run(HAY_BASIC);
  }

  // 一致した語の数 → 同じ設備 → 新しい順。hay は並べ替えにだけ使い、応答には含めない
  const scored = rows.map((r) => {
    const hay = String(r.hay || '').toLowerCase();
    const score = tokenVariants.reduce((n, vs) => n + (containsToken(hay, vs) ? 1 : 0), 0);
    const { hay: _drop, ...row } = r;
    return { row, score, sameEq: equipmentId && Number(r.equipment_id) === Number(equipmentId) ? 1 : 0 };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.sameEq - a.sameEq)
    || String(b.row.occurred_at || '').localeCompare(String(a.row.occurred_at || '')));
  return scored.slice(0, max).map((x) => x.row);
}
