// 通知センター（最近の動き・アラート）一覧
//   GET /api/notifications?status=unread&type=parts_zero&limit=50
//     status=unread … 未確認のみ（省略時は確認済みも含めて新着順）
//     type           … parts_zero / inspection_abnormal / trouble で絞り込み
//   未読数（unread_count）は常に返す（ホームのバッジ表示に使う）。
//   閲覧は全ログインユーザー可（確認操作のみ editor 以上）。

import { json } from '../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const status = sp.get('status');           // 'unread' | null
  const type = sp.get('type');               // parts_zero / inspection_abnormal / trouble
  const limit = Math.min(Number(sp.get('limit')) || 50, 200);

  let sql = `SELECT * FROM notifications WHERE deleted_at IS NULL`;
  const binds = [];
  if (status === 'unread') sql += ` AND acknowledged_at IS NULL`;
  if (type) { sql += ` AND type = ?`; binds.push(type); }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE deleted_at IS NULL AND acknowledged_at IS NULL`)
    .first();

  return json({ notifications: results ?? [], unread_count: countRow?.n ?? 0 });
}
