// POST /api/admin/masters/restore — マスタ変更履歴（master_history）からの復元（admin）
//   body: { history_id }
//   スナップショット時点の内容へレコードを戻す。削除済みなら復活、
//   レコード自体が消えていれば同じIDで再作成する。
//   復元前の現在値も master_history に保存するため、復元の取り消しも可能。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

// 復元対応マスタと、スナップショットから書き戻してよい列の許可リスト
// （テーブル名・列名はこの定義からのみ使用する。リクエスト値を SQL に直接使わない）
const MASTERS = {
  trouble_category:     ['name', 'sort_order'],
  report_category:      ['name', 'sort_order'],
  inspection_master:    ['equipment_id', 'name', 'input_type', 'unit', 'min_value', 'max_value', 'options_json', 'sort_order'],
  trouble_custom_field: ['name', 'input_type', 'options_json', 'sort_order'],
};

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const historyId = Number(body?.history_id);
  if (!historyId) return jsonError(400, 'history_id は必須です');

  const hist = await db.prepare(`SELECT * FROM master_history WHERE id = ?`).bind(historyId).first();
  if (!hist) return jsonError(404, '履歴が見つかりません');

  const cols = MASTERS[hist.master_name];
  if (!cols) return jsonError(400, `このマスタは復元に対応していません: ${hist.master_name}`);
  if (hist.record_id == null) return jsonError(400, 'レコード単位の履歴のみ復元できます');

  let snap;
  try {
    snap = JSON.parse(hist.snapshot_json);
  } catch {
    return jsonError(500, 'スナップショットの読み込みに失敗しました');
  }

  // trouble_category の履歴は「当時の全行スナップショット（配列）」形式のため、
  // 対象レコードの行を取り出して単一行スナップショットとして扱う
  if (Array.isArray(snap)) {
    snap = snap.find((row) => Number(row?.id) === Number(hist.record_id));
    if (!snap) return jsonError(400, 'スナップショット内に対象レコードが見つかりません');
  }

  const present = cols.filter((c) => c in snap);
  if (present.length === 0) return jsonError(400, '復元できる項目がありません');

  const table = hist.master_name; // MASTERS のキー = テーブル名（許可リスト由来のため安全）
  const now = nowIso();
  const userEmail = data.user.email;

  const current = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(hist.record_id).first();

  if (current) {
    // 復元の取り消しができるよう、復元前の現在値をスナップショット
    await writeMasterHistory(db, { masterName: table, recordId: hist.record_id, snapshot: current, changedBy: userEmail });

    const sets = present.map((c) => `${c} = ?`).join(', ');
    await db.prepare(
      `UPDATE ${table}
          SET ${sets}, deleted_by = NULL, deleted_at = NULL, updated_by = ?, updated_at = ?
        WHERE id = ?`
    ).bind(...present.map((c) => snap[c]), userEmail, now, hist.record_id).run();
  } else {
    const placeholders = ['?', ...present.map(() => '?'), '?', '?', '?', '?'].join(', ');
    await db.prepare(
      `INSERT INTO ${table} (id, ${present.join(', ')}, created_by, created_at, updated_by, updated_at)
       VALUES (${placeholders})`
    ).bind(
      hist.record_id,
      ...present.map((c) => snap[c]),
      snap.created_by || userEmail,
      snap.created_at || now,
      userEmail,
      now
    ).run();
  }

  await writeAuditLog(db, {
    tableName: table,
    recordId: hist.record_id,
    action: 'restore',
    changedBy: userEmail,
    diff: { restored_from_history_id: historyId },
  });

  return json({ ok: true });
}
