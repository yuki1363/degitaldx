import { requireRole } from '../../_lib/auth.js';
import { json } from '../../_lib/http.js';

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const masterName = sp.get('master_name');
  const limit      = Math.min(Number(sp.get('limit')) || 100, 500);

  let sql = `SELECT * FROM master_history WHERE 1=1`;
  const binds = [];
  if (masterName) { sql += ` AND master_name = ?`; binds.push(masterName); }
  sql += ` ORDER BY changed_at DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();

  const { results: names } = await db.prepare(
    `SELECT DISTINCT master_name FROM master_history ORDER BY master_name`
  ).all();

  return json({ history: results ?? [], master_names: (names ?? []).map((r) => r.master_name) });
}
