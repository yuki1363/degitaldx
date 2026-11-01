// 設備台帳との紐づけ（部品在庫 05・保全計画 01）
//   設備名(line_name)＋機器名(equipment_name)が設備台帳の「1件にだけ」一致するときに、その設備の id を
//   equipment_id に入れる。0件（台帳に無い名前）・複数件（同じ名前の設備が複数）のときは入れない。
//   入力欄は今までどおり自由入力で、紐づけは裏で行う（入力を止めない）。
//   読み取り側（設備カルテ・設備詳細）は equipment_id を先に使い、無ければ従来の名前の一致で拾う。

import { normalizeJa } from './normalize.js';
import { ensureColumns } from './db-compat.js';
import { auditStatement } from './audit.js';

const TABLES = {
  maintenance_plan: { label: '保全計画' },
  parts_inventory: { label: '部品在庫' },
};
const BACKFILL_AUDIT_IDS = 500; // 監査ログに残す対象IDの上限

const norm = (s) => normalizeJa(String(s ?? '')).trim();

/** parts_inventory.equipment_id 列を（無ければ）追加する。使えない環境では false */
export function ensureEquipmentLinkColumns(db) {
  return ensureColumns(db, 'parts_equipment_link', [
    'ALTER TABLE parts_inventory ADD COLUMN equipment_id INTEGER',
    'CREATE INDEX IF NOT EXISTS idx_parts_inventory_equipment ON parts_inventory (equipment_id)',
  ]);
}

/** 設備名＋機器名に一致する設備台帳の候補（最大 limit 件）。両方空なら空配列 */
export async function findEquipmentCandidates(db, line, equip, limit = 3) {
  const l = norm(line);
  const e = norm(equip);
  if (!l && !e) return [];
  const { results } = await db.prepare(
    `SELECT id, code, name FROM equipment_ledger
      WHERE deleted_at IS NULL AND COALESCE(line_name, '') = ?1 AND COALESCE(equipment_name, '') = ?2
      ORDER BY id LIMIT ?3`
  ).bind(l, e, limit).all();
  return results ?? [];
}

/** 一致が1件だけならその id、そうでなければ null */
export async function resolveEquipmentId(db, line, equip) {
  const c = await findEquipmentCandidates(db, line, equip, 2);
  return c.length === 1 ? c[0].id : null;
}

/**
 * 登録・更新の直後に、その1件の equipment_id を入れ直す（失敗しても本体の保存は止めない）。
 *   ・一致が1件 → その id を入れる
 *   ・設備名・機器名が入っているのに一致しない → NULL に戻す（名前を変えたのに古い紐づけが残らないように）
 *   ・設備名・機器名が空 → 変更しない（旧データの紐づけを消さない）
 */
export async function linkRowToEquipment(db, table, id) {
  if (!TABLES[table]) return;
  try {
    if (table === 'parts_inventory' && !(await ensureEquipmentLinkColumns(db))) return;
    const row = await db.prepare(`SELECT line_name, equipment_name, equipment_id FROM ${table} WHERE id = ?1`).bind(id).first();
    if (!row) return;
    if (!norm(row.line_name) && !norm(row.equipment_name)) return;
    const eqId = await resolveEquipmentId(db, row.line_name, row.equipment_name);
    if ((row.equipment_id ?? null) === eqId) return;
    // updated_at は変えない（編集中の画面の同時編集ガード＝updated_at の比較に影響させないため）
    await db.prepare(`UPDATE ${table} SET equipment_id = ?1 WHERE id = ?2`).bind(eqId, id).run();
  } catch (err) {
    console.error('linkRowToEquipment failed:', err && err.stack ? err.stack : err);
  }
}

/**
 * 既存データの一括紐づけ。dryRun=true なら数えるだけで何も書かない。
 * 設備名＋機器名の組ごとに台帳を引き、1件一致 → 紐づけ／複数一致 → 要確認／0件 → 一致なし に分けて返す。
 * 既に equipment_id が入っている行は触らない。
 */
export async function backfillEquipmentLinks(db, { dryRun = true, userEmail = 'system' } = {}) {
  await ensureEquipmentLinkColumns(db);
  const summary = { dry_run: dryRun, tables: {}, ambiguous: [], unmatched: [] };
  const statements = [];
  const auditIds = {};

  for (const [table, { label }] of Object.entries(TABLES)) {
    const { results: pairs } = await db.prepare(
      `SELECT line_name, equipment_name, COUNT(*) AS n FROM ${table}
        WHERE deleted_at IS NULL AND equipment_id IS NULL
          AND (COALESCE(line_name, '') != '' OR COALESCE(equipment_name, '') != '')
        GROUP BY line_name, equipment_name`
    ).all();
    const t = { label, linked: 0, ambiguous: 0, unmatched: 0 };
    for (const p of pairs ?? []) {
      const cands = await findEquipmentCandidates(db, p.line_name, p.equipment_name, 3);
      if (cands.length === 1) {
        t.linked += p.n;
        if (!dryRun) {
          const { results: ids } = await db.prepare(
            `SELECT id FROM ${table} WHERE deleted_at IS NULL AND equipment_id IS NULL
               AND line_name IS ?1 AND equipment_name IS ?2`
          ).bind(p.line_name, p.equipment_name).all();
          (auditIds[table] ??= []).push(...(ids ?? []).map((r) => r.id));
          statements.push(db.prepare(
            `UPDATE ${table} SET equipment_id = ?1
              WHERE deleted_at IS NULL AND equipment_id IS NULL AND line_name IS ?2 AND equipment_name IS ?3`
          ).bind(cands[0].id, p.line_name, p.equipment_name));
        }
      } else if (cands.length > 1) {
        t.ambiguous += p.n;
        summary.ambiguous.push({ table: label, line_name: p.line_name, equipment_name: p.equipment_name, count: p.n, candidates: cands.map((c) => c.code || c.name) });
      } else {
        t.unmatched += p.n;
        summary.unmatched.push({ table: label, line_name: p.line_name, equipment_name: p.equipment_name, count: p.n });
      }
    }
    summary.tables[table] = t;
  }
  summary.ambiguous = summary.ambiguous.slice(0, 30);
  summary.unmatched.sort((a, b) => b.count - a.count);
  summary.unmatched = summary.unmatched.slice(0, 30);

  if (!dryRun && statements.length) {
    // 紐づけの更新と監査ログは1つの batch（途中で失敗しても一部だけ残らない）
    statements.push(auditStatement(db, {
      tableName: 'equipment_ledger', recordId: 0, action: 'update', changedBy: userEmail,
      diff: {
        equipment_link_backfill: Object.fromEntries(Object.entries(summary.tables).map(([k, v]) => [k, v.linked])),
        // どの行を紐づけたか（上限つき）。戻すときの手がかり
        linked_ids: Object.fromEntries(Object.entries(auditIds).map(([k, ids]) => [k, ids.slice(0, BACKFILL_AUDIT_IDS)])),
      },
    }));
    await db.batch(statements);
  }
  return summary;
}
