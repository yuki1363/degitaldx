// 点検計画 → 点検実施 への遷移URLを作る共有ヘルパー。
//   計画の設備名（line_name + equipment_name）から設備台帳の equipment_id を解決し、
//   計画で入力済みの「設備・実施日・点検者」を点検入力へ引き継ぐ（被る項目を連動させる）。
//   設備が解決できれば点検入力でその設備の点検項目（チェックリスト）が読み込まれる。
//   plan_id を渡すので、点検を保存するとこの計画が自動で完了になる。
import { api } from '/js/api.js';

export async function buildInspectionStartUrl(plan, dateOverride) {
  let equipmentId = null;
  try {
    const { equipment } = await api.get('/api/equipment');
    const match = (equipment || []).find((e) =>
      (e.line_name || '') === (plan.line_name || '') &&
      (e.equipment_name || '') === (plan.equipment_name || ''));
    if (match) equipmentId = match.id;
  } catch { /* 設備解決に失敗しても点検入力は開く（設備は手動選択） */ }

  const q = new URLSearchParams({ new: '1', plan_id: String(plan.id) });
  if (equipmentId) q.set('equipment_id', String(equipmentId));
  const date = dateOverride || (plan.planned_date ? plan.planned_date.slice(0, 10) : '');
  if (date) q.set('date', date);
  const assignee = plan.inspector_name || plan.assignee_name || '';
  if (assignee) q.set('assignee', assignee);
  return `/pages/inspection?${q}`;
}
