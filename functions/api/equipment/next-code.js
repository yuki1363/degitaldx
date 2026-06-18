// GET /api/equipment/next-code — 次の設備番号（INV-xxx）を返す
import { json } from '../_lib/http.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT MAX(CAST(REPLACE(code, 'INV-', '') AS INTEGER)) AS max_num
     FROM equipment_ledger WHERE code LIKE 'INV-%'`
  ).all();
  const maxNum = results?.[0]?.max_num || 0;
  const nextNum = maxNum + 1;
  return json({ code: `INV-${String(nextNum).padStart(3, '0')}` });
}
