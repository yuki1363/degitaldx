import { requireRole } from '../_lib/auth.js';
import { writeAuditLog, auditStatement } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];
const VALID_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

// 期限超過の自動判定（表示専用）: pending のまま予定日（期間予定は終了日）を過ぎた予定を
// overdue として返す。DB の status は書き換えない（完了にすれば done になる）。
// 手動で overdue にしなくても、カレンダー・年間計画表・CSV出力で「期限超過」になる。
// 日付は JST 基準（UTC のままだと朝9時まで前日扱いになり判定が1日近く遅れる）。
//
// 年間計画（毎月1日に登録＝月単位で管理）は「月単位」で判定する。日単位だと予定月の
// 2日以降に当月分が誤って超過になるため（home-tabs.js と同じ考え方）。当月中は超過にしない
// （月末までにやる扱い）。monthly を明示指定できるが、未指定なら plan.annual_only で自動判定。
//   ※ 呼び出しは必ず (p) => deriveOverdue(p, …) の形にする。map に直接渡すと第2引数に配列の index が入る。
//   年間計画は「毎年共通のテンプレート」で、planned_date の年は登録した年のまま残る。年込みで
//   比べると、年度リセットで未実施に戻した直後に前年度の月がすべて超過になる（通知も一斉に出る）
//   ため、予定の「月」を今の年間計画の会計年度（opts.fy）に当てはめて判定する（annualMonthInFy）。
//   opts.fy は getAnnualFyState(db).current（＝最後に年度リセットした年度＋1）。省略時は時計の年度。
export function deriveOverdue(plan, opts = {}) {
  if (!plan || plan.status !== 'pending' || plan.unscheduled) return plan;
  const limit = (plan.planned_end_date || plan.planned_date || '').slice(0, 10);
  if (!limit) return plan;
  const isMonthly = opts.monthly ?? !!plan.annual_only;
  const nowJst = new Date(Date.now() + 9 * 3600_000).toISOString();
  if (isMonthly) {
    const nowYm = nowJst.slice(0, 7);
    const fy = opts.fy ?? clockFiscalYear(nowYm);
    return annualMonthInFy(limit, fy) < nowYm ? { ...plan, status: 'overdue' } : plan;
  }
  return limit < nowJst.slice(0, 10) ? { ...plan, status: 'overdue' } : plan;
}

// 会計年度の開始月（10月始まり9月終わり。FY2026 = 2026/10〜2027/09）
export const FISCAL_YEAR_START_MONTH = 10;

// 年月（YYYY-MM）が属する会計年度（開始年）
export function clockFiscalYear(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m >= FISCAL_YEAR_START_MONTH ? y : y - 1;
}

// 年間計画の予定日（YYYY-MM-DD）の「月」を、会計年度 fy の年月に当てはめる。
// 例: FY2026（2026/10〜2027/09）なら、5月の予定は 2027-05、10月の予定は 2026-10。
export function annualMonthInFy(dateStr, fy) {
  const m = Number(String(dateStr).slice(5, 7));
  const year = m >= FISCAL_YEAR_START_MONTH ? fy : fy + 1;
  return `${year}-${String(m).padStart(2, '0')}`;
}

