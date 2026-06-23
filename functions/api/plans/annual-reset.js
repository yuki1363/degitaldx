import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

// 年間計画 年度末リセット
//   POST /api/plans/annual-reset
//     { fiscal_year: 2025, csv_snapshot: "..." }
//   → annual_only=1 の全予定を status='pending' にリセットし、
//     plan_reset_log に CSV スナップショットを保存する。
//   GET /api/plans/annual-reset
//     → 過去のリセット履歴（csv_snapshot は除いて返す）
//   GET /api/plans/annual-reset?fiscal_year=2025&csv=1
//     → 指定年度の CSV スナップショットを返す

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const fy = Number(sp.get('fiscal_year'));
  const wantCsv = sp.get('csv') === '1';

  if (fy && wantCsv) {
    let row;
    try {
      row = await db.prepare(
        'SELECT csv_snapshot FROM plan_reset_log WHERE fiscal_year = ?'
      ).bind(fy).first();
    } catch {
      return jsonError(500, 'リセット履歴の取得に失敗しました。');
    }
    if (!row) return jsonError(404, '指定年度のリセット履歴が見つかりません。');
    return new Response(row.csv_snapshot || '', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="annual_plan_FY${fy}.csv"`,
      },
    });
  }

  let logs;
  try {
    ({ results: logs } = await db.prepare(
      'SELECT id, fiscal_year, reset_at, reset_by, plan_count FROM plan_reset_log ORDER BY fiscal_year DESC LIMIT 20'
    ).all());
  } catch {
    logs = [];
  }
  return json({ logs: logs ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const fiscalYear = Number(body.fiscal_year);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
    return jsonError(400, 'fiscal_year が不正です（例: 2025）。');
  }

  // 既にリセット済みかチェック
  let existing;
  try {
    existing = await db.prepare('SELECT id FROM plan_reset_log WHERE fiscal_year = ?').bind(fiscalYear).first();
  } catch {
    existing = null;
  }
  if (existing && !body.force) {
    return jsonError(409, `FY${fiscalYear} はリセット済みです。再実行するには force:true を指定してください。`);
  }

  const userEmail = data.user.email;
  const now = nowIso();

  // annual_only=1 の全予定を pending にリセット
  let resetCount = 0;
  try {
    const result = await db.prepare(
      `UPDATE maintenance_plan SET status = 'pending', updated_by = ?, updated_at = ?
       WHERE annual_only = 1 AND deleted_at IS NULL AND status != 'pending'`
    ).bind(userEmail, now).run();
    resetCount = result.meta?.changes ?? 0;
  } catch (err) {
    return jsonError(500, `リセットに失敗しました: ${err.message}`);
  }

  // CSV スナップショットを保存（クライアントから送ってくれた場合）
  const csvSnapshot = typeof body.csv_snapshot === 'string' ? body.csv_snapshot : null;

  try {
    if (existing) {
      await db.prepare(
        `UPDATE plan_reset_log SET reset_at = ?, reset_by = ?, plan_count = ?, csv_snapshot = ? WHERE fiscal_year = ?`
      ).bind(now, userEmail, resetCount, csvSnapshot, fiscalYear).run();
    } else {
      await db.prepare(
        `INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count, csv_snapshot)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(fiscalYear, now, userEmail, resetCount, csvSnapshot).run();
    }
  } catch {
    // ログ保存失敗はリセット自体は完了しているため警告に留める
  }

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: 'annual_reset',
    action: 'update',
    changedBy: userEmail,
    diff: { fiscal_year: fiscalYear, reset_count: resetCount },
  });

  return json({ ok: true, fiscal_year: fiscalYear, reset_count: resetCount });
}
