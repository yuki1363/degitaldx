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

let browser;
try {
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
} catch (err) {
  // ブラウザ未導入の環境で「何が必要か」をすぐ分かるようにする
  console.error('❌ Chromium を起動できませんでした。ブラウザが未導入の可能性があります。');
  console.error('   対処: cd tests && npx playwright install chromium');
  console.error('   （同梱ブラウザを使う場合は E2E_CHROMIUM=/path/to/chrome を指定）');
  console.error(`   詳細: ${err.message}`);
  process.exit(1);
}
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
// 設備名でも横断検索がヒットするか検証するため、設備に紐づけて登録する
const eqForSearch = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-01', name: 'E2E設備フィルム機' } });
const eqSearchId = eqForSearch.json?.id;
const t1 = await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2E現象テスト', reporter_name: 'E2E記録者名', equipment_id: eqSearchId } });
check('トラブル登録（201）', t1.status === 201, `status=${t1.status}`);
const troubleId = t1.json?.id;

await page.goto(`${BASE}/pages/trouble`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
// 検索するまで一覧は表示しない（設備指定なしで開いた場合）
const beforeSearch = await page.evaluate(() => document.body.innerText);
check('トラブル一覧: 検索するまで表示しない', !beforeSearch.includes('E2E現象テスト') && beforeSearch.includes('検索'));
await page.click('button:has-text("検索")');
await page.waitForFunction(() => document.body.innerText.includes('E2E現象テスト'), { timeout: 10000 }).catch(() => {});
const afterSearch = await page.evaluate(() => document.body.innerText.includes('E2E現象テスト'));
check('トラブル一覧: 検索で表示される', afterSearch);

const put1 = await api(`/api/troubles/${troubleId}`, { method: 'PUT', body: { phenomenon: 'E2E現象テスト（編集後）' } });
check('編集PUT（200）', put1.status === 200, `status=${put1.status}`);

// 横断検索: 本文（現象）と記録者名の両方でヒットすること
const s1 = await api(`/api/search?q=${encodeURIComponent('E2E現象テスト')}`);
check('横断検索: 現象でヒット', (s1.json?.results || []).some((r) => r.type === 'trouble'));
const s2 = await api(`/api/search?q=${encodeURIComponent('E2E記録者名')}`);
check('横断検索: 記録者名でヒット', (s2.json?.results || []).some((r) => r.type === 'trouble'));
// あいまい検索: ひらがな・小文字で入力してもカタカナ・大文字のデータがヒットする
const s3 = await api(`/api/search?q=${encodeURIComponent('e2e現象てすと')}`);
check('横断検索: あいまい（かな/大小文字ゆれ）でヒット', (s3.json?.results || []).some((r) => r.type === 'trouble'));
// 設備名でヒット: 本文に「フィルム機」が無くても、紐づく設備名でトラブル・点検が引ける
// （同じ設備に点検も作る。設備名JOINの回帰＝未マイグレーション環境のフォールバック不具合対策）
const mSearch = await api('/api/inspections/masters', { method: 'POST', body: { equipment_id: eqSearchId, name: 'E2E点検項目', input_type: 'ok_ng' } });
await api('/api/inspections', { method: 'POST', body: { equipment_id: eqSearchId, inspected_at: new Date().toISOString(), items: [{ master_id: mSearch.json?.id, value: 'ok' }] } });
const s4 = await api(`/api/search?q=${encodeURIComponent('フィルム機')}`);
check('横断検索: 設備名でトラブルがヒット', (s4.json?.results || []).some((r) => r.type === 'trouble'));
check('横断検索: 設備名で点検がヒット', (s4.json?.results || []).some((r) => r.type === 'inspection'));

// 機器名が name 列でなく equipment_name 列にある設備でも、設備台帳・点検が引ける
// （今回の「保全計画しかヒットしない」不具合の回帰。name には keyword を入れずに登録する）
const eqSplit = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-SPLIT', name: 'JP2号', line_name: 'JP2号', equipment_name: 'E2Eハイドロ機' } });
check('分割名の設備登録（201）', eqSplit.status === 201, `status=${eqSplit.status}`);
const mSplit = await api('/api/inspections/masters', { method: 'POST', body: { equipment_id: eqSplit.json?.id, name: 'E2E分割項目', input_type: 'ok_ng' } });
await api('/api/inspections', { method: 'POST', body: { equipment_id: eqSplit.json?.id, inspected_at: new Date().toISOString(), items: [{ master_id: mSplit.json?.id, value: 'ok' }] } });
const s5 = await api(`/api/search?q=${encodeURIComponent('ハイドロ')}`);
check('横断検索: equipment_name列で設備台帳がヒット', (s5.json?.results || []).some((r) => r.type === 'equipment'));
check('横断検索: equipment_name列で点検がヒット', (s5.json?.results || []).some((r) => r.type === 'inspection'));

// 半角カタカナで登録された設備名を、全角カタカナの検索でヒットさせる（今回の実データ不具合の回帰）
// 設備名 "ﾌｨﾙﾑ機"（半角）を登録し、"フィルム機"（全角）で検索してヒットするか
const eqHalf = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-HALF', name: 'ﾌｨﾙﾑ機', line_name: 'JP3号', equipment_name: 'ﾌｨﾙﾑ機' } });
check('半角カナ設備の登録（201）', eqHalf.status === 201, `status=${eqHalf.status}`);
const sHalf = await api(`/api/search?q=${encodeURIComponent('フィルム機')}`);
check('横断検索: 全角カナ検索で半角カナ設備がヒット', (sHalf.json?.results || []).some((r) => r.type === 'equipment'));
// 逆方向: 半角カナ検索で全角カナ登録もヒット（設備 E2E設備フィルム機 は全角）
const sHalf2 = await api(`/api/search?q=${encodeURIComponent('ﾌｨﾙﾑ')}`);
check('横断検索: 半角カナ検索で全角カナ設備がヒット', (sHalf2.json?.results || []).some((r) => r.type === 'equipment'));

// 半角⇄全角英数字・大文字小文字のゆれ
await api('/api/parts', { method: 'POST', body: { name: 'Ｅ２ＥＫＥＮ１２３部品', quantity: 1, safety_stock: 1 } }); // 全角英数で登録
const sAlnum1 = await api(`/api/search?q=${encodeURIComponent('ken123')}`);                                       // 半角小文字で検索
check('横断検索: 半角小文字で全角英数字がヒット', (sAlnum1.json?.results || []).some((r) => r.type === 'parts'));
await api('/api/parts', { method: 'POST', body: { name: 'E2E-XYZ789-部品', quantity: 1, safety_stock: 1 } });     // 半角英数で登録
const sAlnum2 = await api(`/api/search?q=${encodeURIComponent('ＸＹＺ７８９')}`);                                   // 全角で検索
check('横断検索: 全角英数字で半角登録がヒット', (sAlnum2.json?.results || []).some((r) => r.type === 'parts'));

// 表記正規化: 半角カナで登録しても全角カナで保存される（保存時 NFKC 正規化）
const eqNorm = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-NORM', name: 'ﾃｽﾄ', line_name: 'ﾃｽﾄ', equipment_name: 'ﾎﾟﾝﾌﾟ' } });
check('正規化: 半角カナ設備の登録（201）', eqNorm.status === 201, `status=${eqNorm.status}`);
const eqNormGet = await api(`/api/equipment/${eqNorm.json?.id}`);
check('正規化: 保存時に半角カナ→全角カナ', eqNormGet.json?.equipment?.equipment_name === 'ポンプ', `equipment_name=${eqNormGet.json?.equipment?.equipment_name}`);
// 一括正規化API（admin）が動く
const normRes = await api('/api/admin/normalize', { method: 'POST', body: {} });
check('一括正規化API（200・ok）', normRes.status === 200 && normRes.json?.ok === true, `status=${normRes.status}`);
// 検索結果画面にCSV出力ボタンが出る（ダッシュボードの抽出レポートから集約した機能）
await page.goto(`${BASE}/pages/search?q=${encodeURIComponent('フィルム機')}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.search-result-header button'), { timeout: 10000 }).catch(() => {});
const hasCsvBtn = await page.evaluate(() =>
  [...document.querySelectorAll('.search-result-header button')].some((b) => b.textContent.includes('CSV'))
);
check('横断検索: 結果にCSV出力ボタンが出る', hasCsvBtn);

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

// ---------- 6.5 現場のクイックアクション ----------
section('6.5 現場のクイックアクション（設備台帳・発注メール）');
// 設備台帳の詳細ページから、トラブル記録・業務依頼をワンタップで新規作成できる
const eqQuick = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-QUICK', name: 'E2Eクイック設備' } });
check('クイックアクション用の設備登録', eqQuick.status === 201, `status=${eqQuick.status}`);
await page.goto(`${BASE}/pages/ledger?id=${eqQuick.json?.id}`, { waitUntil: 'networkidle' });
const quickLinks = await page.evaluate(() => ({
  trouble: document.querySelector('a[href*="/pages/trouble?new=1"]')?.getAttribute('href') || null,
  repair: document.querySelector('a[href*="/pages/repair?new=1"]')?.getAttribute('href') || null,
}));
check('設備台帳: トラブル記録への新規作成リンクがある', (quickLinks.trouble || '').includes(`equipment_id=${eqQuick.json?.id}`), `href=${quickLinks.trouble}`);
check('設備台帳: 業務依頼への新規作成リンクがある', (quickLinks.repair || '').includes(`equipment_id=${eqQuick.json?.id}`), `href=${quickLinks.repair}`);

// 発注メールの宛先自動入力・納期指定
const partForOrder = await api('/api/parts', { method: 'POST', body: { name: 'E2E発注部品', quantity: 1, safety_stock: 5, supplier_email: 'supplier@example.com' } });
check('発注メールテスト用の部品登録', partForOrder.status === 201, `status=${partForOrder.status}`);
await page.goto(`${BASE}/pages/parts?id=${partForOrder.json?.id}`, { waitUntil: 'networkidle' });
await page.click('button:has-text("発注メールを作成")');
await page.waitForFunction(() => !!document.querySelector('.modal textarea'), { timeout: 5000 }).catch(() => {});
const hintHasSupplier = await page.evaluate(() => document.querySelector('.modal')?.innerText.includes('supplier@example.com'));
check('発注メール: 仕入先メールが宛先ヒントに自動反映される', hintHasSupplier);
await page.fill('.modal input[type="date"]', '2026-08-15');
const previewHasDueDate = await page.evaluate(() => document.querySelector('.modal textarea')?.value.includes('希望納期'));
check('発注メール: 納期を入力すると本文プレビューに反映される', previewHasDueDate);
await page.click('.modal button:has-text("閉じる")');

// ---------- 6.6 業務依頼: 優先度・期限 ----------
section('6.6 業務依頼（優先度・期限超過）');
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE');

// 優先度を指定せず登録 → 既定値「中」になる
const rDefault = await api('/api/repairs', { method: 'POST', body: { title: 'E2E業務依頼-既定優先度' } });
check('業務依頼: 優先度未指定で登録（201）', rDefault.status === 201, `status=${rDefault.status}`);
const rDefaultGet = await api(`/api/repairs/${rDefault.json?.id}`);
check('業務依頼: 優先度の既定値は「中」', rDefaultGet.json?.repair?.priority === '中', `priority=${rDefaultGet.json?.repair?.priority}`);

// 期限切れ（昨日）＋未完了 → is_overdue: true
const rOverdue = await api('/api/repairs', { method: 'POST', body: { title: 'E2E業務依頼-期限超過', priority: '高', due_date: yesterday } });
check('業務依頼: 優先度・期限付きで登録（201）', rOverdue.status === 201, `status=${rOverdue.status}`);
const rOverdueGet = await api(`/api/repairs/${rOverdue.json?.id}`);
check('業務依頼: 優先度が保存される', rOverdueGet.json?.repair?.priority === '高', `priority=${rOverdueGet.json?.repair?.priority}`);
check('業務依頼: 期限切れ・未完了は is_overdue', rOverdueGet.json?.repair?.is_overdue === true, `is_overdue=${rOverdueGet.json?.repair?.is_overdue}`);
const rList = await api('/api/repairs');
const rOverdueInList = (rList.json?.repairs || []).find((r) => r.id === rOverdue.json?.id);
check('業務依頼: 一覧GETにも is_overdue が反映される', rOverdueInList?.is_overdue === true, `is_overdue=${rOverdueInList?.is_overdue}`);

// 完了にすると is_overdue は false になる（期限切れでも「未完了」の間だけ超過扱い）
await api(`/api/repairs/${rOverdue.json?.id}`, { method: 'PUT', body: { status: 'done', expected_updated_at: rOverdueGet.json?.repair?.updated_at } });
const rDoneGet = await api(`/api/repairs/${rOverdue.json?.id}`);
check('業務依頼: 完了にすると is_overdue が解除される', rDoneGet.json?.repair?.is_overdue === false, `is_overdue=${rDoneGet.json?.repair?.is_overdue}`);

// 期限が未来なら is_overdue は false
const rFuture = await api('/api/repairs', { method: 'POST', body: { title: 'E2E業務依頼-期限未来', due_date: tomorrow } });
const rFutureGet = await api(`/api/repairs/${rFuture.json?.id}`);
check('業務依頼: 期限が未来なら is_overdue は false', rFutureGet.json?.repair?.is_overdue === false, `is_overdue=${rFutureGet.json?.repair?.is_overdue}`);

// 不正な日付形式は400
const rBadDate = await api('/api/repairs', { method: 'POST', body: { title: 'E2E業務依頼-不正日付', due_date: '2026/08/15' } });
check('業務依頼: 不正な期限形式は400', rBadDate.status === 400, `status=${rBadDate.status}`);

// UI: 登録フォームに優先度・期限の入力欄がある
await page.goto(`${BASE}/pages/repair?new=1`, { waitUntil: 'networkidle' });
const repairFormFields = await page.evaluate(() => ({
  priority: !!document.querySelector('select')?.querySelector('option[value="高"]'),
  dueDate: !!document.querySelector('input[type="date"]'),
}));
check('業務依頼フォーム: 優先度セレクトがある', repairFormFields.priority);
check('業務依頼フォーム: 対応期限の入力欄がある', repairFormFields.dueDate);

// UI: 詳細ページに優先度バッジ・期限超過バッジが表示される
// （rOverdue は上で完了済みにしたため、未完了のまま確認できる別の期限超過依頼を用意する）
const rOverdue2 = await api('/api/repairs', { method: 'POST', body: { title: 'E2E業務依頼-表示確認', priority: '高', due_date: yesterday } });
await page.goto(`${BASE}/pages/repair?id=${rOverdue2.json?.id}`, { waitUntil: 'networkidle' });
const detailBadges = await page.evaluate(() => document.body.innerText);
check('業務依頼詳細: 優先度バッジが表示される', detailBadges.includes('高'));
check('業務依頼詳細: 期限超過バッジが表示される', detailBadges.includes('期限超過'));

// ---------- 7. 週表示: 期間予定が全日に出る ----------
section('7. 保全計画 週表示（期間予定）');
const weekPlan = await page.evaluate(async () => {
  // plan.js の週表示は「直前の日曜日」始まり（Sun–Sat）。表示週の月〜金に期間予定を作る。
  // ISO週の月曜で作ると、今日が日曜のとき表示週の外になり検出できない（曜日非依存にする）。
  const now = new Date();
  const sun = new Date(now); sun.setDate(now.getDate() - now.getDay()); // 表示週の開始（直前の日曜）
  const mon = new Date(sun); mon.setDate(sun.getDate() + 1);            // 表示週の月曜
  const fri = new Date(sun); fri.setDate(sun.getDate() + 5);            // 表示週の金曜
  const f = (d) => d.toLocaleDateString('sv-SE');
  const r = await fetch('/api/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E週跨ぎ予定', plan_type: 'construction', planned_date: f(mon), planned_end_date: f(fri) }),
  });
  return r.status;
});
check('期間予定の登録', weekPlan === 201, `status=${weekPlan}`);
await page.goto(`${BASE}/pages/plan`, { waitUntil: 'networkidle' });
// 月表示の描画完了を待ってから「週」に切り替える（読み込み中にクリックすると、
// 後着した月表示の描画が週表示を上書きして .cal-week-col が0個になるフレークがCIで出る）
await page.waitForFunction(() => !!document.querySelector('.cal-grid'), { timeout: 10000 }).catch(() => {});
await page.click('button:has-text("週")');
// 週表示の7列が揃い、対象予定が現れるまで条件待ち（固定1秒待ちは遅いCIで不足する）
await page.waitForFunction(() => document.querySelectorAll('.cal-week-col').length >= 7, { timeout: 10000 }).catch(() => {});
await page.waitForFunction(
  () => [...document.querySelectorAll('.cal-week-col')].filter((c) => c.innerText.includes('E2E週跨ぎ予定')).length >= 5,
  { timeout: 10000 }
).catch(() => {});
const weekHits = await page.evaluate(() =>
  [...document.querySelectorAll('.cal-week-col')].filter((c) => c.innerText.includes('E2E週跨ぎ予定')).length);
check('週表示で5日間すべてに表示', weekHits === 5, `${weekHits}日`);

// 期限超過の自動判定: 予定日を過ぎた pending は overdue として返る（DBは書き換えない）
const odPlan = await page.evaluate(async () => {
  const d = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE'); // 昨日
  const r = await fetch('/api/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E期限超過判定', plan_type: 'other', planned_date: d }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, id: j?.id };
});
check('期限超過テスト用の予定登録', odPlan.status === 201, `status=${odPlan.status}`);
const odList = await api('/api/plans');
const odRow = (odList.json?.plans || []).find((p) => p.title === 'E2E期限超過判定');
check('一覧GET: 期限超過が自動判定される', odRow?.status === 'overdue', `status=${odRow?.status}`);
const odDetail = await api(`/api/plans/${odPlan.id}`);
check('詳細GET: 期限超過が自動判定される', odDetail.json?.plan?.status === 'overdue', `status=${odDetail.json?.plan?.status}`);

// 年間計画は「月単位」で超過判定する（毎月1日登録・当月は超過にしない）。
// 当月1日の annual_only 予定は、月の2日以降でも overdue にならないこと（日単位バグの回帰）。
const curMonth1st = new Date().toLocaleDateString('sv-SE').slice(0, 7) + '-01';
const anThis = await api('/api/plans', { method: 'POST', body: { title: 'E2E年間当月', plan_type: 'inspection', planned_date: curMonth1st, annual_only: true } });
check('年間計画（当月）の登録', anThis.status === 201, `status=${anThis.status}`);
// 先月の annual_only 予定は overdue になること
const prevMonth1st = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toLocaleDateString('sv-SE').slice(0, 7) + '-01'; })();
const anPrev = await api('/api/plans', { method: 'POST', body: { title: 'E2E年間先月', plan_type: 'inspection', planned_date: prevMonth1st, annual_only: true } });
check('年間計画（先月）の登録', anPrev.status === 201, `status=${anPrev.status}`);
const anList = await api('/api/plans?annual_only=1');
const anThisRow = (anList.json?.plans || []).find((p) => p.title === 'E2E年間当月');
const anPrevRow = (anList.json?.plans || []).find((p) => p.title === 'E2E年間先月');
check('年間計画: 当月分は月単位判定で超過にならない', anThisRow?.status === 'pending', `status=${anThisRow?.status}`);
check('年間計画: 先月分は超過になる', anPrevRow?.status === 'overdue', `status=${anPrevRow?.status}`);

// ---------- 7.5 保全計画: 期間予定の「1日だけ削除」----------
section('7.5 保全計画（期間予定の1日だけ削除）');
const addDaysStr = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
const dayDelBase = addDaysStr(new Date(), 10); // 他テストの日付と衝突しない近未来の起点
const dd = (n) => addDaysStr(dayDelBase, n);

// 先頭日を削除 → 開始日が1日進む（レコードは残る。全期間は消えない）
const pHead = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別削除-先頭', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
check('日別削除: 先頭テスト用の予定登録', pHead.status === 201, `status=${pHead.status}`);
const delHead = await api(`/api/plans/${pHead.json?.id}/delete-day`, { method: 'POST', body: { date: dd(0) } });
check('日別削除: 先頭日削除（200・shrunk）', delHead.status === 200 && delHead.json?.mode === 'shrunk', `status=${delHead.status} mode=${delHead.json?.mode}`);
const pHeadAfter = await api(`/api/plans/${pHead.json?.id}`);
check('日別削除: 先頭日削除後、開始日が1日進む', pHeadAfter.json?.plan?.planned_date?.slice(0, 10) === dd(1), `planned_date=${pHeadAfter.json?.plan?.planned_date}`);

// 末尾日を削除 → 終了日が1日戻る
const pTail = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別削除-末尾', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
const delTail = await api(`/api/plans/${pTail.json?.id}/delete-day`, { method: 'POST', body: { date: dd(4) } });
check('日別削除: 末尾日削除（200・shrunk）', delTail.status === 200 && delTail.json?.mode === 'shrunk', `status=${delTail.status} mode=${delTail.json?.mode}`);
const pTailAfter = await api(`/api/plans/${pTail.json?.id}`);
check('日別削除: 末尾日削除後、終了日が1日戻る', pTailAfter.json?.plan?.planned_end_date?.slice(0, 10) === dd(3), `planned_end_date=${pTailAfter.json?.plan?.planned_end_date}`);

// 途中の日を削除 → 前後2件に分割される（他の日程は残る）
const pMid = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別削除-分割', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
const delMid = await api(`/api/plans/${pMid.json?.id}/delete-day`, { method: 'POST', body: { date: dd(2) } });
check('日別削除: 途中の日削除（200・split）', delMid.status === 200 && delMid.json?.mode === 'split' && !!delMid.json?.new_id, `status=${delMid.status} mode=${delMid.json?.mode}`);
const pMidHead = await api(`/api/plans/${pMid.json?.id}`);
const pMidTail = await api(`/api/plans/${delMid.json?.new_id}`);
check('日別削除: 分割後、前半の終了日が削除日の前日', pMidHead.json?.plan?.planned_end_date?.slice(0, 10) === dd(1), `planned_end_date=${pMidHead.json?.plan?.planned_end_date}`);
check('日別削除: 分割後、後半の開始日が削除日の翌日', pMidTail.json?.plan?.planned_date?.slice(0, 10) === dd(3), `planned_date=${pMidTail.json?.plan?.planned_date}`);
check('日別削除: 分割後、後半の終了日は元の終了日のまま', pMidTail.json?.plan?.planned_end_date?.slice(0, 10) === dd(4), `planned_end_date=${pMidTail.json?.plan?.planned_end_date}`);
const midRange = await api(`/api/plans?from=${dd(0)}&to=${dd(5)}`);
const midRangeTitles = (midRange.json?.plans || []).filter((p) => p.title === 'E2E日別削除-分割');
check('日別削除: 分割後、範囲取得に前後2件とも含まれる', midRangeTitles.length === 2, `count=${midRangeTitles.length}`);
const midDayHits = midRangeTitles.filter((p) => p.planned_date?.slice(0, 10) <= dd(2) && (p.planned_end_date || p.planned_date).slice(0, 10) >= dd(2));
check('日別削除: 削除した中日はどちらの分割片の範囲にも含まれない', midDayHits.length === 0, `hits=${midDayHits.length}`);

// 単日予定は「1日だけ削除」＝全体削除と同じ扱い
const pSingle = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別削除-単日', plan_type: 'other', planned_date: dd(0) } });
const delSingle = await api(`/api/plans/${pSingle.json?.id}/delete-day`, { method: 'POST', body: { date: dd(0) } });
check('日別削除: 単日予定は全体削除扱い（200・deleted）', delSingle.status === 200 && delSingle.json?.mode === 'deleted', `status=${delSingle.status} mode=${delSingle.json?.mode}`);
const pSingleAfter = await api(`/api/plans/${pSingle.json?.id}`);
check('日別削除: 単日予定削除後は404', pSingleAfter.status === 404, `status=${pSingleAfter.status}`);

// 期間外の日付を指定すると400エラー
const pRangeCheck = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別削除-範囲外', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(2) } });
const delOutOfRange = await api(`/api/plans/${pRangeCheck.json?.id}/delete-day`, { method: 'POST', body: { date: dd(10) } });
check('日別削除: 期間外の日付指定は400', delOutOfRange.status === 400, `status=${delOutOfRange.status}`);

// UI操作: カレンダーの日付シートから🗑で「その日だけ削除」→前後の日程は残る
const uiPlan = await page.evaluate(async () => {
  const now = new Date();
  const sun = new Date(now); sun.setDate(now.getDate() - now.getDay()); // 表示週の開始（直前の日曜）
  const f = (n) => { const d = new Date(sun); d.setDate(sun.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const r = await fetch('/api/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2EUI日別削除', plan_type: 'construction', planned_date: f(2), planned_end_date: f(4) }), // 火〜木
  });
  return { status: r.status, wed: f(3) };
});
check('UI日別削除テスト用の期間予定登録', uiPlan.status === 201, `status=${uiPlan.status}`);

await page.goto(`${BASE}/pages/plan`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.cal-grid'), { timeout: 10000 }).catch(() => {});
await page.click('button:has-text("週")');
await page.waitForFunction(
  () => [...document.querySelectorAll('.cal-week-col')].some((c) => c.innerText.includes('E2EUI日別削除')),
  { timeout: 10000 }
).catch(() => {});

// 削除する日（水曜）の日付ボタンをクリックしてシートを開く
const wedDayNum = String(Number(uiPlan.wed.slice(-2)));
await page.evaluate((num) => {
  const target = [...document.querySelectorAll('.cal-day-num')].find((b) => b.textContent.trim() === num);
  target?.click();
}, wedDayNum);
// このテスト実行時点で他テスト（週跨ぎ予定・期間予定）が同じ週の水曜に重なることがあるため、
// 対象タイトルを含む行に限定して🗑をクリックする
await page.waitForFunction(
  () => [...document.querySelectorAll('.day-plan-row')].some((r) => r.textContent.includes('E2EUI日別削除') && r.querySelector('.day-plan-del-btn')),
  { timeout: 5000 }
).catch(() => {});
await page.locator('.day-plan-row', { hasText: 'E2EUI日別削除' }).locator('.day-plan-del-btn').click();
// confirm() は page.on('dialog') で自動承諾される。シートが閉じ、カレンダーが再描画されるまで待つ
await page.waitForFunction((title) => {
  if (document.querySelector('.sheet-backdrop')) return false;
  const cols = [...document.querySelectorAll('.cal-week-col')];
  return cols.filter((c) => c.innerText.includes(title)).length === 2;
}, 'E2EUI日別削除', { timeout: 10000 }).catch(() => {});
const afterUiDelete = await page.evaluate((title) =>
  [...document.querySelectorAll('.cal-week-col')].filter((c) => c.innerText.includes(title)).length,
'E2EUI日別削除');
check('UI日別削除: 削除した日だけ消え、前後の日は残る', afterUiDelete === 2, `hits=${afterUiDelete}`);

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
// 送信者本人は既読に数えない（自分の投稿を自分が読んでも既読0のまま）
const chatAfterRead = await api('/api/chat?channel=general&limit=10');
const ownMsg = (chatAfterRead.json?.messages || []).find((m) => m.body === 'E2Eチャットテスト');
check('自分の投稿の既読数は0（送信者除外）', ownMsg?.read_count === 0, `read_count=${ownMsg?.read_count}`);

// 記録化リンク・申し送りテンプレート（チャットを業務の入り口にする2機能）
await page.goto(`${BASE}/pages/chat`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.body.innerText.includes('E2Eチャットテスト'), { timeout: 8000 }).catch(() => {});
const recordHref = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-record-actions a')]
    .map((x) => x.getAttribute('href'))
    .find((h) => h && h.includes('/pages/trouble?new=1')) || null
);
check('チャット: 記録化リンクが本文を引き継ぐ', !!recordHref && decodeURIComponent(recordHref).includes('E2Eチャットテスト'), `href=${recordHref}`);
await page.waitForFunction(() => !!document.querySelector('.chat-tpl-chip'), { timeout: 10000 }).catch(() => {});
const tplValue = await page.evaluate(() => {
  const chip = document.querySelector('.chat-tpl-chip');
  if (!chip) return null;
  chip.click();
  return document.querySelector('#chat-form textarea')?.value ?? null;
});
check('チャット: 申し送りテンプレートが入力欄に挿入される', !!tplValue && tplValue.includes('【'), `value=${tplValue}`);

// 👍確認リアクション（トグル）と meta 反映
const chatMsgId = chatPost.json?.id;
const react1 = await api(`/api/chat/${chatMsgId}`, { method: 'POST', body: { action: 'react' } });
check('リアクション付与（reacted=true）', react1.status === 200 && react1.json?.reacted === true, `status=${react1.status}`);
const listR = await api('/api/chat?channel=general&limit=10');
const metaR = listR.json?.meta?.[chatMsgId];
check('リアクションが meta に反映（名前・my_react）', (metaR?.reactions || []).length === 1 && metaR?.my_react === true, JSON.stringify(metaR));
const react2 = await api(`/api/chat/${chatMsgId}`, { method: 'POST', body: { action: 'react' } });
check('リアクション取り消し（reacted=false）', react2.status === 200 && react2.json?.reacted === false, `status=${react2.status}`);

// 📌ピン留め → ピン一覧・上部バー表示 → 解除
const pin1 = await api(`/api/chat/${chatMsgId}`, { method: 'PUT', body: { pinned: true } });
check('ピン留め（pinned=true）', pin1.status === 200 && pin1.json?.pinned === true, `status=${pin1.status}`);
const listP = await api('/api/chat?channel=general&limit=10');
check('ピン一覧に反映', (listP.json?.pinned || []).some((p) => p.id === chatMsgId));
await page.goto(`${BASE}/pages/chat`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => (document.getElementById('chat-pinned')?.innerText || '').includes('E2Eチャットテスト'),
  { timeout: 10000 }
).catch(() => {});
const pinBarText = await page.evaluate(() => document.getElementById('chat-pinned')?.innerText || '');
check('ピン留めバーに表示される', pinBarText.includes('E2Eチャットテスト'), `bar="${pinBarText.slice(0, 60)}"`);
const unpin = await api(`/api/chat/${chatMsgId}`, { method: 'PUT', body: { pinned: false } });
check('ピン解除（pinned=false）', unpin.status === 200 && unpin.json?.pinned === false, `status=${unpin.status}`);

// 画像添付のサムネイル表示（ファイルメタAPI ?meta=1 のバグ修正回帰）
const up = await page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e11'; ctx.fillRect(0, 0, 8, 8);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const res = await fetch('/api/files?filename=e2e-chat.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  return { status: res.status, json: await res.json().catch(() => null) };
});
check('画像アップロード（201）', up.status === 201, `status=${up.status}`);
const upId = up.json?.file?.id;
const fileMeta = await api(`/api/files/${upId}?meta=1`);
check('ファイルメタAPI（?meta=1）', fileMeta.status === 200 && fileMeta.json?.content_type === 'image/png', JSON.stringify(fileMeta.json));
await api('/api/chat', { method: 'POST', body: { body: 'E2E画像添付', channel: 'general', file_ids: [upId] } });
await page.goto(`${BASE}/pages/chat`, { waitUntil: 'networkidle' });
// 添付メタの取得（?meta=1）→サムネイル描画は非同期のため条件待ち
await page.waitForFunction(() => !!document.querySelector('.chat-msg img.chat-thumb'), { timeout: 10000 }).catch(() => {});
const hasThumb = await page.evaluate(() => !!document.querySelector('.chat-msg img.chat-thumb'));
check('画像添付がサムネイル表示される（バグ修正）', hasThumb);

// ポーリング: 開いたままの画面に新着が1回だけ表示される（二重描画バグの回帰）
await api('/api/chat', { method: 'POST', body: { body: 'E2Eポーリング新着', channel: 'general' } });
await page.waitForTimeout(6500);
const pollCount = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg .chat-body')].filter((b) => b.textContent === 'E2Eポーリング新着').length);
check('ポーリングで新着が1回だけ表示される', pollCount === 1, `count=${pollCount}`);

// ---------- 9.5 機能強化: 点検の前回値表示・部品の棚卸モード ----------
section('9.5 機能強化（前回値表示・棚卸モード）');
// 前回値: 数値項目の入力欄に、直近の点検の値と差分が表示される
const eqLast = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-LAST', name: 'E2E前回値設備' } });
const mLast = await api('/api/inspections/masters', { method: 'POST', body: { equipment_id: eqLast.json?.id, name: 'E2E圧力', input_type: 'number', unit: 'MPa' } });
const insp1 = await api('/api/inspections', { method: 'POST', body: { equipment_id: eqLast.json?.id, inspected_at: new Date().toISOString(), items: [{ master_id: mLast.json?.id, value: 0.45 }] } });
check('前回値テスト用の点検登録', insp1.status === 201, `status=${insp1.status}`);
await page.goto(`${BASE}/pages/inspection?new=1&equipment_id=${eqLast.json?.id}`, { waitUntil: 'networkidle' });
// チェックリスト＋前回値の取得は非同期のため条件待ち（固定待ちは遅いCIで不足する）
await page.waitForFunction(() => !!document.querySelector('.last-value-hint'), { timeout: 10000 }).catch(() => {});
const lastHintText = await page.evaluate(() => document.querySelector('.last-value-hint')?.textContent || '');
check('点検入力に前回値が表示される', lastHintText.includes('前回 0.45'), `hint="${lastHintText}"`);

// 棚卸モード: 実数を入力→一括確定で在庫が調整される
const stPart = await api('/api/parts', { method: 'POST', body: { name: 'E2E棚卸部品', quantity: 10, safety_stock: 1 } });
check('棚卸テスト用の部品登録', stPart.status === 201, `status=${stPart.status}`);
await page.goto(`${BASE}/pages/parts`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('button'), { timeout: 10000 }).catch(() => {});
await page.click('button:has-text("棚卸")');
await page.fill('input[type="search"]', 'E2E棚卸部品');
// 検索デバウンス300ms + 再取得 → 棚卸入力欄が出るまで条件待ち
await page.waitForFunction(() => !!document.querySelector('.stocktake-input'), { timeout: 10000 }).catch(() => {});
await page.fill('.stocktake-input', '7');
await page.click('button:has-text("一括確定")');
// adjust の反映を最大5秒リトライで確認（確定は confirm→逐次POST→alert の非同期処理）
let stQty = null;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(500);
  const r = await api(`/api/parts/${stPart.json?.id}`);
  stQty = r.json?.part?.quantity;
  if (stQty === 7) break;
}
check('棚卸モードで在庫が実数に更新される', stQty === 7, `qty=${stQty}`);

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
