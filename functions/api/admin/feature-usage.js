// 09: 機能別の利用状況 — GET /api/admin/feature-usage?days=30（admin のみ）
//   監査ログ（audit_log）を機能（テーブル）ごとに数えて、どの機能がどれだけ使われているかを返す。
//   次に何を直すか・何をやめるかの判断材料にする。個人ごとの操作数は返さない（人数だけ）。
//   読み取りだけの閲覧は監査ログに残らないため、数えられるのは「登録・更新・削除・復元」のみ。
//   days は 1〜366（既定30）。期間は現在から遡った日数（UTC の ISO で比べる）。

import { requireRole } from '../_lib/auth.js';
import { json } from '../_lib/http.js';

// 監査ログの table_name → 画面に出す機能名。ここに無いものは table_name のまま「その他」に入れる
export const FEATURE_LABELS = {
  maintenance_plan: '保全計画',
  inspection_result: '点検実施',
  electrical_inspection: '電気設備点検',
  repair_request: '業務依頼',
  trouble_record: 'トラブル記録',
  parts_inventory: '部品在庫（登録・入出庫）',
  equipment_ledger: '設備台帳',
  daily_report: '日報',
  utility_report: 'ユーティリティ日報',
  chat_messages: 'チャット',
  print_templates: '帳票テンプレート',
  inspection_master: '点検項目マスタ',
  utility_item: 'ユーティリティ項目マスタ',
  users: 'ユーザー管理',
};

const clampDays = (v) => Math.min(Math.max(1, Math.trunc(Number(v)) || 30), 366);

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const days = clampDays(new URL(request.url).searchParams.get('days'));
  const since = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const { results } = await env.DB.prepare(
    `SELECT table_name, action, COUNT(*) AS n, COUNT(DISTINCT changed_by) AS users, MAX(changed_at) AS last_at
       FROM audit_log
      WHERE changed_at >= ?1
      GROUP BY table_name, action`
  ).bind(since).all();

  // 機能ごとにまとめる（作成・更新・削除・復元の件数）
  const byFeature = new Map();
  for (const r of results ?? []) {
    const known = Object.prototype.hasOwnProperty.call(FEATURE_LABELS, r.table_name);
    const key = known ? r.table_name : '__other';
    const f = byFeature.get(key) ?? {
      key, label: known ? FEATURE_LABELS[r.table_name] : 'その他', create: 0, update: 0, delete: 0, restore: 0, total: 0, last_at: null,
    };
    if (r.action in f) f[r.action] += r.n;
    f.total += r.n;
    if (!f.last_at || (r.last_at && r.last_at > f.last_at)) f.last_at = r.last_at;
    byFeature.set(key, f);
  }
  // 利用者の人数（機能をまたいだ実人数）
  const people = await env.DB.prepare(
    `SELECT COUNT(DISTINCT changed_by) AS n FROM audit_log WHERE changed_at >= ?1`
  ).bind(since).first();

  // 使われた機能が多い順。期間内に一度も使われていない主要機能も 0 件で並べる（使われていないことが分かるように）
  for (const [table, label] of Object.entries(FEATURE_LABELS)) {
    if (!byFeature.has(table)) byFeature.set(table, { key: table, label, create: 0, update: 0, delete: 0, restore: 0, total: 0, last_at: null });
  }
  const features = [...byFeature.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'ja'));

  return json({ days, since, active_users: people?.n ?? 0, features });
}
