// 09: バックアップの CSV 一括出力（管理者）
//   JSON バックアップ（GET /api/admin/backup）を取得し、テーブルごとの CSV を ZIP にまとめて保存する。
//   CSV は閲覧・集計用（Excel で開ける）。CSV インジェクション対策（js/csv.js の escCsv）を通すため、
//   「=」「+」「-」「@」で始まる値は先頭に ' が付く。データの復元には JSON／SQL を使うこと。
import { buildCsvText } from '/js/csv.js';
import { loadJSZip } from '/js/excel-fill.js';

/** バックアップのテーブル一覧 → { ファイル名: CSV文字列 }（取得に失敗したテーブルは含めない） */
export function buildBackupCsvFiles(tables) {
  const files = {};
  const skipped = [];
  for (const [name, rows] of Object.entries(tables || {})) {
    if (!Array.isArray(rows)) { skipped.push(name); continue; }
    // 列は全行のキーの和集合（先頭行にだけ無い列が欠けないように）
    const cols = [];
    const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    if (cols.length === 0) { files[`${name}.csv`] = ''; continue; }
    files[`${name}.csv`] = buildCsvText(rows, cols.map((k) => ({ label: k, value: (r) => r[k] })));
  }
  return { files, skipped };
}

/** ZIP を作って Blob で返す。BOM付きUTF-8（Excel で文字化けしない） */
export async function buildBackupCsvZip(backup) {
  const JSZip = await loadJSZip();
  const { files, skipped } = buildBackupCsvFiles(backup.tables);
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, '\ufeff' + text);
  if (skipped.length) zip.file('_取得できなかったテーブル.txt', skipped.join('\n') + '\n');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, skipped, count: Object.keys(files).length };
}
