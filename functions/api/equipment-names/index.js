// /api/equipment-names — 設備名・機器名の共有候補（全機能で流用）
//   GET : 在庫(parts_inventory)と設備台帳(equipment_ledger)の両方から、
//         設備名(line_name)・機器名(equipment_name)の組み合わせを重複なく集めて返す。
//         どこかで登録した設備名・機器名が、他機能（設備台帳・点検・保全計画）の
//         入力候補にも出るようにするための共有ソース。

import { json } from '../_lib/http.js';

export async function onRequestGet({ env }) {
  const { DB } = env;
  const { results } = await DB.prepare(
    `SELECT DISTINCT line_name, equipment_name FROM parts_inventory
       WHERE deleted_at IS NULL AND (line_name IS NOT NULL OR equipment_name IS NOT NULL)
     UNION
     SELECT DISTINCT line_name, equipment_name FROM equipment_ledger
       WHERE deleted_at IS NULL AND (line_name IS NOT NULL OR equipment_name IS NOT NULL)`
  ).all();

  return json({ pairs: results ?? [] });
}
