// 05: 部品在庫 — 入出庫記録
// POST /api/parts/:id/transaction  在庫数を更新して入出庫履歴を登録（editor以上）
//   client_tx_id（任意・英数字と - で8〜64文字）: 端末が1回の操作ごとに作る識別番号。
//   同じ番号の入出庫が既にあれば何もせず duplicate:true を返す（オフラインの送信待ちの再送や、
//   通信が途中で切れて押し直したときに、同じ出庫が2回在庫に反映されないように）。
//   ただし登録済みの内容（部品・種別・数量）が今回と違うときは 409 を返す（数量を変えて押し直した
//   のに、変更前の内容で成功扱いになり、画面では変更後の数量が記録されたように見えるのを防ぐ）。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { notifyTeam } from '../../_lib/notify.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureColumns } from '../../_lib/db-compat.js';

const CLIENT_TX_RE = /^[A-Za-z0-9-]{8,64}$/;
const DUPLICATE_TX = Symbol('duplicate client_tx_id');

// 在庫更新と履歴の batch。同じ client_tx_id が同時に届き、履歴の UNIQUE で失敗したら DUPLICATE_TX を投げる
async function runTxBatch(DB, clientTxId, statements) {
  try {
    return await DB.batch(statements);
  } catch (err) {
    if (clientTxId !== null && /UNIQUE/i.test(String(err?.message))) throw DUPLICATE_TX;
    throw err;
  }
}

// 同じ識別番号で登録済みの入出庫と、今回の内容が同じか。棚卸調整（adjust）は履歴の数量が増減分で、
// 今回の絶対値と比べられないため、部品と種別だけ比べる
function sameTransaction(row, { partId, type, delta }) {
  return Number(row.part_id) === partId && row.type === type && (type === 'adjust' || Number(row.quantity) === delta);
}
const CLIENT_TX_CONFLICT = '同じ識別番号で、内容の違う入出庫が既に登録されています。画面を開き直して、もう一度記録してください。';

export async function ensurePartsTxColumns(db) {
  await ensureColumns(db, 'parts_transaction_client_tx', [
    'ALTER TABLE parts_transaction ADD COLUMN client_tx_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_transaction_client_tx ON parts_transaction (client_tx_id) WHERE client_tx_id IS NOT NULL',
  ]);
}