// 年間計画の会計年度（「年度リセットで年度を進める」方式）
//   年間計画の完了状態は年度リセットで未実施に戻すまで前年度のもの。時計で年度を切り替えると、
//   リセット前に前年度の未実施が超過表示から消え、リセットを忘れても気づけなかった。そのため
//   current（＝完了状態が属する年度・期限超過の判定に使う年度）は「最後にリセットした年度＋1」とする。
//     ・リセット履歴が無い（導入直後）なら時計の年度
//     ・時計の年度＋1 より先には進めない（9月中に前倒しでリセットした場合が＋1）
//   resetTarget は次に「🔁 年度リセット」で締める年度。通常は current と同じ。履歴が無いときだけ、
//   10〜12月のリセットは「終わったばかりの前年度」を締める扱いにする（10月に実行すると時計の年度＝
//   始まったばかりの年度を締めた記録になっていた）。
//   resetAvailable: 締める年度の最終月（9月）以降だけ true。10月にリセットした直後に、もう一度押して
//   始まったばかりの年度まで締めてしまうのを防ぐ。
// 旧画面の誤記録の見分け方: 旧画面は年度リセットの年度を端末の時計から決めていたため、10月以降に押すと
//   「始まったばかりの年度」＝実行日の属する年（JST）を記録していた（正しくはその前の年度）。
//   新しい画面ではこの組み合わせ（10〜12月に実行・年度＝実行年）は作られない
//   （締める年度の9月より前は実行できないため）ので、これに当てはまる行は旧画面の誤記録と判断できる。
const LEGACY_RESET_LOG_SIG =
  `CAST(strftime('%Y', reset_at, '+9 hours') AS INTEGER) = fiscal_year
   AND CAST(strftime('%m', reset_at, '+9 hours') AS INTEGER) >= ${FISCAL_YEAR_START_MONTH}`;

// 旧画面の誤記録を1つ前の年度に直す（1回だけ・監査ログ付き）。1つ前の年度の行が既にあるときは
// 重複（UNIQUE）になるため直さない（その行は読み取り時に補正して扱う）。
let legacyResetLogChecked = false;
async function repairLegacyResetLog(db) {
  if (legacyResetLogChecked) return;
  try {
    for (let pass = 0; pass < 5; pass++) { // 連続して誤記録がある場合に備えて古い方から順に直す
      const { results } = await db.prepare(
        `SELECT id, fiscal_year, reset_at FROM plan_reset_log
          WHERE ${LEGACY_RESET_LOG_SIG}
            AND NOT EXISTS (SELECT 1 FROM plan_reset_log o WHERE o.fiscal_year = plan_reset_log.fiscal_year - 1)`
      ).all();
      if (!results?.length) break;
      for (const r of results) {
        await db.batch([
          db.prepare(
            `UPDATE plan_reset_log SET fiscal_year = fiscal_year - 1
              WHERE id = ?1 AND fiscal_year = ?2
                AND NOT EXISTS (SELECT 1 FROM plan_reset_log o WHERE o.fiscal_year = ?2 - 1)`
          ).bind(r.id, r.fiscal_year),
          auditStatement(db, {
            tableName: 'plan_reset_log', recordId: r.id, action: 'update', changedBy: 'system:legacy-fy-fix',
            diff: {
              fiscal_year: { from: r.fiscal_year, to: r.fiscal_year - 1 },
              reset_at: r.reset_at,
              reason: '旧画面が10月以降のリセットで始まったばかりの年度を記録していたため、1つ前の年度に補正',
            },
          }, { ifPrevChanged: true }),
        ]);
      }
    }
    legacyResetLogChecked = true;
  } catch { /* plan_reset_log が無い旧DB等は何もしない（次回また試す） */ }
}

export async function getAnnualFyState(db) {
  const nowYm = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  const clockFy = clockFiscalYear(nowYm);
  let last = null;
  try {
    await repairLegacyResetLog(db);
    // 直せなかった旧誤記録（1つ前の年度の行と重複する場合）も、ここで1つ前の年度として数える
    const row = await db.prepare(
      `SELECT MAX(CASE WHEN ${LEGACY_RESET_LOG_SIG} THEN fiscal_year - 1 ELSE fiscal_year END) AS fy FROM plan_reset_log`
    ).first();
    last = row?.fy == null ? null : Number(row.fy);
  } catch { /* plan_reset_log が無い旧DBは履歴なし扱い */ }
  if (last == null) {
    const m = Number(nowYm.slice(5, 7));
    const resetTarget = (m >= FISCAL_YEAR_START_MONTH && m <= FISCAL_YEAR_START_MONTH + 2) ? clockFy - 1 : clockFy;
    return { current: clockFy, resetTarget, lastReset: null, clockFy, resetAvailable: nowYm >= `${resetTarget + 1}-09` };
  }
  const current = Math.min(last + 1, clockFy + 1);
  return { current, resetTarget: current, lastReset: last, clockFy, resetAvailable: nowYm >= `${current + 1}-09` };
}

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

