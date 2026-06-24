import { json, jsonError, readJson } from '../_lib/http.js';
import { textModel } from '../_lib/ai-models.js';

// PDFトラブル報告書の解析 — クライアントで抽出したテキストからトラブルデータを構造化する
export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  if (!env.AI) return jsonError(503, 'AI サービスが利用できません');

  const body = await readJson(request);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return jsonError(400, 'PDFのテキストが空です');

  // 長すぎるテキストは切り詰め（トークン節約）
  const truncated = text.slice(0, 6000);

  const messages = [
    {
      role: 'system',
      content: `あなたは工場のトラブル報告書を解析するAIです。与えられたテキストからトラブル記録に必要な情報を抽出してください。
回答は以下のJSON形式のみで返してください（見つからない項目はnull）:
{"occurred_at":"発生日時 YYYY-MM-DDTHH:MM（24時間）or null","equipment_name":"設備名 or null","phenomenon":"現象・不具合内容 or null","cause":"原因 or null","countermeasure":"対策・処置内容 or null","reporter_name":"記録者・担当者名 or null"}
日付変換: 「令和5年3月15日14時30分」→「2023-03-15T14:30」、「R5.3.15」→「2023-03-15T00:00」、「2024/3/15」→「2024-03-15T00:00」`,
    },
    {
      role: 'user',
      content: `以下のトラブル報告書テキストからデータを抽出してください:\n\n${truncated}`,
    },
  ];

  try {
    const result = await env.AI.run(textModel(env), { messages, max_tokens: 400 });
    const raw = result?.response || result?.result?.response || '';
    const match = raw.match(/\{[\s\S]*?\}/);
    let extracted = {};
    if (match) {
      try { extracted = JSON.parse(match[0]); } catch { /* JSONパース失敗 */ }
    }
    return json({ extracted });
  } catch (err) {
    return jsonError(500, `AI の処理に失敗しました: ${err.message}`);
  }
}
