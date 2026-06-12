// GET /api/files/usage — R2 ストレージ使用量と上限（容量上限ガードの状態）
//   ダッシュボード・管理画面での表示用。認証済みユーザーなら誰でも参照可。

import { json } from '../_lib/http.js';
import { getStorageUsage } from '../_lib/storage.js';

export async function onRequestGet({ env }) {
  return json({ usage: await getStorageUsage(env) });
}
