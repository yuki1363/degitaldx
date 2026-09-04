// 13 ユーティリティ日報 — テーブル定義と初期項目（自己修復マイグレーション）
//
//   schema.sql に同じ内容を書いてあるが、本番 D1 への適用忘れで「保存したつもりが
//   テーブルが無い」事故を防ぐため、API入口で ensureUtilitySchema() を呼んで自己修復する
//   （12 電気設備点検の ensureElectricalSchema と同じ方式）。
//   schema.sql の該当箇所は、この UTILITY_ITEMS から生成した SQL を貼ってあるので
//   項目を増やすときは両方を必ず揃えること。

import { ensureColumns } from '../_lib/db-compat.js';

/** 入力方式。02点検の inspection_master に multi（複数選択）と time（HH:MM）を足したもの */
export const INPUT_TYPES = ['number', 'select', 'multi', 'time', 'text'];

/** 表示グループ（入力画面のカード見出し・並び順） */
export const SECTIONS = ['灯油系統', '温水・圧縮機', '各種タンク', '蒸気ボイラー・ドレン'];

const UNITS = ['1号機', '2号機', '3号機'];
const OIL_LEVEL = ['OK', '要補充', '異常'];

/** 初期投入する31項目（元のユーティリティ日報用紙 #2〜#32。#1 点検日時と #33 備考は専用列） */
export const UTILITY_ITEMS = [
  { section: '灯油系統', name: '灯油サブタンクレベル（液面）', input_type: 'select', options: ['上', '中', '下'], sort_order: 1 },
  { section: '灯油系統', name: '温水ボイラー灯油メーター', input_type: 'number', unit: 'L', sort_order: 2 },
  { section: '灯油系統', name: '運転開始時間', input_type: 'time', sort_order: 3 },
  { section: '灯油系統', name: '運転終了時間', input_type: 'time', sort_order: 4 },

  // 温水系 → 空気圧縮機 の順（現場の巡回順に合わせる）
  { section: '温水・圧縮機', name: '温水ポンプ運転号機', input_type: 'multi', options: UNITS, sort_order: 10 },
  { section: '温水・圧縮機', name: '温水ポンプ圧力', input_type: 'number', unit: 'MPa', sort_order: 11 },
  { section: '温水・圧縮機', name: '温水タンク容量', input_type: 'number', unit: '㎥', sort_order: 12 },
  { section: '温水・圧縮機', name: '温水タンク内温度', input_type: 'number', unit: '℃', sort_order: 13 },
  { section: '温水・圧縮機', name: '空気圧縮機運転号機', input_type: 'multi', options: UNITS, sort_order: 14 },
  { section: '温水・圧縮機', name: 'ヘッダー圧力', input_type: 'number', unit: 'MPa', sort_order: 15 },
  // 空気圧縮機の号機別 総運転時間・油面確認。ヘッダー圧力の直後に「号機ごとに1組」で並べ、
  // 現場が号機単位で上から順に入力できるようにする
  { section: '温水・圧縮機', name: '総運転時間1', input_type: 'number', unit: 'hr', sort_order: 16 },
  { section: '温水・圧縮機', name: '油面確認1', input_type: 'select', options: OIL_LEVEL, alert_options: ['要補充', '異常'], sort_order: 17 },
  { section: '温水・圧縮機', name: '総運転時間2', input_type: 'number', unit: 'hr', sort_order: 18 },
  { section: '温水・圧縮機', name: '油面確認2', input_type: 'select', options: OIL_LEVEL, alert_options: ['要補充', '異常'], sort_order: 19 },
  { section: '温水・圧縮機', name: '総運転時間3', input_type: 'number', unit: 'hr', sort_order: 20 },
  { section: '温水・圧縮機', name: '油面確認3', input_type: 'select', options: OIL_LEVEL, alert_options: ['要補充', '異常'], sort_order: 21 },

  { section: '各種タンク', name: '中水タンク容量', input_type: 'number', unit: '㎥', sort_order: 30 },
  { section: '各種タンク', name: '飲料水タンク容量', input_type: 'number', unit: '㎥', sort_order: 31 },
  { section: '各種タンク', name: 'PWタンク容量', input_type: 'number', unit: '㎥', sort_order: 32 },
  { section: '各種タンク', name: '市水温度', input_type: 'number', unit: '℃', sort_order: 33 },
  { section: '各種タンク', name: '灯油タンク容量TK605', input_type: 'number', unit: '㎥', sort_order: 34 },
  { section: '各種タンク', name: '灯油メーター1', input_type: 'number', unit: 'L', sort_order: 35 },
  { section: '各種タンク', name: '薬品タンク1', input_type: 'number', unit: 'L', sort_order: 36 },
  { section: '各種タンク', name: '灯油メーター2', input_type: 'number', unit: 'L', sort_order: 37 },
  { section: '各種タンク', name: '薬品タンク2', input_type: 'number', unit: 'L', sort_order: 38 },

  { section: '蒸気ボイラー・ドレン', name: '蒸気ボイラー運転号機', input_type: 'multi', options: ['1号機', '2号機'], sort_order: 40 },
  { section: '蒸気ボイラー・ドレン', name: '蒸気ボイラー圧力', input_type: 'number', unit: 'MPa', sort_order: 41 },
  { section: '蒸気ボイラー・ドレン', name: 'PW補給水メーター', input_type: 'number', unit: 'L', sort_order: 42 },
  { section: '蒸気ボイラー・ドレン', name: 'ボイラー給水ポンプ圧力', input_type: 'number', unit: 'MPa', sort_order: 43 },
  { section: '蒸気ボイラー・ドレン', name: 'ドレン電導度', input_type: 'number', unit: 'μS/cm', sort_order: 44 },
  { section: '蒸気ボイラー・ドレン', name: 'ドレンポンプ圧力', input_type: 'number', unit: 'MPa', sort_order: 45 },

];

