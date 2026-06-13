// 通知を1件「確認済み」にする（チーム共有: 最初の確認者を記録）
//   POST /api/notifications/:id   editor 以上

import { requireRole } from '../_lib/auth.js';
import { json, jsonError } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestPost({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, 'id が不正です');

  const row = await db
    .prepare(`SELECT id, acknowledged_at FROM notifications WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!row) return jsonError(404, '通知が見つかりません');

  // 既に確認済みなら上書きしない（最初の確認者・日時を保持）
  if (!row.acknowledged_at) {
    const now = nowIso();
    await db
      .prepare(
        `UPDATE notifications
            SET acknowledged_by = ?1, acknowledged_at = ?2, updated_by = ?1, updated_at = ?2
          WHERE id = ?3 AND acknowledged_at IS NULL`
      )
      .bind(data.user.email, now, id)
      .run();
  }

  return json({ ok: true });
}
