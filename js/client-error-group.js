// 管理画面「エラー記録」の表示用: 同じエラーを1行にまとめる純粋関数（他の import なし＝単体テスト tests/unit-client-errors.mjs）

// 端末の種類（User-Agent から大まかに。細かい版までは出さない）
export function deviceLabel(ua) {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return 'Android';
  if (/Windows/.test(s)) return 'Windows PC';
  if (/Macintosh|Mac OS X/.test(s)) return 'Mac';
  return s ? 'その他' : '';
}

// 同じエラー（種類・内容・場所・ページ）をまとめ、回数・最後に起きた日時・起きた人・端末・版を出す
export function groupClientErrors(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = [r.kind, r.message, r.source || '', r.page || ''].join('\u0001');
    let g = map.get(key);
    if (!g) {
      // 行は新しい順に届くので、最初の1件がそのエラーの最新
      g = { kind: r.kind, message: r.message, source: r.source, page: r.page, stack: r.stack, count: 0, last_at: r.created_at, first_at: r.created_at, users: new Set(), devices: new Set(), versions: new Set() };
      map.set(key, g);
    }
    g.count++;
    g.first_at = r.created_at;
    if (!g.stack && r.stack) g.stack = r.stack;
    g.users.add(r.user_name || r.created_by);
    const dev = deviceLabel(r.user_agent);
    if (dev) g.devices.add(dev);
    if (r.app_version) g.versions.add(r.app_version);
  }
  return [...map.values()];
}