// 年間計画表からの一括登録（/api/plans/batch）で作られた予定のID集合を返す。
// 監査ログの diff に batch:true が残るため、登録日（1日以外でも）に依存せず判定できる。
// → annual_only 列の導入前に登録した「旧年間計画」を確実に復元するための手がかり。
// 旧形式の年間計画（annual_only 列が入る前に一括登録した予定）の ID。audit_log の batch 署名で見分ける
export async function getBatchPlanIds(db) {
  try {
    const { results } = await db.prepare(`
      SELECT record_id FROM audit_log
      WHERE table_name = 'maintenance_plan' AND action = 'create'
        AND diff_json LIKE '%"batch":true%'
    `).all();
    return new Set((results ?? []).map((r) => String(r.record_id)));
  } catch {
    return new Set(); // audit_log 参照に失敗しても通常表示は続行
  }
}

// maintenance_plan への INSERT。annual_only / unscheduled / inspector_name など、
// マイグレーション前のDBに存在しない列が混じっていても登録が壊れないよう、
// 「no such column」を検出したらその列を外して再試行する。
// 列名は固定の許可リスト由来でユーザー入力を含まないため安全。
export async function insertMaintenancePlan(db, cols, vals) {
  let c = [...cols];
  let v = [...vals];
  for (let attempt = 0; attempt < 6; attempt++) {
    const placeholders = c.map(() => '?').join(', ');
    try {
      return await db.prepare(
        `INSERT INTO maintenance_plan (${c.join(', ')}) VALUES (${placeholders})`
      ).bind(...v).run();
    } catch (err) {
      // SQLite の列不足エラーは "has no column named X"（INSERT）/ "no such column: X"（SELECT）の
      // 2形式があるため両方に対応し、該当列を外して再試行する。
      const msg = String(err?.message || '');
      const m = /(?:has no column named|no such column):?\s*([A-Za-z_]\w*)/i.exec(msg);
      const idx = m ? c.indexOf(m[1]) : -1;
      if (idx === -1) throw err; // 列不足以外のエラーはそのまま投げる
      c.splice(idx, 1);
      v.splice(idx, 1);
    }
  }
  throw new Error('予定の登録に失敗しました（列の不一致）。');
}

// 予定の INSERT 文を「実行せずに」返す（D1 の batch に入れて、他の書き込みと1トランザクションにする用）。
//   dropCols に入っている列は外す（未マイグレーション環境で列が無いとき。runPlanBatch が使う）。
//   ifPrevChanged: true なら「直前の文がちょうど1行を変えたときだけ」登録する（changes() = 1。
//   guardedPlanUpdate を先頭に置いた連鎖で、競合したときに何も作らないために使う）。
export function insertMaintenancePlanStatement(db, cols, vals, dropCols = new Set(), { ifPrevChanged = false } = {}) {
  const c = [], v = [];
  cols.forEach((col, i) => { if (!dropCols.has(col)) { c.push(col); v.push(vals[i]); } });
  const cond = ifPrevChanged ? ' WHERE changes() = 1' : '';
  return db.prepare(
    `INSERT INTO maintenance_plan (${c.join(', ')}) SELECT ${c.map(() => '?').join(', ')}${cond}`
  ).bind(...v);
}

