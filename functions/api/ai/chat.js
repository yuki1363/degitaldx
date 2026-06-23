import { json, jsonError, readJson } from '../_lib/http.js';

// AIチャットボット — Cloudflare Workers AI（無料枠）
//   モデル: @cf/meta/llama-3.1-8b-instruct（無料）
//   用途: 保全業務に関する質問への回答（設備、点検、故障対応など）
//   注意: AI が生成したコンテンツは参考情報です。実際の判断は現場担当者が行ってください。

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SYSTEM_PROMPT = `あなたは工場の設備保全業務を支援するアシスタントです。
以下の業務に関する質問に日本語で簡潔・的確に回答してください:
- 設備の点検・修理・部品交換に関する技術情報
- トラブルの原因調査と対処方法
- 保全計画・点検スケジュールの考え方
- 工事連絡書・トラブル報告書の書き方

回答は現場作業者向けに平易な言葉で、安全に関わる内容は必ず「現場の責任者や専門家に確認する」ことを促してください。
個人情報（氏名・連絡先・住所）が含まれる場合は回答を断ってください。`;

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');

  const ai = env.AI;
  if (!ai) {
    return jsonError(503, 'AI サービスが利用できません。Cloudflare ダッシュボードで Workers AI バインディングを設定してください。');
  }

  const body = await readJson(request);
  const userMessage = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!userMessage) return jsonError(400, 'メッセージを入力してください');
  if (userMessage.length > 1000) return jsonError(400, 'メッセージは1000文字以内で入力してください');

  // 会話履歴（最大5往復）
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: String(h.content || '') })),
    { role: 'user', content: userMessage },
  ];

  try {
    const result = await ai.run(MODEL, { messages, max_tokens: 512 });
    const reply = result?.response || result?.result?.response || '回答を生成できませんでした。';
    return json({ reply });
  } catch (err) {
    return jsonError(500, `AI の処理に失敗しました: ${err.message}`);
  }
}
