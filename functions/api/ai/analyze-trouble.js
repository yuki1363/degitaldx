import { json, jsonError, readJson } from '../_lib/http.js';
import { textModel } from '../_lib/ai-models.js';

// トラブル分析 — 入力されたトラブル内容 + PDF報告書の本文 + 過去の類似事例をまとめてAIが分析する
//   出力: 根本原因の推定 / 再発防止策 / 確認ポイント / 類似事例からの教訓
export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  if (!env.AI) return jsonError(503, 'AI サービスが利用できません');

  const body = await readJson(request);
  const phenomenon = (body?.phenomenon || '').trim();
  const cause = (body?.cause || '').trim();
  const countermeasure = (body?.countermeasure || '').trim();
  const equipmentName = (body?.equipment_name || '').trim();
  const categoryName = (body?.category_name || '').trim();
  const pdfText = (body?.pdf_text || '').trim().slice(0, 5000);

  if (!phenomenon && !pdfText) {
    return jsonError(400, '現象またはPDFの内容が必要です');
  }

  // 過去の類似トラブルを取得（現象 or PDF本文の先頭キーワードで LIKE 検索）
  const keywordSource = phenomenon || pdfText;
  const keyword = keywordSource.split(/\s+/)[0] || keywordSource.slice(0, 10);
  let pastCases = [];
  try {
    if (env.DB && keyword) {
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
  } catch { /* DB失敗はAIのみで分析 */ }

  // 入力済みトラブル内容
  const enteredParts = [];
  if (equipmentName) enteredParts.push(`設備: ${equipmentName}`);
  if (categoryName) enteredParts.push(`ジャンル: ${categoryName}`);
  if (phenomenon) enteredParts.push(`現象: ${phenomenon}`);
  if (cause) enteredParts.push(`記入済みの原因: ${cause}`);
  if (countermeasure) enteredParts.push(`記入済みの対策: ${countermeasure}`);
  const enteredText = enteredParts.length > 0
    ? enteredParts.join('\n')
    : '（構造化された入力はありません）';

  const pastText = pastCases.length > 0
    ? pastCases.map((r, i) =>
        `事例${i + 1}: 現象「${r.phenomenon}」原因「${r.cause || '記録なし'}」対策「${r.countermeasure || '記録なし'}」（設備:${r.equipment_name || '不明'}）`
      ).join('\n')
    : '（類似事例なし）';

  const userContent = `# 入力されたトラブル内容
${enteredText}

# PDF報告書から抽出した本文
${pdfText || '（PDFの添付なし）'}

# 過去の類似トラブル事例（このデータベース内）
${pastText}`;

  const messages = [
    {
      role: 'system',
      content: `あなたは工場の設備保全のベテラン分析者です。入力されたトラブル内容・PDF報告書の本文・過去の類似事例を総合的に分析してください。
入力された原因や対策が妥当か、見落としがないか、PDF本文に追加情報がないかも踏まえて検討してください。
回答は以下のJSON形式のみで返してください（他のテキストは不要・各項目200字以内・該当なしは空文字）:
{"root_cause":"根本原因の推定（なぜ起きたかを掘り下げる）","prevention":"再発防止策の提案","checkpoints":"今後の点検・確認で注意すべきポイント","lessons":"過去の類似事例から得られる教訓（事例がない場合は空文字）"}
安全に関わる重大事項は「現場責任者・専門家への確認」を促してください。`,
    },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await env.AI.run(textModel(env), { messages, max_tokens: 700 });
    const raw = result?.response || result?.result?.response || '';
    const match = raw.match(/\{[\s\S]*\}/);
    let analysis = { root_cause: '', prevention: '', checkpoints: '', lessons: '' };
    if (match) {
      try { analysis = { ...analysis, ...JSON.parse(match[0]) }; } catch { /* JSONパース失敗時は生テキストを所見に */ }
    }
    // JSONが取れなかった場合は生テキストを総合所見として返す
    if (!analysis.root_cause && !analysis.prevention && !analysis.checkpoints && raw.trim()) {
      analysis.root_cause = raw.trim().slice(0, 600);
    }
    return json({ analysis, similar_cases: pastCases });
  } catch (err) {
    return jsonError(500, `AI の処理に失敗しました: ${err.message}`);
  }
}
