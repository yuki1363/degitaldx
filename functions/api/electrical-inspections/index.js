// 電気設備点検（12）の記録API。
//   取り込み元アプリ（電気設備 日常点検記録・単一HTML）の Record を D1 に保存し、
//   チーム共有・監査ログ・論理削除を得る。記録本体は record_json にそのまま保存する
//   （設定スナップショットを含む＝設定変更後も過去記録が壊れない。02 の items_json と同じ思想）。
//
//   GET  /api/electrical-inspections?equipment_type=main
//        → { records: { [client_id]: Record } }（型省略時は全タイプまとめて返す）
//   POST /api/electrical-inspections   （editor以上）
//        body: Record そのもの、または { record: Record }。client_id で冪等 upsert。

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureColumns } from '../_lib/db-compat.js';

export const EQUIPMENT_TYPES = ['main', 'battery', 'generator'];

// テーブルが無い旧DBでも落ちないよう、API入口で自己修復する（CREATE TABLE は冪等）。
export async function ensureElectricalSchema(db) {
  await ensureColumns(db, 'electrical_tables', [
    `CREATE TABLE IF NOT EXISTS electrical_inspection (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       client_id TEXT NOT NULL UNIQUE,
       equipment_type TEXT NOT NULL,
       inspected_date TEXT NOT NULL,
       has_abnormal INTEGER NOT NULL DEFAULT 0,
       record_json TEXT NOT NULL,
       created_by TEXT,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       updated_by TEXT, updated_at TEXT, deleted_by TEXT, deleted_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_electrical_inspection ON electrical_inspection (equipment_type, inspected_date)`,
    `CREATE TABLE IF NOT EXISTS electrical_config (
       equipment_type TEXT PRIMARY KEY,
       config_json TEXT, default_json TEXT,
       updated_by TEXT, updated_at TEXT
     )`,
  ]);
}

// caution / repair が1つでもあれば異常扱い（一覧の色分け・将来の通知用）
export function computeHasAbnormal(statuses) {
  if (!statuses || typeof statuses !== 'object') return 0;
  return Object.values(statuses).some((v) => v === 'caution' || v === 'repair') ? 1 : 0;
}

export async function onRequestGet({ env, request, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureElectricalSchema(db);

  const type = new URL(request.url).searchParams.get('equipment_type');
  let sql = 'SELECT client_id, record_json FROM electrical_inspection WHERE deleted_at IS NULL';
  const binds = [];
  if (type) {
    if (!EQUIPMENT_TYPES.includes(type)) return jsonError(400, 'equipment_type が不正です');
    sql += ' AND equipment_type = ?';
    binds.push(type);
  }
  const { results } = await db.prepare(sql).bind(...binds).all();
  const records = {};
  for (const r of results ?? []) {
    try { records[r.client_id] = JSON.parse(r.record_json); } catch { /* 壊れた行はスキップ */ }
  }
  return json({ records });
}

export async function onRequestPost({ env, request, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureElectricalSchema(db);

  const body = await readJson(request);
  const rec = body && typeof body === 'object' && body.record ? body.record : body;
  if (!rec || typeof rec !== 'object') return jsonError(400, 'record が不正です');

  const clientId = String(rec.id || '').trim();
  const type = String(rec.equipmentType || '').trim();
  const date = String(rec.date || '').slice(0, 10);
  if (!clientId) return jsonError(400, 'record.id は必須です');
  if (!EQUIPMENT_TYPES.includes(type)) return jsonError(400, 'equipmentType が不正です');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError(400, 'date は YYYY-MM-DD 形式で指定してください');

  const hasAbnormal = computeHasAbnormal(rec.statuses);
  const recordJson = JSON.stringify(rec);
  const now = nowIso();
  const email = data.user.email;

  // client_id で冪等 upsert（論理削除済みでも同IDで再保存されたら復活させる）
  const existing = await db.prepare('SELECT id FROM electrical_inspection WHERE client_id = ?')
    .bind(clientId).first();

  if (existing) {
    await db.prepare(
      `UPDATE electrical_inspection
          SET equipment_type = ?, inspected_date = ?, has_abnormal = ?, record_json = ?,
              updated_by = ?, updated_at = ?, deleted_at = NULL, deleted_by = NULL
        WHERE client_id = ?`
    ).bind(type, date, hasAbnormal, recordJson, email, now, clientId).run();
    await writeAuditLog(db, {
      tableName: 'electrical_inspection', recordId: existing.id, action: 'update',
      changedBy: email, diff: { equipment_type: type, date },
    });
    return json({ ok: true, id: existing.id, client_id: clientId });
  }

  const res = await db.prepare(
    `INSERT INTO electrical_inspection
       (client_id, equipment_type, inspected_date, has_abnormal, record_json,
        created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(clientId, type, date, hasAbnormal, recordJson, email, now, email, now).run();
  const id = res.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'electrical_inspection', recordId: id, action: 'create',
    changedBy: email, diff: { equipment_type: type, date },
  });
  return json({ ok: true, id, client_id: clientId }, 201);
}
