// 画面エラーの自動記録（09 管理機能）
//   POST /api/client-errors … 画面（js/error-report.js）が自動で送る。ログイン済みなら誰でも（閲覧のみも）
//   GET  /api/client-errors … 管理画面「エラー記録」タブ用（admin のみ・新しい順 300 件）
//
//   現場の端末で起きたエラーは、利用者が知らせてくれない限り分からなかった。画面のエラー（JavaScript）・
//   読み込めなかったファイル・API のサーバーエラー（5xx）を記録し、管理者が後から見られるようにする。
//
//   ・業務データではなく技術的な記録のため、論理削除・監査ログは持たない（誰が・いつは created_by/created_at）。
//     90日より古い記録は自動で消す（1プロセスにつき1時間に1回）。
//   ・D1 の書き込み枠（10万行/日）を使い切らないよう、1人あたり1時間 MAX_PER_HOUR 件まで。
//     超えた分は保存せず捨てる（画面側にも回数制限がある）。
//   ・文字数は切り詰める。ページはパスだけを受け取る（検索語・本文の入ったクエリは画面側で落とす）。
import { requireRole } from '../_lib/auth.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { ensureColumns } from '../_lib/db-compat.js';
import { nowIso } from '../_lib/util.js';

export const CLIENT_ERROR_KINDS = ['js', 'promise', 'resource', 'api'];
export const MAX_PER_HOUR = 30;
export const RETENTION_DAYS = 90;
const LIST_LIMIT = 300;

// schema.sql と同じ定義。本番の D1 には schema.sql を毎回は流さないため、初めて使うときに作る
const TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS client_error_log (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     kind        TEXT NOT NULL,
     message     TEXT NOT NULL,
     source      TEXT,
     stack       TEXT,
     page        TEXT,
     app_version TEXT,
     user_agent  TEXT,
     created_by  TEXT NOT NULL,
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_client_error_log_created ON client_error_log (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_client_error_log_user ON client_error_log (created_by, created_at)`,
];
export const ensureClientErrorTable = (db) => ensureColumns(db, 'client_error_log_v1', TABLE_SQL);

const cut = (v, n) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, n);
};
// ページは「/pages/parts」のようなパスだけにする（クエリ・ハッシュが付いていても落とす）
const pathOnly = (v) => {
  const s = cut(v, 300);
  if (!s) return null;
  return s.split(/[?#]/)[0].slice(0, 200) || null;
};
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

let lastPruneAt = 0;
async function pruneOld(db) {
  if (Date.now() - lastPruneAt < 3600_000) return;
  lastPruneAt = Date.now();
  await db.prepare(`DELETE FROM client_error_log WHERE created_at < ?1`).bind(isoAgo(RETENTION_DAYS * 86400_000)).run();
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return jsonError(400, 'リクエストボディが不正です。');
  const kind = CLIENT_ERROR_KINDS.includes(body.kind) ? body.kind : null;
  const message = cut(body.message, 500);
  if (!kind || !message) return jsonError(400, 'kind と message は必須です。');

  const db = env.DB;
  if (!(await ensureClientErrorTable(db))) return json({ ok: true, saved: false });

  const recent = await db
    .prepare(`SELECT COUNT(*) AS n FROM client_error_log WHERE created_by = ?1 AND created_at >= ?2`)
    .bind(data.user.email, isoAgo(3600_000))
    .first();
  if ((recent?.n ?? 0) >= MAX_PER_HOUR) return json({ ok: true, saved: false, limited: true });

  await db
    .prepare(
      `INSERT INTO client_error_log (kind, message, source, stack, page, app_version, user_agent, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      kind, message, cut(body.source, 300), cut(body.stack, 2000), pathOnly(body.page),
      cut(body.version, 40), cut(request.headers.get('User-Agent'), 300), data.user.email, nowIso()
    )
    .run();
  await pruneOld(db).catch(() => {});
  return json({ ok: true, saved: true }, 201);
}

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  if (!(await ensureClientErrorTable(db))) return json({ errors: [], retention_days: RETENTION_DAYS });
  const { results } = await db
    .prepare(
      `SELECT c.id, c.kind, c.message, c.source, c.stack, c.page, c.app_version, c.user_agent,
              c.created_by, c.created_at, u.name AS user_name
         FROM client_error_log c
         LEFT JOIN users u ON u.email = c.created_by
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?1`
    )
    .bind(LIST_LIMIT + 1)
    .all();
  const rows = results ?? [];
  return json({
    errors: rows.slice(0, LIST_LIMIT),
    truncated: rows.length > LIST_LIMIT,
    retention_days: RETENTION_DAYS,
  });
}