/** 管理画面から並び替えたときの採番。UTILITY_MIGRATIONS が参照する旧番号（1〜45）と
 *  重ならない番号帯にすることで、手動の並びが移行SQLで巻き戻されるのを防ぐ
 *  （さらに ensureUtilityOrder が「1000番台が1件でもあれば移行しない」で二重に守る） */
export const REORDER_BASE = 1000;
export const REORDER_STEP = 10;

/**
 * 既に31項目を投入済みのDBを、上の並びへ合わせ直す移行。
 *   空気圧縮機の号機別「総運転時間N／油面確認N」を、圧縮機セクションのヘッダー圧力直後へ
 *   1組ずつ並べ、押し出される温水ポンプ系を繰り下げる。
 *
 * 各文は name で1項目に限定し、「移動元になり得る位置」を条件に含める。そのため
 *   - どの旧レイアウトのDBからでも1回で最終形へ揃う
 *   - 一度動いた後は何度実行しても no-op（管理画面での並び替えを毎回は上書きしない）
 * 温水ポンプ系は後ろの項目から更新し、並び替え途中の重複を避ける。
 * ※ 本番の全DBが移行済みになったら、この配列は丸ごと削除してよい。
 */
export const UTILITY_MIGRATIONS = [
  // 後続セクションの番号帯を空ける（温水・圧縮機が 10〜21 を使うため）
  `UPDATE utility_item SET sort_order = sort_order + 10 WHERE section = '蒸気ボイラー・ドレン' AND sort_order BETWEEN 30 AND 35`,
  `UPDATE utility_item SET sort_order = sort_order + 10 WHERE section = '各種タンク'           AND sort_order BETWEEN 20 AND 28`,
  // 温水系を先頭（10〜13）へ。旧位置は 初版12〜15 / 中間15〜18 / 直前18〜21
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 10 WHERE name = '温水ポンプ運転号機' AND sort_order IN (12, 15, 18)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 11 WHERE name = '温水ポンプ圧力'     AND sort_order IN (13, 16, 19)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 12 WHERE name = '温水タンク容量'     AND sort_order IN (14, 17, 20)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 13 WHERE name = '温水タンク内温度'   AND sort_order IN (15, 18, 21)`,
  // 空気圧縮機を温水の後ろ（14〜21）へ
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 14 WHERE name = '空気圧縮機運転号機' AND sort_order = 10`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 15 WHERE name = 'ヘッダー圧力'       AND sort_order = 11`,
  // 号機別の総運転時間・油面確認（旧位置は「運転時間・油面」/「油面確認」セクション、または直前の12〜17）
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 16 WHERE name = '総運転時間1' AND (section = '運転時間・油面' OR sort_order = 12)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 17 WHERE name = '油面確認1'   AND (section IN ('運転時間・油面', '油面確認') OR sort_order = 13)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 18 WHERE name = '総運転時間2' AND (section = '運転時間・油面' OR sort_order IN (13, 14))`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 19 WHERE name = '油面確認2'   AND (section IN ('運転時間・油面', '油面確認') OR sort_order = 15)`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 20 WHERE name = '総運転時間3' AND (section = '運転時間・油面' OR sort_order IN (14, 16))`,
  `UPDATE utility_item SET section = '温水・圧縮機', sort_order = 21 WHERE name = '油面確認3'   AND (section IN ('運転時間・油面', '油面確認') OR sort_order = 17)`,
  // 旧セクション名の取りこぼし（管理画面で足した項目など）をまとめて改称
  `UPDATE utility_item SET section = '温水・圧縮機' WHERE section = '圧縮機・温水'`,
];


