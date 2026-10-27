import { requireRole } from '../_lib/auth.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { getAnnualFyState } from './index.js';

// 年間計画 年度末リセット
//   POST /api/plans/annual-reset
//     { fiscal_year: 2025（省略可・締める年度の確認用）, csv_snapshot: "..." }
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

// 全タスクの完了状態をまとめて消す操作のため管理者のみ（画面のボタンも admin にだけ出す）
//   締める年度はサーバーが決める（getAnnualFyState の resetTarget＝通常は最後にリセットした年度＋1）。
//   画面の時計で年度を決めると、10月に実行したとき始まったばかりの年度を締めた記録になっていた。
//   fiscal_year を送ってきた場合は、それが締める年度と一致しなければ 409（古い画面・二重実行）。
//   締める年度の最終月（9月）より前は締められない（10月にリセットした直後の2回目で、始まったばかりの
//   年度まで締めてしまうのを防ぐ）。
//   監査（戻す予定と変更前の状態）→ 予定を未実施へ → 履歴の登録 を1つの batch（トランザクション）で行う。
//   同じ年度の二重実行は plan_reset_log の UNIQUE(fiscal_year) で後の方が丸ごと失敗する。
export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { resetTarget: fiscalYear, resetAvailable } = await getAnnualFyState(db);
  if (body.fiscal_year != null && Number(body.fiscal_year) !== fiscalYear) {
    return jsonError(409, `年度リセットの対象は FY${fiscalYear} です（画面が古い可能性があります。再読み込みしてください）。`);
  }
  if (!resetAvailable) {
    return jsonError(409, `FY${fiscalYear} の年度リセットは ${fiscalYear + 1}年9月から実行できます（FY${fiscalYear - 1} はリセット済みです）。`);
  }

  const userEmail = data.user.email;
  const now = nowIso();
  // CSV スナップショット（リセット前の完了状態。画面から送られた場合のみ）
  const csvSnapshot = typeof body.csv_snapshot === 'string' ? body.csv_snapshot : null;
  const TARGET = `annual_only = 1 AND deleted_at IS NULL AND status != 'pending'`;

  let results;
  try {
    results = await db.batch([
      // 監査: 戻す予定のIDと変更前の状態（D1 の Time Travel を使わずに、誤操作時の確認・手動復旧ができるように）
      db.prepare(
        `INSERT INTO audit_log (table_name, record_id, action, changed_by, diff_json)
         SELECT 'maintenance_plan', 'annual_reset', 'update', ?1,
                json_object('fiscal_year', ?2, 'reset_count', COUNT(*),
                            'reset_plans', json_group_array(json_object('id', id, 'from', status)))
           FROM maintenance_plan WHERE ${TARGET}`
      ).bind(userEmail, fiscalYear),
      db.prepare(
        `UPDATE maintenance_plan SET status = 'pending', updated_by = ?1, updated_at = ?2 WHERE ${TARGET}`
      ).bind(userEmail, now),
      // changes() は直前の UPDATE で戻した件数
      db.prepare(
        `INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count, csv_snapshot)
         VALUES (?1, ?2, ?3, changes(), ?4)`
      ).bind(fiscalYear, now, userEmail, csvSnapshot),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) {
      return jsonError(409, `FY${fiscalYear} はリセット済みです。`);
    }
    return jsonError(500, `リセットに失敗しました: ${err.message}`);
  }
  const resetCount = results[1]?.meta?.changes ?? 0;
  return json({ ok: true, fiscal_year: fiscalYear, reset_count: resetCount, current_fiscal_year: fiscalYear + 1 });
}
