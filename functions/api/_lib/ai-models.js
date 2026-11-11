// Workers AI のモデルID（一元管理）
//   Cloudflare はモデルを随時廃止する（例: llama-3.1-8b-instruct は 2026-05-30 廃止）。
//   廃止されたら Cloudflare ダッシュボード → Pages → 設定 → 環境変数 に
//   AI_VISION_MODEL を設定すれば、再デプロイなしで差し替えられる。
//   （テキストのAI〔トラブルの原因・対策の提案〕は廃止した。残るのは画像を読むAIだけ）
//   未設定時は下記の現行デフォルトを使う。
//
//   画像    : ai.run(model, { image: [...bytes], prompt }) 形式（LLaVA / Llama Vision 共通）

export const visionModel = (env) => env.AI_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
