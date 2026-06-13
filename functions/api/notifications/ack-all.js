// 未確認の通知をまとめて「確認済み」にする
//   POST /api/notifications/ack-all   editor 以上
//   body: { type? }  type を指定するとそのトピックのみ確認済みにする

import { requireRole } from '../_lib/auth.js';
import { json, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const type = body?.type || null;
  const now = nowIso();

  let sql = `UPDATE notifications
                SET acknowledged_by = ?1, acknowledged_at = ?2, updated_by = ?1, updated_at = ?2
              WHERE deleted_at IS NULL AND acknowledged_at IS NULL`;
  const binds = [data.user.email, now];
  if (type) { sql += ` AND type = ?3`; binds.push(type); }

  const res = await db.prepare(sql).bind(...binds).run();
  return json({ ok: true, acknowledged: res.meta?.changes ?? 0 });
}