export async function onRequestPost({ env, data, params, request, waitUntil }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const id = Number(params.id);
  const { DB } = env;
  const userEmail = data.user.email;

  // 部品の存在確認（在庫0・安全在庫割れ通知の見出し・しきい値に使う）
  const part = await DB.prepare(
    `SELECT id, name, model_no, quantity, safety_stock FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();

  if (!part) return jsonError(404, '部品が見つかりません。');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  const { type, quantity: bodyQty, note } = body;
  const clientTxId = body.client_tx_id == null || body.client_tx_id === '' ? null : String(body.client_tx_id);
  if (clientTxId !== null && !CLIENT_TX_RE.test(clientTxId)) {
    return jsonError(400, 'client_tx_id が不正です。');
  }

  // バリデーション: type
  if (!['in', 'out', 'adjust'].includes(type)) {
    return jsonError(400, 'type は in / out / adjust のいずれかを指定してください。');
  }

  // バリデーション: quantity（整数）。入庫・出庫は1以上、棚卸調整(adjust)のみ0も許可
  // （棚卸で在庫ゼロを記録できるようにするため）
  if (!Number.isInteger(bodyQty) || bodyQty < 0) {
    return jsonError(400, 'quantity は0以上の整数を指定してください。');
  }
  if (bodyQty === 0 && type !== 'adjust') {
    return jsonError(400, '入庫・出庫の数量は1以上を指定してください。');
  }

  // 任意: 入出庫を業務依頼・トラブル対応に紐づける（使用部品の記録）
  const RELATED_TABLES = ['repair_request', 'trouble_record'];
  const relatedTable = body.related_table ?? null;
  const relatedId =
    body.related_id === undefined || body.related_id === null ? null : Number(body.related_id);
  if (relatedTable !== null && !RELATED_TABLES.includes(relatedTable)) {
    return jsonError(400, `related_table が不正です: ${relatedTable}`);
  }
  if (relatedId !== null && !Number.isInteger(relatedId)) {
    return jsonError(400, 'related_id は整数で指定してください。');
  }

  // 入庫・出庫の増減分（棚卸調整は書き込む瞬間の在庫で決まる）。登録済みの同じ識別番号との比較に使う
  const expectedDelta = type === 'in' ? bodyQty : type === 'out' ? -bodyQty : null;
  const wanted = { partId: id, type, delta: expectedDelta };

  // 同じ識別番号の入出庫が登録済みなら、もう反映済み（再送・押し直し）。何もしないで現在の在庫を返す
  await ensurePartsTxColumns(DB);
  if (clientTxId !== null) {
    const done = await DB.prepare('SELECT part_id, type, quantity FROM parts_transaction WHERE client_tx_id = ?1').bind(clientTxId).first();
    if (done) {
      if (!sameTransaction(done, wanted)) return jsonError(409, CLIENT_TX_CONFLICT);
      return json({ ok: true, duplicate: true, quantity: part.quantity });
    }
  }

  // 在庫の更新と入出庫履歴の登録は1トランザクション（D1 batch）で行う。別々に実行していると、
  // 履歴の登録に失敗したとき在庫だけ変わって履歴が残らない（履歴の合計と在庫が合わなくなる）。
  let oldQty;
  let newQty;
  let delta;
  const now = nowIso();
  // client_tx_id は UNIQUE。確認と登録の間に同じ番号が届いても、後の方は履歴の INSERT で失敗し
  // 同じ batch の在庫更新ごと取り消される（2回反映されない）
  const historyCols = 'part_id, type, quantity, note, related_table, related_id, created_by, created_at, client_tx_id';

  try {
    if (type === 'adjust') {
      // adjust: body.quantity は新しい絶対値（棚卸）。増減（delta）は「書き込む瞬間の在庫」から
      // 同じトランザクション内で計算する。事前に読んだ在庫から計算すると、その間の他の人の
      // 出庫が履歴の delta に反映されず、履歴の合計と在庫が合わなくなる。
      const [before] = await runTxBatch(DB, clientTxId, [
        DB.prepare('SELECT quantity FROM parts_inventory WHERE id = ?1').bind(id),
        DB.prepare(
          `INSERT INTO parts_transaction (${historyCols})
           SELECT ?1, 'adjust', ?2 - quantity, ?3, ?4, ?5, ?6, ?7, ?8 FROM parts_inventory WHERE id = ?1`
        ).bind(id, bodyQty, note ?? null, relatedTable, relatedId, userEmail, now, clientTxId),
        DB.prepare(
          `UPDATE parts_inventory SET quantity = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4`
        ).bind(bodyQty, userEmail, now, id),
      ]);
      oldQty = before.results?.[0]?.quantity ?? part.quantity;
      newQty = bodyQty;
      delta = newQty - oldQty;
    } else {
      // 入庫・出庫は相対更新（quantity = quantity + Δ）で行う。
      // 「読み取り→計算→絶対値で書き込み」だと、2人が同時に±したとき片方の更新が消える。
      // 出庫の在庫不足ガードも同じUPDATEの条件で行い、同時出庫でもマイナス在庫にならない。
      // 履歴は「直前の UPDATE が1行更新したときだけ」登録する（changes() = 1。在庫不足なら履歴も作らない）。
      delta = type === 'in' ? bodyQty : -bodyQty;
      const [upd, , after] = await runTxBatch(DB, clientTxId, [
        DB.prepare(
          `UPDATE parts_inventory
              SET quantity = quantity + ?1, updated_by = ?2, updated_at = ?3
            WHERE id = ?4 AND quantity + ?1 >= 0`
        ).bind(delta, userEmail, now, id),
        DB.prepare(
          `INSERT INTO parts_transaction (${historyCols})
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE changes() = 1`
        ).bind(id, type, delta, note ?? null, relatedTable, relatedId, userEmail, now, clientTxId),
        DB.prepare('SELECT quantity FROM parts_inventory WHERE id = ?1').bind(id),
      ]);
      if ((upd.meta?.changes ?? 0) === 0) {
        return jsonError(400, '在庫不足です。');
      }
      newQty = after.results?.[0]?.quantity ?? part.quantity + delta;
      oldQty = newQty - delta;
    }
  } catch (err) {
    if (err !== DUPLICATE_TX) throw err;
    // 同時に同じ番号が届いて、先に登録された方がある。内容が同じなら反映済み、違えば 409
    const done = await DB.prepare('SELECT part_id, type, quantity FROM parts_transaction WHERE client_tx_id = ?1').bind(clientTxId).first();
    if (done && !sameTransaction(done, wanted)) return jsonError(409, CLIENT_TX_CONFLICT);
    const cur = await DB.prepare('SELECT quantity FROM parts_inventory WHERE id = ?1').bind(id).first();
    return json({ ok: true, duplicate: true, quantity: cur?.quantity ?? part.quantity });
  }

  // 入庫したら「発注中」バッジを自動解除する（発注→入庫の完了）。
  // ordered_at 列が無い旧DBではエラーになるが、バッジ機能が無いだけなので握りつぶす。
  if (type === 'in' && delta > 0) {
    try {
      await DB.prepare(
        `UPDATE parts_inventory SET ordered_at = NULL, ordered_by = NULL WHERE id = ?1 AND ordered_at IS NOT NULL`
      ).bind(id).run();
    } catch { /* 列未追加の旧DBでは何もしない */ }
  }

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: { old_qty: oldQty, new_qty: newQty, type, delta },
  });

  // 在庫アラート通知。多重通知を避けるため「しきい値をまたいだ瞬間」だけ発火する。
  //   ・在庫切れ（0）  : alert（0→0は変化なしなので oldQty>0 のときのみ）
  //   ・安全在庫割れ    : warning（必要数を下回った瞬間。0は上の在庫切れで通知済みなので除外）
  const label = part.model_no ? `${part.model_no}（${part.name}）` : part.name;
  const safetyStock = part.safety_stock || 0;
  if (newQty === 0 && oldQty > 0) {
    await notifyTeam(env, waitUntil, {
      type: 'parts_zero',
      level: 'alert',
      title: `在庫切れ: ${part.name}`,
      body: `${label}の在庫が0になりました。発注をご検討ください。`,
      relatedTable: 'parts_inventory',
      relatedId: id,
      linkUrl: `/pages/parts?id=${id}`,
      createdBy: userEmail,
    });
  } else if (safetyStock > 0 && newQty > 0 && newQty < safetyStock && oldQty >= safetyStock) {
    await notifyTeam(env, waitUntil, {
      type: 'parts_low',
      level: 'warning',
      title: `発注アラート: ${part.name}`,
      body: `${label}の在庫が必要数（${safetyStock}）を下回りました（現在 ${newQty}）。発注をご検討ください。`,
      relatedTable: 'parts_inventory',
      relatedId: id,
      linkUrl: `/pages/parts?id=${id}`,
      createdBy: userEmail,
    });
  }

  // 入庫したら、この部品を使う「部品待ち」の業務依頼に入庫を通知する
  //   （部品待ちで止まりがちな依頼を、部品到着で自動的に促す）
  if (type === 'in' && delta > 0) {
    const waiting = await DB.prepare(
      `SELECT DISTINCT r.id, r.title
         FROM parts_transaction pt
         JOIN repair_request r ON r.id = pt.related_id
        WHERE pt.part_id = ?1 AND pt.related_table = 'repair_request'
          AND r.status = 'waiting_parts' AND r.deleted_at IS NULL`
    )
      .bind(id)
      .all()
      .catch(() => ({ results: [] }));
    for (const r of waiting.results ?? []) {
      await notifyTeam(env, waitUntil, {
        type: 'parts_restock',
        level: 'info',
        title: `部品が入庫しました: ${part.name}`,
        body: `部品待ちの業務依頼「${r.title}」で使用する${label}が入庫しました（現在 ${newQty}）。`,
        relatedTable: 'repair_request',
        relatedId: r.id,
        linkUrl: `/pages/repair?id=${r.id}`,
        createdBy: userEmail,
      });
    }
  }

  return json({ quantity: newQty });
}
