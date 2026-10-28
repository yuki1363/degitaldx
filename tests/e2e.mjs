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
//     9. ユーティリティ日報（1日1件ガード・異常判定・横断検索）
//    10. オフラインでの静的ページ表示（SWプリキャッシュ）

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
// CSP（_headers）で本来の動作が妨げられていないかをテスト全体で監視する
const cspViolations = [];
page.on('console', (m) => {
  if (/Content Security Policy/i.test(m.text())) cspViolations.push(`${page.url()}: ${m.text()}`);
});
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
  'plan-annual', 'trouble', 'repair', 'parts', 'report', 'utility', 'dashboard', 'admin', 'chat', 'search', 'notifications',
  'ai-support'];
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
// D1 の bind 上限（100）対策: 長音付きカタカナを多く入れても検索全体が失敗せず、
// 上限に収まらない語はその種別でだけ条件から外して ignored_keywords で知らせる
// （ローカルの SQLite は上限が大きく失敗は再現しないため、語が外れて先頭語でヒットすることで確認する）
// 全語を含むトラブルを用意し、語を外しても（残った語の AND で）ヒットすることを確認する
await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2E多語 コンプレッサー モーター フィルター ポンプ' } });
const manyKw = 'E2E多語 コンプレッサー モーター フィルター ポンプ';
const sMany = await api(`/api/search?q=${encodeURIComponent(manyKw)}`);
check('横断検索: 長音カタカナ多語でも200', sMany.status === 200, `status=${sMany.status}`);
check('横断検索: 上限に入らない語を外してもトラブルがヒット', (sMany.json?.results || []).some((r) => r.type === 'trouble'));
const manyIgnored = sMany.json?.ignored_keywords || [];
check('横断検索: 外した語を ignored_keywords で返す', manyIgnored.length > 0 && manyIgnored.every((k) => manyKw.split(' ').includes(k)),
  JSON.stringify(manyIgnored));
check('横断検索: 少語では ignored_keywords が空', (s1.json?.ignored_keywords || []).length === 0);
await page.goto(`${BASE}/pages/search?q=${encodeURIComponent(manyKw)}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.search-notice'), { timeout: 10000 }).catch(() => {});
check('横断検索: 外した語の注意書きが画面に出る',
  await page.evaluate((kw) => !!kw && (document.querySelector('.search-notice')?.textContent || '').includes(kw), manyIgnored[0]));
// JST の日付境界: 日時列は UTC 保存。JST 2031/10/01 08:00（= 2031-09-30T23:00Z）の記録は、
// 期間「2031/10/01」に入り「2031/09/30」には入らない（UTC の日付境界だと逆になっていた）
const jstEarly = await api('/api/troubles', { method: 'POST', body: { occurred_at: '2031-09-30T23:00:00Z', phenomenon: 'E2E早朝JSTトラブル' } });
check('JST境界: 早朝のトラブル登録（201）', jstEarly.status === 201, `status=${jstEarly.status}`);
const jstOct = await api('/api/troubles?from=2031-10-01&to=2031-10-01');
check('JST境界: トラブル一覧の期間（当日）に入る', (jstOct.json?.troubles || []).some((t) => t.id === jstEarly.json?.id));
const jstSep = await api('/api/troubles?from=2031-09-30&to=2031-09-30');
check('JST境界: トラブル一覧の前日には入らない', !(jstSep.json?.troubles || []).some((t) => t.id === jstEarly.json?.id));
const jstSearch = await api(`/api/search?q=${encodeURIComponent('E2E早朝JST')}&type=trouble&from=2031-10-01&to=2031-10-01`);
const jstHit = (jstSearch.json?.results || []).find((r) => r.id === jstEarly.json?.id);
check('JST境界: 横断検索の期間に入り、日付は JST（2031-10-01）', jstHit?.date === '2031-10-01', `date=${jstHit?.date}`);
const jstStats = await api('/api/stats?from=2031-10-01&to=2031-10-31');
check('JST境界: ダッシュボード集計は JST の月（2031-10）に数える',
  (jstStats.json?.trouble_trend || []).some((m) => m.month === '2031-10' && m.count >= 1)
  && !(jstStats.json?.trouble_trend || []).some((m) => m.month === '2031-09'),
  JSON.stringify(jstStats.json?.trouble_trend));
const jstUtil = await page.evaluate(async () => {
  const u = await import('/js/util.js');
  return { d: u.toJstDateStr('2031-09-30T23:00:00Z'), f: u.formatDate('2031-09-30T23:00:00Z'), today: u.jstTodayStr() };
});
check('JST境界: 画面の日付変換（toJstDateStr / formatDate）', jstUtil.d === '2031-10-01' && jstUtil.f === '2031/10/01', JSON.stringify(jstUtil));
check('JST境界: jstTodayStr は JST の今日', jstUtil.today === new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10), JSON.stringify(jstUtil));
await api(`/api/troubles/${jstEarly.json?.id}`, { method: 'DELETE' });
// 検索結果画面にCSV出力ボタンが出る（ダッシュボードの抽出レポートから集約した機能）
await page.goto(`${BASE}/pages/search?q=${encodeURIComponent('フィルム機')}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.search-result-header button'), { timeout: 10000 }).catch(() => {});
const hasCsvBtn = await page.evaluate(() =>
  [...document.querySelectorAll('.search-result-header button')].some((b) => b.textContent.includes('CSV'))
);
check('横断検索: 結果にCSV出力ボタンが出る', hasCsvBtn);

// ---------- 2.5 類似トラブル事例・AI提案 ----------
section('2.5 類似トラブル事例・AI提案');
// 現象が重なる2件を作る（あいまい/OR検索の確認用）
const simA = await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2E類似 コンプレッサ 異音', cause: 'ベアリング摩耗', countermeasure: 'ベアリング交換' } });
const simB = await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2E類似 コンプレッサ 停止', cause: '過負荷', countermeasure: 'リセット' } });
check('類似検索用トラブルの登録（201）', simA.status === 201 && simB.status === 201, `a=${simA.status} b=${simB.status}`);

const sim1 = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('コンプレッサ 異音')}`);
check('類似トラブル: 現象キーワードでヒット', (sim1.json?.similar || []).some((s) => s.id === simA.json?.id));
// OR検索なので「コンプレッサ」を含むもう1件も拾う（再現率重視）
check('類似トラブル: OR検索で関連事例も拾う', (sim1.json?.similar || []).some((s) => s.id === simB.json?.id));

const sim2 = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('コンプレッサ')}&exclude_id=${simA.json?.id}`);
check('類似トラブル: exclude_idで自分を除外', Array.isArray(sim2.json?.similar) && !sim2.json.similar.some((s) => s.id === simA.json?.id));

// あいまい: ひらがなで入力してもカタカナ登録がヒットする
const sim3 = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('こんぷれっさ')}`);
check('類似トラブル: あいまい（かなゆれ）でヒット', (sim3.json?.similar || []).length > 0);

// 一致した語の多い順に並べる: よくある語だけに一致する新しい記録が多数あっても、全部の語に一致する古い記録が出る
const rankOld = await api('/api/troubles', { method: 'POST', body: { occurred_at: '2020-01-10T01:00:00Z', phenomenon: 'E2E順位圧縮機 E2E順位異音', cause: '古い事例' } });
const rankNew = [];
for (let i = 0; i < 12; i++) {
  rankNew.push(await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: `E2E順位異音 その${i}` } }));
}
const simRank = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('E2E順位圧縮機 E2E順位異音')}&limit=10`);
check('類似トラブル: 全部の語に一致する古い記録が先頭（新しい順だけで切らない）', simRank.json?.similar?.[0]?.id === rankOld.json?.id,
  JSON.stringify((simRank.json?.similar || []).slice(0, 3).map((x) => x.phenomenon)));
// 設備名・ジャンルでも見つかる（現象に設備名を書いていない記録）
const simEq = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-SIMEQ', name: 'E2E類似用ボイラー' } });
const simEqT = await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: '圧力が上がらない', equipment_id: simEq.json?.id } });
const simByEq = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('E2E類似用ボイラー')}`);
check('類似トラブル: 設備名でも見つかる', (simByEq.json?.similar || []).some((x) => x.id === simEqT.json?.id), JSON.stringify(simByEq.json));
const simByCode = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('E2E-SIMEQ')}`);
check('類似トラブル: 設備番号でも見つかる', (simByCode.json?.similar || []).some((x) => x.id === simEqT.json?.id));
check('類似トラブル: 応答に検索用の内部列（hay）を含めない', !(simByEq.json?.similar || []).some((x) => 'hay' in x));
// 4語目・5語目も使う（以前は3語目まで）
const sim5w = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('あいう かきく さしす E2E類似用ボイラー たちつ')}`);
check('類似トラブル: 4語目以降の語でも見つかる', (sim5w.json?.similar || []).some((x) => x.id === simEqT.json?.id));
for (const t of [rankOld, ...rankNew, simEqT]) await api(`/api/troubles/${t.json?.id}`, { method: 'DELETE' });
await api(`/api/equipment/${simEq.json?.id}`, { method: 'DELETE' });

// 現象2文字未満はノイズ防止で空配列
const sim4 = await api(`/api/troubles/similar?phenomenon=${encodeURIComponent('あ')}`);
check('類似トラブル: 1文字は空配列（ノイズ防止）', Array.isArray(sim4.json?.similar) && sim4.json.similar.length === 0);

// フォームUI: 現象を入力すると類似事例パネルが出る
await page.goto(`${BASE}/pages/trouble?new=1`, { waitUntil: 'networkidle' });
await page.fill('textarea[placeholder*="異音"]', 'コンプレッサ 異音');
await page.waitForFunction(() => document.body.innerText.includes('類似のトラブル事例'), { timeout: 5000 }).catch(() => {});
check('類似トラブル: フォームにパネルが表示される', await page.evaluate(() => document.body.innerText.includes('類似のトラブル事例')));

// [ai] 未構成のE2E環境では ai_enabled:false → AIボタンを出さない
const meAiRes = await api('/api/me');
check('/api/me: ai_enabled が false（[ai]未構成）', meAiRes.json?.ai_enabled === false, `ai_enabled=${meAiRes.json?.ai_enabled}`);
// 画像AI（計器の📷読み取り・銘板読み取り）は既定オフ（AI_VISION_ENABLED=1 のときだけ出す）
check('/api/me: ai_vision_enabled が既定で false',
  meAiRes.json?.ai_vision_enabled === false, `ai_vision_enabled=${meAiRes.json?.ai_vision_enabled}`);
check('類似トラブル: AI未構成ならAIボタンを出さない',
  !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('AIに原因・対策')))));

// POST /api/ai/suggest-trouble は [ai] 未構成なら 503
const aiRes = await api('/api/ai/suggest-trouble', { method: 'POST', body: { phenomenon: 'コンプレッサ 異音' } });
check('AI提案: [ai]未構成なら503', aiRes.status === 503, `status=${aiRes.status}`);
await page.evaluate(() => localStorage.removeItem('draft:trouble-new')); // 後続の下書きテストに影響させない

// ---------- 2.6 類似部品検索（あいまい） ----------
section('2.6 類似部品検索（あいまい）');
// 型番・部品名が近い2件（型番は設計上重複可＝別ラインに同じ部品）
const dupPa = await api('/api/parts', { method: 'POST', body: { name: 'E2E類似ベアリング', model_no: '6205ZZ', line_name: 'JP1号', quantity: 3, safety_stock: 1 } });
const dupPb = await api('/api/parts', { method: 'POST', body: { name: 'E2E類似ベアリング', model_no: '6205ZZ', line_name: 'JP2号', quantity: 5, safety_stock: 1 } });
check('類似部品用の登録（201）', dupPa.status === 201 && dupPb.status === 201, `a=${dupPa.status} b=${dupPb.status}`);

// スペース入りの複数語がAND検索でヒットする（旧実装は substring 一致で実質0件だった不具合の回帰）
const pq1 = await api(`/api/parts?q=${encodeURIComponent('ベアリング 6205')}`);
check('類似部品: 複数語ANDでヒット（スペース入り）',
  (pq1.json?.parts || []).filter((p) => p.name === 'E2E類似ベアリング').length === 2,
  `count=${(pq1.json?.parts || []).filter((p) => p.name === 'E2E類似ベアリング').length}`);

// exclude_id で自分を除外（もう1件は残る）
const pq2 = await api(`/api/parts?q=${encodeURIComponent('6205ZZ')}&exclude_id=${dupPa.json?.id}`);
check('類似部品: exclude_idで自分を除外',
  !(pq2.json?.parts || []).some((p) => p.id === dupPa.json?.id) && (pq2.json?.parts || []).some((p) => p.id === dupPb.json?.id));

// フォームUI: 部品名を入力すると類似部品ヒントが出る（保存は妨げない）
await page.goto(`${BASE}/pages/parts?new=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.fill('input[placeholder*="ベアリング 6205"]', 'E2E類似ベアリング');
await page.waitForFunction(() => document.body.innerText.includes('類似の部品が見つかりました'), { timeout: 5000 }).catch(() => {});
check('類似部品: フォームにヒントが表示される', await page.evaluate(() => document.body.innerText.includes('類似の部品が見つかりました')));

