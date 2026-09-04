// 13 ユーティリティ日報 — 入力値の検証・スナップショット化・異常判定（index.js と [id].js で共有）

import { jsonError } from '../_lib/http.js';

/**
 * 数値の表記ゆれを半角へ寄せる（js/inspection-items.js の normalizeNumberText と同じ規則）。
 * クライアント側で正規化済みだが、全角のまま届いても 400 で弾かず保存できるようにする保険。
 */
function normalizeNumberText(text) {
  return String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，,、\s]/g, '')
    .replace(/[－ー−―‐]/g, '-');
}

const parseJson = (s, fallback) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

/** マスタ行（DB）を API/フロントで扱う形へ。options_json などは配列に開いて返す */
export function toItem(row) {
  return {
    id: row.id,
    section: row.section || '',
    name: row.name,
    input_type: row.input_type,
    unit: row.unit,
    min_value: row.min_value,
    max_value: row.max_value,
    options: parseJson(row.options_json, null),
    alert_options: parseJson(row.alert_options_json, null),
    sort_order: row.sort_order,
  };
}

/** 有効な項目マスタを並び順で取得する */
export async function listItems(db) {
  const { results } = await db.prepare(
    `SELECT id, section, name, input_type, unit, min_value, max_value,
            options_json, alert_options_json, sort_order
       FROM utility_item
      WHERE deleted_at IS NULL
      ORDER BY sort_order, id`
  ).all();
  return (results ?? []).map(toItem);
}

/** 1項目の異常判定。数値は上下限、選択式は alert_options に含まれる値を異常とする */
export function isAbnormal(item, value) {
  if (value === null || value === undefined || value === '') return false;
  if (item.input_type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (item.min_value !== null && item.min_value !== undefined && n < item.min_value) return true;
    if (item.max_value !== null && item.max_value !== undefined && n > item.max_value) return true;
    return false;
  }
  if (item.input_type === 'select') {
    return Array.isArray(item.alert_options) && item.alert_options.includes(String(value));
  }
  return false;
}

/**
 * 入力値（{ [item_id]: value } または [{item_id, value}]）を検証し、
 * 実施時点のスナップショット配列に変換する。マスタに無い item_id は捨てる。
 * @returns {{ error?: Response, values?: object[], hasAbnormal?: number }}
 */
export function buildValues(items, rawValues) {
  const map = new Map();
  if (Array.isArray(rawValues)) {
    for (const v of rawValues) {
      if (v && v.item_id !== undefined) map.set(Number(v.item_id), v.value);
    }
  } else if (rawValues && typeof rawValues === 'object') {
    for (const [k, v] of Object.entries(rawValues)) map.set(Number(k), v);
  } else if (rawValues !== undefined && rawValues !== null) {
    return { error: jsonError(400, 'values の形式が不正です。') };
  }

  const values = [];
  for (const item of items) {
    if (!map.has(item.id)) continue;
    let value = map.get(item.id);
    if (value === null || value === undefined || value === '') continue;

    switch (item.input_type) {
      case 'number': {
        const n = Number(normalizeNumberText(value));
        if (!Number.isFinite(n)) {
          return { error: jsonError(400, `「${item.name}」は数値で入力してください。`) };
        }
        value = n;
        break;
      }
      case 'select': {
        value = String(value);
        if (Array.isArray(item.options) && item.options.length && !item.options.includes(value)) {
          return { error: jsonError(400, `「${item.name}」の値が選択肢にありません。`) };
        }
        break;
      }
      case 'multi': {
        const arr = (Array.isArray(value) ? value : String(value).split(';'))
          .map((v) => String(v).trim())
          .filter(Boolean);
        if (Array.isArray(item.options) && item.options.length) {
          const invalid = arr.find((v) => !item.options.includes(v));
          if (invalid) return { error: jsonError(400, `「${item.name}」の値が選択肢にありません: ${invalid}`) };
        }
        if (arr.length === 0) continue;
        value = arr;
        break;
      }
      case 'time': {
        value = String(value).trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
          return { error: jsonError(400, `「${item.name}」は HH:MM 形式で入力してください。`) };
        }
        break;
      }
      default:
        value = String(value).slice(0, 500);
    }

    values.push({
      item_id: item.id,
      name: item.name,
      section: item.section,
      input_type: item.input_type,
      unit: item.unit,
      min_value: item.min_value,
      max_value: item.max_value,
      value,
      abnormal: isAbnormal(item, value),
    });
  }

  return { values, hasAbnormal: values.some((v) => v.abnormal) ? 1 : 0 };
}

/** 保存済みレコードを API レスポンス用に整える（values_json を配列に開く） */
export function toReport(row, { withValues = true } = {}) {
  const { values_json, ...rest } = row;
  return withValues ? { ...rest, values: parseJson(values_json, []) } : rest;
}
