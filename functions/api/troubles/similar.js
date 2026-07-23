// GET /api/troubles/similar?phenomenon=...&exclude_id=...&equipment_id=...&limit=...
//   現象テキストから過去の類似トラブルを返す（あいまい検索・AI不要・常時無料）。
//   トラブル記録の登録/編集フォームと詳細画面から呼ばれる。
//   一覧GET（troubles/index.js）と同じく requireRole なし（閲覧者も見てよい情報）。

import { json } from '../_lib/http.js';
import { findSimilarTroubles } from '../_lib/trouble-similar.js';

export async function onRequestGet({ request, env }) {
  const sp = new URL(request.url).searchParams;
  const excludeId = sp.get('exclude_id');
  const equipmentId = sp.get('equipment_id');
  const similar = await findSimilarTroubles(env.DB, sp.get('phenomenon') || '', {
    excludeId: excludeId ? Number(excludeId) : undefined,
    equipmentId: equipmentId ? Number(equipmentId) : undefined,
    limit: sp.get('limit'),
  });
  return json({ similar });
}