// 在庫検索: 「類似の在庫」（キーワードの一部一致＝OR）も返す（include_similar=1）
const ptSimA = await api('/api/parts', { method: 'POST', body: { name: 'E2ESIMfilter', model_no: 'ZZQ-777', line_name: 'SIMライン', quantity: 1, safety_stock: 0 } });
const ptSimB = await api('/api/parts', { method: 'POST', body: { name: 'E2ESIMpump', model_no: 'ZZQ-888', line_name: 'SIMライン', quantity: 1, safety_stock: 0 } });
check('類似在庫用の登録（201）', ptSimA.status === 201 && ptSimB.status === 201, `a=${ptSimA.status} b=${ptSimB.status}`);
const ptSimQ = encodeURIComponent('E2ESIMfilter E2ESIMpump'); // 両方の語を含む部品は無い
const ptSimRes = await api(`/api/parts?q=${ptSimQ}&include_similar=1`);
const ptExactIds = new Set((ptSimRes.json?.parts || []).map((p) => p.id));
const ptSimIds = new Set((ptSimRes.json?.similar || []).map((p) => p.id));
check('類似在庫: 完全一致(AND)には出ない', !ptExactIds.has(ptSimA.json?.id) && !ptExactIds.has(ptSimB.json?.id), `parts=${[...ptExactIds]}`);
check('類似在庫: 類似(OR)に両方の在庫が出る', ptSimIds.has(ptSimA.json?.id) && ptSimIds.has(ptSimB.json?.id), `similar=${[...ptSimIds]}`);
const ptNoSim = await api(`/api/parts?q=${ptSimQ}`);
check('類似在庫: include_similar無しでは similar を返さない（従来の呼び出しに非影響）', ptNoSim.json?.similar === undefined, `similar=${JSON.stringify(ptNoSim.json?.similar)}`);
// UI: 一覧の検索で「類似の在庫」見出しが表示される
await page.goto(`${BASE}/pages/parts`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.fill('input[type="search"]', 'E2ESIMfilter E2ESIMpump');
await page.waitForFunction(() => document.body.innerText.includes('類似の在庫'), { timeout: 5000 }).catch(() => {});
check('類似在庫: 一覧に「類似の在庫」見出しが表示される', await page.evaluate(() => document.body.innerText.includes('類似の在庫')));

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

// 2つのタブ（PWAの窓とブラウザ等）で同時に復帰しても二重送信しない（Web Locks で端末内の送信を1つに絞る）
const page2 = await context.newPage();
await page2.goto(`${BASE}/pages/trouble`, { waitUntil: 'networkidle' });
await page.goto(`${BASE}/pages/trouble?new=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await context.setOffline(true);
await page.fill('textarea[placeholder*="異音"]', 'E2E二重送信防止');
await page.click('button:has-text("保存")');
await page.waitForTimeout(1200);
await context.setOffline(false);
await Promise.all([page, page2].map((pg) => pg.evaluate(() => window.dispatchEvent(new Event('online')))));
await page.waitForTimeout(3000);
const dupCount = ((await api('/api/troubles')).json?.troubles || []).filter((t) => t.phenomenon === 'E2E二重送信防止').length;
check('送信キュー: 2つのタブで同時に復帰しても1件だけ送信される', dupCount === 1, `件数=${dupCount}`);
// 送信しなかった側のタブも、送信が終わったら送信待ちバーを消す（古い件数が残り続けない）
const staleBars = await Promise.all([page, page2].map((pg) => pg.evaluate(() => !!document.getElementById('offline-queue-bar'))));
check('送信キュー: 送信後はどちらのタブにも送信待ちバーが残らない', staleBars.every((b) => !b), JSON.stringify(staleBars));
await page2.close();

// 保存ボタンの連打で二重登録しない（保存中はボタンを無効化）
await page.goto(`${BASE}/pages/repair?new=1`, { waitUntil: 'networkidle' });
await page.fill('input[placeholder="例: 3号機 ポンプ異音"]', 'E2E連打防止依頼');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
  btn.click(); btn.click(); // 遅い回線での2回タップを再現（1回目の送信中に2回目）
});
await page.waitForTimeout(1500);
const rpCount = ((await api('/api/repairs')).json?.repairs || []).filter((r) => r.title === 'E2E連打防止依頼').length;
check('業務依頼: 保存ボタンを2回押しても1件だけ登録される', rpCount === 1, `件数=${rpCount}`);
const dblPart = await api('/api/parts', { method: 'POST', body: { name: 'E2E連打防止部品', quantity: 5, safety_stock: 0 } });
await page.goto(`${BASE}/pages/parts?id=${dblPart.json?.id}`, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const sel = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'out'));
  sel.value = 'out';
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '更新');
  btn.click(); btn.click();
});
await page.waitForTimeout(1500);
const dblQty = (await api(`/api/parts/${dblPart.json?.id}`)).json?.part?.quantity;
check('部品: 出庫の「更新」を2回押しても1回分だけ反映される', dblQty === 4, `在庫=${dblQty}`);

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

// ---------- 6.7 通知センター: 期限超過フィルタ ----------
// 通知の自動生成（checkOverdueAndNotify）は1時間に1回の裏実行のため、E2E実行中の
// タイミングに依存させず（テストの都度アプリを開いた直後だけ判定される仕様のため、
// wrangler dev の1プロセス内では最初の1回しか走らない）、ここではフィルタUIの存在のみ確認する。
// 実際に通知が生成されることは手元検証で確認済み（チャットの10日自動削除と同じ検証方針）。
section('6.7 通知センター（期限超過フィルタ）');
await page.goto(`${BASE}/pages/notifications`, { waitUntil: 'networkidle' });
const hasOverdueFilter = await page.evaluate(() => document.body.innerText.includes('期限超過'));
check('通知センター: 「⏰ 期限超過」フィルタが表示される', hasOverdueFilter);

// ---------- 6.8 Web Push 購読API ----------
// 実際のプッシュ配信（暗号化・VAPID署名）はネットワークを要するためE2E環境では検証できない
// （scratchpad で Web Crypto の暗号化→復号ラウンドトリップ・VAPID署名検証・失効購読の自動削除は
// 別途確認済み）。ここでは購読の登録・解除・入力検証というAPI契約の部分を確認する。
section('6.8 Web Push 購読API');
const fakeSub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
  keys: { p256dh: 'BEXAMPLE_P256DH_KEY_BASE64URL', auth: 'EXAMPLE_AUTH_BASE64URL' },
};
const subRes = await api('/api/push/subscribe', { method: 'POST', body: fakeSub });
check('Push購読: 登録できる（201）', subRes.status === 201, `status=${subRes.status}`);
const subAgain = await api('/api/push/subscribe', { method: 'POST', body: fakeSub });
check('Push購読: 同じendpointを再登録しても成功する（ON CONFLICT UPDATE）', subAgain.status === 201, `status=${subAgain.status}`);
const subMissing = await api('/api/push/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
check('Push購読: keys不足は400', subMissing.status === 400, `status=${subMissing.status}`);
const subEvil = await api('/api/push/subscribe', { method: 'POST', body: { ...fakeSub, endpoint: 'https://attacker.example.com/collect' } });
check('Push購読: プッシュサービス以外のURLは400（SSRF防止）', subEvil.status === 400, `status=${subEvil.status}`);
const subLookalike = await api('/api/push/subscribe', { method: 'POST', body: { ...fakeSub, endpoint: 'https://fcm.googleapis.com.attacker.example/x' } });
check('Push購読: 似せたドメインも400', subLookalike.status === 400, `status=${subLookalike.status}`);
const unsubRes = await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: fakeSub.endpoint } });
check('Push購読解除: 200', unsubRes.status === 200, `status=${unsubRes.status}`);
const unsubMissing = await api('/api/push/unsubscribe', { method: 'POST', body: {} });
check('Push購読解除: endpoint不足は400', unsubMissing.status === 400, `status=${unsubMissing.status}`);
const meRes = await api('/api/me');
check('/api/me: vapid_public_key フィールドが存在する（未設定ならnull）', 'vapid_public_key' in (meRes.json || {}), JSON.stringify(meRes.json));

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
// 年間計画は月を「今の会計年度（10月始まり）」に当てはめて判定する。10月は年度の初月で、先月（9月）は
// 前年度に属する＝今年度の9月（来年9月）として扱うため超過にならない。それ以外の月は先月分が超過。
const isFyFirstMonth = new Date().toLocaleDateString('sv-SE').slice(5, 7) === '10';
check(isFyFirstMonth ? '年間計画: 年度初月（10月）は前年度の9月分を超過にしない' : '年間計画: 先月分は超過になる',
  anPrevRow?.status === (isFyFirstMonth ? 'pending' : 'overdue'), `status=${anPrevRow?.status}`);

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

// ---------- 7.6 保全計画: 期間予定の「1日だけ完了」----------
section('7.6 保全計画（期間予定の1日だけ完了）');

// 先頭日を完了 → その日は完了済みの単日レコードに切り出され、残りは未完了のまま開始日が進む
const cHead = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-先頭', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
const compHead = await api(`/api/plans/${cHead.json?.id}/complete-day`, { method: 'POST', body: { date: dd(0) } });
check('日別完了: 先頭日完了（200・split）', compHead.status === 200 && compHead.json?.mode === 'split' && !!compHead.json?.done_id, `status=${compHead.status} mode=${compHead.json?.mode}`);
const cHeadAfter = await api(`/api/plans/${cHead.json?.id}`);
check('日別完了: 先頭日完了後、残りは未完了のまま開始日が1日進む', cHeadAfter.json?.plan?.status === 'pending' && cHeadAfter.json?.plan?.planned_date?.slice(0, 10) === dd(1), `status=${cHeadAfter.json?.plan?.status} planned_date=${cHeadAfter.json?.plan?.planned_date}`);
const cHeadDone = await api(`/api/plans/${compHead.json?.done_id}`);
check('日別完了: 切り出された日は完了済みの単日レコード', cHeadDone.json?.plan?.status === 'done' && cHeadDone.json?.plan?.planned_date?.slice(0, 10) === dd(0) && !cHeadDone.json?.plan?.planned_end_date, `plan=${JSON.stringify(cHeadDone.json?.plan)}`);

// 末尾日を完了 → 終了日が1日戻り、残りは未完了のまま
const cTail = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-末尾', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
const compTail = await api(`/api/plans/${cTail.json?.id}/complete-day`, { method: 'POST', body: { date: dd(4) } });
check('日別完了: 末尾日完了（200・split）', compTail.status === 200 && compTail.json?.mode === 'split', `status=${compTail.status} mode=${compTail.json?.mode}`);
const cTailAfter = await api(`/api/plans/${cTail.json?.id}`);
check('日別完了: 末尾日完了後、残りは未完了のまま終了日が1日戻る', cTailAfter.json?.plan?.status === 'pending' && cTailAfter.json?.plan?.planned_end_date?.slice(0, 10) === dd(3), `status=${cTailAfter.json?.plan?.status} planned_end_date=${cTailAfter.json?.plan?.planned_end_date}`);

// 途中の日を完了 → 前後は未完了のまま2件に分割され、間に完了済みの単日レコードが挟まる
const cMid = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-分割', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(4) } });
const compMid = await api(`/api/plans/${cMid.json?.id}/complete-day`, { method: 'POST', body: { date: dd(2) } });
check('日別完了: 途中の日完了（200・split）', compMid.status === 200 && compMid.json?.mode === 'split' && !!compMid.json?.done_id && !!compMid.json?.tail_id, `status=${compMid.status} mode=${compMid.json?.mode}`);
const cMidHead = await api(`/api/plans/${cMid.json?.id}`);
const cMidDone = await api(`/api/plans/${compMid.json?.done_id}`);
const cMidTail = await api(`/api/plans/${compMid.json?.tail_id}`);
check('日別完了: 分割後、前半は未完了のまま終了日が完了日の前日', cMidHead.json?.plan?.status === 'pending' && cMidHead.json?.plan?.planned_end_date?.slice(0, 10) === dd(1), `plan=${JSON.stringify(cMidHead.json?.plan)}`);
check('日別完了: 分割後、完了日は完了済みの単日レコード', cMidDone.json?.plan?.status === 'done' && cMidDone.json?.plan?.planned_date?.slice(0, 10) === dd(2) && !cMidDone.json?.plan?.planned_end_date, `plan=${JSON.stringify(cMidDone.json?.plan)}`);
check('日別完了: 分割後、後半は未完了のまま元の終了日を保持', cMidTail.json?.plan?.status === 'pending' && cMidTail.json?.plan?.planned_date?.slice(0, 10) === dd(3) && cMidTail.json?.plan?.planned_end_date?.slice(0, 10) === dd(4), `plan=${JSON.stringify(cMidTail.json?.plan)}`);
const midCompleteRange = await api(`/api/plans?from=${dd(0)}&to=${dd(5)}`);
const midCompleteTitles = (midCompleteRange.json?.plans || []).filter((p) => p.title === 'E2E日別完了-分割');
check('日別完了: 分割後、範囲取得に3件（前半・完了日・後半）とも含まれる', midCompleteTitles.length === 3, `count=${midCompleteTitles.length}`);

// 単日予定は「1日だけ完了」＝全体完了と同じ扱い（分割しない）
const cSingle = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-単日', plan_type: 'other', planned_date: dd(6) } });
const compSingle = await api(`/api/plans/${cSingle.json?.id}/complete-day`, { method: 'POST', body: { date: dd(6) } });
check('日別完了: 単日予定は全体完了扱い（200・done）', compSingle.status === 200 && compSingle.json?.mode === 'done', `status=${compSingle.status} mode=${compSingle.json?.mode}`);
const cSingleAfter = await api(`/api/plans/${cSingle.json?.id}`);
check('日別完了: 単日予定完了後はstatus=done（同一レコード）', cSingleAfter.json?.plan?.status === 'done', `status=${cSingleAfter.json?.plan?.status}`);

// 2日間の期間で片方を完了すると、残りは単日になり planned_end_date が null になる
const cTwoDay = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-2日間', plan_type: 'other', planned_date: dd(7), planned_end_date: dd(8) } });
await api(`/api/plans/${cTwoDay.json?.id}/complete-day`, { method: 'POST', body: { date: dd(7) } });
const cTwoDayAfter = await api(`/api/plans/${cTwoDay.json?.id}`);
check('日別完了: 2日間の先頭完了後、残りは単日になりplanned_end_dateがnull', cTwoDayAfter.json?.plan?.planned_date?.slice(0, 10) === dd(8) && !cTwoDayAfter.json?.plan?.planned_end_date, `plan=${JSON.stringify(cTwoDayAfter.json?.plan)}`);

// 期間外の日付を指定すると400エラー
const cRangeCheck = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-範囲外', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(2) } });
const compOutOfRange = await api(`/api/plans/${cRangeCheck.json?.id}/complete-day`, { method: 'POST', body: { date: dd(10) } });
check('日別完了: 期間外の日付指定は400', compOutOfRange.status === 400, `status=${compOutOfRange.status}`);

// すでに完了済みの予定への日別完了は400エラー
const cAlreadyDone = await api('/api/plans', { method: 'POST', body: { title: 'E2E日別完了-完了済み', plan_type: 'other', planned_date: dd(0), planned_end_date: dd(2) } });
await api(`/api/plans/${cAlreadyDone.json?.id}`, { method: 'PUT', body: { status: 'done' } });
const compAlreadyDone = await api(`/api/plans/${cAlreadyDone.json?.id}/complete-day`, { method: 'POST', body: { date: dd(0) } });
check('日別完了: すでに完了済みの予定は400', compAlreadyDone.status === 400, `status=${compAlreadyDone.status}`);

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

// UI操作: カレンダーの日付シートから✓で「その日だけ完了」→他の日程は未完了のまま残る
const uiCompletePlan = await page.evaluate(async () => {
  const now = new Date();
  const sun = new Date(now); sun.setDate(now.getDate() - now.getDay());
  const f = (n) => { const d = new Date(sun); d.setDate(sun.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const r = await fetch('/api/plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2EUI日別完了', plan_type: 'construction', planned_date: f(2), planned_end_date: f(4) }), // 火〜木
  });
  return { status: r.status, wed: f(3) };
});
check('UI日別完了テスト用の期間予定登録', uiCompletePlan.status === 201, `status=${uiCompletePlan.status}`);

await page.goto(`${BASE}/pages/plan`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.cal-grid'), { timeout: 10000 }).catch(() => {});
await page.click('button:has-text("週")');
await page.waitForFunction(
  () => [...document.querySelectorAll('.cal-week-col')].some((c) => c.innerText.includes('E2EUI日別完了')),
  { timeout: 10000 }
).catch(() => {});

// 完了する日（水曜）の日付ボタンをクリックしてシートを開く
const wedDayNum2 = String(Number(uiCompletePlan.wed.slice(-2)));
await page.evaluate((num) => {
  const target = [...document.querySelectorAll('.cal-day-num')].find((b) => b.textContent.trim() === num);
  target?.click();
}, wedDayNum2);
await page.waitForFunction(
  () => [...document.querySelectorAll('.day-plan-row')].some((r) => r.textContent.includes('E2EUI日別完了') && r.querySelector('.day-plan-done-btn')),
  { timeout: 5000 }
).catch(() => {});
await page.locator('.day-plan-row', { hasText: 'E2EUI日別完了' }).locator('.day-plan-done-btn').click();
// confirm() は自動承諾される。シートが閉じ、完了日が単日レコードとして切り出され3日分（火・水・木）表示になるまで待つ
await page.waitForFunction((title) => {
  if (document.querySelector('.sheet-backdrop')) return false;
  const cols = [...document.querySelectorAll('.cal-week-col')];
  return cols.filter((c) => c.innerText.includes(title)).length === 3;
}, 'E2EUI日別完了', { timeout: 10000 }).catch(() => {});
const afterUiComplete = await page.evaluate((title) =>
  [...document.querySelectorAll('.cal-week-col')].filter((c) => c.innerText.includes(title)).length,
'E2EUI日別完了');
check('UI日別完了: 完了した日は完了済みの単日レコードとして残り、他の日も未完了のまま残る', afterUiComplete === 3, `hits=${afterUiComplete}`);

// ---------- 7.7 工事連絡書の印刷記録 ----------
section('7.7 工事連絡書の印刷記録（POST /api/plans/:id/printed）');
const prPlan = await api('/api/plans', { method: 'POST', body: { title: 'E2E印刷記録', plan_type: 'construction', planned_date: addDaysStr(new Date(), 2) } });
check('印刷記録: テスト用の工事予定登録', prPlan.status === 201, `status=${prPlan.status}`);
const prBefore = await api(`/api/plans/${prPlan.json?.id}`);
check('印刷記録: 登録直後は printed_at が未設定', !prBefore.json?.plan?.printed_at, `printed_at=${prBefore.json?.plan?.printed_at}`);
const prPost = await api(`/api/plans/${prPlan.json?.id}/printed`, { method: 'POST' });
check('印刷記録: 印刷記録API（200・printed_at返却）', prPost.status === 200 && !!prPost.json?.printed_at, `status=${prPost.status} printed_at=${prPost.json?.printed_at}`);
const prAfter = await api(`/api/plans/${prPlan.json?.id}`);
check('印刷記録: 記録後は詳細に printed_at が入る', !!prAfter.json?.plan?.printed_at, `printed_at=${prAfter.json?.plan?.printed_at}`);
const prMissing = await api('/api/plans/99999999/printed', { method: 'POST' });
check('印刷記録: 存在しない計画は404', prMissing.status === 404, `status=${prMissing.status}`);


// ---------- 7.8 年間計画の会計年度判定・年度リセット/部品全置き換えの権限 ----------
section('7.8 年間計画（年度またぎの期限超過）・管理者限定操作');
// 指定ユーザーとして API を呼ぶ（Access のメールヘッダーで識別。JWT 未設定のローカルでのみ有効）
const apiAs = (email, path, opts) => page.evaluate(async ({ email, path, opts }) => {
  const res = await fetch(path, {
    method: opts?.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': email },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* JSONでないレスポンス */ }
  return { status: res.status, json };
}, { email, path, opts });

// 年間計画は毎年共通のテンプレートで、予定日の年は登録年のまま残る。年込みで比べると
// 年度リセット直後に前年度の月が一斉に「期限超過」になるため、月を今の会計年度に当てはめて判定する
const nowJstYm = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const [nowY, nowM] = nowJstYm.split('-').map(Number);
const mm2 = (m) => String(m).padStart(2, '0');
// 今月（2年前の日付で登録）＝当月は月末までにやる扱い → 超過にならない
const annCur = await api('/api/plans', { method: 'POST', body: { title: 'E2E年間_今月', plan_type: 'inspection', planned_date: `${nowY - 2}-${mm2(nowM)}-01`, annual_only: 1 } });
check('年間計画: 登録（201）', annCur.status === 201, `status=${annCur.status}`);
let annPrev = null;
if (nowM !== 10) { // 10月は会計年度の初月で、同じ年度内に「前の月」が無い
  const prevM = nowM === 1 ? 12 : nowM - 1;
  annPrev = await api('/api/plans', { method: 'POST', body: { title: 'E2E年間_先月', plan_type: 'inspection', planned_date: `${nowY - 2}-${mm2(prevM)}-01`, annual_only: 1 } });
}
const annList = (await api('/api/plans?annual_only=1')).json?.plans || [];
const annCurGot = annList.find((p) => p.id === annCur.json?.id);
check('年間計画: 過去年の日付でも今月の予定は期限超過にならない', annCurGot?.status === 'pending', `status=${annCurGot?.status}`);
if (annPrev) {
  const annPrevGot = annList.find((p) => p.id === annPrev.json?.id);
  check('年間計画: 今年度の過ぎた月の未実施は期限超過', annPrevGot?.status === 'overdue', `status=${annPrevGot?.status}`);
}

// 年度リセット・部品CSVの全置き換えは管理者のみ（入力可=editor は403、差分マージは可）
const editorEmail = 'e2e-editor@example.com';
const mkEditor = await api('/api/admin/users', { method: 'POST', body: { email: editorEmail, name: 'E2E入力者', role: 'editor' } });
check('権限: 入力可ユーザーを作成（201/409）', mkEditor.status === 201 || mkEditor.status === 409, `status=${mkEditor.status}`);
const resetByEditor = await apiAs(editorEmail, '/api/plans/annual-reset', { method: 'POST', body: {} });
check('権限: 年度リセットは入力可では403', resetByEditor.status === 403, `status=${resetByEditor.status}`);
const replaceByEditor = await apiAs(editorEmail, '/api/parts/import', { method: 'POST', body: { mode: 'replace', rows: [{ name: 'E2E置換テスト' }] } });
check('権限: 部品CSVの全置き換えは入力可では403', replaceByEditor.status === 403, `status=${replaceByEditor.status}`);
const mergeByEditor = await apiAs(editorEmail, '/api/parts/import', { method: 'POST', body: { mode: 'merge', rows: [{ name: 'E2E入力者マージ部品' }] } });
check('権限: 部品CSVの差分マージは入力可でも実行できる', mergeByEditor.status === 200, `status=${mergeByEditor.status}`);

// 年度リセット（admin）: 締める年度はサーバーが決める（最後にリセットした年度＋1。履歴なしの10〜12月は前年度）。
// 締める年度の9月より前は409（実行できる時期は日付しだいのため、API の reset_available に合わせて確認する。
// 時計を動かした網羅的な確認は tests/unit-overdue.mjs）
const annMeta = (await api('/api/plans?annual_only=1')).json || {};
check('年間計画API: 今年度・締める年度を返す',
  Number.isInteger(annMeta.fiscal_year) && Number.isInteger(annMeta.reset_target_fy) && typeof annMeta.reset_available === 'boolean',
  JSON.stringify({ fy: annMeta.fiscal_year, target: annMeta.reset_target_fy, avail: annMeta.reset_available }));
const resetStale = await api('/api/plans/annual-reset', { method: 'POST', body: { fiscal_year: annMeta.reset_target_fy + 1 } });
check('年度リセット: 締める年度と違う年度を指定すると409', resetStale.status === 409, `status=${resetStale.status}`);
if (annCur.json?.id) await api(`/api/plans/${annCur.json.id}`, { method: 'PUT', body: { status: 'done' } });
const resetRes = await api('/api/plans/annual-reset', { method: 'POST', body: { fiscal_year: annMeta.reset_target_fy } });
if (!annMeta.reset_available) {
  check('年度リセット: 締める年度の9月より前は409', resetRes.status === 409, `status=${resetRes.status}`);
} else {
check('年度リセット: 管理者は実行できる（200）', resetRes.status === 200 && resetRes.json?.fiscal_year === annMeta.reset_target_fy, `status=${resetRes.status} ${JSON.stringify(resetRes.json)}`);
const resetAgain = await api('/api/plans/annual-reset', { method: 'POST', body: {} });
check('年度リセット: 直後のもう一度は409（始まったばかりの年度を締めない）', resetAgain.status === 409, `status=${resetAgain.status}`);
const resetAudit = await api('/api/admin/audit?table=maintenance_plan&limit=50');
const resetEntry = (resetAudit.json?.logs || resetAudit.json?.entries || []).find((l) => String(l.record_id) === 'annual_reset');
const resetDiff = (() => { try { return typeof resetEntry?.diff_json === 'string' ? JSON.parse(resetEntry.diff_json) : (resetEntry?.diff_json || resetEntry?.diff); } catch { return null; } })();
check('年度リセット: 監査ログに戻した予定と変更前の状態が残る',
  Array.isArray(resetDiff?.reset_plans) && resetDiff.reset_plans.some((r) => r.id === annCur.json?.id && r.from === 'done'),
  JSON.stringify(resetDiff)?.slice(0, 200));
const annAfter = ((await api('/api/plans?annual_only=1')).json?.plans || []);
check('年度リセット: リセット直後に過去年の今月分が期限超過にならない',
  annAfter.find((p) => p.id === annCur.json?.id)?.status === 'pending');
}
for (const id of [annCur.json?.id, annPrev?.json?.id].filter(Boolean)) await api(`/api/plans/${id}`, { method: 'DELETE' });

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

// ダッシュボードからもトラブル記録CSV（集計期間・04一覧と同じ列）を出力できる
const [dashDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
  page.click('#trouble-csv-bar button:has-text("UTF-8")'),
]);
const dashCsv = dashDl ? (await (await dashDl.createReadStream()).toArray()).map(String).join('') : '';
check('ダッシュボード: トラブルCSVを出力（04と同じ列）',
  /^\uFEFF?発生日時,設備番号,設備,ジャンル,現象/.test(dashCsv) && dashCsv.split('\n').length >= 2,
  `file=${dashDl?.suggestedFilename()} head=${dashCsv.slice(0, 60)}`);

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
// 日報への記録化: new=1 が無いと日報ページは一覧を開き、本文が引き継がれない（回帰防止）
const reportHref = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-record-actions a')]
    .map((x) => x.getAttribute('href')).find((h) => h && h.startsWith('/pages/report?')) || null);
check('チャット: 日報への記録化リンクに new=1 が付く', !!reportHref && new URLSearchParams(reportHref.split('?')[1]).get('new') === '1', `href=${reportHref}`);
if (reportHref) {
  await page.goto(`${BASE}${reportHref}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('E2Eチャットテスト')), { timeout: 8000 }).catch(() => {});
  check('チャット: 日報の作成画面に本文が引き継がれる',
    await page.evaluate(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('E2Eチャットテスト'))));
}

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

