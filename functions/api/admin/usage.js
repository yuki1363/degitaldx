// GET /api/admin/usage — Cloudflare 無料枠の利用状況（admin のみ）
//   アプリ内で正確に取得できる要素のみ返す:
//     r2     … ファイルストレージ使用量（getStorageUsage と同じ。10GB無料枠）
//     d1     … データベースのおおよそのサイズ（PRAGMA から推定・5GB無料枠）。
//              D1 が PRAGMA を許可しない場合は size_bytes: null（画面はダッシュボード誘導）。
//     access … 利用登録ユーザー数（= Cloudflare Access の許可リスト相当・50名無料枠）
//   ※ Workers リクエスト数・D1 の日次読取/書込は API トークンが必要なため
//     アプリでは取得しない（画面で Cloudflare ダッシュボードへ誘導する）。

import { requireRole } from '../_lib/auth.js';
import { json } from '../_lib/http.js';
import { getStorageUsage } from '../_lib/storage.js';

const D1_FREE_TIER_BYTES = 5_000_000_000; // 5 GB
const ACCESS_FREE_USERS = 50;

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;

  // R2（写真・動画・PDF）
  let r2 = null;
  try { r2 = await getStorageUsage(env); } catch { r2 = null; }

  // 利用登録ユーザー数（論理削除を除く）
  let userCount = null;
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`).first();
    userCount = row ? row.n : null;
  } catch { userCount = null; }

  // D1 サイズ推定（page_count × page_size）。D1 が PRAGMA を許可しない場合は null。
  let d1Bytes = null;
  try {
    const pc = await db.prepare('PRAGMA page_count').first();
    const ps = await db.prepare('PRAGMA page_size').first();
    const pageCount = pc ? Number(Object.values(pc)[0]) : NaN;
    const pageSize = ps ? Number(Object.values(ps)[0]) : NaN;
    if (Number.isFinite(pageCount) && Number.isFinite(pageSize) && pageCount > 0 && pageSize > 0) {
      d1Bytes = pageCount * pageSize;
    }
  } catch { d1Bytes = null; }

  return json({
    r2,
    d1: { size_bytes: d1Bytes, free_tier_bytes: D1_FREE_TIER_BYTES },
    access: { user_count: userCount, free_limit: ACCESS_FREE_USERS },
  });
}
