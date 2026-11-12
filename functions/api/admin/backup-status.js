// GET /api/admin/backup-status — 前回バックアップ（JSON／SQL）を取った日時と経過日数（admin のみ）
//   バックアップは月1回の手動ダウンロードで、取り忘れに気づく手段が無かった。
//   backup.js が監査ログに残した記録（table_name='backup'）の最新1件を返す。
//   overdue: 記録が無い、または BACKUP_REMIND_DAYS 日を超えた（管理者のホームに注意を出す）。
import { requireRole } from '../_lib/auth.js';
import { json } from '../_lib/http.js';
import { BACKUP_AUDIT_TABLE } from './backup.js';

export const BACKUP_REMIND_DAYS = 35; // 月1回＋数日の余裕

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const row = await env.DB
    .prepare(
      `SELECT a.changed_at, a.changed_by, a.diff_json, u.name AS user_name
         FROM audit_log a
         LEFT JOIN users u ON u.email = a.changed_by
        WHERE a.table_name = ?1 AND a.action = 'create'
        ORDER BY a.changed_at DESC, a.id DESC
        LIMIT 1`
    )
    .bind(BACKUP_AUDIT_TABLE)
    .first();

  if (!row) return json({ last: null, days_since: null, overdue: true, remind_days: BACKUP_REMIND_DAYS });

  let format = null;
  try { format = JSON.parse(row.diff_json || '{}').format || null; } catch { format = null; }
  const ms = Date.now() - Date.parse(row.changed_at);
  const days = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400_000)) : null;
  return json({
    last: { at: row.changed_at, by: row.user_name || row.changed_by, format },
    days_since: days,
    overdue: days === null || days > BACKUP_REMIND_DAYS,
    remind_days: BACKUP_REMIND_DAYS,
  });
}
