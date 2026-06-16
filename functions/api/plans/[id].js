import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];
const VALID_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

async function getPlan(db, id) {
  // 設備名・担当者名は予定に保存（自由入力）。旧FK用のJOINは廃止。
  return db.prepare(`
    SELECT p.*
    FROM maintenance_plan p
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).bind(id).first();
}

export async function onRequestGet({ params, env }) {
  const db = env.DB;
  const plan = await getPlan(db, params.id);
  if (!plan) return jsonError(404, '保全計画が見つかりません');
  return json({ plan });
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const id = params.id;

  const existing = await getPlan(db, id);
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  const body = await readJson(request);
  const now = nowIso();
  const userEmail = data.user.email;

  // 期間の整合性チェック（終了日 < 開始日 はエラー）
  const newStart = ('planned_date' in body) ? body.planned_date : existing.planned_date;
  const newEnd = ('planned_end_date' in body) ? body.planned_end_date : existing.planned_end_date;
  if (newEnd && newStart && newEnd < newStart) {
    return jsonError(400, '終了日は開始日以降にしてください');
  }

  const UPDATABLE = ['title', 'planned_date', 'planned_end_date', 'plan_type', 'line_name', 'equipment_name', 'assignee_name', 'status', 'note'];
  const TRIM_FIELDS = new Set(['title', 'line_name', 'equipment_name', 'assignee_name']);
  const setClauses = [];
  const binds = [];
  const diff = {};

  // recurrence_rule を個別処理（JSON文字列の正規化が必要）
  if ('recurrence_rule' in body) {
    let recRule = null;
    const rv = body.recurrence_rule;
    if (rv) {
      try {
        const parsed = typeof rv === 'string' ? JSON.parse(rv) : rv;
        if (!VALID_FREQS.includes(parsed.freq)) return jsonError(400, 'recurrence_rule.freq が不正です');
        const interval = Number(parsed.interval) || 1;
        const clean = { freq: parsed.freq, interval };
        if (parsed.until) clean.until = String(parsed.until);
        recRule = JSON.stringify(clean);
      } catch {
        return jsonError(400, 'recurrence_rule の形式が不正です');
      }
    }
    if (String(existing.recurrence_rule ?? '') !== String(recRule ?? '')) {
      diff['recurrence_rule'] = { from: existing.recurrence_rule, to: recRule };
    }
    setClauses.push('recurrence_rule = ?');
    binds.push(recRule);
  }

  for (const field of UPDATABLE) {
    if (!(field in body)) continue;
    let value = body[field];

    if (field === 'plan_type' && !PLAN_TYPES.includes(value)) {
      return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);
    }
    if (field === 'status' && !STATUSES.includes(value)) {
      return jsonError(400, `status は ${STATUSES.join('/')} のいずれかです`);
    }
    if (field === 'title' && (!value || !value.trim())) {
      return jsonError(400, 'title は必須です');
    }

    const oldValue = existing[field];
    const newValue = TRIM_FIELDS.has(field) ? (value?.trim() || null) : (value ?? null);
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      diff[field] = { from: oldValue, to: newValue };
    }
    setClauses.push(`${field} = ?`);
    binds.push(newValue);
  }

  if (setClauses.length === 0) return jsonError(400, '更新するフィールドがありません');

  setClauses.push('updated_by = ?', 'updated_at = ?');
  binds.push(userEmail, now, id);

  await db.prepare(`
    UPDATE maintenance_plan SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...binds).run();

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'maintenance_plan',
      recordId: String(id),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getPlan(db, id);
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  await db.prepare(`
    UPDATE maintenance_plan SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?
  `).bind(now, userEmail, now, userEmail, id).run();

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: String(id),
    action: 'delete',
    changedBy: userEmail,
    diff: { deleted_at: now },
  });

  return json({ ok: true });
}
