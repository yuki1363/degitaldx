// 点検計画 → 点検実施 への遷移URLを作る共有ヘルパー。
//   計画の設備名（line_name + equipment_name）から設備台帳の equipment_id を解決し、
//   計画で入力済みの「設備・実施日・点検者」を点検入力へ引き継ぐ（被る項目を連動させる）。
//   設備が解決できれば点検入力でその設備の点検項目（チェックリスト）が読み込まれる。
//   plan_id を渡すので、点検を保存するとこの計画が自動で完了になる。
//   カレンダーの日程シート（期間予定のある1日）から開いたときは plan_day も渡し、その日だけを完了にする
//   （全体を完了にすると、残りの日程まで完了になっていた。日程シートの ✓ と同じ complete-day）。
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
  if (dateOverride) q.set('plan_day', dateOverride);
  if (equipmentId) q.set('equipment_id', String(equipmentId));
  const date = dateOverride || (plan.planned_date ? plan.planned_date.slice(0, 10) : '');
  if (date) q.set('date', date);
  const assignee = plan.inspector_name || plan.assignee_name || '';
  if (assignee) q.set('assignee', assignee);
  return `/pages/inspection?${q}`;
}

// 点検の保存後に、開始元の計画を完了にする（失敗しても点検記録は保存済みなので呼び出し側は続行）。
//   planDay があれば その日だけ完了（期間予定は分割・単日予定は全体完了）、無ければ計画全体を完了。
export async function completePlanAfterInspection(planId, planDay) {
  if (!planId) return;
  if (planDay) await api.post(`/api/plans/${planId}/complete-day`, { date: planDay });
  else await api.put(`/api/plans/${planId}`, { status: 'done' });
}
