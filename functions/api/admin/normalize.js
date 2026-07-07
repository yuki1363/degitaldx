// POST /api/admin/normalize — 既存データの表記ゆれを一括正規化（admin のみ）
//   設備台帳・部品在庫・保全計画の名称系テキストを NFKC 正規化する
//   （半角カナ→全角カナ・全角英数→半角 等）。検索・一覧表示のゆれを解消する。
//   ・NFKC は冪等なので、何度実行しても安全（変化のある行だけ更新）。
//   ・code / part_no（一意キー）は衝突回避のため対象外。
//   ・対象テーブル・列は固定の許可リストのみ（リクエスト値を SQL に使わない）。

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { normalizeJa } from '../_lib/normalize.js';

const TARGETS = [
  { table: 'equipment_ledger', cols: ['name', 'line_name', 'equipment_name', 'location', 'manufacturer', 'model', 'note'] },
  { table: 'parts_inventory',  cols: ['model_no', 'name', 'line_name', 'equipment_name', 'location', 'supplier', 'note'] },
  { table: 'maintenance_plan', cols: ['title', 'line_name', 'equipment_name', 'note'] },
];

export async function onRequestPost({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const now = nowIso();
  const email = data.user.email;
  const summary = {};

  for (const { table, cols } of TARGETS) {
    let scanned = 0;
    let updated = 0;
    try {
      // 列名・テーブル名は固定の許可リスト由来（ユーザー入力ではない）
      const rows = (await db.prepare(
        `SELECT id, ${cols.join(', ')} FROM ${table} WHERE deleted_at IS NULL`
      ).all()).results;
      for (const r of rows ?? []) {
        scanned++;
        const sets = [];
        const binds = [];
        for (const c of cols) {
          const orig = r[c];
          if (orig == null) continue;
          const norm = normalizeJa(orig);
          if (norm !== orig) { sets.push(`${c} = ?`); binds.push(norm); }
        }
        if (sets.length === 0) continue;
        binds.push(email, now, r.id);
        await db.prepare(
          `UPDATE ${table} SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`
        ).bind(...binds).run();
        updated++;
      }
      summary[table] = { scanned, updated };
    } catch (e) {
      // 列が無い等の環境ではその表だけスキップ（他表の正規化は続行）
      summary[table] = { skipped: String((e && e.message) || e) };
    }
  }

  await writeAuditLog(db, {
    tableName: 'normalize', recordId: 'bulk', action: 'update',
    changedBy: email, diff: summary,
  });
  return json({ ok: true, result: summary });
}
