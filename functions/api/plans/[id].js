import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson, checkEditConflict } from '../_lib/http.js';
import { nowIso, isValidYmd } from '../_lib/util.js';
import { linkRowToEquipment, describeEquipmentLink } from '../_lib/equipment-link.js';
import { normalizeFormValues, deriveOverdue, getAnnualFyState } from './index.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];

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
  // 一覧GETと同じく、期限を過ぎた pending は「期限超過」として返す（表示の一貫性）
  const fy = plan.annual_only ? (await getAnnualFyState(db)).current : undefined;
  // 設備台帳との紐づけ状況（画面に「どの設備に紐づいているか」を出すため）
  const link = await describeEquipmentLink(db, plan);
  // 変更履歴（他機能の詳細画面と同じ表示方式。共通監査設計）
  const { results: history } = await db.prepare(
    `SELECT action, changed_by, changed_at, diff_json
       FROM audit_log
      WHERE table_name = 'maintenance_plan' AND record_id = ?1
      ORDER BY changed_at DESC, id DESC
      LIMIT 20`
  ).bind(String(plan.id)).all();
  return json({
    plan: deriveOverdue(plan, { fy }),
    equipment_link: link.equipment,
    equipment_status: link.status,
    history: history ?? [],
  });
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const id = params.id;

  const existing = await getPlan(db, id);
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');
  const conflict = checkEditConflict(body, existing);
  if (conflict) return conflict; // 同時編集ガード
  const now = nowIso();
  const userEmail = data.user.email;

  // 日付の形式チェック（存在しない日付・文字列を保存しない）
  if ('planned_date' in body && !isValidYmd(body.planned_date)) return jsonError(400, 'planned_date は YYYY-MM-DD の実在する日付で指定してください');
  if ('planned_end_date' in body && body.planned_end_date && !isValidYmd(body.planned_end_date)) return jsonError(400, 'planned_end_date は YYYY-MM-DD の実在する日付で指定してください');

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

  // recurrence_rule（繰り返し予定）は廃止済み。ボディに含まれていても無視する
  // （画面側が送ってくる recurrence_rule: null で、過去に登録された値を黙って消していた不具合の修正。
  // 列自体は残っているので、旧データの値はそのまま触れずに残る＝1回だけの予定として扱われる）

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

  // 設備名・機器名を変えたときは、設備台帳との紐づけも入れ直す（失敗しても保存は止めない）
  if (setClauses.length > 0 && ('line_name' in body || 'equipment_name' in body)) {
    await linkRowToEquipment(db, 'maintenance_plan', id);
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