// build(dropCols) が返す文の配列を D1 の batch（1トランザクション）で実行する。途中で失敗すれば
// 全部取り消されるので「期間を詰めたのに後半の予定が作られない」等の中途半端な状態が残らない。
// 未マイグレーション環境の「列が無い」エラーは、その列を外して batch ごと再試行する
// （insertMaintenancePlan の1件ずつの再試行と同じ考え方。batch は全体が巻き戻るので再試行して安全）。
export async function runPlanBatch(db, build) {
  const dropCols = new Set();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.batch(build(dropCols));
    } catch (err) {
      const msg = String(err?.message || err?.cause?.message || '');
      const m = /(?:has no column named|no such column):?\s*([A-Za-z_]\w*)/i.exec(msg);
      if (!m || dropCols.has(m[1])) throw err;
      dropCols.add(m[1]);
    }
  }
  throw new Error('予定の登録に失敗しました（列の不一致）。');
}

// 期間予定を分割する操作（1日だけ削除・完了）の先頭に置く、条件付きの UPDATE 文。
//   「読み取った時点の日程・状態のまま」のときだけ元の予定を書き換える（setSql の内容）。
//   同じ予定への同時操作（ボタンの2回押し・2人が同時に操作）は、先に実行された側が日程か状態を
//   変えるため、後の側はこの文が0件更新になる。後続の文は ifPrevChanged（changes() = 1）で連鎖させ、
//   0件なら何も作らない（完了済みの単日レコードが2件できる等を防ぐ）。呼び出し側は results[0] の
//   changes が 0 なら 409 を返す。updated_at（秒精度）での比較は同じ秒の2回押しを防げないため使わない。
export function guardedPlanUpdate(db, plan, setSql, setBinds) {
  return db.prepare(
    `UPDATE maintenance_plan SET ${setSql}
      WHERE id = ? AND deleted_at IS NULL AND status = ? AND planned_date = ? AND planned_end_date IS ?`
  ).bind(...setBinds, plan.id, plan.status, plan.planned_date, plan.planned_end_date ?? null);
}

export const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 期間予定を分割するとき、新しいレコードに引き継ぐ列と値を組み立てる
// （id・監査列・日付は個別に指定）。POST /api/plans の登録時と同じ列セット
// （旧FKの equipment_id/assignee_id は含めない）。
// overrideStatus を指定すると status 列だけ元の予定と変えて登録する
// （例: 1日だけ完了にする → その日の新レコードだけ 'done' にする）。
export function buildCloneColumns(plan, userEmail, now, newStart, newEnd, overrideStatus) {
  const cols = ['title', 'planned_date', 'planned_end_date', 'plan_type', 'line_name',
    'equipment_name', 'assignee_name', 'status', 'note', 'recurrence_rule'];
  const vals = [
    plan.title, newStart, newEnd, plan.plan_type, plan.line_name,
    plan.equipment_name, plan.assignee_name, overrideStatus ?? plan.status, plan.note, plan.recurrence_rule,
  ];
  if (plan.inspector_name) { cols.push('inspector_name'); vals.push(plan.inspector_name); }
  if (plan.unscheduled) { cols.push('unscheduled'); vals.push(plan.unscheduled); }
  if (plan.annual_only) { cols.push('annual_only'); vals.push(plan.annual_only); }
  if (plan.form_values_json != null) { cols.push('form_values_json'); vals.push(plan.form_values_json); }
  if (plan.source_plan_id != null) { cols.push('source_plan_id'); vals.push(plan.source_plan_id); }
  if (plan.on_calendar) { cols.push('on_calendar'); vals.push(plan.on_calendar); }
  // 工事連絡書の印刷日も引き継ぐ（分割で後半が「未印刷」になり、未印刷リマインドが誤って出ないように）
  if (plan.printed_at) { cols.push('printed_at', 'printed_by'); vals.push(plan.printed_at, plan.printed_by ?? null); }
  cols.push('created_by', 'created_at', 'updated_by', 'updated_at');
  vals.push(userEmail, now, userEmail, now);
  return { cols, vals };
}

