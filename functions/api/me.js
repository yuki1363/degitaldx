// GET /api/me — ログインユーザー情報
//   フロント（js/auth.js）が起動時に呼び、画面の出し分け（UX目的）に使う。
//   実際の権限チェックは各 API ハンドラ側で必ず行う。

import { json } from './_lib/http.js';

export function onRequestGet({ data }) {
  return json({ user: data.user });
}
