import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];
const VALID_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

// 繰り返し予定を指定範囲内に展開して返す
function expandRecurring(plan, rangeStart, rangeEnd) {
  let rule;
  try { rule = JSON.parse(plan.recurrence_rule); } catch { return []; }
  const { freq, interval = 1, until } = rule;
  if (!VALID_FREQS.includes(freq)) return [];

  const msDay = 86400000;
  const rStart = new Date(rangeStart + 'T00:00:00Z');
  const rEnd = new Date(rangeEnd + 'T00:00:00Z'); // exclusive
  const untilDate = until ? new Date(until + 'T00:00:00Z') : new Date('2099-12-31T00:00:00Z');
  let cur = new Date(plan.planned_date.slice(0, 10) + 'T00:00:00Z');

  // 範囲開始付近まで高速早送り（ループ回数を最小化）
  if (cur < rStart) {
    if (freq === 'daily') {
      const steps = Math.floor((rStart - cur) / (interval * msDay));
      cur.setUTCDate(cur.getUTCDate() + steps * interval);
    } else if (freq === 'weekly') {
      const steps = Math.floor((rStart - cur) / (interval * 7 * msDay));
      cur.setUTCDate(cur.getUTCDate() + steps * interval * 7);
    }
    // monthly/yearly はステップ数が少ないので単純ループ
    while (cur < rStart) advance();
  }

  function advance() {
    switch (freq) {
      case 'daily':   cur.setUTCDate(cur.getUTCDate() + interval); break;
      case 'weekly':  cur.setUTCDate(cur.getUTCDate() + interval * 7); break;
      case 'monthly': cur.setUTCMonth(cur.getUTCMonth() + interval); break;
      case 'yearly':  cur.setUTCFullYear(cur.getUTCFullYear() + interval); break;
    }
  }

  const instances = [];
  let guard = 0;
  while (cur < rEnd && cur <= untilDate && guard++ < 200) {
    instances.push({ ...plan, planned_date: cur.toISOString().slice(0, 10) });
    advance();
  }
  return instances;
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const month = sp.get('month');   // YYYY-MM
  const from  = sp.get('from');    // YYYY-MM-DD（週表示用）
  const to    = sp.get('to');      // YYYY-MM-DD exclusive
  // 実施月未定（年間計画表の「未定」枠）はカレンダー・月クエリでは除外し、
  // 年間計画表（include_unscheduled=1）でのみ返す
  const includeUnscheduled = sp.get('include_unscheduled') === '1';
  // annual_only=1: 年間計画表専用予定を「年に関係なく」全件返す（毎年共通のテンプレート）
  const annualOnly = sp.get('annual_only') === '1';

  // 年間計画表は毎年共通。年で絞らず annual_only の全件を返す
  if (annualOnly) {
    const { results: rows } = await db.prepare(`
      SELECT p.* FROM maintenance_plan p
      WHERE p.deleted_at IS NULL
      ORDER BY p.planned_date ASC, p.id ASC
    `).all();
    const plans = (rows ?? []).filter((p) => p.annual_only);
    return json({ plans });
  }

  let rangeStart, rangeEnd;

  if (month) {
    const [y, m] = month.split('-').map(Number);
    rangeStart = `${month}-01`;
    const nextMonthDate = new Date(Date.UTC(y, m, 1));
    rangeEnd = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
  } else if (from && to) {
    rangeStart = from;
    rangeEnd = to;
  }

  let results;

  if (rangeStart && rangeEnd) {
    // 非繰り返し: 範囲と重なるもの
    // 繰り返し  : 基準日が範囲終了より前（until 判定はJS側）
    const { results: rows } = await db.prepare(`
      SELECT p.*
      FROM maintenance_plan p
      WHERE p.deleted_at IS NULL
        AND (
          (p.recurrence_rule IS NULL
            AND p.planned_date < ?
            AND COALESCE(p.planned_end_date, p.planned_date) >= ?)
          OR
          (p.recurrence_rule IS NOT NULL AND p.planned_date < ?)
        )
      ORDER BY p.planned_date ASC, p.id ASC
    `).bind(rangeEnd, rangeStart, rangeEnd).all();

    const plans = [];
    for (const plan of rows ?? []) {
      if (!plan.recurrence_rule) {
        plans.push(plan);
      } else {
        plans.push(...expandRecurring(plan, rangeStart, rangeEnd));
      }
    }
    plans.sort((a, b) => a.planned_date.localeCompare(b.planned_date) || a.id - b.id);
    results = plans;
  } else {
    const { results: rows } = await db.prepare(`
      SELECT p.* FROM maintenance_plan p
      WHERE p.deleted_at IS NULL
      ORDER BY p.planned_date ASC, p.id ASC
    `).all();
    results = rows ?? [];
  }

  // 実施月未定（年間計画表の「未定」枠）はカレンダー・月クエリでは除外し、
  // include_unscheduled=1 のときだけ返す。
  // annual_only=1（年間計画表専用）も同様にカレンダーから除外する。
  // ※ JS側で除外することで、各列が未マイグレーションでもカレンダーは壊れない
  if (!includeUnscheduled) results = results.filter((p) => !p.unscheduled && !p.annual_only);

  return json({ plans: results });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const body = await readJson(request);

  const {
    title, planned_date, planned_end_date, plan_type,
    line_name, equipment_name, assignee_name, inspector_name, status, note,
    recurrence_rule, unscheduled,
  } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!planned_date) return jsonError(400, 'planned_date は必須です');
  if (!PLAN_TYPES.includes(plan_type)) return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);
  if (planned_end_date && planned_end_date < planned_date) {
    return jsonError(400, '終了日は開始日以降にしてください');
  }

  // recurrence_rule の検証・正規化
  let recRule = null;
  if (recurrence_rule) {
    try {
      const parsed = typeof recurrence_rule === 'string' ? JSON.parse(recurrence_rule) : recurrence_rule;
      if (!VALID_FREQS.includes(parsed.freq)) return jsonError(400, 'recurrence_rule.freq が不正です');
      const interval = Number(parsed.interval) || 1;
      const clean = { freq: parsed.freq, interval };
      if (parsed.until) clean.until = String(parsed.until);
      recRule = JSON.stringify(clean);
    } catch {
      return jsonError(400, 'recurrence_rule の形式が不正です');
    }
  }

  const resolvedStatus = STATUSES.includes(status) ? status : 'pending';
  const now = nowIso();
  const userEmail = data.user.email;

  // 列名は固定の許可リストのみ。inspector_name / unscheduled は値があるときだけ列に含める
  // （列を追加するマイグレーション前でも通常の登録が壊れないようにするため）。
  const cols = ['title', 'planned_date', 'planned_end_date', 'plan_type', 'line_name',
    'equipment_name', 'assignee_name', 'status', 'note', 'recurrence_rule'];
  const vals = [
    title.trim(),
    planned_date,
    planned_end_date ?? null,
    plan_type,
    line_name?.trim() || null,
    equipment_name?.trim() || null,
    assignee_name?.trim() || null,
    resolvedStatus,
    note ?? null,
    recRule,
  ];
  const inspector = inspector_name ? String(inspector_name).trim() : '';
  if (inspector) { cols.push('inspector_name'); vals.push(inspector); }
  if (unscheduled) { cols.push('unscheduled'); vals.push(1); }
  cols.push('created_by', 'created_at', 'updated_by', 'updated_at');
  vals.push(userEmail, now, userEmail, now);

  const placeholders = cols.map(() => '?').join(', ');
  const result = await db.prepare(
    `INSERT INTO maintenance_plan (${cols.join(', ')}) VALUES (${placeholders})`
  ).bind(...vals).run();

  const id = result.meta?.last_row_id;

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: String(id),
    action: 'create',
    changedBy: userEmail,
    diff: { title, planned_date, planned_end_date, plan_type, line_name, equipment_name, assignee_name, status: resolvedStatus, note, recurrence_rule: recRule },
  });

  return json({ id }, 201);
}
