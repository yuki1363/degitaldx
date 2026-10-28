// Cloudflare の利用量（無料枠を超えると課金・停止になるもの）を Cloudflare の API から取得する
//   管理画面「ファイル容量」の「無料枠の使用状況」用（GET /api/admin/usage から呼ぶ・admin のみ）。
//
//   必要な環境変数（未設定なら configured:false を返し、画面は今までどおりダッシュボードへ案内する）:
//     CF_API_TOKEN     … 読み取り専用の API トークン（権限: Account Analytics: Read ／ Cloudflare Pages: Read）。
//                        暗号化（シークレット）で設定する。サーバー側だけで使い、応答には含めない
//     CF_ACCOUNT_ID    … Cloudflare のアカウントID（32桁の16進）
//     CF_PAGES_PROJECT … Pages のプロジェクト名（省略時 degitaldx）。ビルド回数を数えるのに使う
//
//   取得するもの（無料枠のリセットに合わせて UTC で数える）:
//     workers_requests … Workers ＋ Pages Functions のリクエスト（今日）。無料枠は両方の合計で 10万/日
//     d1_rows_read / d1_rows_written … D1 の読取・書込行数（今日・アカウント全体）
//     r2_class_a / r2_class_b … R2 の操作回数（今月）。actionType を公式の区分で A／B に振り分ける
//     ai_neurons       … Workers AI の使用量（今日）。データセット名は公式ドキュメントで確認できておらず不確か
//     pages_builds     … Pages のデプロイ数（今月）。ビルド回数の概算
//   項目ごとに別々に問い合わせ、失敗した項目だけ { error } にする（1項目の失敗で全体を止めない）。
//   GraphQL の値はリテラルで埋め込む（変数の型が日付/時刻でデータセットごとに違うため）。埋め込む値は
//   検証済みのアカウントID と、ここで作る日時文字列だけ（入力値は入らない）。

const API_BASE = 'https://api.cloudflare.com/client/v4';
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { key, at, data }

// 無料枠（CLAUDE.md の「Cloudflare 無料枠と有料化条件」と同じ値）
export const FREE_LIMITS = {
  workers_requests: 100_000,   // /日（Workers と Pages Functions の合計）
  d1_rows_read: 5_000_000,     // /日
  d1_rows_written: 100_000,    // /日
  r2_class_a: 1_000_000,       // /月
  r2_class_b: 10_000_000,      // /月
  ai_neurons: 10_000,          // /日
  pages_builds: 500,           // /月
};

// R2 の操作区分（公式の料金ページの一覧。ここに無い操作＝DeleteObject 等は無料）
const R2_CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload',
  'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart',
  'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
const R2_CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation',
  'GetBucketCors', 'GetBucketLifecycleConfiguration',
]);

export function classifyR2(groups) {
  let a = 0;
  let b = 0;
  for (const g of groups || []) {
    const type = g?.dimensions?.actionType;
    const n = Number(g?.sum?.requests) || 0;
    if (R2_CLASS_A.has(type)) a += n;
    else if (R2_CLASS_B.has(type)) b += n;
  }
  return { a, b };
}

// UTC の今日の 0:00 と今月1日 0:00（無料枠のリセット基準）
export function utcPeriods(now = new Date()) {
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const day = now.toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { day, dayStart: `${day}T00:00:00Z`, monthStart: iso(monthStart), now: iso(now) };
}

function config(env) {
  const token = env.CF_API_TOKEN;
  const accountId = String(env.CF_ACCOUNT_ID || '').trim();
  const project = String(env.CF_PAGES_PROJECT || 'degitaldx').trim();
  if (!token || !/^[0-9a-f]{32}$/i.test(accountId)) return null;
  return { token, accountId, project: /^[a-z0-9-]{1,63}$/.test(project) ? project : null };
}

async function graphql(cfg, fetchImpl, body) {
  const res = await fetchImpl(`${API_BASE}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ viewer { accounts(filter: { accountTag: "${cfg.accountId}" }) { ${body} } } }` }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`HTTP ${res.status}`);
  if (Array.isArray(json.errors) && json.errors.length) throw new Error(String(json.errors[0]?.message || 'GraphQL エラー').slice(0, 200));
  return json.data?.viewer?.accounts?.[0] ?? {};
}

const sumOf = (groups, field) => (groups || []).reduce((s, g) => s + (Number(g?.sum?.[field]) || 0), 0);
const fail = (err) => ({ error: String(err?.message || err).slice(0, 200) });

