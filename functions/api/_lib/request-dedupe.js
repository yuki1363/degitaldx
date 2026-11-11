// 登録の二重実行を防ぐ「識別番号」（client_request_id）
//
//   困りごと: 電波が不安定なとき「サーバーには届いて登録されたのに、返事だけ届かなかった」ことがある。
//   画面は失敗と見なして送信待ちに入れ、電波が戻ると同じ内容をもう一度送るため、同じトラブル・点検・
//   業務依頼・日報が2件できていた（部品の入出庫だけは client_tx_id で対策済み）。
//
//   対策: 画面は新規の入力フォームを開いたときに識別番号（UUID）を1つ作り、同じ内容の送信にはずっと
//   同じ番号を付ける（送信待ちに入れたときも同じ）。サーバーは番号を request_dedupe に記録し、
//   既に登録済みの番号が来たら何も作らず、最初に登録した記録のIDを返す（duplicate:true）。
//   記録と番号の登録は同じ batch（1トランザクション）で行うため、同時に2回届いても片方は
//   UNIQUE 違反で丸ごと取り消され、2件にならない。
//
//   ・番号は任意（付いていない古い画面・外部からの呼び出しは従来どおり動く）
//   ・番号の表を作れないときは番号なしで続行する（登録そのものは止めない）
import { ensureColumns } from './db-compat.js';

export const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const DEDUPE_CONFLICT_MESSAGE = '同じ識別番号で、別の種類の記録が既に登録されています。画面を開き直して、もう一度入力してください。';

/** body.client_request_id を取り出す。無ければ { key: null }、形式が不正なら { error } */
export function readClientRequestId(body) {
  const v = body?.client_request_id;
  if (v === undefined || v === null || v === '') return { key: null };
  const s = String(v);
  if (!CLIENT_REQUEST_ID_RE.test(s)) return { error: 'client_request_id が不正です（英数字と - の8〜64文字で指定してください）。' };
  return { key: s };
}

/** 識別番号の表が無ければ作る（古い本番DBでも動く）。使えるなら true */
export function ensureDedupeTable(db) {
  return ensureColumns(db, 'request_dedupe', [
    `CREATE TABLE IF NOT EXISTS request_dedupe (
       client_request_id TEXT PRIMARY KEY,
       kind              TEXT NOT NULL,
       record_id         INTEGER NOT NULL,
       created_by        TEXT,
       created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     )`,
  ]);
}

/**
 * 登録の前に呼ぶ。戻り値:
 *   { error }          … 番号の形式が不正（呼び出し側が 400 を返す）
 *   { key: null }      … 番号なし（従来どおり登録する）
 *   { key, dup: null } … 初めての番号（登録して、同じ batch で番号を記録する）
 *   { key, dup: { record_id } } … 登録済み（登録せず、そのIDを返す）
 *   { key, dup: { conflict: true } } … 別の種類の記録に使われた番号（画面のバグ。409 にする）
 */
export async function beginIdempotent(db, body, kind) {
  const { key, error } = readClientRequestId(body);
  if (error) return { error };
  if (!key) return { key: null };
  if (!(await ensureDedupeTable(db))) return { key: null };
  return { key, dup: await findDuplicate(db, key, kind) };
}

export async function findDuplicate(db, key, kind) {
  const row = await db.prepare(`SELECT kind, record_id FROM request_dedupe WHERE client_request_id = ?1`).bind(key).first();
  if (!row) return null;
  return row.kind === kind ? { record_id: row.record_id } : { conflict: true };
}

/**
 * 番号を記録する文。直前の INSERT（記録の登録）と同じ batch に、その直後に入れる
 * （last_insert_rowid() が記録のIDを指している間に実行するため）。監査ログが同じ batch にあるときは
 * 代わりに dedupeBeforeStatement / dedupeFixStatement を使う。
 * ifPrevChanged: true なら直前の文が1行を変えたときだけ記録する（条件付きの登録用）。
 */
export function dedupeStatement(db, key, kind, userEmail, now, { ifPrevChanged = false } = {}) {
  return db.prepare(
    `INSERT INTO request_dedupe (client_request_id, kind, record_id, created_by, created_at)
     SELECT ?1, ?2, last_insert_rowid(), ?3, ?4${ifPrevChanged ? ' WHERE changes() = 1' : ''}`
  ).bind(key, kind, userEmail, now);
}

/**
 * 監査ログも同じ batch に入れる登録（トラブル記録）用の2文。
 * 監査ログは last_insert_rowid() で「いま登録した記録のID」を取るため、記録の直後に別の表へ INSERT すると
 * そのIDがずれる。そこで 番号を先に（record_id=0 で）入れ → 記録を登録 → 番号の record_id を
 * last_insert_rowid() で直す（UPDATE は last_insert_rowid() を変えない）→ 監査ログ、の順にする。
 * 番号の重複はいちばん最初の INSERT で起きるので、batch 全体が取り消され、記録は作られない。
 */
export function dedupeBeforeStatement(db, key, kind, userEmail, now) {
  return db.prepare(
    `INSERT INTO request_dedupe (client_request_id, kind, record_id, created_by, created_at) VALUES (?1, ?2, 0, ?3, ?4)`
  ).bind(key, kind, userEmail, now);
}
export function dedupeFixStatement(db, key) {
  return db.prepare(`UPDATE request_dedupe SET record_id = last_insert_rowid() WHERE client_request_id = ?1`).bind(key);
}

/** batch が「識別番号の重複（同時に2回届いた）」で失敗したか */
export function isDedupeConflict(err) {
  const m = String(err?.message || err?.cause?.message || '');
  return /UNIQUE/i.test(m) && /request_dedupe/i.test(m);
}

/** 同時に届いた2回目: 先に登録された記録のIDを探す。見つからなければ null（元のエラーを投げ直す） */
export async function resolveRaceDuplicate(db, key, kind) {
  const dup = await findDuplicate(db, key, kind);
  return dup && !dup.conflict ? dup.record_id : null;
}
