import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso, likeContains, LIKE_ESCAPE, isValidYmd } from '../_lib/util.js';
import { beginIdempotent, dedupeStatement, isDedupeConflict, resolveRaceDuplicate, DEDUPE_CONFLICT_MESSAGE } from '../_lib/request-dedupe.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const categoryId  = sp.get('category_id');
  const reporter    = (sp.get('reporter') || '').trim(); // 入力者名の部分一致検索（自由入力）
  const from        = sp.get('from');
  const to          = sp.get('to');
  const date        = sp.get('date');
  // 件数の上限（既定500・最大3000）。既定のFROM〜TOは直近30日だが、期間を広げて検索した
  // ときでも D1 の読み取り枠を無制限に消費しないようにする
  const limit = Math.min(Math.max(1, Math.trunc(Number(sp.get('limit'))) || 500), 3000);

  // 入力者は自由入力の reporter_name を正とし、未設定の旧データは users.name で補う
  let sql = `
    SELECT
      dr.*,
      rc.name AS category_name,
      COALESCE(dr.reporter_name, u.name) AS reporter_name
    FROM daily_report dr
    LEFT JOIN report_category rc ON dr.category_id = rc.id
    LEFT JOIN users            u  ON dr.reporter_id = u.id
    WHERE dr.deleted_at IS NULL
  `;
  const binds = [];

  if (date) {
    sql += ` AND dr.report_date = ?`;
    binds.push(date);
  } else {
    if (from) { sql += ` AND dr.report_date >= ?`; binds.push(from); }
    if (to)   { sql += ` AND dr.report_date <= ?`; binds.push(to); }
  }
  if (categoryId) { sql += ` AND dr.category_id = ?`; binds.push(categoryId); }
  if (reporter) {
    sql += ` AND COALESCE(dr.reporter_name, u.name) LIKE ?${LIKE_ESCAPE}`;
    binds.push(likeContains(reporter));
  }

  sql += ` ORDER BY dr.report_date DESC, dr.id DESC LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await db.prepare(sql).bind(...binds).all();
  const rows = results ?? [];
  const truncated = rows.length > limit;
  return json({ reports: truncated ? rows.slice(0, limit) : rows, truncated, limit });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { report_date, body: bodyText, category_id, reporter_name } = body ?? {};

  if (!report_date) return jsonError(400, 'report_date は必須です');
  if (!isValidYmd(report_date)) return jsonError(400, 'report_date は YYYY-MM-DD の実在する日付で指定してください');
  // 本文は任意（空でも保存可）。NOT NULL 制約のため空文字で格納する。
  const bodyValue = bodyText ? String(bodyText).trim() : '';
  const reporterName = reporter_name ? String(reporter_name).trim().slice(0, 100) : null;

  const userEmail = data.user.email;
  const userRow = await db.prepare(`SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`).bind(userEmail).first();
  if (!userRow) return jsonError(403, 'ユーザーが見つかりません');

  // 同じ識別番号（client_request_id）が登録済みなら、二重に作らず最初の日報を返す
  const idem = await beginIdempotent(db, body, 'daily_report');
  if (idem.error) return jsonError(400, idem.error);
  if (idem.dup?.conflict) return jsonError(409, DEDUPE_CONFLICT_MESSAGE);
  if (idem.dup) return json({ id: idem.dup.record_id, duplicate: true });

  const now = nowIso();

  // reporter_id は NOT NULL 制約のためログインユーザーIDで埋める（入力者の表示・検索は reporter_name）
  const insertStmt = db.prepare(`
    INSERT INTO daily_report
      (reporter_id, reporter_name, report_date, category_id, body,
       created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userRow.id,
    reporterName,
    report_date,
    category_id ?? null,
    bodyValue,
    userEmail, now, userEmail, now
  );
  let id;
  if (idem.key) {
    // 日報と識別番号は同じ batch（同時に2回届いたら片方は丸ごと取り消される）
    try {
      const results = await db.batch([insertStmt, dedupeStatement(db, idem.key, 'daily_report', userEmail, now)]);
      id = results[0].meta?.last_row_id;
    } catch (err) {
      const existingId = isDedupeConflict(err) ? await resolveRaceDuplicate(db, idem.key, 'daily_report') : null;
      if (!existingId) throw err;
      return json({ id: existingId, duplicate: true });
    }
  } else {
    id = (await insertStmt.run()).meta?.last_row_id;
  }
  await writeAuditLog(db, {
    tableName: 'daily_report',
    recordId: id,
    action: 'create',
    changedBy: userEmail,
    diff: { report_date, category_id, body: bodyValue, reporter_name: reporterName },
  });
  return json({ id }, 201);
}
