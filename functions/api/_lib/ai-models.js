// Workers AI のモデルID（一元管理）
//   Cloudflare はモデルを随時廃止する（例: llama-3.1-8b-instruct は 2026-05-30 廃止）。
//   廃止されたら Cloudflare ダッシュボード → Pages → 設定 → 環境変数 に
//   AI_TEXT_MODEL / AI_VISION_MODEL を設定すれば、再デプロイなしで差し替えられる。
//   未設定時は下記の現行デフォルトを使う。
//
//   テキスト: messages 形式（ai.run(model, { messages, max_tokens })）
//   画像    : ai.run(model, { image: [...bytes], prompt }) 形式（LLaVA / Llama Vision 共通）

export const textModel = (env) => env.AI_TEXT_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
export const visionModel = (env) => env.AI_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';

// Workers AI 応答の response 部分を取り出す（result.response もしくは result.result.response）。
// モデルによって文字列だったりオブジェクト（構造化出力）だったりする。
function rawResponse(result) {
  return result?.response ?? result?.result?.response ?? '';
}

// テキスト応答を必ず文字列で返す（チャット等の生テキスト用途）。
// response がオブジェクトのモデルでも .match 等で落ちないようにするための正規化。
export function aiResponseText(result) {
  const r = rawResponse(result);
  if (typeof r === 'string') return r;
  if (r == null || r === '') return '';
  try { return JSON.stringify(r); } catch { return String(r); }
}

// テキスト応答から JSON オブジェクトを取り出す。response が既にオブジェクトなら
// それをそのまま使い、文字列なら最初の { … } を取り出してパースする。取れなければ null。
export function extractAiJson(result) {
  const r = rawResponse(result);
  if (r && typeof r === 'object') return r;
  const raw = typeof r === 'string' ? r : String(r ?? '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
