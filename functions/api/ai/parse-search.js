import { json, jsonError, readJson } from '../_lib/http.js';
import { textModel, extractAiJson } from '../_lib/ai-models.js';

// 自然言語で横断検索 — 日本語クエリを構造化された検索条件に変換する
export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  if (!env.AI) return jsonError(503, 'AI サービスが利用できません');

  const body = await readJson(request);
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) return jsonError(400, 'クエリを入力してください');
  if (query.length > 200) return jsonError(400, '200文字以内で入力してください');

  // 今日の日付（JST）をコンテキストとして渡す
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const messages = [
    {
      role: 'system',
      content: `あなたは工場設備保全アプリの検索アシスタントです。ユーザーの日本語クエリを解析し、検索条件をJSONで返してください。
今日の日付（JST）: ${today}
対応する種別: trouble（トラブル）/ repair（業務依頼）/ inspection（点検）/ report（日報）/ equipment（設備台帳）/ parts（部品在庫）/ plan（保全計画）
「先月」「今週」「今年」などの相対表現は、今日の日付から計算して必ず実際の YYYY-MM-DD 形式に変換してください（日本語の日付表現をそのまま返さない）。
回答は以下のJSON形式のみで返してください（他のテキストは不要）:
{"keywords":"検索キーワード（スペース区切り、設備名は除く）","from":"YYYY-MM-DD or null","to":"YYYY-MM-DD or null","equipment":"設備名の一部 or null","types":["trouble","repair"] or null（全種別の場合はnull）}
例1（今日が2026-06-24の場合）: 「先月コンプレッサで油漏れ」→ {"keywords":"油漏れ","from":"2026-05-01","to":"2026-05-31","equipment":"コンプレッサ","types":["trouble","repair"]}
例2: 「3号機の点検履歴」→ {"keywords":"","from":null,"to":null,"equipment":"3号機","types":["inspection"]}`,
    },
    { role: 'user', content: query },
  ];

  try {
    const result = await env.AI.run(textModel(env), { messages, max_tokens: 200 });
    const obj = extractAiJson(result);
    let parsed = { keywords: query, from: null, to: null, equipment: null, types: null };
    if (obj) parsed = { ...parsed, ...obj };
    return json({ parsed, original_query: query });
  } catch (err) {
    return jsonError(500, `AI の処理に失敗しました: ${err.message}`);
  }
}
