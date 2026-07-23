import { json, jsonError, readJson } from '../_lib/http.js';
import { textModel } from '../_lib/ai-models.js';
import { requireRole } from '../_lib/auth.js';
import { findSimilarTroubles } from '../_lib/trouble-similar.js';

// 過去事例の各項目はニューロンコスト・暴走防止のため安全にカットしてプロンプトに入れる
const cap = (s, n = 150) => { const t = s == null ? '' : String(s); return t.length > n ? t.slice(0, n) + '…' : t; };

// トラブル入力AIサジェスト — 現象から過去事例を検索してAIが原因・対策を提案する
export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  // 呼び出し元はeditor専用の登録・編集フォーム。Functions側でも権限を確認する（CLAUDE.md）。
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  if (!env.AI) return jsonError(503, 'AI サービスが利用できません');

  const body = await readJson(request);
  const phenomenon = typeof body?.phenomenon === 'string' ? body.phenomenon.trim() : '';
  if (!phenomenon) return jsonError(400, '現象を入力してください');

  // 過去の類似トラブルを最大5件取得（横断検索と同じあいまい検索を再利用）。
  // DB失敗時は空配列でAIのみの提案にフォールバックする（現象からの一般知識で回答）。
  const pastCases = env.DB
    ? await findSimilarTroubles(env.DB, phenomenon, { limit: 5 }).catch(() => [])
    : [];

  const pastText = pastCases.length > 0
    ? '## 過去の類似トラブル事例\n' + pastCases.map((r, i) =>
        `事例${i + 1}: 現象「${cap(r.phenomenon)}」→ 原因「${cap(r.cause) || '記録なし'}」対策「${cap(r.countermeasure) || '記録なし'}」（設備:${r.equipment_name || '不明'}、ジャンル:${r.category_name || '不明'}）`
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
