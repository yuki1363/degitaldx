import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { normalizeFormValues } from './index.js';

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

  const UPDATABLE = ['title', 'planned_date', 'planned_end_date', 'plan_type', 'line_name', 'equipment_name', 'assignee_name', 'inspector_name', 'status', 'note', 'unscheduled', 'annual_only'];
  const TRIM_FIELDS = new Set(['title', 'line_name', 'equipment_name', 'assignee_name', 'inspector_name']);
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

  if (setClauses.length === 0 && !('form_values_json' in body) && !('on_calendar' in body)) {
    return jsonError(400, '更新するフィールドがありません');
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_by = ?', 'updated_at = ?');
    binds.push(userEmail, now, id);
    await db.prepare(`
      UPDATE maintenance_plan SET ${setClauses.join(', ')} WHERE id = ?
    `).bind(...binds).run();
  }

  // 帳票の入力値は別UPDATE（form_values_json 列が無い旧DBでも本体更新が壊れないように）
  if ('form_values_json' in body) {
    const fvj = normalizeFormValues(body.form_values_json);
    if (fvj.error) return jsonError(400, fvj.error);
    try {
      await db.prepare('UPDATE maintenance_plan SET form_values_json = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .bind(fvj.value, userEmail, now, id).run();
    } catch (err) {
      if (!/no such column/i.test(String(err?.message || ''))) throw err;
    }
  }

  // カレンダー表示フラグも別UPDATE（on_calendar 列が無い旧DBでも本体更新が壊れないように）
  if ('on_calendar' in body) {
    const v = body.on_calendar ? 1 : 0;
    try {
      await db.prepare('UPDATE maintenance_plan SET on_calendar = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .bind(v, userEmail, now, id).run();
      if (String(existing.on_calendar ?? '') !== String(v)) diff['on_calendar'] = { from: existing.on_calendar, to: v };
    } catch (err) {
      if (!/no such column/i.test(String(err?.message || ''))) throw err;
    }
  }

  // 年間計画タスクの完了は「年ごと」に記録する（毎年共通テンプレートの当年の実施状況）。
  // status を変更したとき、annual_only の予定なら annual_plan_status にも反映する。
  // 対象年は annual_year（年間計画表の表示年）。未指定なら現在の年。
  if ('status' in body && existing.annual_only) {
    const yr = Number.isInteger(Number(body.annual_year)) ? Number(body.annual_year) : new Date().getUTCFullYear();
    const st = STATUSES.includes(body.status) ? body.status : 'pending';
    try {
      await db.prepare(
        `INSERT INTO annual_plan_status (plan_id, year, status, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(plan_id, year) DO UPDATE SET status = ?3, updated_by = ?4, updated_at = ?5`
      ).bind(id, yr, st, userEmail, now).run();
      diff['annual_status'] = { year: yr, to: st };
    } catch (err) {
      if (!/no such table/i.test(String(err?.message || ''))) throw err;
    }
  }

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'maintenance_plan',
      recordId: String(id),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  // 同期: カレンダー登録元（年間計画タスク）がある予定を「完了」にしたら、登録元も完了にする
  if (body.status === 'done' && existing.source_plan_id) {
    try {
      const r = await db.prepare(
        `UPDATE maintenance_plan SET status='done', updated_by=?, updated_at=?
           WHERE id=? AND deleted_at IS NULL AND status != 'done'`
      ).bind(userEmail, now, existing.source_plan_id).run();
      if (r.meta?.changes > 0) {
        await writeAuditLog(db, {
          tableName: 'maintenance_plan',
          recordId: String(existing.source_plan_id),
          action: 'update',
          changedBy: userEmail,
          diff: { status: 'done', synced_from: String(id) },
        });
      }
    } catch (err) {
      if (!/no such column/i.test(String(err?.message || ''))) throw err;
    }
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
