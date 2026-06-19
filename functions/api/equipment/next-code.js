// GET /api/equipment/next-code?line_name=... — 次の設備番号（設備ごとの連番 NN-MM）を返す
//   line_name を渡すと、その設備の続き番号を返す（新しい設備なら新しい設備番号で MM=01）
import { json } from '../_lib/http.js';
import { computeNextEquipmentCode } from './index.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lineName = (url.searchParams.get('line_name') || '').trim() || null;
  const code = await computeNextEquipmentCode(env.DB, lineName);
  return json({ code });
}
