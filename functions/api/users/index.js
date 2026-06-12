// GET /api/users — 担当者選択などに使うユーザー一覧（認証済みユーザー全員）
//   ユーザーの追加・編集・削除は管理機能（09 / Phase 5）で実装する。

import { json } from '../_lib/http.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, group_name, role
       FROM users
      WHERE deleted_at IS NULL
      ORDER BY name`
  ).all();
  return json({ users: results });
}
