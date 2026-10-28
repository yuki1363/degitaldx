// 単体テスト: Cloudflare の利用量の取得（functions/api/_lib/cf-analytics.js）
//   開発環境からは Cloudflare の API に届かないため、fetch を差し替えて応答の組み立てを確認する。
//   実行: node unit-cf-analytics.mjs（npm test から呼ばれる）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getCloudflareUsage, classifyR2, utcPeriods } = await import(
  pathToFileURL(path.join(ROOT, 'functions/api/_lib/cf-analytics.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== 単体: Cloudflare の利用量（無料枠の使用状況） ===');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const env = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: ACCOUNT, CF_PAGES_PROJECT: 'degitaldx' };
const NOW = new Date('2026-10-28T05:30:00Z');

// 偽の Cloudflare API。GraphQL はクエリに含まれるデータセット名で応答を返し分ける
const calls = [];
function fakeFetch({ failAi = false, deployments = null } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/graphql')) {
      const q = JSON.parse(init.body).query;
      const acct = (o) => reply(200, { data: { viewer: { accounts: [o] } }, errors: null });
      if (q.includes('workersInvocationsAdaptive')) return acct({ workersInvocationsAdaptive: [{ sum: { requests: 1200 } }] });
      if (q.includes('pagesFunctionsInvocationsAdaptiveGroups')) return acct({ pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 80000 } }] });
      if (q.includes('d1AnalyticsAdaptiveGroups')) return acct({ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 250000, rowsWritten: 3000 } }] });
      if (q.includes('r2OperationsAdaptiveGroups')) return acct({ r2OperationsAdaptiveGroups: [
        { sum: { requests: 40 }, dimensions: { actionType: 'PutObject' } },
        { sum: { requests: 5 }, dimensions: { actionType: 'ListObjects' } },
        { sum: { requests: 900 }, dimensions: { actionType: 'GetObject' } },
        { sum: { requests: 7 }, dimensions: { actionType: 'DeleteObject' } }, // 無料の操作は数えない
      ] });
      if (q.includes('aiInferenceAdaptiveGroups')) {
        return failAi
          ? reply(200, { data: null, errors: [{ message: 'unknown field "aiInferenceAdaptiveGroups"' }] })
          : acct({ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 9500 } }] });
      }
      return reply(400, { errors: [{ message: 'unexpected query' }] });
    }
    if (url.includes('/pages/projects/degitaldx/deployments')) {
      const page = Number(new URL(url).searchParams.get('page'));
      const list = deployments ? (deployments[page - 1] || []) : [];
      return reply(200, { success: true, result: list });
    }
    return reply(404, { success: false, errors: [{ message: 'not found' }] });
  };
}

ok('トークン未設定なら configured:false（Cloudflare へ問い合わせない）',
  (await getCloudflareUsage({}, { fetchImpl: fakeFetch(), now: NOW })).configured === false && calls.length === 0);
ok('アカウントIDが不正なら configured:false',
  (await getCloudflareUsage({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'abc"}' }, { fetchImpl: fakeFetch(), now: NOW })).configured === false);

const p = utcPeriods(NOW);
ok('期間は UTC の今日0時と今月1日', p.dayStart === '2026-10-28T00:00:00Z' && p.monthStart === '2026-10-01T00:00:00Z', JSON.stringify(p));

const r2 = classifyR2([
  { sum: { requests: 3 }, dimensions: { actionType: 'PutObject' } },
  { sum: { requests: 4 }, dimensions: { actionType: 'HeadObject' } },
  { sum: { requests: 9 }, dimensions: { actionType: 'DeleteObject' } },
]);
ok('R2 の操作を Class A／B に振り分け、無料の操作は数えない', r2.a === 3 && r2.b === 4, JSON.stringify(r2));