// ポーリング: 開いたままの画面に新着が1回だけ表示される（二重描画バグの回帰）。
// POLL_MS=5秒。since は >= 比較のため境界の投稿が毎周期返るので、2周期以上またいで
// 待つ（el の dataset 未対応で data-id が付かず重複ガードが外れると、周期ごとに増える）。
await api('/api/chat', { method: 'POST', body: { body: 'E2Eポーリング新着', channel: 'general' } });
await page.waitForTimeout(11500);
const pollCount = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg .chat-body')].filter((b) => b.textContent === 'E2Eポーリング新着').length);
check('ポーリングで新着が1回だけ表示される（2周期後も重複しない）', pollCount === 1, `count=${pollCount}`);
// メッセージ行に data-id 属性が付いている（重複ガード・削除・ピンジャンプの前提）
const hasDataId = await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg')].every((r) => !!r.getAttribute('data-id')));
check('チャット行に data-id が付与される（el の dataset 対応）', hasDataId);

// 削除: ✕ をタップするとリロードせずに消える（row.remove()）
await api('/api/chat', { method: 'POST', body: { body: 'E2E削除テスト', channel: 'general' } });
await page.waitForFunction(() =>
  [...document.querySelectorAll('.chat-msg .chat-body')].some((b) => b.textContent === 'E2E削除テスト'),
  { timeout: 8000 }).catch(() => {});
check('削除テスト用メッセージが表示される', await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg .chat-body')].filter((b) => b.textContent === 'E2E削除テスト').length === 1));
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.chat-msg')].find((r) => r.querySelector('.chat-body')?.textContent === 'E2E削除テスト');
  row?.querySelector('button[title="削除"]')?.click(); // confirm は自動承諾
});
await page.waitForFunction(() =>
  ![...document.querySelectorAll('.chat-msg .chat-body')].some((b) => b.textContent === 'E2E削除テスト'),
  { timeout: 8000 }).catch(() => {});
check('削除すると画面更新なしで消える', await page.evaluate(() =>
  [...document.querySelectorAll('.chat-msg .chat-body')].filter((b) => b.textContent === 'E2E削除テスト').length === 0));