// 帳票の入力値（{タグ名:値} のJSON）を検証・正規化する。
//   戻り値: { value: 文字列|null } または { error }
export function normalizeFormValues(raw) {
  if (raw == null || raw === '') return { value: null };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { value: JSON.stringify(raw) };
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return { value: JSON.stringify(o) };
    } catch { /* 落ちる */ }
  }
  return { error: 'form_values_json が不正です（オブジェクトJSONで指定してください）' };
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

  // 年間計画表は毎年共通（タスクは年に関係なく全件）。
  // ステータスは maintenance_plan.status を直接使う（annual_plan_status は廃止）。
  // 会計年度末（9月）に /api/plans/annual-reset でリセットし、CSV 履歴を保存する。
  if (annualOnly) {
    const { results: rows } = await db.prepare(`
      SELECT p.* FROM maintenance_plan p
      WHERE p.deleted_at IS NULL
      ORDER BY p.planned_date ASC, p.id ASC
    `).all();
    const batchIds = await getBatchPlanIds(db);
    const plans = (rows ?? []).filter((p) => p.annual_only || batchIds.has(String(p.id)));
    // 年間計画表は月単位で超過判定する（毎月1日登録・当月は超過にしない）。
    // batch由来で annual_only 列が無い予定もあるため monthly=true を明示する。
    const fyState = await getAnnualFyState(db);
    return json({
      plans: plans.map((p) => deriveOverdue(p, { monthly: true, fy: fyState.current })),
      // 年間計画表の既定表示年度（完了状態が属する年度）と、年度リセットで締める年度
      fiscal_year: fyState.current,
      reset_target_fy: fyState.resetTarget,
      last_reset_fy: fyState.lastReset,
      clock_fiscal_year: fyState.clockFy,
      reset_available: fyState.resetAvailable,
    });
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
  // annual_only=1（年間計画表専用）と、一括登録された年間計画（batch 署名）も
  // 同様にカレンダーから除外する（annual_only 列が未マイグレーションの旧データ対策）。
  // ※ JS側で除外することで、各列が未マイグレーションでもカレンダーは壊れない
  if (!includeUnscheduled) {
    const batchIds = await getBatchPlanIds(db);
    results = results.filter((p) => {
      if (p.unscheduled) return false;
      // 年間計画の予定でも on_calendar=1 なら、その planned_date でカレンダーに表示する
      if (p.on_calendar) return true;
      return !p.annual_only && !batchIds.has(String(p.id));
    });
  }

  // 通常カレンダーは日単位で判定（annual_only の on_calendar 予定だけは月単位に自動フォールバック）
  const fy = results.some((p) => p.annual_only) ? (await getAnnualFyState(db)).current : undefined;
  return json({ plans: results.map((p) => deriveOverdue(p, { fy })) });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const body = await readJson(request);

  const {
    title, planned_date, planned_end_date, plan_type,
    line_name, equipment_name, assignee_name, inspector_name, status, note,
    recurrence_rule, unscheduled, annual_only, on_calendar,
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
  // annual_only=1（年間計画表の＋追加など）。未マイグレーション環境では
  // insertMaintenancePlan が列を外して再試行する（年間計画表には batch/1日付で復元される）。
  if (annual_only) { cols.push('annual_only'); vals.push(1); }
  // on_calendar=1（年間計画の予定をカレンダーにも表示）。列が無い旧DBでは insert が外して再試行する
  if (on_calendar) { cols.push('on_calendar'); vals.push(1); }
  // 帳票の入力値（列が無い旧DBでは insertMaintenancePlan が外して再試行する）
  const fvj = normalizeFormValues(body.form_values_json);
  if (fvj.error) return jsonError(400, fvj.error);
  if (fvj.value != null) { cols.push('form_values_json'); vals.push(fvj.value); }
  // カレンダー登録元（年間計画タスク）のID。列が無い旧DBでは insert が外して再試行する
  const srcId = Number(body.source_plan_id);
  if (Number.isInteger(srcId) && srcId > 0) { cols.push('source_plan_id'); vals.push(srcId); }
  cols.push('created_by', 'created_at', 'updated_by', 'updated_at');
  vals.push(userEmail, now, userEmail, now);

  const result = await insertMaintenancePlan(db, cols, vals);

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
