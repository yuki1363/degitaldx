// 部品在庫の「版」— 他の人が入出庫・編集したかを、ごく軽い問い合わせで確かめるための値。
//
//   部品一覧・詳細は、画面を開いている間 20 秒ごとに最新を取り直して他の人の入出庫を反映する。
//   以前は毎回一覧を全件読んでいた（部品1,500件で 3,000行/回 ＝ 1時間で約54万行）ため、
//   まずこの「版」だけを取り、前回と変わっていたときだけ一覧を取り直す（数行/回で済む）。
//
//   ・一覧の版 … parts_inventory の最終更新日時（MAX(updated_at)・索引だけで分かる）と、
//               入出庫履歴の最新ID（MAX(id)・主キーだけで分かる）。部品の登録・編集・削除・発注状態・
//               入出庫のどれが起きても、どちらかが必ず変わる（部品の書き込みはすべて updated_at を更新し、
//               在庫数の変更は必ず入出庫履歴を1行足す）。
//   ・詳細の版 … その部品の更新日時・その部品の入出庫履歴の最新ID・設備の紐づけの最終更新日時。
//   更新日時は秒精度のため、同じ秒に2回変わっても入出庫の最新IDが変わる。MAX は NULL を無視するので、
//   更新日時が空の古いデータがあっても動く。
export async function partsListVersion(db) {
  const row = await db.prepare(
    `SELECT (SELECT MAX(updated_at) FROM parts_inventory) AS u,
            (SELECT MAX(id) FROM parts_transaction) AS t`
  ).first();
  return `${row?.u ?? ''}|${row?.t ?? 0}`;
}

export async function partsDetailVersion(db, partId) {
  const row = await db.prepare(
    `SELECT (SELECT updated_at FROM parts_inventory WHERE id = ?1) AS u,
            (SELECT MAX(id) FROM parts_transaction WHERE part_id = ?1) AS t`
  ).bind(partId).first();
  let eq = '';
  try {
    const r = await db.prepare(`SELECT MAX(updated_at) AS e FROM parts_equipment WHERE part_id = ?1`).bind(partId).first();
    eq = r?.e ?? '';
  } catch { /* 表が無い環境では設備の紐づけは版に含めない */ }
  return `${row?.u ?? ''}|${row?.t ?? 0}|${eq}`;
}
