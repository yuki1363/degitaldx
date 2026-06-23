import { json, jsonError, readJson } from '../_lib/http.js';

// 計器写真から数値を自動読み取り（Cloudflare Workers AI Vision）
//   POST /api/ai/read-meter
//   Body: { file_id, item_name, unit, min_value, max_value }
//   Returns: { value: number|null, raw: string, note: string }

const MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');

  const ai = env.AI;
  if (!ai) {
    return jsonError(503, 'AI サービスが利用できません。Cloudflare ダッシュボードで Workers AI バインディングを設定してください。');
  }

  const body = await readJson(request);
  const fileId = Number(body?.file_id);
  if (!Number.isInteger(fileId) || fileId <= 0) return jsonError(400, 'file_id を指定してください');

  const itemName = String(body?.item_name || '計測値');
  const unit = String(body?.unit || '');
  const minValue = body?.min_value != null ? Number(body.min_value) : null;
  const maxValue = body?.max_value != null ? Number(body.max_value) : null;

  // R2から画像を取得
  const db = env.DB;
  let fileRecord;
  try {
    fileRecord = await db.prepare('SELECT r2_key, content_type FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId).first();
  } catch {
    return jsonError(500, 'ファイル情報の取得に失敗しました');
  }
  if (!fileRecord) return jsonError(404, 'ファイルが見つかりません');
  if (!fileRecord.content_type?.startsWith('image/')) return jsonError(400, '画像ファイルを指定してください');

  const r2 = env.FILES;
  let imageData;
  try {
    const obj = await r2.get(fileRecord.r2_key);
    if (!obj) return jsonError(404, '画像ファイルが見つかりません');
    const buf = await obj.arrayBuffer();
    imageData = [...new Uint8Array(buf)];
  } catch (err) {
    return jsonError(500, `画像の取得に失敗しました: ${err.message}`);
  }

  const rangeText = (minValue != null && maxValue != null)
    ? `基準範囲: ${minValue} 〜 ${maxValue} ${unit}`
    : (minValue != null ? `最小値: ${minValue} ${unit}` : (maxValue != null ? `最大値: ${maxValue} ${unit}` : ''));

  const prompt = `この画像は工場設備の計器です。計器が示す数値を読み取ってください。
計測項目: ${itemName}${unit ? `  単位: ${unit}` : ''}${rangeText ? `  ${rangeText}` : ''}

デジタル表示の場合: 表示されている数字をそのまま読んでください。
指針（アナログ）計器の場合: 目盛りと針の位置から数値を読んでください。

数値のみを返してください（例: 0.45 または 23.1）。
読み取れない場合は「不明」と返してください。`;

  try {
    const result = await ai.run(MODEL, {
      image: imageData,
      prompt,
      max_tokens: 64,
    });
    const rawText = (result?.description || result?.response || '').trim();

    if (!rawText || /不明|わからない|読め|cannot|unknown/i.test(rawText)) {
      return json({ value: null, raw: rawText, note: '計器の数値を読み取れませんでした。手入力してください。' });
    }

    const numMatch = rawText.match(/[-+]?\d+(\.\d+)?/);
    if (!numMatch) {
      return json({ value: null, raw: rawText, note: 'AIの回答から数値を抽出できませんでした。手入力してください。' });
    }

    const value = Number(numMatch[0]);
    return json({ value, raw: rawText, note: '' });
  } catch (err) {
    return jsonError(500, `AI 処理に失敗しました: ${err.message}`);
  }
}
