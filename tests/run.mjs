// E2Eテストランナー — 1コマンドで「環境準備 → ローカルサーバー起動 → テスト → 後片付け」を行う
//
//   使い方:  cd tests && npm install && npm test
//
//   やること:
//     1. wrangler.toml から [ai] バインディングを一時的に外す
//        （ローカル/CI には Cloudflare の認証情報が無く、AI のリモート接続で起動に失敗するため。
//          終了時に必ず元へ戻す）
//     2. .dev.vars が無ければ .dev.vars.example から作る（DEV_USER_EMAIL でログイン扱いになる）
//     3. テスト専用の D1 状態ディレクトリ（.wrangler/e2e-state）を毎回作り直し、schema.sql を適用
//        （開発用のローカルDBには触れない）
//     4. wrangler pages dev をポート8799で起動し、e2e.mjs を実行
//     5. サーバー停止・wrangler.toml 復元・テスト状態の削除

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS_DIR, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST_DIR = path.join(ROOT, '.wrangler', 'e2e-state');
const TOML = path.join(ROOT, 'wrangler.toml');
const TOML_BACKUP = path.join(ROOT, 'wrangler.toml.e2e-backup');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const SERVER_LOG = path.join(TESTS_DIR, 'e2e-server.log');

const log = (m) => console.log(`[run] ${m}`);

// wrangler の実行ファイルを解決（tests/node_modules → PATH の順）
function wranglerBin() {
  const local = path.join(TESTS_DIR, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(local)) return local;
  return 'wrangler';
}

// [ai] セクションを取り除いた wrangler.toml を作る（セクションは次の [ か EOF まで）
function stripAiSection(toml) {
  const lines = toml.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\[ai\]\s*$/.test(line.trim())) { skipping = true; continue; }
    if (skipping && /^\[/.test(line.trim())) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

let server = null;
let createdDevVars = false;

function cleanup() {
  try { if (server && !server.killed) process.kill(-server.pid, 'SIGKILL'); } catch { /* 既に終了 */ }
  try {
    if (fs.existsSync(TOML_BACKUP)) {
      fs.copyFileSync(TOML_BACKUP, TOML);
      fs.unlinkSync(TOML_BACKUP);
      log('wrangler.toml を復元しました');
    }
  } catch (e) { console.error('[run] wrangler.toml の復元に失敗:', e.message); }
  try { if (createdDevVars && fs.existsSync(DEV_VARS)) fs.unlinkSync(DEV_VARS); } catch { /* 無視 */ }
  try { fs.rmSync(PERSIST_DIR, { recursive: true, force: true }); } catch { /* 無視 */ }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function waitForServer(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return true;
    } catch { /* まだ起動中 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

let exitCode = 1;
try {
  // 1. wrangler.toml の [ai] を一時除去（バックアップして復元保証）
  const toml = fs.readFileSync(TOML, 'utf8');
  fs.copyFileSync(TOML, TOML_BACKUP);
  fs.writeFileSync(TOML, stripAiSection(toml));
  log('wrangler.toml から [ai] を一時的に外しました（終了時に復元）');

  // 2. .dev.vars（ローカルログイン用）
  if (!fs.existsSync(DEV_VARS)) {
    fs.copyFileSync(path.join(ROOT, '.dev.vars.example'), DEV_VARS);
    createdDevVars = true;
    log('.dev.vars を .dev.vars.example から作成しました');
  }

  // 3. テスト専用DBを作り直して schema.sql 適用
  fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
  log('テスト用DBに schema.sql を適用中…');
  const schema = spawnSync(wranglerBin(),
    ['d1', 'execute', 'mainte-db', '--local', '--file=schema.sql', `--persist-to=${PERSIST_DIR}`],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (schema.status !== 0) {
    console.error(schema.stdout, schema.stderr);
    throw new Error('schema.sql の適用に失敗しました');
  }

  // 4. サーバー起動（プロセスグループごと止められるよう detached）
  log(`wrangler pages dev をポート ${PORT} で起動中…（ログ: tests/e2e-server.log）`);
  const logFd = fs.openSync(SERVER_LOG, 'w');
  server = spawn(wranglerBin(),
    ['pages', 'dev', '.', '--port', String(PORT), '--ip', '127.0.0.1', `--persist-to=${PERSIST_DIR}`],
    { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] });

  if (!(await waitForServer())) {
    throw new Error(`サーバーが起動しませんでした（${SERVER_LOG} を確認してください）`);
  }
  log('サーバー起動を確認。E2Eテストを実行します…\n');

  // 5. テスト本体
  const test = spawnSync(process.execPath, [path.join(TESTS_DIR, 'e2e.mjs')], {
    cwd: TESTS_DIR,
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE: BASE },
  });
  exitCode = test.status ?? 1;
} catch (err) {
  console.error(`[run] ${err.message}`);
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
