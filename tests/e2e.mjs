// E2Eテスト本体 — 実ブラウザ（Chromium）で主要機能を検証する
//   直接実行せず、tests/run.mjs（npm test）経由で実行すること（サーバー起動・DB準備を行うため）。
//
//   カバー範囲:
//     1. 全ページがJSエラーなく表示される
//     2. トラブル: 登録 → 一覧に自動表示 → 編集反映
//     3. 同時編集の競合ガード（expected_updated_at 不一致 → 409）
//     4. 下書き自動保存 → 復元
//     5. オフライン送信キュー（圏外保存 → 復帰で自動送信）
//     6. 部品の発注中バッジ → 入庫で自動解除
//     7. 保全計画: 期間予定が週表示の全日に出る
//     8. ダッシュボード: カスタムグラフ描画
//     9. オフラインでの静的ページ表示（SWプリキャッシュ）

import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8799';

// Chromium 実行ファイルの解決:
//   E2E_CHROMIUM 環境変数 → 開発コンテナの同梱ブラウザ → Playwright 既定（CI は playwright install 済み）
function chromiumPath() {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (fs.existsSync(bundled)) return bundled;
  return undefined;
}

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

const api = (path, opts) => page.evaluate(async ({ path, opts }) => {
  const res = await fetch(path, opts ? {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  } : undefined);
  let json = null;
  try { json = await res.json(); } catch { /* JSONでないレスポンス */ }
  return { status: res.status, json };
}, { path, opts });

// ---------- 1. 全ページ表示 ----------
section('1. 全ページがJSエラーなく表示される');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
// SW登録＋プリキャッシュ完了を待つ（後段のオフラインテストの前提）
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20000 });
await page.waitForFunction(async () => {
  for (const n of await caches.keys()) {
    if ((await (await caches.open(n)).keys()).length > 60) return true;
  }
  return false;
}, { timeout: 30000 });
const PAGES = ['ledger', 'labels', 'inspection', 'inspection-batch', 'inspection-report', 'plan',
  'plan-annual', 'trouble', 'repair', 'parts', 'report', 'dashboard', 'admin', 'chat', 'search', 'notifications'];
