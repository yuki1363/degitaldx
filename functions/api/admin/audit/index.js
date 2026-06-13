import { requireRole } from '../../_lib/auth.js';
import { json } from '../../_lib/http.js';

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const table    = sp.get('table');
  const action   = sp.get('action');
  const user     = sp.get('user');
  const from     = sp.get('from');
  const to       = sp.get('to');
  const limit    = Math.min(Number(sp.get('limit')) || 100, 500);
  const offset   = Number(sp.get('offset')) || 0;

  let sql = `SELECT * FROM audit_log WHERE 1=1`;
  const binds = [];

  if (table)  { sql += ` AND table_name = ?`;  binds.push(table); }
  if (action) { sql += ` AND action = ?`;       binds.push(action); }
  if (user)   { sql += ` AND changed_by LIKE ?`; binds.push(`%${user}%`); }
  if (from)   { sql += ` AND changed_at >= ?`;  binds.push(from); }
  if (to)     { sql += ` AND changed_at <= ?`;  binds.push(to + 'T23:59:59Z'); }

  sql += ` ORDER BY changed_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const { results } = await db.prepare(sql).bind(...binds).all();

  let countSql = `SELECT COUNT(*) AS n FROM audit_log WHERE 1=1`;
  const countBinds = [];
  if (table)  { countSql += ` AND table_name = ?`; countBinds.push(table); }
  if (action) { countSql += ` AND action = ?`;      countBinds.push(action); }
  if (user)   { countSql += ` AND changed_by LIKE ?`; countBinds.push(`%${user}%`); }
  if (from)   { countSql += ` AND changed_at >= ?`; countBinds.push(from); }
  if (to)     { countSql += ` AND changed_at <= ?`; countBinds.push(to + 'T23:59:59Z'); }
  const total = await db.prepare(countSql).bind(...countBinds).first();

  return json({ logs: results ?? [], total: total?.n ?? 0, limit, offset });
}
