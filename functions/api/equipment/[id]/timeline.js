// 06: 設備カルテ — GET /api/equipment/:id/timeline
//   その設備の 点検・トラブル・業務依頼・保全計画・使用部品 を、日付の新しい順に1本の時系列で返す。
//   （設備詳細の「直近10件」では足りない、過去の経緯をたどる用途）
//   ?types=inspection,trouble,repair,plan,parts  で種別を絞る（既定は全部）
//   ?limit=（既定30・最大100）&offset=（最大5000）  で続きを取る。has_more:true なら続きがある
//   並びは JST に直した日時の降順（保全計画は予定日）。読み取りのみ（全員）。

import { json, jsonError } from '../../_lib/http.js';

const KINDS = {
  inspection: `SELECT 'inspection' AS kind, r.id AS rec_id, r.inspected_at AS at, datetime(r.inspected_at, '+9 hours') AS sort_key,
                      '点検' AS title, COALESCE(r.assignee_name, '') AS sub, CAST(r.has_abnormal AS TEXT) AS extra
                 FROM inspection_result r
                WHERE r.equipment_id = ?1 AND r.deleted_at IS NULL`,
  trouble: `SELECT 'trouble' AS kind, t.id AS rec_id, t.occurred_at AS at, datetime(t.occurred_at, '+9 hours') AS sort_key,
                   COALESCE(t.phenomenon, '') AS title, COALESCE(tc.name, '') AS sub, '' AS extra
              FROM trouble_record t LEFT JOIN trouble_category tc ON tc.id = t.category_id
             WHERE t.equipment_id = ?1 AND t.deleted_at IS NULL`,
  repair: `SELECT 'repair' AS kind, r.id AS rec_id, r.created_at AS at, datetime(r.created_at, '+9 hours') AS sort_key,
                  COALESCE(r.title, '') AS title, '' AS sub, COALESCE(r.status, '') AS extra
             FROM repair_request r
            WHERE r.equipment_id = ?1 AND r.deleted_at IS NULL`,
  // 保全計画は自由入力の設備名・機器名で保存されるため、台帳の設備名・機器名と一致するものを拾う（設備詳細と同じ）
  plan: `SELECT 'plan' AS kind, p.id AS rec_id, p.planned_date AS at, p.planned_date AS sort_key,
                COALESCE(p.title, '') AS title, COALESCE(p.plan_type, '') AS sub, COALESCE(p.status, '') AS extra
           FROM maintenance_plan p
          WHERE p.deleted_at IS NULL
            AND COALESCE(p.line_name, '') = ?2 AND COALESCE(p.equipment_name, '') = ?3`,
  // 使用部品: 業務依頼・トラブルに紐づけて記録された入出庫のうち、この設備のもの
  parts: `SELECT 'parts' AS kind, pt.part_id AS rec_id, pt.created_at AS at, datetime(pt.created_at, '+9 hours') AS sort_key,
                 COALESCE(p.name, '') AS title, pt.type AS sub, CAST(pt.quantity AS TEXT) AS extra
            FROM parts_transaction pt JOIN parts_inventory p ON p.id = pt.part_id
           WHERE (pt.related_table = 'repair_request'
                    AND pt.related_id IN (SELECT id FROM repair_request WHERE equipment_id = ?1))
              OR (pt.related_table = 'trouble_record'
                    AND pt.related_id IN (SELECT id FROM trouble_record WHERE equipment_id = ?1))`,
};

const clampInt = (v, def, min, max) => Math.min(Math.max(min, Math.trunc(Number(v)) || def), max);

export async function onRequestGet({ request, env, params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError(400, '設備IDが不正です。');

  const eq = await env.DB.prepare(
    `SELECT id, line_name, equipment_name FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id).first().catch(() => null);
  if (!eq) return jsonError(404, '設備が見つかりません。');

  const sp = new URL(request.url).searchParams;
  const wanted = (sp.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const kinds = wanted.length ? Object.keys(KINDS).filter((k) => wanted.includes(k)) : Object.keys(KINDS);
  if (kinds.length === 0) return jsonError(400, 'types が不正です（inspection / trouble / repair / plan / parts）。');
  const limit = clampInt(sp.get('limit'), 30, 1, 100);
  const offset = clampInt(sp.get('offset'), 0, 0, 5000);

  // 設備名・機器名の無い設備は、保全計画を拾わない（空文字どうしで無関係な計画に一致するのを防ぐ）
  const planBlank = !eq.line_name && !eq.equipment_name;
  const parts = kinds.filter((k) => !(k === 'plan' && planBlank)).map((k) => KINDS[k]);
  if (parts.length === 0) return json({ items: [], has_more: false });

  // 日付の同じものは種別・IDで安定して並べる。続きの判定のため1件多く読む
  const sql = `SELECT * FROM (${parts.join(' UNION ALL ')})
                ORDER BY sort_key DESC, kind ASC, rec_id DESC
                LIMIT ?4 OFFSET ?5`;
  // D1 は使わない番号付きパラメータがあるとエラーになるため、?1〜?5 をすべて使う形にそろえる
  const needsPlan = parts.includes(KINDS.plan);
  const stmt = env.DB.prepare(needsPlan ? sql : sql.replace('?4', '?2').replace('?5', '?3'));
  const binds = needsPlan
    ? [id, eq.line_name || '', eq.equipment_name || '', limit + 1, offset]
    : [id, limit + 1, offset];

  let rows;
  try {
    rows = (await stmt.bind(...binds).all()).results;
  } catch (err) {
    // 旧DBで列が足りない等。設備詳細と同じく、履歴が取れなくても画面は止めない
    console.error('equipment timeline failed:', err && err.stack ? err.stack : err);
    return json({ items: [], has_more: false, error: '履歴を取得できませんでした。' });
  }
  const hasMore = rows.length > limit;
  return json({ items: hasMore ? rows.slice(0, limit) : rows, has_more: hasMore });
}
