import { json, jsonError, readJson } from '../_lib/http.js';
import { textModel } from '../_lib/ai-models.js';

// トラブル入力AIサジェスト — 現象から過去事例を検索してAIが原因・対策を提案する
export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  if (!env.AI) return jsonError(503, 'AI サービスが利用できません');

  const body = await readJson(request);
  const phenomenon = typeof body?.phenomenon === 'string' ? body.phenomenon.trim() : '';
  if (!phenomenon) return jsonError(400, '現象を入力してください');

  // 過去の類似トラブルを最大5件取得（最初のキーワードで LIKE 検索）
  const keyword = phenomenon.split(/\s+/)[0] || phenomenon;
  let pastCases = [];
  try {
    if (env.DB) {
      const rows = await env.DB.prepare(
        `SELECT tc.name AS category_name, el.equipment_name,
                tr.phenomenon, tr.cause, tr.countermeasure
         FROM trouble_record tr
         LEFT JOIN trouble_category tc ON tc.id = tr.category_id
         LEFT JOIN equipment_ledger el ON el.id = tr.equipment_id
         WHERE tr.deleted_at IS NULL
           AND (tr.phenomenon LIKE ? OR tr.cause LIKE ? OR tr.countermeasure LIKE ?)
         ORDER BY tr.occurred_at DESC LIMIT 5`
      ).bind(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`).all();
      pastCases = rows.results || [];
    }
  } catch { /* DB失敗は無視してAIのみで提案 */ }

  const pastText = pastCases.length > 0
    ? '## 過去の類似トラブル事例\n' + pastCases.map((r, i) =>
        `事例${i + 1}: 現象「${r.phenomenon}」→ 原因「${r.cause || '記録なし'}」対策「${r.countermeasure || '記録なし'}」（設備:${r.equipment_name || '不明'}、ジャンル:${r.category_name || '不明'}）`
      ).join('\n')
    : '（過去の類似事例はありません。設備保全の一般知識から提案します）';

  const messages = [
    {
      role: 'system',
      content: `あなたは工場の設備保全専門家です。与えられた「現象」と過去事例をもとに、原因と対策を提案してください。
回答は以下のJSON形式のみで返してください（余分なテキスト・説明文は不要）:
{"cause":"原因の提案（100字以内）","countermeasure":"対策の提案（100字以内）","confidence":"high/medium/low"}
過去事例と一致度が高い場合は high、一般知識のみの場合は low にしてください。`,
    },
    {
      role: 'user',
      content: `現象: ${phenomenon}\n\n${pastText}`,
    },
  ];

  try {
    const result = await env.AI.run(textModel(env), { messages, max_tokens: 300 });
    const raw = result?.response || result?.result?.response || '';
    const match = raw.match(/\{[\s\S]*?\}/);
    let suggestion = { cause: '', countermeasure: '', confidence: 'low' };
    if (match) {
      try { suggestion = { ...suggestion, ...JSON.parse(match[0]) }; } catch { /* JSONパース失敗 */ }
    }
    return json({ suggestion, similar_cases: pastCases });
  } catch (err) {
    return jsonError(500, `AI の処理に失敗しました: ${err.message}`);
  }
}
