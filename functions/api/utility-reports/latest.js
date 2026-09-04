// 13 ユーティリティ日報 — 直近1件（入力画面の「前回値」表示用）
//   GET /api/utility-reports/latest?before=YYYY-MM-DD&exclude_id=N
//     before    … その日より前（同日は含まない）の直近1件
//     exclude_id… 編集時に自分自身を除外する
//   見つからないときは { report: null }（前回値なしで入力を続けられるようにする）

import { json, jsonError } from '../_lib/http.js';
import { ensureUtilitySchema } from './_schema.js';
import { toReport } from './_values.js';

export async function onRequestGet({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureUtilitySchema(db);

  const sp = new URL(request.url).searchParams;
  const before = sp.get('before');
  const excludeId = Number(sp.get('exclude_id')) || 0;

  let sql = `SELECT * FROM utility_report WHERE deleted_at IS NULL`;
  const binds = [];
  if (before) { sql += ` AND report_date < ?`; binds.push(before); }
  if (excludeId) { sql += ` AND id <> ?`; binds.push(excludeId); }
  sql += ` ORDER BY report_date DESC, id DESC LIMIT 1`;

  const row = await db.prepare(sql).bind(...binds).first();
  return json({ report: row ? toReport(row) : null });
}
