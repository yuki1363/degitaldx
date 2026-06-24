import { json, jsonError, readJson } from '../_lib/http.js';
import { visionModel } from '../_lib/ai-models.js';

// 設備銘板写真からデータを自動抽出（Cloudflare Workers AI Vision）
//   POST /api/ai/extract-equipment
//   Body: { file_id: number }（R2にアップロード済みの画像ファイルIDを指定）
//   Returns: { equipment_name, model, serial_no, manufacturer, year, note }
//   モデル: ai-models.js の visionModel()（env AI_VISION_MODEL で上書き可）

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');

  const ai = env.AI;
  if (!ai) {
    return jsonError(503, 'AI サービスが利用できません。Cloudflare ダッシュボードで Workers AI バインディングを設定してください。');
  }

  const body = await readJson(request);
  const fileId = Number(body?.file_id);
  if (!Number.isInteger(fileId) || fileId <= 0) return jsonError(400, 'file_id を指定してください');

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

  const prompt = `この画像は工場設備の銘板（ネームプレート）または設備本体の写真です。
以下の情報を見つけてJSON形式で返してください（見つからない項目は null にする）:
{
  "equipment_name": "設備名（例: コンプレッサ、ポンプ）",
  "model": "型式・型番",
  "serial_no": "製造番号・シリアル番号",
  "manufacturer": "メーカー名",
  "year": "製造年または設置年（数字のみ）",
  "note": "その他読み取れた情報（定格、出力、電圧など）"
}
JSONのみを返し、説明文は不要です。`;

  try {
    const result = await ai.run(visionModel(env), {
      image: imageData,
      prompt,
      max_tokens: 256,
    });
    const rawText = result?.description || result?.response || '';
    // JSON部分を抽出
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ extracted: null, raw: rawText, note: 'JSON を抽出できませんでした。銘板が写っているか確認してください。' });
    }
    let extracted;
    try { extracted = JSON.parse(jsonMatch[0]); } catch { extracted = null; }
    return json({ extracted, raw: rawText });
  } catch (err) {
    return jsonError(500, `AI 処理に失敗しました: ${err.message}`);
  }
}