const sq = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** 1項目分の冪等 seed SQL（既存の trouble_category と同じ INSERT ... WHERE NOT EXISTS 形式） */
export function itemSeedSql(it) {
  const cols = [
    sq(it.section), sq(it.name), sq(it.input_type), sq(it.unit ?? null),
    it.options ? sq(JSON.stringify(it.options)) : 'NULL',
    it.alert_options ? sq(JSON.stringify(it.alert_options)) : 'NULL',
    String(it.sort_order), `'system'`,
  ].join(', ');
  return `INSERT INTO utility_item (section, name, input_type, unit, options_json, alert_options_json, sort_order, created_by)\n` +
    `SELECT ${cols} WHERE NOT EXISTS (SELECT 1 FROM utility_item WHERE name = ${sq(it.name)})`;
}

export const CREATE_UTILITY_ITEM = `CREATE TABLE IF NOT EXISTS utility_item (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  section            TEXT    NOT NULL DEFAULT '',
  name               TEXT    NOT NULL,
  input_type         TEXT    NOT NULL DEFAULT 'number'
                             CHECK (input_type IN ('number', 'select', 'multi', 'time', 'text')),
  unit               TEXT,
  min_value          REAL,
  max_value          REAL,
  options_json       TEXT,
  alert_options_json TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by         TEXT,
  updated_at         TEXT,
  deleted_by         TEXT,
  deleted_at         TEXT
)`;

export const CREATE_UTILITY_REPORT = `CREATE TABLE IF NOT EXISTS utility_report (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date   TEXT    NOT NULL,
  inspected_at  TEXT    NOT NULL,
  reporter_name TEXT,
  has_abnormal  INTEGER NOT NULL DEFAULT 0,
  values_json   TEXT    NOT NULL DEFAULT '[]',
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by    TEXT,
  updated_at    TEXT,
  deleted_by    TEXT,
  deleted_at    TEXT
)`;

/** テーブル・初期項目が無い環境でも動くよう、API入口で自己修復する（すべて冪等） */
export async function ensureUtilitySchema(db) {
  await ensureColumns(db, 'utility_tables', [
    CREATE_UTILITY_ITEM,
    CREATE_UTILITY_REPORT,
    `CREATE INDEX IF NOT EXISTS idx_utility_report_date ON utility_report (report_date)`,
    `CREATE INDEX IF NOT EXISTS idx_utility_item_sort ON utility_item (sort_order, id)`,
    ...UTILITY_ITEMS.map(itemSeedSql),
  ]);
  await ensureUtilityOrder(db);
}

let orderMigrated = false;

/**
 * 旧レイアウトの並びを最終形へ揃える移行（1プロセス内で1回だけ）。
 * 管理画面から並び替え済み（sort_order が 1000番台）のDBでは実行しない
 * ＝現場が決めた並びを移行SQLで巻き戻さないため。
 */
async function ensureUtilityOrder(db) {
  if (orderMigrated) return;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM utility_item WHERE sort_order >= ?`
    ).bind(REORDER_BASE).first();
    if ((row?.n ?? 0) === 0) {
      for (const sql of UTILITY_MIGRATIONS) {
        try { await db.prepare(sql).run(); } catch { /* 冪等なので失敗しても続行 */ }
      }
    }
    orderMigrated = true;
  } catch { /* テーブル未作成など。次のリクエストで再試行する */ }
}