// 今月のデプロイ: 1ページ目25件（うち今月25）、2ページ目に先月が混ざったら止める
const mk = (n, date) => Array.from({ length: n }, () => ({ created_on: date }));
const deployments = [mk(25, '2026-10-20T00:00:00Z'), [...mk(3, '2026-10-02T00:00:00Z'), ...mk(22, '2026-09-30T00:00:00Z')], mk(25, '2026-09-01T00:00:00Z')];
calls.length = 0;
const u = await getCloudflareUsage(env, { fetchImpl: fakeFetch({ failAi: true, deployments }), now: NOW, noCache: true });
const it = u.items || {};
ok('Workers は Pages Functions と合わせた合計（無料枠10万/日）', it.workers_requests?.used === 81200 && it.workers_requests?.limit === 100000 && !it.workers_requests?.partial, JSON.stringify(it.workers_requests));
ok('D1 の読取・書込行数（今日）', it.d1_rows_read?.used === 250000 && it.d1_rows_written?.used === 3000 && it.d1_rows_read?.period === 'day');
ok('R2 Class A／B（今月）', it.r2_class_a?.used === 45 && it.r2_class_b?.used === 900 && it.r2_class_b?.limit === 10000000, JSON.stringify([it.r2_class_a, it.r2_class_b]));
ok('Workers AI が取れなくても他の項目は返し、AI だけ error', it.ai_neurons?.error?.includes('aiInferenceAdaptiveGroups') && it.ai_neurons?.limit === 10000, JSON.stringify(it.ai_neurons));
ok('Pages ビルドは今月分だけ数え、先月が出たページで止める', it.pages_builds?.used === 28 && calls.filter((c) => c.url.includes('/deployments')).length === 2, JSON.stringify(it.pages_builds));
ok('トークンは Authorization ヘッダーにだけ使い、応答に含めない',
  calls.every((c) => c.init.headers?.Authorization === 'Bearer tok') && !JSON.stringify(u).includes('tok"'));
ok('GraphQL にはアカウントIDを埋め込む', calls.some((c) => c.init.body && JSON.parse(c.init.body).query.includes(`accountTag: "${ACCOUNT}"`)));

// 5分キャッシュ: 2回目は問い合わせない。refresh（noCache）なら取り直す
calls.length = 0;
await getCloudflareUsage(env, { fetchImpl: fakeFetch({ deployments }), now: new Date(NOW.getTime() + 60_000) });
ok('5分以内の2回目はキャッシュを返す（API を叩きすぎない）', calls.length === 0, `calls=${calls.length}`);
await getCloudflareUsage(env, { fetchImpl: fakeFetch({ deployments }), now: new Date(NOW.getTime() + 60_000), noCache: true });
ok('再取得（refresh）は取り直す', calls.length > 0);

// Workers の片方だけ失敗 → 取れた分＋partial
const halfFetch = async (url, init) => {
  if (url.endsWith('/graphql') && JSON.parse(init.body).query.includes('pagesFunctionsInvocationsAdaptiveGroups')) {
    return new Response('{"errors":[{"message":"x"}]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fakeFetch({ deployments })(url, init);
};
const half = await getCloudflareUsage(env, { fetchImpl: halfFetch, now: NOW, noCache: true });
ok('Workers と Pages Functions の片方だけ取れたら、取れた分＋partial', half.items.workers_requests.used === 1200 && half.items.workers_requests.partial === true, JSON.stringify(half.items.workers_requests));

// 認証エラー（トークンの権限不足等）は全項目 error（例外にしない）
const deny = async () => new Response('{"success":false,"errors":[{"message":"Authentication error"}]}', { status: 403, headers: { 'Content-Type': 'application/json' } });
const denied = await getCloudflareUsage(env, { fetchImpl: deny, now: NOW, noCache: true });
ok('トークンが無効でも例外にせず、各項目を error で返す', Object.values(denied.items).every((x) => x.error), JSON.stringify(denied.items).slice(0, 200));

console.log(`\n========== 単体（Cloudflare 利用量）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
