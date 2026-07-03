// 共通レスポンスヘルパー — API のレスポンスは必ずここを経由して JSON で返す

/** 成功レスポンス */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** エラーレスポンス（フロントの api.js が error.message を表示する） */
export function jsonError(status, message, detail = undefined) {
  return json({ error: { message, ...(detail !== undefined ? { detail } : {}) } }, status);
}

/** リクエストボディの JSON を安全に読む（不正な JSON は null を返す） */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 同時編集ガード（楽観ロック）。
 * クライアントが編集開始時点の updated_at を expected_updated_at として送ってきた場合、
 * 現在のレコードの updated_at と違えば「他の人が先に更新した」ため 409 を返す。
 * 送ってこない呼び出し（ステータス変更などの部分更新・旧クライアント）はチェックしない。
 * 使い方: const conflict = checkEditConflict(body, existing); if (conflict) return conflict;
 */
export function checkEditConflict(body, existing) {
  const expected = body?.expected_updated_at;
  if (expected === undefined || expected === null) return null;
  if (String(expected) === String(existing?.updated_at ?? '')) return null;
  return jsonError(409,
    '他のユーザーがこの記録を先に更新しています。\nページを再読み込みして最新の内容を確認してから、もう一度編集してください。');
}
