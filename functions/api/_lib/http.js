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