// UI送信: 実際のボタンで1回送信 → DBに1件だけ（二重POSTの回帰）
await page.goto(`${BASE}/pages/chat`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const uiBody = 'E2EUI二重送信-' + Date.now();
await page.fill('textarea', uiBody);
await page.click('button:has-text("送信")');
await page.waitForTimeout(1500);
const uiRows = await api(`/api/chat?channel=general&limit=50`);
const uiDbCount = (uiRows.json?.messages || []).filter((m) => m.body === uiBody).length;
check('UI送信: 1回の送信でDBに1件だけ（二重POSTなし）', uiDbCount === 1, `count=${uiDbCount}`);

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

// 小さなPNGを /api/files へアップロードするヘルパ（写真添付テスト用）
const uploadTestImage = (filename) => page.evaluate(async (name) => {
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1a5'; ctx.fillRect(0, 0, 8, 8);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const res = await fetch(`/api/files?filename=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}, filename);

// チャット添付: 本人がアップロードした未紐づけファイルだけを受け付け、メッセージに紐づける
// （他の記録のファイルIDを指定すると、10日後の自動削除でそのファイルが R2 から消えるため）
const chatUp = await uploadTestImage('e2e-chat.png');
const chatFileId = chatUp.json?.file?.id;
const chatWithFile = await api('/api/chat', { method: 'POST', body: { body: 'E2E添付チャット', channel: 'general', file_ids: [chatFileId] } });
check('チャット添付: 自分の未紐づけファイルは添付できる（201）', chatWithFile.status === 201, `status=${chatWithFile.status}`);
const chatFiles = await api('/api/files');
check('チャット添付: ファイルがメッセージに紐づく（related_table=chat_messages）',
  (chatFiles.json?.files ?? []).some((f) => f.id === chatFileId && f.related_table === 'chat_messages' && f.related_id === chatWithFile.json?.id));
const chatReuse = await api('/api/chat', { method: 'POST', body: { body: 'E2E添付の使い回し', channel: 'general', file_ids: [chatFileId] } });
check('チャット添付: 紐づけ済み（他の記録）のファイルIDは400', chatReuse.status === 400, `status=${chatReuse.status}`);

// 部品CSVの差分マージ: CSVで対応付けていない列（在庫数・場所など）は既存値を保つ
const mergePart = await api('/api/parts', { method: 'POST', body: { name: 'E2Eマージ部品', model_no: 'E2E-MERGE-001', quantity: 7, location: 'E2E棚A', supplier: 'E2E商事' } });
check('部品マージ: 事前登録（201）', mergePart.status === 201, `status=${mergePart.status}`);
const mergeRes = await api('/api/parts/import', { method: 'POST', body: { mode: 'merge', rows: [{ model_no: 'E2E-MERGE-001', name: 'E2Eマージ部品 改' }] } });
check('部品マージ: 取込（200・更新1件）', mergeRes.status === 200 && mergeRes.json?.updated === 1, JSON.stringify(mergeRes.json));
const mergedPart = (await api(`/api/parts/${mergePart.json?.id}`)).json?.part;
check('部品マージ: 部品名は更新される', mergedPart?.name === 'E2Eマージ部品 改', mergedPart?.name);
check('部品マージ: 対応付けていない在庫数・場所・仕入先は保たれる',
  mergedPart?.quantity === 7 && mergedPart?.location === 'E2E棚A' && mergedPart?.supplier === 'E2E商事', JSON.stringify(mergedPart));

// limit の下限: 負の値でも LIMIT が無制限（-1）にならない
const sNeg = await api(`/api/search?q=${encodeURIComponent('E2E')}&limit=-1`);
const negByType = {};
for (const r of sNeg.json?.results || []) negByType[r.type] = (negByType[r.type] || 0) + 1;
check('検索: limit=-1 は1件に丸められる（種別ごとに最大1件）', sNeg.status === 200 && Object.values(negByType).every((n) => n <= 1) && Object.keys(negByType).length > 0,
  JSON.stringify(negByType));

// ---------- 9.6 電気設備点検（D1同期・別アプリ統合） ----------
section('9.6 電気設備点検（/electrical/ + /api/electrical-*）');
// 記録を POST → client_id キーで取得できる。has_abnormal は repair 混在で1（サーバー算出）
const elClientId = 'E2E' + Date.now();
const elRec = {
  id: elClientId, equipmentType: 'main', date: '2026-09-03', inspector: 'E2E点検者',
  facility: '第1キュービクル', weather: '晴', room_temp: '22', humidity: '55',
  statuses: { g_noise: 'good', tr_dmg: 'caution', cu_water: 'repair' },
  measurements: { tr_v1: ['6600', '6600', '6598'], tr_ot: '42', whm: '1234' },
  qualifiers: { c_i: '未満' }, // main版の未満/以上（record_jsonに保持されること）
  categoryRemarks: {}, remarks: 'E2E特記', config: [], savedAt: new Date().toISOString(),
};
const elPost = await api('/api/electrical-inspections', { method: 'POST', body: elRec });
check('電気点検: 記録POST（201）', elPost.status === 201, `status=${elPost.status}`);
const elGet = await api('/api/electrical-inspections?equipment_type=main');
check('電気点検: client_idキーで取得できる', !!elGet.json?.records?.[elClientId], `keys=${Object.keys(elGet.json?.records||{}).length}`);
check('電気点検: measurements/statusesが往復する',
  elGet.json?.records?.[elClientId]?.statuses?.cu_water === 'repair' &&
  Array.isArray(elGet.json?.records?.[elClientId]?.measurements?.tr_v1));
check('電気点検: qualifiers（未満/以上）が往復する（main版）',
  elGet.json?.records?.[elClientId]?.qualifiers?.c_i === '未満');
// 設定の往復（admin）。乗数(multiplier)・未満以上(qualifier)フィールドが保持されること
const elCfgPut = await api('/api/electrical-config', { method: 'PUT', body: { equipment_type: 'battery', config: [{ id: 'c1', title: 'E2Eカテゴリ', checks: [], measurements: [{ key: 'w1', label: 'WHM', unit: 'kwh', phases: 1, multiplier: 2400 }, { key: 'i1', label: '電流', unit: 'A', phases: 3, qualifier: true }] }] } });
check('電気点検: 設定PUT（admin・200）', elCfgPut.status === 200, `status=${elCfgPut.status}`);
const elCfgGet = await api('/api/electrical-config');
check('電気点検: 設定がGETで戻る', elCfgGet.json?.battery?.[0]?.title === 'E2Eカテゴリ', JSON.stringify(elCfgGet.json?.battery));
check('電気点検: 乗数×2400が設定に保持される', elCfgGet.json?.battery?.[0]?.measurements?.[0]?.multiplier === 2400);
check('電気点検: qualifier=trueが設定に保持される', elCfgGet.json?.battery?.[0]?.measurements?.[1]?.qualifier === true);
// 写真添付（12）: アップロード → 記録に photos を載せて保存 → 記録に紐づく
const elUp = await uploadTestImage('e2e-electrical.png');
check('電気点検: 写真アップロード（201）', elUp.status === 201, `status=${elUp.status}`);
const elFileId = elUp.json?.file?.id;
const elPhotoPost = await api('/api/electrical-inspections', {
  method: 'POST',
  body: { ...elRec, photos: [{ id: elFileId, file_name: 'e2e-electrical.png', content_type: 'image/png' }] },
});
check('電気点検: 写真つきで保存できる（200）', elPhotoPost.status === 200, `status=${elPhotoPost.status}`);
check('電気点検: 写真が記録に紐づく（attached_files=1）', elPhotoPost.json?.attached_files === 1,
  JSON.stringify(elPhotoPost.json));
const elGet3 = await api('/api/electrical-inspections?equipment_type=main');
check('電気点検: 取得した記録に photos が入る',
  (elGet3.json?.records?.[elClientId]?.photos ?? []).some((p) => p.id === elFileId),
  JSON.stringify(elGet3.json?.records?.[elClientId]?.photos));
const elFileList = await api('/api/files');
check('電気点検: files の related_table が electrical_inspection になる',
  (elFileList.json?.files ?? []).some((f) => f.id === elFileId && f.related_table === 'electrical_inspection'),
  JSON.stringify((elFileList.json?.files ?? []).find((f) => f.id === elFileId)));

// 論理削除 → 一覧から消える
const elDel = await api(`/api/electrical-inspections/${encodeURIComponent(elClientId)}`, { method: 'DELETE' });
check('電気点検: 記録DELETE（200）', elDel.status === 200, `status=${elDel.status}`);
const elGet2 = await api('/api/electrical-inspections');
check('電気点検: 削除後は一覧に出ない（論理削除）', !elGet2.json?.records?.[elClientId]);
// ページが pageerror なく表示される（別ドキュメント）
const elBefore = pageErrors.length;
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('電気点検: /electrical/ が pageerror なく表示', pageErrors.length === elBefore,
  pageErrors.slice(elBefore).join(' / '));
check('電気点検: 設備バーが描画される', await page.evaluate(() => !!document.querySelector('.eq-btn')));
check('電気点検: 写真・動画の追加UIがある',
  await page.evaluate(() => !!document.getElementById('photo-input')
    && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('写真・動画を追加'))));
// アップロード用モジュール（/js/files.js）が読み込めている（import失敗だと保存時に写真が送れない）
await page.waitForFunction(() => !!window.ElecFiles, { timeout: 5000 }).catch(() => {});
check('電気点検: 写真アップロードモジュールが読み込まれる',
  await page.evaluate(() => !!(window.ElecFiles && window.ElecFiles.uploadFile)));
check('電気点検: 写真の削除UIが用意されている',
  await page.evaluate(() => typeof deleteCurrentPhoto === 'function' && typeof uploadPendingPhotos === 'function'));

// XSS対策: 他の利用者が保存した記録に HTML/スクリプトが入っていても実行されない
const elBadId = await api('/api/electrical-inspections', { method: 'POST', body: { ...elRec, id: "x');alert(1)//" } });
check('電気点検: 不正な record.id は 400', elBadId.status === 400, `status=${elBadId.status}`);
const xssId = 'E2EXSS' + Date.now();
const xss = (tag) => `<img src=x onerror="window.__xss='${tag}'">`;
const xssPost = await api('/api/electrical-inspections', {
  method: 'POST',
  body: {
    ...elRec, id: xssId, date: '2026-09-04' + xss('date'),
    inspector: xss('inspector'), facility: xss('facility'), weather: xss('weather'),
    room_temp: xss('temp'), humidity: xss('hum'),
    statuses: { g_noise: xss('status') }, qualifiers: { tr_ot: xss('qual') },
    measurements: { tr_ot: xss('meas'), tr_v1: [xss('phase'), '1', '2'] },
  },
});
check('電気点検: XSS検証用の記録を保存（201）', xssPost.status === 201, `status=${xssPost.status}`);
const xssGet = await api('/api/electrical-inspections?equipment_type=main');
check('電気点検: date は検証済みの YYYY-MM-DD で保存される', xssGet.json?.records?.[xssId]?.date === '2026-09-04',
  xssGet.json?.records?.[xssId]?.date);
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
const xssModalText = await page.evaluate((id) => {
  showTab('history');
  openRecord(id);
  const text = document.getElementById('modal-content')?.textContent || '';
  showTab('entry');
  editRecord(id); // 前回値表示・編集フォームへの復元
  return text;
}, xssId);
await page.waitForTimeout(400);
check('電気点検: 記録の HTML が実行されない（一覧・詳細・編集）',
  await page.evaluate(() => window.__xss === undefined), await page.evaluate(() => String(window.__xss)));
check('電気点検: 点検者名は文字としてそのまま表示される', xssModalText.includes('<img src=x'));
await api(`/api/electrical-inspections/${encodeURIComponent(xssId)}`, { method: 'DELETE' });

// 保存は D1 が先: サーバー送信に失敗したら端末側（localStorage）にも保存しない
// （逆順だと「端末でだけ保存済み」に見え、次回オンライン起動時の D1→localStorage 充填で黙って消える）
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
const elFailDate = '2026-01-15';
const elFillForm = () => page.evaluate((d) => {
  showTab('entry');
  document.getElementById('date').value = d;
  document.getElementById('inspector').value = 'E2E送信失敗テスト';
}, elFailDate);
const elLocalHas = () => page.evaluate((d) => Object.values(getRecords()).some((r) => r.date === d), elFailDate);
await page.route('**/api/electrical-inspections', (route) =>
  route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"E2E"}}' }) : route.continue());
await elFillForm();
const elDlgBefore = dialogs.length;
await page.evaluate(() => saveRecord());
check('電気点検: 送信失敗時は「まだ保存されていません」と知らせる',
  dialogs.slice(elDlgBefore).some((m) => m.includes('まだ保存されていません')), dialogs.slice(elDlgBefore).join(' / '));
check('電気点検: 送信失敗時は端末側にも保存しない', !(await elLocalHas()));
check('電気点検: 送信失敗時も入力内容が残る',
  await page.evaluate(() => document.getElementById('inspector').value === 'E2E送信失敗テスト'));
await page.unroute('**/api/electrical-inspections');
await page.evaluate(() => saveRecord());
const elRetry = await api('/api/electrical-inspections?equipment_type=main');
const elRetryRec = Object.values(elRetry.json?.records || {}).find((r) => r.date === elFailDate && r.inspector === 'E2E送信失敗テスト');
check('電気点検: 押し直すとサーバーと端末の両方に保存される', !!elRetryRec && await elLocalHas());
if (elRetryRec) await api(`/api/electrical-inspections/${encodeURIComponent(elRetryRec.id)}`, { method: 'DELETE' });

// ---------- 9.7 ユーティリティ日報（13） ----------
section('9.7 ユーティリティ日報（項目マスタ・1日1件ガード・異常判定）');
const utItems = await api('/api/utility-reports/items');
check('ユーティリティ: 初期項目が31件ある', utItems.json?.items?.length === 31,
  `count=${utItems.json?.items?.length}`);
const byName = (n) => utItems.json.items.find((i) => i.name === n);
const utHeader = byName('ヘッダー圧力');
const utOil = byName('油面確認1');
const utComp = byName('空気圧縮機運転号機');
const utStart = byName('運転開始時間');
const utOrder = utItems.json.items.filter((i) => i.section === '温水・圧縮機').map((i) => i.name);
check('ユーティリティ: 温水 → 圧縮機（号機ごとに1組）の順に並ぶ',
  utOrder.join(',') ===
    '温水ポンプ運転号機,温水ポンプ圧力,温水タンク容量,温水タンク内温度,' +
    '空気圧縮機運転号機,ヘッダー圧力,総運転時間1,油面確認1,総運転時間2,油面確認2,総運転時間3,油面確認3',
  utOrder.join(','));
const utSorts = utItems.json.items.map((i) => i.sort_order);
check('ユーティリティ: sort_orderが重複しない（セクション分断の防止）',
  new Set(utSorts).size === utSorts.length, utSorts.join(','));
check('ユーティリティ: 総運転時間は数値入力（単位hr）',
  utItems.json.items.filter((i) => i.name.startsWith('総運転時間'))
    .every((i) => i.input_type === 'number' && i.unit === 'hr'));
check('ユーティリティ: 複数選択・時刻・異常選択肢の定義がある',
  utComp?.input_type === 'multi' && utStart?.input_type === 'time' &&
  Array.isArray(utOil?.alert_options) && utOil.alert_options.includes('異常'),
  JSON.stringify({ comp: utComp?.input_type, start: utStart?.input_type, alert: utOil?.alert_options }));

// 上下限を設定してから異常判定を確認する（初期値は未設定のため）
const utLimit = await api(`/api/utility-reports/items/${utHeader.id}`, {
  method: 'PUT',
  body: { section: utHeader.section, name: utHeader.name, input_type: 'number', unit: 'MPa',
          min_value: 0.5, max_value: 0.9, sort_order: utHeader.sort_order },
});
check('ユーティリティ: 項目マスタPUT（admin・200）', utLimit.status === 200, `status=${utLimit.status}`);

// --- 点検項目の並び替え（管理画面の ▲▼ = PUT /items/reorder） ---
const utOrder0 = (await api('/api/utility-reports/items')).json.items.map((i) => i.id);
const utSwapped = [...utOrder0];
const utSwapAt = utSwapped.indexOf(utHeader.id);
[utSwapped[utSwapAt - 1], utSwapped[utSwapAt]] = [utSwapped[utSwapAt], utSwapped[utSwapAt - 1]];
const utReorder = await api('/api/utility-reports/items/reorder', {
  method: 'PUT', body: { order: utSwapped, moved_id: utHeader.id },
});
check('ユーティリティ: 並び替えPUT（admin・200）', utReorder.status === 200, `status=${utReorder.status}`);
const utReordered = (await api('/api/utility-reports/items')).json.items;
check('ユーティリティ: 指定した順に並び替わる',
  utReordered.map((i) => i.id).join(',') === utSwapped.join(','), utReordered.map((i) => i.name).join(','));
check('ユーティリティ: 並び替え後は1000番台の連番（移行SQLの番号帯と衝突させない）',
  utReordered.every((i, idx) => i.sort_order === 1000 + idx * 10),
  utReordered.map((i) => i.sort_order).join(','));
const utReorderShort = await api('/api/utility-reports/items/reorder', {
  method: 'PUT', body: { order: utSwapped.slice(1) },
});
check('ユーティリティ: 項目の抜けた並び替えは409', utReorderShort.status === 409, `status=${utReorderShort.status}`);
const utReorderBad = await api('/api/utility-reports/items/reorder', { method: 'PUT', body: { order: 'x' } });
check('ユーティリティ: order が配列でなければ400', utReorderBad.status === 400, `status=${utReorderBad.status}`);
// 以降の並び順テストのため元の順へ戻す（並び替えは何度でもやり直せる）
const utReorderBack = await api('/api/utility-reports/items/reorder', { method: 'PUT', body: { order: utOrder0 } });
const utBackList = (await api('/api/utility-reports/items')).json.items.map((i) => i.id);
check('ユーティリティ: 元の順へ戻せる',
  utReorderBack.status === 200 && utBackList.join(',') === utOrder0.join(','), utBackList.join(','));

const utDate = '2026-01-15';
const utPost = await api('/api/utility-reports', {
  method: 'POST',
  body: {
    report_date: utDate, reporter_name: 'E2E点検者', note: 'E2Eユーティリティ特記',
    values: { [utHeader.id]: 1.5, [utOil.id]: '異常', [utComp.id]: ['1号機', '3号機'], [utStart.id]: '08:30' },
  },
});
check('ユーティリティ: 日報POST（201）', utPost.status === 201, `status=${utPost.status}`);
check('ユーティリティ: 基準範囲外・異常選択で has_abnormal=1', utPost.json?.has_abnormal === 1,
  JSON.stringify(utPost.json));
const utId = utPost.json?.id;

// 1日1件ガード（同じ日の2件目は 409 + 既存ID）
const utDup = await api('/api/utility-reports', { method: 'POST', body: { report_date: utDate, values: {} } });
check('ユーティリティ: 同じ日の2件目は409', utDup.status === 409, `status=${utDup.status}`);
check('ユーティリティ: 409に既存IDが入る', utDup.json?.error?.detail?.existing_id === utId,
  JSON.stringify(utDup.json?.error));

// 入力値の検証（時刻の形式違反は400）
const utBadTime = await api('/api/utility-reports', {
  method: 'POST', body: { report_date: '2026-01-16', values: { [utStart.id]: '8:3' } },
});
check('ユーティリティ: 時刻の形式違反は400', utBadTime.status === 400, `status=${utBadTime.status}`);

// 詳細（値のスナップショット・変更履歴）
const utDetail = await api(`/api/utility-reports/${utId}`);
const utComps = utDetail.json?.report?.values?.find((v) => v.item_id === utComp.id);
check('ユーティリティ: 複数選択が配列で往復する',
  Array.isArray(utComps?.value) && utComps.value.join(',') === '1号機,3号機', JSON.stringify(utComps?.value));
check('ユーティリティ: 変更履歴が記録される', (utDetail.json?.history?.length ?? 0) >= 1);

// 前回値API（この日より前の記録が無いので null）
const utLatest = await api(`/api/utility-reports/latest?before=${utDate}`);
check('ユーティリティ: 前回値なしでも200で report:null', utLatest.status === 200 && utLatest.json?.report === null,
  JSON.stringify(utLatest.json));

// 同時編集ガード
const utConflict = await api(`/api/utility-reports/${utId}`, {
  method: 'PUT',
  body: { report_date: utDate, values: {}, expected_updated_at: '2000-01-01T00:00:00Z' },
});
check('ユーティリティ: 競合する編集は409', utConflict.status === 409, `status=${utConflict.status}`);

// 横断検索（11）で拾える
const utSearch = await api('/api/search?q=' + encodeURIComponent('E2Eユーティリティ特記') + '&type=utility');
check('ユーティリティ: 横断検索でヒットする',
  (utSearch.json?.results ?? []).some((r) => r.type === 'utility' && r.id === utId),
  JSON.stringify((utSearch.json?.results ?? []).map((r) => r.type)));

// 一覧・CSV用の with_values
const utList = await api(`/api/utility-reports?from=${utDate}&to=${utDate}&with_values=1`);
check('ユーティリティ: 一覧に values 付きで出る',
  utList.json?.reports?.[0]?.id === utId && Array.isArray(utList.json.reports[0].values));

// 論理削除 → 一覧から消え、同じ日を再登録できる
const utDel = await api(`/api/utility-reports/${utId}`, { method: 'DELETE' });
check('ユーティリティ: DELETE（200）', utDel.status === 200, `status=${utDel.status}`);
const utList2 = await api(`/api/utility-reports?from=${utDate}&to=${utDate}`);
check('ユーティリティ: 削除後は一覧に出ない（論理削除）', (utList2.json?.reports ?? []).length === 0);
const utReAdd = await api('/api/utility-reports', {
  method: 'POST',
  body: { report_date: utDate, values: { [utOil.id]: 'OK', [utStart.id]: '07:00', [utHeader.id]: 0.7 } },
});
check('ユーティリティ: 削除した日は再登録できる', utReAdd.status === 201, `status=${utReAdd.status}`);

// 写真添付（13）: アップロード → file_ids で保存 → 詳細に files が返る
const utUp = await uploadTestImage('e2e-utility.png');
check('ユーティリティ: 写真アップロード（201）', utUp.status === 201, `status=${utUp.status}`);
const utFileId = utUp.json?.file?.id;
const utReAddId = utReAdd.json?.id;
const utAttach = await api(`/api/utility-reports/${utReAddId}`, {
  method: 'PUT',
  // values は再登録時と同じ内容を送る（PUTは全置換のため。後段の「前回値」テストの前提を壊さない）
  body: {
    report_date: utDate,
    values: { [utOil.id]: 'OK', [utStart.id]: '07:00', [utHeader.id]: 0.7 },
    file_ids: [utFileId],
  },
});
check('ユーティリティ: 写真を添付して保存できる（PUT 200）', utAttach.status === 200, `status=${utAttach.status}`);
check('ユーティリティ: 写真が日報に紐づく（attached_files=1）', utAttach.json?.attached_files === 1,
  JSON.stringify(utAttach.json));
const utDetail2 = await api(`/api/utility-reports/${utReAddId}`);
check('ユーティリティ: 詳細APIが files を返す',
  (utDetail2.json?.files ?? []).some((f) => f.id === utFileId && f.content_type === 'image/png'),
  JSON.stringify(utDetail2.json?.files));

// 入力画面が pageerror なく開く
const utBefore = pageErrors.length;
await page.goto(`${BASE}/pages/utility?new=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check('ユーティリティ: 入力画面が pageerror なく表示', pageErrors.length === utBefore,
  pageErrors.slice(utBefore).join(' / '));
check('ユーティリティ: 計器の📷AI読み取りボタンは既定で出ない',
  await page.evaluate(() => !document.querySelector('#app .meter-cam-btn')));
check('ユーティリティ: 入力画面に写真・動画の追加UIがある',
  await page.evaluate(() => !!document.querySelector('#app input[type=file]')
    && [...document.querySelectorAll('#app button')].some((b) => b.textContent.includes('写真・動画を追加'))));
check('ユーティリティ: 点検項目が描画される',
  await page.evaluate(() => document.querySelectorAll('.check-item').length >= 30),
  String(await page.evaluate(() => document.querySelectorAll('.check-item').length)));
// 項目名は先頭のテキストノード（基準値ヒントの span を除く）で比べる
const utCards = await page.evaluate(() => [...document.querySelectorAll('#app .card')]
  .map((c) => ({
    title: c.querySelector('.card-title')?.textContent || '',
    items: [...c.querySelectorAll('.check-item-name')].map((n) => (n.childNodes[0]?.textContent || '').trim()),
  }))
  .filter((c) => c.items.length));
check('ユーティリティ: 同じセクションが1枚のカードにまとまる',
  new Set(utCards.map((c) => c.title)).size === utCards.length,
  utCards.map((c) => c.title).join(','));
check('ユーティリティ: 温水→圧縮機の順で描画される（画面）',
  (utCards.find((c) => c.title === '温水・圧縮機')?.items || []).join(',') ===
    '温水ポンプ運転号機,温水ポンプ圧力,温水タンク容量,温水タンク内温度,' +
    '空気圧縮機運転号機,ヘッダー圧力,総運転時間1,油面確認1,総運転時間2,油面確認2,総運転時間3,油面確認3',
  JSON.stringify(utCards.find((c) => c.title === '温水・圧縮機')?.items));

// --- 数値欄の実キー入力（page.fill は値を直接代入するため、この種の不具合を検出できない） ---
const utNumIdx = await page.evaluate(() => [...document.querySelectorAll('#app .check-item')]
  .findIndex((c) => (c.querySelector('.check-item-name')?.childNodes[0]?.textContent || '').trim() === 'ヘッダー圧力'));
const utNumInput = page.locator('#app .check-item').nth(utNumIdx).locator('input[type=text], input[type=number]').first();
const utNumBox = await utNumInput.boundingBox();
check('ユーティリティ: 数値欄が潰れていない（120px以上）',
  (utNumBox?.width ?? 0) >= 120, `width=${Math.round(utNumBox?.width ?? 0)}`);

const typeInto = async (text) => {
  await utNumInput.evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await utNumInput.click();
  await page.keyboard.type(text);
  return utNumInput.inputValue();
};
check('ユーティリティ: 欄をタップしただけでは値が入らない（スピナー誤爆なし）',
  (await typeInto('')) === '', await utNumInput.inputValue());
check('ユーティリティ: 実キー入力で小数が入る', (await typeInto('1.5')) === '1.5', await utNumInput.inputValue());
check('ユーティリティ: 全角数字は半角へ直して入る', (await typeInto('１２３')) === '123', await utNumInput.inputValue());
check('ユーティリティ: 桁区切りカンマを除いて入る', (await typeInto('1,234')) === '1234', await utNumInput.inputValue());
const utHints = await page.evaluate(() =>
  [...document.querySelectorAll('.check-item')].map((c) => ({
    name: c.querySelector('.check-item-name')?.textContent || '',
    hint: c.querySelector('.last-value-hint')?.textContent || '',
  })).filter((x) => x.hint));
check('ユーティリティ: 数値項目に前回値が出る',
  utHints.some((h) => h.name.includes('ヘッダー圧力') && h.hint.includes('前回 0.7')),
  JSON.stringify(utHints));
check('ユーティリティ: 選択式・時刻にも前回値が出る',
  utHints.some((h) => h.name.includes('油面確認1') && h.hint.includes('前回 OK')) &&
  utHints.some((h) => h.name.includes('運転開始時間') && h.hint.includes('前回 07:00')),
  JSON.stringify(utHints));

// --- 管理画面の ▲▼ で並び替えできる（画面操作） ---
const utItemsBefore = pageErrors.length;
await page.goto(`${BASE}/pages/utility?items=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('ユーティリティ: 点検項目マスタが pageerror なく表示', pageErrors.length === utItemsBefore,
  pageErrors.slice(utItemsBefore).join(' / '));
const utGroupNames = () => page.evaluate(() => {
  const card = [...document.querySelectorAll('#app .card')].find((c) => c.querySelector('.row-list'));
  // :scope を付けないとカード見出し（グループ名）まで拾ってしまう
  //（querySelectorAll のセレクタは文書全体で評価されるため、外側の .row-list に一致する）
  return [...card.querySelectorAll(':scope > .row-list .list-item-title')].map((n) => n.textContent.trim());
});
const utNamesBefore = await utGroupNames();
const utRow = (n) => page.locator('#app .card .row-list .list-item').nth(n);
await utRow(0).locator('button[title$="を下へ"]').click();
await page.waitForTimeout(600);
const utNamesAfter = await utGroupNames();
check('ユーティリティ: ▼で項目が1つ下へ移動する',
  utNamesAfter[0] === utNamesBefore[1] && utNamesAfter[1] === utNamesBefore[0],
  `${utNamesBefore.slice(0, 2).join(',')} → ${utNamesAfter.slice(0, 2).join(',')}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('ユーティリティ: 並び替えが保存されている（再読込後も同じ）',
  (await utGroupNames()).join(',') === utNamesAfter.join(','), (await utGroupNames()).join(','));
// 元へ戻す（▲）
await utRow(1).locator('button[title$="を上へ"]').click();
await page.waitForTimeout(600);
check('ユーティリティ: ▲で元の順へ戻せる（画面）',
  (await utGroupNames()).join(',') === utNamesBefore.join(','), (await utGroupNames()).join(','));
// スマホ幅（375px）で ▲▼🗑 を並べても横スクロールが出ないこと
await page.setViewportSize({ width: 375, height: 720 });
await page.waitForTimeout(300);
const utOverflow = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
}));
check('ユーティリティ: 点検項目マスタが375px幅で横に溢れない',
  utOverflow.scroll <= utOverflow.client + 1, JSON.stringify(utOverflow));
await page.setViewportSize({ width: 1280, height: 720 });

// 詳細画面に添付写真のサムネイルが出る
await page.goto(`${BASE}/pages/utility?id=${utReAddId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('ユーティリティ: 詳細に写真サムネイルが表示される',
  await page.evaluate(() => !!document.querySelector('#app img.thumb')));
// 添付写真の削除（× ボタン → 論理削除）。confirm() は page.on('dialog') が自動承諾する
await page.click('#app .thumb-del');
await page.waitForTimeout(1000);
check('ユーティリティ: 詳細から写真を削除できる（画面）',
  await page.evaluate(() => !document.querySelector('#app img.thumb')));
const utAfterDel = await api(`/api/utility-reports/${utReAddId}`);
check('ユーティリティ: 削除した写真は詳細APIから消える',
  !(utAfterDel.json?.files ?? []).some((f) => f.id === utFileId),
  JSON.stringify(utAfterDel.json?.files));

// ---------- 9.8 AIサポート（14） ----------
section('9.8 AIサポート（14 トラブル・部品・業務依頼＋AI）');
// 1つのキーワードで3種類すべてに当たるデータを作る（現場の1入力を再現）
const FS_KW = 'E2Eゲンバサポート';
await api('/api/troubles', { method: 'POST', body: {
  occurred_at: new Date().toISOString(), phenomenon: `${FS_KW}現象 異音がする` } });
await api('/api/parts', { method: 'POST', body: {
  name: `${FS_KW}部品ゼロ`, quantity: 0, safety_stock: 1 } });           // 在庫0
await api('/api/parts', { method: 'POST', body: {
  name: `${FS_KW}部品フソク`, quantity: 1, safety_stock: 5 } });          // 要発注
const fsRepair = await api('/api/repairs', { method: 'POST', body: { title: `${FS_KW}依頼` } });
check('AIサポート: 前提データ（業務依頼）を作成', fsRepair.status === 201, `status=${fsRepair.status}`);

// ホームはタイルから遷移する形（埋め込みカードは置かない）
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('AIサポート: ホームにタイルがあり /pages/ai-support へ行く',
  await page.evaluate(() => [...document.querySelectorAll('a.tile')]
    .some((a) => a.getAttribute('href') === '/pages/ai-support' && a.innerText.includes('AIサポート'))));
check('AIサポート: ホームに検索カードを埋め込んでいない',
  await page.evaluate(() => !document.querySelector('.home-ai') && !document.querySelector('#home-ai')));

await page.goto(`${BASE}/pages/ai-support`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
check('AIサポート: 検索欄がある（[ai]未構成でも開ける）',
  await page.evaluate(() => !!document.querySelector('#app .search-input')));
check('AIサポート: [ai]未構成なら「対応策の案」ボタンを出さない',
  await page.evaluate(() => !document.body.innerText.includes('対応策の案をもらう')));

// 検索を実行（入力 → 🔍 探す）
const fsSearch = async (q) => {
  await page.fill('#app .search-input', q);
  await page.click('.ai-sup-bar .btn');
  await page.waitForFunction(
    () => !document.querySelector('#app .loading'), { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(300);
  return page.evaluate(() => document.getElementById('app')?.innerText || '');
};

const fsText = await fsSearch(FS_KW);
check('AIサポート: 過去の似たトラブルが出る',
  fsText.includes('過去の似たトラブル') && fsText.includes(`${FS_KW}現象`), fsText.slice(0, 200));
check('AIサポート: トラブル行のリンク先が詳細ページ',
  await page.evaluate(() => [...document.querySelectorAll('#app a')]
    .some((a) => /\/pages\/trouble\?id=\d+/.test(a.getAttribute('href') || ''))));
check('AIサポート: 関連する部品在庫が出る', fsText.includes('部品在庫'), fsText.slice(0, 300));
check('AIサポート: 在庫0の部品に「在庫0」バッジが付く', fsText.includes('在庫0'), fsText.slice(0, 300));
check('AIサポート: 在庫不足の部品に「要発注」バッジが付く', fsText.includes('要発注'), fsText.slice(0, 300));
check('AIサポート: 関連する業務依頼が出る',
  fsText.includes('関連する業務依頼') && fsText.includes(`${FS_KW}依頼`), fsText.slice(0, 400));
check('AIサポート: 業務依頼にステータスが出る', fsText.includes('受付'), fsText.slice(0, 400));
// 各セクションから横断検索へ全件を見に行ける（種別つき）
const fsAllLinks = await page.evaluate(() => [...document.querySelectorAll('#app a')]
  .map((a) => a.getAttribute('href') || '').filter((h) => h.startsWith('/pages/search?q=')));
check('AIサポート: 3セクションすべてに「すべて見る（横断検索）」がある',
  ['type=trouble', 'type=parts', 'type=repair'].every((t) => fsAllLinks.some((h) => h.includes(t))),
  fsAllLinks.join(' | '));

// 部品はAND検索。現象の語を混ぜると全キーワードを含む部品は0件になるが、
// そこで「0件」と畳んでしまうと関係のある部品が隠れてしまう（実機で発覚）。
// いずれかの語に一致した部品を最初から開いて出すこと。
const fsOrText = await fsSearch(`${FS_KW}部品ゼロ ${FS_KW}部品フソク`);
check('AIサポート: AND0件でも類似の部品を畳まずに出す',
  fsOrText.includes('関連しそうな部品在庫') && fsOrText.includes(`${FS_KW}部品ゼロ`)
    && fsOrText.includes(`${FS_KW}部品フソク`), fsOrText.slice(0, 400));

// 業務依頼は /api/search の AND 検索。存在しない語を混ぜて0件にし、先頭1語での再検索を確認する
const fsRetryText = await fsSearch(`${FS_KW}依頼 ゼッタイニナイ語`);
check('AIサポート: 業務依頼が0件なら先頭1語で再検索する',
  fsRetryText.includes('で再検索') && fsRetryText.includes(`${FS_KW}依頼`), fsRetryText.slice(0, 400));

// どれにも当たらない語
const fsEmptyText = await fsSearch('ZZZ存在しないキーワードZZZ');
check('AIサポート: 0件なら見つからなかった旨と横断検索リンクを出す',
  fsEmptyText.includes('見つかりませんでした') && fsEmptyText.includes('横断検索で探す'),
  fsEmptyText.slice(0, 300));

check('AIサポート: 検索しても pageerror が出ていない',
  pageErrors.filter((e) => e.includes('/pages/ai-support')).length === 0, pageErrors.join(' | '));

// スマホ幅（375px）: 入力欄＋ボタン、結果のバッジ行が横に溢れないこと
await page.setViewportSize({ width: 375, height: 720 });
await fsSearch(FS_KW);
const fsOverflow = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
}));
check('AIサポート: 375px幅で横に溢れない',
  fsOverflow.scroll <= fsOverflow.client + 1, JSON.stringify(fsOverflow));
await page.setViewportSize({ width: 1280, height: 720 });

// ---------- 9.9 ログイン切れの疑い → 「再ログイン」ボタン ----------
section('9.9 Accessログイン切れ時の再ログインボタン');
await page.goto(`${BASE}/pages/trouble`, { waitUntil: 'networkidle' });
check('通常時は再ログインバナーが出ない', (await page.locator('#relogin-banner').count()) === 0);
// オンラインなのに /api/me だけ届かない状態（＝Access のログイン画面へのリダイレクトで fetch が弾かれる状況）を再現
await context.route('**/api/me', (route) => route.abort());
await page.goto(`${BASE}/pages/trouble`, { waitUntil: 'domcontentloaded' });
// 1回目は自動で再認証へ誘導（?reauth=付きで再読込）、2回目は15秒ガードで止まりバナーが出る
const reloginShown = await page.waitForSelector('#relogin-banner button', { timeout: 15000 }).then(() => true).catch(() => false);
check('ログイン切れの疑い時に「再ログインする」ボタンが出る', reloginShown);
check('再ログインバナーの文言', (await page.locator('#relogin-banner').innerText().catch(() => '')).includes('再ログインする'));
await context.unroute('**/api/me');
await page.evaluate(() => sessionStorage.clear());

// ---------- 9.10 CSVインジェクション対策 ----------
section('9.10 CSV出力: 数式で始まる値を無害化する');
const csvOut = await page.evaluate(async () => {
  const { escCsv, excelText } = await import('/js/csv.js');
  return {
    eq: escCsv('=HYPERLINK("http://x","y")'), plus: escCsv('+cmd'), at: escCsv('@SUM(A1)'), tab: escCsv('\t=1'),
    neg: escCsv('-5'), dec: escCsv('+1.5'), dash: escCsv('-'), text: escCsv('3号機 異音'),
    excel: escCsv(excelText('3-25')),
  };
});
check('CSV: = で始まる値に \' が付く', csvOut.eq === `"'=HYPERLINK(""http://x"",""y"")"`, csvOut.eq);
check('CSV: + / @ / タブ始まりも無害化', csvOut.plus === "'+cmd" && csvOut.at === "'@SUM(A1)" && csvOut.tab === "'\t=1",
  JSON.stringify(csvOut));
check('CSV: 数値（-5・+1.5）と「-」はそのまま', csvOut.neg === '-5' && csvOut.dec === '+1.5' && csvOut.dash === '-',
  JSON.stringify(csvOut));
check('CSV: 通常の文字と excelText(="…") はそのまま', csvOut.text === '3号機 異音' && csvOut.excel === '"=""3-25"""',
  JSON.stringify(csvOut));

// ---------- 9.11 セキュリティヘッダー ----------
section('9.11 セキュリティヘッダー（_headers / API）');
const hdr = await page.evaluate(async () => {
  const pick = (r) => ({
    csp: r.headers.get('content-security-policy') || '', nosniff: r.headers.get('x-content-type-options') || '',
    frame: r.headers.get('x-frame-options') || '',
  });
  return { page: pick(await fetch('/', { cache: 'no-store' })), api: pick(await fetch('/api/me', { cache: 'no-store' })) };
});
check('ヘッダー: ページに CSP（外部への通信禁止・frame-ancestors none）が付く',
  hdr.page.csp.includes("connect-src 'self'") && hdr.page.csp.includes("frame-ancestors 'none'"), hdr.page.csp);
check('ヘッダー: ページに nosniff / X-Frame-Options が付く', hdr.page.nosniff === 'nosniff' && hdr.page.frame === 'DENY',
  JSON.stringify(hdr.page));
check('ヘッダー: API 応答に nosniff / X-Frame-Options が付く', hdr.api.nosniff === 'nosniff' && hdr.api.frame === 'DENY',
  JSON.stringify(hdr.api));
check('ヘッダー: テスト全体を通して CSP 違反が出ていない', cspViolations.length === 0, cspViolations.slice(0, 3).join(' / '));


// ---------- 9.12 一括処理の原子化（D1 batch）・同時操作ガード ----------
section('9.12 一括処理の原子化・同時操作ガード');
const auditFor = async (table) => ((await api(`/api/admin/audit?table=${table}&limit=200`)).json?.logs || []);

// 予定の一括登録: 全件が1トランザクションで登録され、監査ログが各予定のIDを指す（last_insert_rowid）
const pb = await api('/api/plans/batch', { method: 'POST', body: { items: [
  { title: 'E2E一括A', planned_date: '2032-01-01', plan_type: 'inspection', annual_only: 1 },
  { title: 'E2E一括B', planned_date: '2032-02-01', plan_type: 'inspection', annual_only: 1 },
] } });
check('一括登録: 予定2件（201）', pb.status === 201 && pb.json?.ids?.length === 2 && pb.json.ids.every(Boolean), JSON.stringify(pb.json));
const pbAudit = await auditFor('maintenance_plan');
check('一括登録: 監査ログが各予定のIDで残る', (pb.json?.ids || []).every((pid) =>
  pbAudit.some((l) => Number(l.record_id) === pid && l.action === 'create' && String(l.diff_json).includes('"batch":true'))));
const pbBad = await api('/api/plans/batch', { method: 'POST', body: { items: [
  { title: 'E2E一括C', planned_date: '2032-03-01', plan_type: 'inspection' },
  { title: 'E2E一括D', planned_date: 'bad', plan_type: 'inspection' },
] } });
const pbBadLeft = ((await api('/api/plans?annual_only=1')).json?.plans || []).some((p) => p.title === 'E2E一括C');
check('一括登録: 1件でも不正なら1件も登録しない', pbBad.status === 400 && !pbBadLeft, `status=${pbBad.status}`);
for (const pid of pb.json?.ids || []) await api(`/api/plans/${pid}`, { method: 'DELETE' });

// 点検のまとめ入力: 監査ログが各点検記録のIDを指す
const ib = await api('/api/inspections/batch', { method: 'POST', body: {
  inspected_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  entries: [{ equipment_id: eqSearchId, items: [{ master_id: mSearch.json?.id, value: 'ok' }] }],
} });
check('点検まとめ入力（201）', ib.status === 201 && ib.json?.saved?.length === 1, `status=${ib.status} ${JSON.stringify(ib.json)}`);
const ibId = ib.json?.saved?.[0]?.id;
check('点検まとめ入力: 監査ログが点検記録のIDで残る',
  (await auditFor('inspection_result')).some((l) => Number(l.record_id) === ibId && l.action === 'create'));

// 期間予定の「1日だけ完了」を同時に2回押しても、完了済みの単日レコードは1件だけ。
// 同時に処理されたかはタイミング次第のため5回くり返す（同じ秒に作成・印刷した直後の2回押しも含む）
const ccStatuses = [];
let ccDupFree = true, ccPrintedOk = true;
for (let k = 0; k < 5; k++) {
  const d2 = (n) => `2032-05-${String(n).padStart(2, '0')}`;
  const day = 1 + k * 5; // 5/1〜5/5, 5/6〜5/10, … 5/21〜5/25
  const cc = await api('/api/plans', { method: 'POST', body: { title: `E2E同時完了${k}`, plan_type: 'construction', planned_date: d2(day), planned_end_date: d2(day + 4) } });
  await api(`/api/plans/${cc.json?.id}/printed`, { method: 'POST' });
  const sts = await page.evaluate(async ({ pid, date }) => Promise.all([1, 2].map(() =>
    fetch(`/api/plans/${pid}/complete-day`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) })
      .then((r) => r.status))), { pid: cc.json?.id, date: d2(day + 2) });
  ccStatuses.push(sts.join('/'));
  const rows = ((await api('/api/plans?from=2032-05-01&to=2032-06-30')).json?.plans || []).filter((p) => p.title === `E2E同時完了${k}`);
  if (rows.filter((p) => p.status === 'done').length !== 1 || rows.length !== 3 || sts.filter((x) => x === 200).length !== 1) ccDupFree = false;
  if (!rows.every((p) => !!p.printed_at)) ccPrintedOk = false;
  for (const p of rows) await api(`/api/plans/${p.id}`, { method: 'DELETE' });
}
console.log(`  （同時2回押しの応答: ${ccStatuses.join(' , ')}）`);
check('1日完了: 同時に2回押しても成功は1回・完了済みの単日レコードは1件だけ（5回）', ccDupFree, ccStatuses.join(' , '));
check('1日完了: 分割した予定にも工事連絡書の印刷日が引き継がれる', ccPrintedOk);

// 棚卸調整: 履歴の増減は「書き込む瞬間の在庫」から計算される（在庫 3 → 実数 10 なら +7）
const adjPart = await api('/api/parts', { method: 'POST', body: { name: 'E2E棚卸調整部品', quantity: 3, safety_stock: 0 } });
await api(`/api/parts/${adjPart.json?.id}/transaction`, { method: 'POST', body: { type: 'adjust', quantity: 10, note: '棚卸' } });
const adjOut = await api(`/api/parts/${adjPart.json?.id}/transaction`, { method: 'POST', body: { type: 'out', quantity: 99 } });
const adjGot = (await api(`/api/parts/${adjPart.json?.id}`)).json;
check('棚卸調整: 在庫は実数・履歴の増減は+7', adjGot?.part?.quantity === 10 && (adjGot?.transactions || []).some((t) => t.type === 'adjust' && t.quantity === 7),
  JSON.stringify(adjGot?.transactions));
check('出庫: 在庫不足は400で、在庫も履歴も変わらない', adjOut.status === 400 && !(adjGot?.transactions || []).some((t) => t.type === 'out'));

// 設備番号の振り直し: 1トランザクションで NN-MM に揃い、一時コード（TMP-）が残らない
const rn = await api('/api/equipment/renumber', { method: 'POST' });
check('設備番号の振り直し（200）', rn.status === 200, `status=${rn.status} ${JSON.stringify(rn.json)}`);
const rnEq = (await api('/api/equipment')).json?.equipment || [];
check('設備番号の振り直し: すべて NN-MM 形式で TMP- が残らない', rnEq.length > 0 && rnEq.every((e) => /^\d{2}-\d{2}$/.test(e.code)),
  JSON.stringify(rnEq.map((e) => e.code).slice(0, 10)));


// ---------- 9.13 復元・履歴・監査の穴 ----------
section('9.13 復元・履歴・監査');
const historyOf = async (master) => ((await api(`/api/admin/masters?master_name=${master}&limit=50`)).json?.history || []);

// 電気設備点検: 削除した記録は「削除済み」から復元でき、古い画面からの保存では復活しない
const elRestoreId = 'E2ERST' + Date.now();
await api('/api/electrical-inspections', { method: 'POST', body: { id: elRestoreId, equipmentType: 'main', date: '2032-06-01', inspector: 'E2E復元', statuses: {}, measurements: {} } });
await api(`/api/electrical-inspections/${elRestoreId}`, { method: 'DELETE' });
const elResave = await api('/api/electrical-inspections', { method: 'POST', body: { id: elRestoreId, equipmentType: 'main', date: '2032-06-01', inspector: 'E2E古い画面', statuses: {}, measurements: {} } });
check('電気点検: 削除済みの記録は再保存で復活しない（409）', elResave.status === 409, `status=${elResave.status}`);
const elDeleted = (await api('/api/admin/restore?table=electrical_inspection')).json;
const elDelRow = (elDeleted?.records || []).find((r) => r.date_val === '2032-06-01');
check('復元: 電気設備点検が削除済み一覧に出る（件数・ページ情報付き）', !!elDelRow && typeof elDeleted.total === 'number' && elDeleted.offset === 0);
const elRestore = await api('/api/admin/restore', { method: 'POST', body: { table: 'electrical_inspection', id: elDelRow?.id } });
const elAfterRestore = (await api('/api/electrical-inspections?equipment_type=main')).json?.records?.[elRestoreId];
check('復元: 電気設備点検を復元できる', elRestore.status === 200 && elAfterRestore?.inspector === 'E2E復元', `status=${elRestore.status}`);
await api(`/api/electrical-inspections/${elRestoreId}`, { method: 'DELETE' });

// 電気設備点検の設定: 変更は監査ログに残り、マスタ変更履歴から元に戻せる
const elCfgA = [{ id: 'r1', title: 'E2E設定A', checks: [], measurements: [] }];
const elCfgB = [{ id: 'r1', title: 'E2E設定B', checks: [], measurements: [] }];
await api('/api/electrical-config', { method: 'PUT', body: { equipment_type: 'generator', config: elCfgA } });
await api('/api/electrical-config', { method: 'PUT', body: { equipment_type: 'generator', config: elCfgB } });
const elCfgHist = (await historyOf('electrical_config')).find((h) => String(h.snapshot_json).includes('E2E設定A'));
const elCfgRestore = await api('/api/admin/masters/restore', { method: 'POST', body: { history_id: elCfgHist?.id } });
const elCfgNow = (await api('/api/electrical-config')).json?.generator;
check('設定履歴: 電気設備点検の設定を履歴から戻せる', elCfgRestore.status === 200 && elCfgNow?.[0]?.title === 'E2E設定A', `status=${elCfgRestore.status} ${JSON.stringify(elCfgNow)?.slice(0, 80)}`);
check('監査ログ: 電気設備点検の設定変更が残る',
  ((await api('/api/admin/audit?table=electrical_config&limit=20')).json?.logs || []).some((l) => l.action === 'update'));

// 帳票テンプレート: 入力項目（fields_json）の変更前を履歴に残し、戻せる
const ptNew = await api('/api/print-templates', { method: 'POST', body: { name: 'E2E帳票', template_type: 'trouble_report', fields_json: [{ key: '旧項目', label: '旧項目', type: 'text' }] } });
const ptId = ptNew.json?.id ?? ptNew.json?.template?.id;
await api(`/api/print-templates/${ptId}`, { method: 'PUT', body: { name: 'E2E帳票', template_type: 'trouble_report', fields_json: [] } });
const ptHist = (await historyOf('print_templates')).find((h) => Number(h.record_id) === ptId);
const ptRestore = await api('/api/admin/masters/restore', { method: 'POST', body: { history_id: ptHist?.id } });
const ptNow = ((await api('/api/print-templates')).json?.templates || []).find((t) => t.id === ptId);
check('設定履歴: 帳票テンプレートの入力項目を履歴から戻せる', ptRestore.status === 200 && String(ptNow?.fields_json).includes('旧項目'),
  `status=${ptRestore.status} new=${ptNew.status} ${String(ptNow?.fields_json).slice(0, 80)}`);
await api(`/api/print-templates/${ptId}`, { method: 'DELETE' });
check('復元: 帳票テンプレートが削除済み一覧に出る',
  ((await api('/api/admin/restore?table=print_templates')).json?.records || []).some((r) => r.id === ptId));

// ユーティリティ日報: 同じ日の記録があるときは復元しない（1日1件）
const utRDate = '2032-07-01';
const utR1 = await api('/api/utility-reports', { method: 'POST', body: { report_date: utRDate, values: {} } });
await api(`/api/utility-reports/${utR1.json?.id}`, { method: 'DELETE' });
const utR2 = await api('/api/utility-reports', { method: 'POST', body: { report_date: utRDate, values: {} } });
const utRestore = await api('/api/admin/restore', { method: 'POST', body: { table: 'utility_report', id: utR1.json?.id } });
check('復元: 同じ日のユーティリティ日報があるときは409', utRestore.status === 409, `status=${utRestore.status}`);
await api(`/api/utility-reports/${utR2.json?.id}`, { method: 'DELETE' });

// チャット: ピン留めしたまま削除すると、ピン留めも外れる（10日自動削除の対象に戻る）
const pinDel = await api('/api/chat', { method: 'POST', body: { body: 'E2Eピン留め削除', channel: 'general' } });
await api(`/api/chat/${pinDel.json?.id}`, { method: 'PUT', body: { pinned: true } });
await api(`/api/chat/${pinDel.json?.id}`, { method: 'DELETE' });
check('チャット: 削除するとピン一覧から消える', !((await api('/api/chat?channel=general&limit=10')).json?.pinned || []).some((p) => p.id === pinDel.json?.id));

// 監査列: 設備の新規登録で更新者・更新日時も入る
const eqAudit = await api('/api/equipment', { method: 'POST', body: { code: 'E2E-AUD', name: 'E2E監査列設備' } });
const eqAuditGot = (await api(`/api/equipment/${eqAudit.json?.id}`)).json?.equipment;
check('監査列: 設備の新規登録で updated_by / updated_at が入る', !!eqAuditGot?.updated_by && !!eqAuditGot?.updated_at, JSON.stringify({ by: eqAuditGot?.updated_by, at: eqAuditGot?.updated_at }));


// ---------- 9.14 低優先度の修正（AIの権限・件数上限・検索ハイライト・電気設定の再送） ----------
section('9.14 AIの権限・件数上限・検索ハイライト・電気設定の再送');
// AI: 閲覧のみ（viewer）は無料枠を消費する AI API を呼べない。画像AIは AI_VISION_ENABLED=1 のときだけ
const viewerEmail = 'e2e-viewer@example.com';
await api('/api/admin/users', { method: 'POST', body: { email: viewerEmail, name: 'E2E閲覧者', role: 'viewer' } });
for (const ep of ['chat', 'analyze-trouble', 'parse-trouble-pdf', 'parse-search', 'suggest-trouble']) {
  const r = await apiAs(viewerEmail, `/api/ai/${ep}`, { method: 'POST', body: { message: 'x', phenomenon: 'x', text: 'x', query: 'x' } });
  check(`AI: 閲覧のみは /api/ai/${ep} を呼べない（403）`, r.status === 403, `status=${r.status}`);
}
const visionRes = await api('/api/ai/read-meter', { method: 'POST', body: { file_id: 1 } });
check('AI: 画像の読み取りは AI_VISION_ENABLED 未設定なら403（管理者でも）', visionRes.status === 403, `status=${visionRes.status}`);

// 点検一覧の件数上限: 既定200・limit で増減できる。CSV出力は上限超過を truncated で知らせる
const inspLim = await api('/api/inspections?limit=1');
check('点検一覧: limit で件数を指定できる', (inspLim.json?.inspections || []).length === 1, `n=${(inspLim.json?.inspections || []).length}`);
const inspExp = await api('/api/inspections/export');
check('点検CSV: 上限情報（truncated / limit）を返す', inspExp.json?.truncated === false && inspExp.json?.limit === 1000, JSON.stringify({ t: inspExp.json?.truncated, l: inspExp.json?.limit }));

// 検索ハイライト: 語が「mark」「amp」等でも表示が崩れず、元の文字列のまま一致部分だけ <mark> になる
await api('/api/troubles', { method: 'POST', body: { occurred_at: new Date().toISOString(), phenomenon: 'E2Eハイライト mark & amp <b>' } });
await page.goto(`${BASE}/pages/search?q=${encodeURIComponent('E2Eハイライト mark amp')}&type=trouble`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.search-result-title'), { timeout: 8000 }).catch(() => {});
const hl = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.search-result-title')].find((x) => x.textContent.includes('E2Eハイライト'));
  return t ? { text: t.textContent, marks: [...t.querySelectorAll('mark')].map((m) => m.textContent), html: t.innerHTML.includes('&lt;b&gt;') } : null;
});
check('検索ハイライト: 元の文字列のまま一致部分だけ強調される',
  hl?.text === 'E2Eハイライト mark & amp <b>' && hl.marks.join(',') === 'E2Eハイライト,mark,amp' && hl.html, JSON.stringify(hl));

// 電気設備点検の設定: サーバー保存に失敗した設定は端末に残り、次回起動時に再送される（上書きで消えない）
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
const elCfgRetry = [{ id: 'rt', title: 'E2E再送設定', checks: [], measurements: [] }];
await page.route('**/api/electrical-config', (route) => (route.request().method() === 'PUT'
  ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"E2E"}}' }) : route.continue()));
await page.evaluate((cfg) => pushConfigToServer('generator', cfg), elCfgRetry);
const elUnsynced = await page.evaluate(() => !!localStorage.getItem('elec_unsynced_config_generator'));
check('電気設定: 送信に失敗した設定は「未送信」として端末に残る', elUnsynced);
await page.unroute('**/api/electrical-config');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const elCfgAfter = (await api('/api/electrical-config')).json?.generator;
const elUnsyncedAfter = await page.evaluate(() => !!localStorage.getItem('elec_unsynced_config_generator'));
check('電気設定: 次回起動時に再送され、サーバーに保存される', elCfgAfter?.[0]?.title === 'E2E再送設定' && !elUnsyncedAfter,
  JSON.stringify({ title: elCfgAfter?.[0]?.title, left: elUnsyncedAfter }));


// ---------- 9.15 再点検で見つかった不具合の回帰テスト ----------
section('9.15 年間計画表の表示・電気設備点検の連打');
// 年間計画表: 点検実績の取得に失敗しても、計画表は実績なしで表示される（.catch がコメントに入っていた）
// GET /api/* は Service Worker 経由で送られ、page.route では差し替えられない。画面側の fetch を、
// sessionStorage のフラグが立っているときだけ「点検APIは500」を返すように包む（フラグなしでは何もしない）
await page.addInitScript(() => {
  if (!sessionStorage.getItem('e2eFailInspections')) return;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (u.pathname === '/api/inspections') {
      return Promise.resolve(new Response('{"error":{"message":"点検取得失敗E2E"}}', { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig(input, init);
  };
});
await page.evaluate(() => sessionStorage.setItem('e2eFailInspections', '1'));
const annErrBefore = pageErrors.length;
await page.goto(`${BASE}/pages/plan-annual`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
check('年間計画表: 点検実績の取得に失敗しても表は表示される',
  // 年ナビ（.cal-nav）が描かれ、エラー表示（showError の .notice.is-error）になっていないこと
  await page.evaluate(() => !!document.querySelector('.cal-nav') && !document.querySelector('#app > .notice.is-error')),
  await page.evaluate(() => document.querySelector('#app')?.innerText.slice(0, 200)));
await page.evaluate(() => sessionStorage.removeItem('e2eFailInspections'));
check('年間計画表: pageerror が出ない', pageErrors.length === annErrBefore, pageErrors.slice(annErrBefore).join(' / '));

// 年間計画表は会計年度（10月〜翌9月）で表示し、既定は API の今年度（最後にリセットした年度＋1）
const annFy = (await api('/api/plans?annual_only=1')).json?.fiscal_year;
const annDoneP = await api('/api/plans', { method: 'POST', body: { title: 'E2E年度表示', plan_type: 'other', planned_date: '2020-11-01', annual_only: 1 } });
await api(`/api/plans/${annDoneP.json?.id}`, { method: 'PUT', body: { status: 'done' } });
await page.goto(`${BASE}/pages/plan-annual`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.annual-view-toggle button:has-text("全月")');
await page.waitForTimeout(300);
const fyView = await page.evaluate(() => ({
  label: document.querySelector('.annual-fy-label')?.textContent || '',
  heads: [...document.querySelectorAll('.annual-grid thead th')].slice(2).map((th) => th.textContent),
  bulk: !!document.querySelector('.annual-month-grid'),
}));
check('年間計画表: 今年度を会計年度で表示（FY◯◯◯◯（YYYY/10〜YYYY/09）（今年度））',
  fyView.label === `FY${annFy}（${annFy}/10〜${annFy + 1}/09）（今年度）`, fyView.label);
check('年間計画表: 列は10月〜翌9月', fyView.heads.length === 12 && fyView.heads[0] === `${annFy}年10月` && fyView.heads[3] === `${annFy + 1}年1月` && fyView.heads[11] === '9月',
  fyView.heads.join(','));
const doneMarkCur = await page.evaluate(() => [...document.querySelectorAll('.annual-grid tbody tr')]
  .find((tr) => tr.textContent.includes('E2E年度表示'))?.querySelector('.annual-mark.is-done') != null);
check('年間計画表: 今年度は完了状態（✓）を表示', doneMarkCur);
// 前の年度: 完了状態を出さず、編集もできない（今年度の完了状態を別の年度に見せない）
await page.click('.cal-nav button[title="前の年度"]');
await page.waitForTimeout(600);
const prevView = await page.evaluate(() => ({
  label: document.querySelector('.annual-fy-label')?.textContent || '',
  notice: document.querySelector('.annual-fy-notice')?.textContent || '',
  done: [...document.querySelectorAll('.annual-grid tbody tr')].find((tr) => tr.textContent.includes('E2E年度表示'))?.querySelector('.annual-mark.is-done') != null,
  bulk: !!document.querySelector('.annual-month-grid'),
  addBtn: !!document.querySelector('.annual-add'),
}));
check('年間計画表: 前の年度は「過去の年度」の案内を出し、完了状態・編集を出さない',
  prevView.label.startsWith(`FY${annFy - 1}（`) && prevView.notice.includes('過去の年度') && !prevView.done && !prevView.bulk && !prevView.addBtn,
  JSON.stringify(prevView));
await api(`/api/plans/${annDoneP.json?.id}`, { method: 'DELETE' });

// 電気設備点検: 保存を連打しても同じ日の記録は1件（サーバー先行の保存のため、送信中の2回目で2件できていた）
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
const elDblDate = '2026-01-20';
await page.evaluate(async (d) => {
  showTab('entry');
  document.getElementById('date').value = d;
  document.getElementById('inspector').value = 'E2E連打';
  await Promise.all([saveRecord(), saveRecord()]);
}, elDblDate);
const elDblRecs = Object.values((await api('/api/electrical-inspections?equipment_type=main')).json?.records || [])
  .filter((r) => r.date === elDblDate && r.inspector === 'E2E連打');
check('電気点検: 保存を連打しても同じ日の記録は1件', elDblRecs.length === 1, `件数=${elDblRecs.length}`);
for (const r of elDblRecs) await api(`/api/electrical-inspections/${encodeURIComponent(r.id)}`, { method: 'DELETE' });

// ---------- 9.16 再点検の残り（期間予定の1日点検・部品・復元・同時登録・日時の検証・設定の再送） ----------
section('9.16 期間予定の1日点検・部品マージ履歴・復元の重複・同時登録・日時検証・設定の競合');
// 期間予定の1日（カレンダーの日程シート）から始めた点検は、その日だけを完了にする
const pdPlan = await api('/api/plans', { method: 'POST', body: { title: 'E2E期間点検1日', plan_type: 'inspection', planned_date: '2033-03-10', planned_end_date: '2033-03-12' } });
const pdUrl = await page.evaluate(async (id) => {
  const m = await import('/js/plan-inspection-link.js');
  return m.buildInspectionStartUrl({ id, planned_date: '2033-03-10' }, '2033-03-11');
}, pdPlan.json?.id);
check('点検開始URL: 日程シートから開くと plan_day が付く', /[?&]plan_day=2033-03-11(&|$)/.test(pdUrl), pdUrl);
await page.evaluate(async (id) => {
  const m = await import('/js/plan-inspection-link.js');
  await m.completePlanAfterInspection(id, '2033-03-11');
}, pdPlan.json?.id);
const pdRows = ((await api('/api/plans?from=2033-03-01&to=2033-04-01')).json?.plans || []).filter((p) => p.title === 'E2E期間点検1日');
const pdDone = pdRows.filter((p) => p.status === 'done').map((p) => `${p.planned_date}~${p.planned_end_date || ''}`);
const pdLeft = pdRows.filter((p) => p.status !== 'done').length;
check('点検の保存で、期間予定はその日だけ完了・残りの日程は未完了のまま',
  pdDone.length === 1 && pdDone[0].startsWith('2033-03-11') && pdLeft === 2, JSON.stringify(pdRows.map((p) => [p.planned_date, p.planned_end_date, p.status])));
for (const p of pdRows) await api(`/api/plans/${p.id}`, { method: 'DELETE' });

// 部品CSVの差分マージで在庫数が変わったら、入出庫履歴（調整）と監査ログに残す
const mqPart = await api('/api/parts', { method: 'POST', body: { name: 'E2Eマージ数量', model_no: 'E2EMQ-1', quantity: 5 } });
const mqRes = await api('/api/parts/import', { method: 'POST', body: { mode: 'merge', rows: [{ model_no: 'E2EMQ-1', name: 'E2Eマージ数量', quantity: 8 }] } });
const mqDetail = (await api(`/api/parts/${mqPart.json?.id}`)).json || {};
const mqTx = (mqDetail.transactions || []).find((t) => t.type === 'adjust' && t.note === 'CSV取込（差分マージ）');
check('部品マージ: 在庫数の変更が入出庫履歴に「調整 +3」で残る', mqRes.status === 200 && mqDetail.part?.quantity === 8 && mqTx?.quantity === 3,
  JSON.stringify({ st: mqRes.status, q: mqDetail.part?.quantity, tx: mqTx }));
const mqAudit = ((await api('/api/admin/audit?table=parts_inventory&limit=20')).json?.logs || [])
  .map((l) => { try { return JSON.parse(l.diff_json || 'null'); } catch { return null; } })
  .find((d) => d?.mode === 'merge' && (d.quantity_changes || []).some((c) => c.id === mqPart.json?.id));
check('部品マージ: 監査ログに在庫数の変更（いくつ→いくつ）が残る',
  mqAudit?.quantity_changes?.some((c) => c.id === mqPart.json?.id && c.from === 5 && c.to === 8), JSON.stringify(mqAudit));
const mqRes2 = await api('/api/parts/import', { method: 'POST', body: { mode: 'merge', rows: [{ model_no: 'E2EMQ-1', name: 'E2Eマージ数量', quantity: 8 }] } });
const mqTx2 = ((await api(`/api/parts/${mqPart.json?.id}`)).json?.transactions || []).filter((t) => t.note === 'CSV取込（差分マージ）');
check('部品マージ: 在庫数が変わらなければ履歴を作らない', mqRes2.status === 200 && mqTx2.length === 1, `件数=${mqTx2.length}`);
await api(`/api/parts/${mqPart.json?.id}`, { method: 'DELETE' });

// 全置き換え等で作り直された部品がある場合、同じ型番・部品名の旧部品は復元できない（重複を作らない）
const rdOld = await api('/api/parts', { method: 'POST', body: { name: 'E2E復元重複', model_no: 'E2ERD-1' } });
await api(`/api/parts/${rdOld.json?.id}`, { method: 'DELETE' });
const rdNew = await api('/api/parts', { method: 'POST', body: { name: 'E2E復元重複', model_no: 'E2ERD-1' } });
const rdRes = await api('/api/admin/restore', { method: 'POST', body: { table: 'parts_inventory', id: rdOld.json?.id } });
check('復元: 同じ型番・部品名の部品があれば409（重複を作らない）', rdRes.status === 409, `status=${rdRes.status}`);
await api(`/api/parts/${rdNew.json?.id}`, { method: 'DELETE' });
const rdRes2 = await api('/api/admin/restore', { method: 'POST', body: { table: 'parts_inventory', id: rdOld.json?.id } });
const rdRes3 = await api('/api/admin/restore', { method: 'POST', body: { table: 'parts_inventory', id: rdOld.json?.id } });
check('復元: 重複が無ければ復元でき、2回目は404/409', rdRes2.status === 200 && (rdRes3.status === 404 || rdRes3.status === 409),
  `1回目=${rdRes2.status} 2回目=${rdRes3.status}`);
await api(`/api/parts/${rdOld.json?.id}`, { method: 'DELETE' });

// ユーティリティ日報: 同じ日を2台で同時に登録しても1件だけ（確認と登録の間をすり抜けない）
const ucDate = '2033-04-01';
const [uc1, uc2] = await Promise.all([1, 2].map(() => api('/api/utility-reports', { method: 'POST', body: { report_date: ucDate, values: {} } })));
const ucStatuses = [uc1.status, uc2.status].sort();
const ucList = ((await api(`/api/utility-reports?from=${ucDate}&to=${ucDate}`)).json?.reports || []);
check('ユーティリティ: 同じ日の同時登録は1件が201・もう1件は409', ucStatuses[0] === 201 && ucStatuses[1] === 409 && ucList.length === 1,
  JSON.stringify({ ucStatuses, n: ucList.length }));
for (const r of ucList) await api(`/api/utility-reports/${r.id}`, { method: 'DELETE' });

// トラブル記録の発生日時はサーバーでも検証し、UTC・秒精度にそろえて保存する（期間の絞り込みから外れない）
const occBad = await api('/api/troubles', { method: 'POST', body: { occurred_at: '昨日の夕方', phenomenon: 'E2E日時検証' } });
check('トラブル: 日時でない occurred_at は400', occBad.status === 400, `status=${occBad.status}`);
const occJst = await api('/api/troubles', { method: 'POST', body: { occurred_at: '2033-05-01T08:30+09:00', phenomenon: 'E2E日時検証' } });
const occGot = (await api(`/api/troubles/${occJst.json?.id}`)).json?.trouble;
check('トラブル: +09:00 付きの日時は UTC の秒精度で保存される', occJst.status === 201 && occGot?.occurred_at === '2033-04-30T23:30:00Z', `${occJst.status} ${occGot?.occurred_at}`);
const occAudit = ((await api(`/api/admin/audit?table=trouble_record&limit=20`)).json?.logs || []).find((l) => String(l.record_id) === String(occJst.json?.id) && l.action === 'create');
check('トラブル: 登録と同時に監査ログ（create）が残る', !!occAudit);
const occPutBad = await api(`/api/troubles/${occJst.json?.id}`, { method: 'PUT', body: { occurred_at: '2033-13-40' } });
check('トラブル: 編集でも日時でない occurred_at は400', occPutBad.status === 400, `status=${occPutBad.status}`);
await api(`/api/troubles/${occJst.json?.id}`, { method: 'DELETE' });

// 電気設定: 未送信の設定を再送するとき、その後に他の管理者がサーバーで保存していたら確認する
const elStale = await api('/api/electrical-config', { method: 'PUT', body: { equipment_type: 'battery', config: [], expected_updated_at: '2000-01-01T00:00:00Z' } });
check('電気設定API: 古い更新日時を添えた保存は409', elStale.status === 409, `status=${elStale.status}`);
await page.goto(`${BASE}/electrical/`, { waitUntil: 'networkidle' });
const elLocal = [{ id: 'cf', title: 'E2E競合ローカル', checks: [], measurements: [] }];
await page.evaluate((cfg) => localStorage.setItem('elec_unsynced_config_battery', JSON.stringify({ value: cfg, base: '2000-01-01T00:00:00Z' })), elLocal);
const elCfDlgBefore = dialogs.length;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const elConflictAsked = dialogs.slice(elCfDlgBefore).some((d) => d.includes('他の管理者'));
const elCfgBattery = (await api('/api/electrical-config')).json?.battery;
check('電気設定: 再送前に他の管理者の変更があれば確認し、OK でこの端末の内容を保存する',
  elConflictAsked && elCfgBattery?.[0]?.title === 'E2E競合ローカル', JSON.stringify({ asked: elConflictAsked, title: elCfgBattery?.[0]?.title }));

// ---------- 9.17 無料枠の使用状況（Cloudflare の利用量） ----------
section('9.17 無料枠の使用状況（リクエスト・行数・操作回数・AI・ビルド）');
const usageRes = await api('/api/admin/usage');
check('利用量API: トークン未設定なら cloudflare.configured=false（他の項目は今までどおり）',
  usageRes.status === 200 && usageRes.json?.cloudflare?.configured === false && usageRes.json?.r2 && usageRes.json?.access,
  JSON.stringify(usageRes.json?.cloudflare));
check('利用量API: D1 のサイズが取れる（PRAGMA か D1 の応答の実サイズ）', Number(usageRes.json?.d1?.size_bytes) > 0, String(usageRes.json?.d1?.size_bytes));
const usageByEditor = await apiAs(editorEmail, '/api/admin/usage');
check('利用量API: 管理者以外は403', usageByEditor.status === 403, `status=${usageByEditor.status}`);
await page.goto(`${BASE}/pages/admin`, { waitUntil: 'networkidle' });
await page.click('.tab-btn[data-tab="files"]');
await page.waitForSelector('#cf-usage', { timeout: 10000 });
const cfUnset = await page.evaluate(() => document.querySelector('#cf-usage')?.innerText || '');
check('無料枠: 未設定なら全項目の無料枠と設定方法を案内する',
  cfUnset.includes('未設定') && cfUnset.includes('R2 Class A') && cfUnset.includes('Workers AI') && cfUnset.includes('CF_API_TOKEN'), cfUnset.slice(0, 200));
// 設定済みの表示: 画面側の fetch を、フラグが立っているときだけ偽の利用量に差し替える（GET は SW 経由で page.route が効かない）
await page.addInitScript(() => {
  if (!sessionStorage.getItem('e2eFakeCfUsage')) return;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.origin);
    const res = await orig(input, init);
    if (u.pathname !== '/api/admin/usage') return res;
    const body = await res.json();
    body.cloudflare = { configured: true, fetched_at: '2026-10-28T05:30:00Z', items: {
      workers_requests: { used: 92000, limit: 100000, period: 'day' },
      d1_rows_read: { used: 250000, limit: 5000000, period: 'day' },
      d1_rows_written: { used: 3000, limit: 100000, period: 'day' },
      r2_class_a: { used: 45, limit: 1000000, period: 'month' },
      r2_class_b: { used: 900, limit: 10000000, period: 'month' },
      ai_neurons: { error: 'unknown field', limit: 10000, period: 'day' },
      pages_builds: { used: 12, limit: 500, period: 'month' },
    } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
await page.evaluate(() => sessionStorage.setItem('e2eFakeCfUsage', '1'));
const cfVp = page.viewportSize();
await page.setViewportSize({ width: 375, height: 720 }); // スマホ幅で崩れないこと
await page.reload({ waitUntil: 'networkidle' });
await page.click('.tab-btn[data-tab="files"]');
await page.waitForSelector('#cf-usage .cf-usage-row', { timeout: 10000 });
const cfSet = await page.evaluate(() => ({
  rows: document.querySelectorAll('#cf-usage .cf-usage-row').length,
  text: document.querySelector('#cf-usage')?.innerText || '',
  overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
}));
check('無料枠: 設定済みなら7項目をメーターで表示（今日／今月・件数・割合）',
  cfSet.rows === 7 && cfSet.text.includes('今日 92,000 / 100,000回（92%）') && cfSet.text.includes('今月 12 / 500回'), cfSet.text.slice(0, 300));
check('無料枠: 80%を超えた項目に警告、取れなかった項目は「取得できませんでした」',
  cfSet.text.includes('⚠ 無料枠の92%') && /Workers AI[\s\S]*取得できませんでした/.test(cfSet.text), cfSet.text.slice(0, 300));
check('無料枠: スマホ幅（375px）で画面からはみ出さない', !cfSet.overflow);
if (cfVp) await page.setViewportSize(cfVp);
await page.evaluate(() => sessionStorage.removeItem('e2eFakeCfUsage'));

// ---------- 9.18 ラベル印刷の開始位置（使いかけの台紙） ----------
section('9.18 ラベル印刷の開始位置');
await page.goto(`${BASE}/pages/labels`, { waitUntil: 'networkidle' });
await page.waitForSelector('.label-start-grid .label-start-cell', { timeout: 10000 });
const lbBefore = await page.evaluate(() => ({
  skip: document.querySelectorAll('.label-page .label-skip').length,
  labels: document.querySelectorAll('.label-page .label-cell:not(.label-skip)').length,
}));
check('ラベル: 既定は左上から（空きマスなし）', lbBefore.skip === 0 && lbBefore.labels > 0, JSON.stringify(lbBefore));
// 上から2段目・左から3列目（7マス目）をタップ → 先頭6マスを空ける
await page.click('.label-start-cell[aria-label="上から2段目・左から3列目から印刷"]');
const lbAfter = await page.evaluate(() => {
  const pages = [...document.querySelectorAll('.label-page')];
  const first = pages[0] ? [...pages[0].children] : [];
  return {
    firstSkips: first.filter((c) => c.classList.contains('label-skip')).length,
    seventhIsLabel: !!first[6] && !first[6].classList.contains('label-skip'),
    otherSkips: pages.slice(1).reduce((n, p) => n + p.querySelectorAll('.label-skip').length, 0),
    labels: document.querySelectorAll('.label-page .label-cell:not(.label-skip)').length,
    pages: pages.length,
    perPageMax: Math.max(...pages.map((p) => p.children.length)),
    text: document.querySelector('.label-start-text')?.textContent || '',
    count: document.querySelector('.labels-controls .action-row .hint')?.textContent || '',
    pressed: document.querySelector('.label-start-cell[aria-pressed="true"]')?.getAttribute('aria-label'),
  };
});
check('ラベル: 2段目・3列目を選ぶと1枚目の先頭6マスを空け、7マス目から印刷',
  lbAfter.firstSkips === 6 && lbAfter.seventhIsLabel && lbAfter.otherSkips === 0 && lbAfter.labels === lbBefore.labels,
  JSON.stringify(lbAfter));
check('ラベル: 台紙は24面ごとに分かれ、枚数表示も空きマスを含めて数える',
  lbAfter.perPageMax <= 24 && lbAfter.pages === Math.ceil((6 + lbAfter.labels) / 24) && lbAfter.count.includes(`台紙 ${lbAfter.pages} 枚`),
  JSON.stringify(lbAfter));
check('ラベル: 開始位置の案内が出る', lbAfter.text.includes('上から2段目・左から3列目から') && lbAfter.pressed === '上から2段目・左から3列目から印刷', lbAfter.text);
// 印刷時は空きマスに何も出さない（位置だけ確保）
await page.emulateMedia({ media: 'print' });
const lbPrint = await page.evaluate(() => {
  const skip = document.querySelector('.label-page .label-skip');
  const label = document.querySelector('.label-page .label-cell:not(.label-skip)');
  return { skipVis: skip ? getComputedStyle(skip).visibility : null, labelVis: label ? getComputedStyle(label).visibility : null,
    controls: getComputedStyle(document.querySelector('.labels-controls')).display };
});
await page.emulateMedia({ media: 'screen' });
check('ラベル: 印刷では空きマスを表示せず、操作パネルも出さない',
  lbPrint.skipVis === 'hidden' && lbPrint.labelVis === 'visible' && lbPrint.controls === 'none', JSON.stringify(lbPrint));
await page.click('.label-start-wrap button:has-text("左上に戻す")');
check('ラベル: 「左上に戻す」で空きマスが無くなる', await page.evaluate(() => document.querySelectorAll('.label-page .label-skip').length === 0));

// ---------- 9.19 在庫: その場で記録・送信待ち・二重反映防止・自動更新 ----------
section('9.19 在庫のリアルタイム化（部品QR・その場で記録・送信待ち・二重反映防止・自動更新）');
const rtPart = await api('/api/parts', { method: 'POST', body: { name: 'E2Eリアルタイム部品', model_no: 'E2E-RT-1', location: '棚A-1', quantity: 10, safety_stock: 1 } });
const rtId = rtPart.json?.id;
const rtTx = (body) => api(`/api/parts/${rtId}/transaction`, { method: 'POST', body });
const rtQty = async () => (await api(`/api/parts/${rtId}`)).json?.part?.quantity;
const rt1 = await rtTx({ type: 'out', quantity: 2, client_tx_id: 'e2e-rt-tx-0001' });
const rt2 = await rtTx({ type: 'out', quantity: 2, client_tx_id: 'e2e-rt-tx-0001' });
check('入出庫: 同じ識別番号を2回送っても在庫は1回だけ減る（再送・押し直し）',
  rt1.status === 200 && rt2.status === 200 && rt2.json?.duplicate === true && (await rtQty()) === 8, JSON.stringify([rt1.json, rt2.json]));
const [rc1, rc2] = await Promise.all([1, 2].map(() => rtTx({ type: 'in', quantity: 5, client_tx_id: 'e2e-rt-tx-0002' })));
check('入出庫: 同じ識別番号が同時に届いても1回だけ反映', [rc1.status, rc2.status].every((x) => x === 200) && (await rtQty()) === 13,
  JSON.stringify([rc1.json, rc2.json]));
const rtBad = await rtTx({ type: 'out', quantity: 1, client_tx_id: 'x"; DROP' });
check('入出庫: 識別番号の形式が不正なら400', rtBad.status === 400, `status=${rtBad.status}`);
const rtNoId = await rtTx({ type: 'out', quantity: 1 });
check('入出庫: 識別番号なし（従来の呼び出し）も動く', rtNoId.status === 200 && (await rtQty()) === 12);

// 部品詳細: 部品QR・その場で記録（数量を ＋ して出庫）
await page.goto(`${BASE}/pages/parts?id=${rtId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.quick-record', { timeout: 10000 });
check('部品詳細: 部品QRコードとラベル印刷のリンクがある',
  await page.evaluate(() => !!document.querySelector('img.qr-img[alt^="部品QRコード"]') && !!document.querySelector('a[href*="/pages/labels?type=parts&ids="]')));
await page.click('.quick-record button[aria-label="数量を増やす"]');
await page.click('.quick-record button[aria-label="数量を増やす"]');
// 2回タップしても1回だけ記録される
await page.evaluate(() => { const b = [...document.querySelectorAll('.quick-record .quick-btn')].find((x) => x.textContent.includes('出庫')); b.click(); b.click(); });
await page.waitForTimeout(1200);
check('その場で記録: 数量3で出庫（2回タップしても1回だけ）', (await rtQty()) === 9, `qty=${await rtQty()}`);
check('その場で記録: 画面の在庫数が更新される', await page.evaluate(() => [...document.querySelectorAll('.info-row')].some((r) => r.textContent.includes('在庫数') && r.textContent.includes('9'))));

// オフライン（電波の無い倉庫）: QR で開いても名前・在庫の目安を出し、出庫を送信待ちに保存 → 復帰で自動送信
await context.setOffline(true);
await page.goto(`${BASE}/pages/parts?id=${rtId}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForSelector('.quick-record', { timeout: 10000 }).catch(() => {});
const rtOff = await page.evaluate(() => document.querySelector('#app')?.innerText || '');
check('オフライン: 部品画面が開き、前回見た名前・在庫の目安を表示', rtOff.includes('オフライン') && rtOff.includes('E2Eリアルタイム部品') && rtOff.includes('在庫数（目安）'), rtOff.slice(0, 200));
const rtDlg = dialogs.length;
await page.click('.quick-record .quick-btn:has-text("出庫")');
await page.waitForTimeout(800);
check('オフライン: 出庫を送信待ちに保存する', dialogs.slice(rtDlg).some((d) => d.includes('送信待ち')) &&
  await page.evaluate(() => (document.querySelector('.offline-queued')?.textContent || '').includes('出庫 −1')), dialogs.slice(rtDlg).join(' / '));
await context.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(2500);
check('オフライン: 電波が戻ると自動で送信され、在庫が1減る', (await rtQty()) === 8, `qty=${await rtQty()}`);
// 同じ送信待ちを（別タブ等で）もう一度送っても二重に反映されない
const rtQueuedId = (await api(`/api/parts/${rtId}`)).json?.transactions?.find((t) => t.note === 'その場で記録' && t.quantity === -1)?.client_tx_id;
const rtReplay = rtQueuedId ? await rtTx({ type: 'out', quantity: 1, client_tx_id: rtQueuedId }) : null;
check('オフライン: 送信待ちの再送は二重に反映されない', !!rtQueuedId && rtReplay?.json?.duplicate === true && (await rtQty()) === 8, String(rtQueuedId));

// 自動更新: 他の人の出庫が、画面を開いたまま反映される（テストでは間隔を短くする）
await page.addInitScript(() => { window.__PARTS_REFRESH_MS__ = 1500; });
await page.goto(`${BASE}/pages/parts?id=${rtId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.quick-record', { timeout: 10000 });
await rtTx({ type: 'out', quantity: 3 });
await page.waitForFunction(() => [...document.querySelectorAll('.info-row')].some((r) => r.textContent.includes('在庫数') && /在庫数\s*5/.test(r.textContent)), { timeout: 8000 }).catch(() => {});
check('自動更新: 部品詳細に他の人の出庫が反映される', await page.evaluate(() => [...document.querySelectorAll('.info-row')].some((r) => /在庫数\s*5/.test(r.textContent))));
await page.goto(`${BASE}/pages/parts`, { waitUntil: 'networkidle' });
await page.selectOption('select.parts-line-select >> nth=0', '__ALL__').catch(() => {});
await page.waitForTimeout(300);
const rtRowQty = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('#app .list-item')].find((r) => r.textContent.includes('E2Eリアルタイム部品'));
  return row?.querySelector('.parts-qty-num')?.textContent ?? null;
});
const rtListBefore = await rtRowQty();
await rtTx({ type: 'in', quantity: 1 });
await page.waitForFunction(() => {
  const row = [...document.querySelectorAll('#app .list-item')].find((r) => r.textContent.includes('E2Eリアルタイム部品'));
  return row?.querySelector('.parts-qty-num')?.textContent === '6';
}, { timeout: 8000 }).catch(() => {});
const rtListAfter = await rtRowQty();
check('自動更新: 部品一覧も一定間隔で取り直し、他の人の入庫が反映される', rtListBefore === '5' && rtListAfter === '6', `${rtListBefore} → ${rtListAfter}`);
await page.evaluate(() => { delete window.__PARTS_REFRESH_MS__; });

// 部品ラベル: 同じ40mm台紙。部品詳細から開くとその部品だけが選ばれている
await page.goto(`${BASE}/pages/labels?type=parts&ids=${rtId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.label-page .label-cell', { timeout: 10000 });
const rtLabel = await page.evaluate(() => ({
  cells: [...document.querySelectorAll('.label-page .label-cell:not(.label-skip)')].map((c) => c.innerText.replace(/\s+/g, ' ')),
  title: document.querySelector('.labels-controls .card-title')?.textContent || '',
}));
check('部品ラベル: 指定した部品だけを型番・部品名・場所で印刷', rtLabel.cells.length === 1 && rtLabel.cells[0].includes('E2E-RT-1') && rtLabel.cells[0].includes('棚A-1') && rtLabel.title.includes('部品'),
  JSON.stringify(rtLabel));
await api(`/api/parts/${rtId}`, { method: 'DELETE' });

// ---------- 10. オフラインでの静的表示 ----------
section('10. オフラインでアプリが起動する（SWプリキャッシュ）');
await context.setOffline(true);
const resp = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
const offlineOk = !!resp && resp.status() === 200 &&
  await page.evaluate(() => document.body.innerText.includes('設備保全'));
check('オフラインでホームが表示される', offlineOk);
// クエリ付きのページ（QRの遷移先 /pages/ledger?id= 等）もオフラインで開ける（ホームに戻されない）
const respQ = await page.goto(`${BASE}/pages/ledger?id=999999&e2e=offline`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
check('オフラインでクエリ付きページ（設備台帳）が開ける', !!respQ && respQ.status() === 200 && (await page.title()).includes('設備台帳'),
  respQ ? `status=${respQ.status()} title=${await page.title()}` : 'no response');
await context.setOffline(false);

// ---------- 結果 ----------
await browser.close();
console.log(`\n========== 結果: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) {
  console.log('失敗項目:', failures.join(' / '));
  process.exit(1);
}