for (const p of PAGES) {
  await page.goto(`${BASE}/pages/${p}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
}
check('全17ページ表示・pageerrorなし', pageErrors.length === 0, pageErrors.join(' / '));

// ---------- 2. トラブル: 登録→一覧自動表示→編集 ----------
section('2. トラブル記録の基本フロー');
const t1 = await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2E現象テスト', reporter_name: 'E2E記録者名' } });
check('トラブル登録（201）', t1.status === 201, `status=${t1.status}`);
const troubleId = t1.json?.id;

await page.goto(`${BASE}/pages/trouble`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const listText = await page.evaluate(() => document.body.innerText);
check('一覧に自動表示（検索ボタン不要）', listText.includes('E2E現象テスト'));

const put1 = await api(`/api/troubles/${troubleId}`, { method: 'PUT', body: { phenomenon: 'E2E現象テスト（編集後）' } });
check('編集PUT（200）', put1.status === 200, `status=${put1.status}`);

// 横断検索: 本文（現象）と記録者名の両方でヒットすること
const s1 = await api(`/api/search?q=${encodeURIComponent('E2E現象テスト')}`);
check('横断検索: 現象でヒット', (s1.json?.results || []).some((r) => r.type === 'trouble'));
const s2 = await api(`/api/search?q=${encodeURIComponent('E2E記録者名')}`);
check('横断検索: 記録者名でヒット', (s2.json?.results || []).some((r) => r.type === 'trouble'));

// ---------- 3. 同時編集の競合ガード ----------
section('3. 同時編集の競合ガード');
const cur = await api(`/api/troubles/${troubleId}`);
const conflict = await api(`/api/troubles/${troubleId}`, {
  method: 'PUT',
  body: { phenomenon: '競合テスト', expected_updated_at: '2000-01-01T00:00:00Z' },
});
check('不一致 → 409', conflict.status === 409, `status=${conflict.status}`);
const okPut = await api(`/api/troubles/${troubleId}`, {
  method: 'PUT',
  body: { phenomenon: '競合テスト正常系', expected_updated_at: cur.json?.trouble?.updated_at },
});
check('一致 → 200', okPut.status === 200, `status=${okPut.status}`);

// ---------- 4. 下書き自動保存→復元 ----------
section('4. 下書き自動保存と復元');
await page.goto(`${BASE}/pages/trouble?new=1`, { waitUntil: 'networkidle' });
await page.fill('textarea[placeholder*="異音"]', 'E2E下書きテスト');
await page.waitForTimeout(1300); // 800msデバウンス待ち
await page.goto(`${BASE}/pages/trouble?new=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const hasBanner = await page.evaluate(() => (document.querySelector('.notice.is-warning')?.innerText || '').includes('下書き'));
check('復元バナー表示', hasBanner);
if (hasBanner) {
  await page.click('button:has-text("復元する")');
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => document.querySelector('textarea[placeholder*="異音"]')?.value || '');
  check('内容が復元される', restored.includes('E2E下書きテスト'), restored);
} else {
  check('内容が復元される', false, 'バナーなしのためスキップ');
}
await page.evaluate(() => localStorage.removeItem('draft:trouble-new'));

// ---------- 5. オフライン送信キュー ----------
section('5. オフライン送信キュー（圏外保存→復帰で自動送信）');
await page.goto(`${BASE}/pages/trouble?new=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await context.setOffline(true);
await page.fill('textarea[placeholder*="異音"]', 'E2Eオフライン同期');
await page.click('button:has-text("保存")');
await page.waitForTimeout(1200);
check('「送信待ちに保存」の案内', dialogs.some((d) => d.includes('送信待ち')));
await context.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(2500);
const synced = await api('/api/troubles');
check('復帰後にサーバーへ自動送信', (synced.json?.troubles || []).some((t) => t.phenomenon === 'E2Eオフライン同期'));

// ---------- 6. 部品: 発注中→入庫で解除 ----------
section('6. 発注状態管理');
const p1 = await api('/api/parts', { method: 'POST', body: { name: 'E2Eテスト部品', safety_stock: 5, quantity: 1 } });
const partId = p1.json?.id;
check('部品登録', !!partId, `status=${p1.status}`);
const ord = await api(`/api/parts/${partId}/order`, { method: 'POST', body: { ordered: true } });
check('発注中に設定', ord.status === 200 && !!ord.json?.ordered_at);
await api(`/api/parts/${partId}/transaction`, { method: 'POST', body: { type: 'in', quantity: 10 } });
const after = await api(`/api/parts/${partId}`);
check('入庫で発注中が自動解除', after.json?.part?.ordered_at === null, `ordered_at=${after.json?.part?.ordered_at}`);

// ---------- 7. 週表示: 期間予定が全日に出る ----------
section('7. 保全計画 週表示（期間予定）');
const weekPlan = await page.evaluate(async () => {
  const now = new Date();
  const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const f = (d) => d.toLocaleDateString('sv-SE');
  const r = await fetch('/api/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E週跨ぎ予定', plan_type: 'construction', planned_date: f(mon), planned_end_date: f(fri) }),
  });
  return r.status;
});
check('期間予定の登録', weekPlan === 201, `status=${weekPlan}`);
await page.goto(`${BASE}/pages/plan`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.click('button:has-text("週")');
await page.waitForTimeout(1000);
const weekHits = await page.evaluate(() =>
  [...document.querySelectorAll('.cal-week-col')].filter((c) => c.innerText.includes('E2E週跨ぎ予定')).length);
check('週表示で5日間すべてに表示', weekHits === 5, `${weekHits}日`);

// ---------- 8. カスタムグラフ ----------
section('8. ダッシュボード カスタムグラフ');
await page.goto(`${BASE}/pages/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.click('button:has-text("カスタムグラフ")');
await page.waitForTimeout(1500);
const graph = await page.evaluate(() => ({
  canvas: !!document.getElementById('chart-custom'),
  chart: typeof Chart !== 'undefined' && !!Chart.getChart('chart-custom'),
}));
check('カスタムグラフ描画', graph.canvas && graph.chart, JSON.stringify(graph));

// ---------- 9. チャット: 投稿→取得→既読 ----------
section('9. チャット（投稿・取得・既読）');
const chatPost = await api('/api/chat', { method: 'POST', body: { body: 'E2Eチャットテスト', channel: 'general' } });
check('チャット投稿（201）', chatPost.status === 201, `status=${chatPost.status}`);
const chatList = await api('/api/chat?channel=general&limit=10');
check('投稿が一覧に反映', (chatList.json?.messages || []).some((m) => m.body === 'E2Eチャットテスト'));
const chatRead = await api('/api/chat?channel=general', { method: 'PUT' });
check('既読の更新（200）', chatRead.status === 200, `status=${chatRead.status}`);
const chatUnread = await api('/api/chat?count_unread=1&channel=general');
check('既読後の未読数が0', chatUnread.json?.unread_count === 0, JSON.stringify(chatUnread.json));

// ---------- 10. オフラインでの静的表示 ----------
section('10. オフラインでアプリが起動する（SWプリキャッシュ）');
await context.setOffline(true);
const resp = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
const offlineOk = !!resp && resp.status() === 200 &&
  await page.evaluate(() => document.body.innerText.includes('設備保全'));
check('オフラインでホームが表示される', offlineOk);
await context.setOffline(false);

// ---------- 結果 ----------
await browser.close();
console.log(`\n========== 結果: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) {
  console.log('失敗項目:', failures.join(' / '));
  process.exit(1);
}