// Pages のデプロイ数（今月）。新しい順に返るので、今月より古いものが出たら止める（最大 40ページ＝1000件）
async function countPagesBuilds(cfg, fetchImpl, monthStart) {
  if (!cfg.project) throw new Error('CF_PAGES_PROJECT が不正です');
  let count = 0;
  for (let page = 1; page <= 40; page++) {
    const res = await fetchImpl(
      `${API_BASE}/accounts/${cfg.accountId}/pages/projects/${cfg.project}/deployments?page=${page}&per_page=25`,
      { headers: { Authorization: `Bearer ${cfg.token}` } },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(String(json?.errors?.[0]?.message || `HTTP ${res.status}`).slice(0, 200));
    const list = json.result || [];
    let older = false;
    for (const d of list) {
      if (String(d.created_on || '') >= monthStart) count++;
      else older = true;
    }
    if (older || list.length < 25) break;
  }
  return count;
}

/**
 * 利用量を取得する（5分キャッシュ）。
 * @returns {Promise<{configured:boolean, fetched_at?:string, period?:object, items?:object}>}
 */
export async function getCloudflareUsage(env, { fetchImpl = fetch, now = new Date(), noCache = false } = {}) {
  const cfg = config(env);
  if (!cfg) return { configured: false };
  const key = `${cfg.accountId}|${cfg.project}`;
  if (!noCache && cache && cache.key === key && now.getTime() - cache.at < CACHE_MS) return cache.data;

  const p = utcPeriods(now);
  const today = `datetime_geq: "${p.dayStart}", datetime_leq: "${p.now}"`;
  const month = `datetime_geq: "${p.monthStart}", datetime_leq: "${p.now}"`;
  const run = (fn) => fn().catch(fail);

  const [workers, pagesFn, d1, r2, ai, builds] = await Promise.all([
    run(async () => sumOf((await graphql(cfg, fetchImpl,
      `workersInvocationsAdaptive(limit: 10000, filter: { ${today} }) { sum { requests } }`)).workersInvocationsAdaptive, 'requests')),
    run(async () => sumOf((await graphql(cfg, fetchImpl,
      `pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { ${today} }) { sum { requests } }`)).pagesFunctionsInvocationsAdaptiveGroups, 'requests')),
    run(async () => {
      const g = (await graphql(cfg, fetchImpl,
        `d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: "${p.day}", date_leq: "${p.day}" }) { sum { rowsRead rowsWritten } }`)).d1AnalyticsAdaptiveGroups;
      return { read: sumOf(g, 'rowsRead'), written: sumOf(g, 'rowsWritten') };
    }),
    run(async () => classifyR2((await graphql(cfg, fetchImpl,
      `r2OperationsAdaptiveGroups(limit: 10000, filter: { ${month} }) { sum { requests } dimensions { actionType } }`)).r2OperationsAdaptiveGroups)),
    run(async () => sumOf((await graphql(cfg, fetchImpl,
      `aiInferenceAdaptiveGroups(limit: 10000, filter: { ${today} }) { sum { totalNeurons } }`)).aiInferenceAdaptiveGroups, 'totalNeurons')),
    run(() => countPagesBuilds(cfg, fetchImpl, p.monthStart)),
  ]);

  const item = (value, limitKey, period) => (value && typeof value === 'object' && 'error' in value
    ? { error: value.error, limit: FREE_LIMITS[limitKey], period }
    : { used: value, limit: FREE_LIMITS[limitKey], period });

  // Workers は Pages Functions と合わせた合計が無料枠。片方だけ取れたときは取れた分＋注記
  let workersItem;
  if (typeof workers === 'number' || typeof pagesFn === 'number') {
    workersItem = {
      used: (typeof workers === 'number' ? workers : 0) + (typeof pagesFn === 'number' ? pagesFn : 0),
      limit: FREE_LIMITS.workers_requests, period: 'day',
      breakdown: { workers: typeof workers === 'number' ? workers : null, pages_functions: typeof pagesFn === 'number' ? pagesFn : null },
      ...(typeof workers === 'number' && typeof pagesFn === 'number' ? {} : { partial: true }),
    };
  } else {
    workersItem = { error: workers.error || pagesFn.error, limit: FREE_LIMITS.workers_requests, period: 'day' };
  }
  const d1Err = d1 && 'error' in d1 ? d1 : null;
  const r2Err = r2 && 'error' in r2 ? r2 : null;

  const data = {
    configured: true,
    fetched_at: p.now,
    period: { day: p.day, month_start: p.monthStart },
    items: {
      workers_requests: workersItem,
      d1_rows_read: item(d1Err || d1.read, 'd1_rows_read', 'day'),
      d1_rows_written: item(d1Err || d1.written, 'd1_rows_written', 'day'),
      r2_class_a: item(r2Err || r2.a, 'r2_class_a', 'month'),
      r2_class_b: item(r2Err || r2.b, 'r2_class_b', 'month'),
      ai_neurons: item(ai, 'ai_neurons', 'day'),
      pages_builds: item(builds, 'pages_builds', 'month'),
    },
  };
  cache = { key, at: now.getTime(), data };
  return data;
}
