// 09: 設備台帳との紐づけ — POST /api/admin/link-equipment  { dry_run: true | false }（admin のみ）
//   部品在庫・保全計画の設備名＋機器名を設備台帳と突き合わせ、1件だけ一致するものに equipment_id を入れる。
//   dry_run（既定 true）は数えるだけ。結果（紐づけた件数・複数一致・一致なし）を見てから dry_run:false で実行する。
//   既に紐づいている行は触らない。updated_at は変えない。実行内容は監査ログに残す。

import { requireRole } from '../_lib/auth.js';
import { json, readJson } from '../_lib/http.js';
import { backfillEquipmentLinks } from '../_lib/equipment-link.js';

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const body = (await readJson(request)) || {};
  const dryRun = body.dry_run !== false; // 明示的に false のときだけ書き込む
  const summary = await backfillEquipmentLinks(env.DB, { dryRun, userEmail: data.user.email });
  return json(summary);
}
