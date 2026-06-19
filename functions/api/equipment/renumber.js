// POST /api/equipment/renumber — 管理者専用: 設備番号を「設備ごとの連番 NN-MM」に振り直す
//   設備（line_name）を最初の登録順（min id）で 01,02,… に採番し、各設備の機器を
//   登録順（id）で 01,02,… の機器番号にする。例: 設備1=01-01,01-02 / 設備2=02-01。
//   UNIQUE 制約（論理削除済みも対象）と衝突しないよう、二段階更新＋削除済みコード退避を行う。
import { json } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

const CODE_RE = /^\d+-\d+$/;
const pad = (n) => String(n).padStart(2, '0');

export async function onRequestPost({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const now = nowIso();
  const userEmail = data.user.email;

  // 有効設備を登録順（id）で取得
  const { results: active } = await db.prepare(
    `SELECT id, code, line_name FROM equipment_ledger
      WHERE deleted_at IS NULL ORDER BY id ASC`
  ).all();
  if (!active || active.length === 0) {
    return json({ updated: 0, message: '設備が登録されていません。' });
  }

  // 設備（line_name）を「最初に登録された順」で並べ、機器を id 順でまとめる
  const order = [];                     // line_name の出現順
  const byLine = new Map();             // line_name -> [eq...]（id順）
  for (const eq of active) {
    const key = eq.line_name || '';
    if (!byLine.has(key)) { byLine.set(key, []); order.push(key); }
    byLine.get(key).push(eq);
  }

  // 最終コード NN-MM を計算（設備=出現順, 機器=id順）
  const finalCode = new Map();          // id -> "NN-MM"
  order.forEach((line, i) => {
    byLine.get(line).forEach((eq, j) => finalCode.set(eq.id, `${pad(i + 1)}-${pad(j + 1)}`));
  });

  // 削除済みで NN-MM 形式のコードは退避（有効設備の最終コードと衝突しないように）
  const { results: deleted } = await db.prepare(
    `SELECT id, code FROM equipment_ledger WHERE deleted_at IS NOT NULL`
  ).all();
  for (const d of deleted || []) {
    if (CODE_RE.test(d.code || '')) {
      await db.prepare('UPDATE equipment_ledger SET code = ?1 WHERE id = ?2')
        .bind(`DEL-${d.id}`, d.id).run();
    }
  }

  // 二段階更新: いったん一意な一時コードにしてから最終コードへ（途中の衝突を回避）
  for (const eq of active) {
    await db.prepare('UPDATE equipment_ledger SET code = ?1 WHERE id = ?2')
      .bind(`TMP-${eq.id}`, eq.id).run();
  }

  const updated = [];
  for (const eq of active) {
    const newCode = finalCode.get(eq.id);
    await db.prepare(
      'UPDATE equipment_ledger SET code = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4'
    ).bind(newCode, userEmail, now, eq.id).run();
    if (eq.code !== newCode) {
      updated.push({ id: eq.id, old_code: eq.code, new_code: newCode });
      await writeAuditLog(db, {
        tableName: 'equipment_ledger',
        recordId: eq.id,
        action: 'update',
        changedBy: userEmail,
        diff: { code: { before: eq.code, after: newCode } },
      });
    }
  }

  return json({ updated: updated.length, total: active.length });
}
