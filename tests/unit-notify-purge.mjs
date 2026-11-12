// 単体テスト: 確認済みの通知を30日後に削除する（overdue-notify.js）。実行: node --experimental-sqlite unit-notify-purge.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/_lib/overdue-notify.js')).href);
const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const db = { prepare: (sql) => ({ bind: (...a) => ({ async run() { const r = sqlite.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } }; } }) }) };
const now = Date.parse('2026-12-01T00:00:00Z');
const day = (n) => new Date(now - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ins = sqlite.prepare(`INSERT INTO notifications (type, level, title, acknowledged_by, acknowledged_at, created_at) VALUES ('t','info',?,?,?,?)`);
ins.run('確認31日前', 'a', day(31), day(40));
ins.run('確認29日前', 'a', day(29), day(40));
ins.run('未確認の古い通知', null, null, day(90));
ins.run('確認直後', 'a', day(0), day(1));
const n = await m.purgeOldAcknowledgedNotifications(db, now);
const left = sqlite.prepare('SELECT title FROM notifications ORDER BY id').all().map((r) => r.title);
let fail = 0;
const ok = (name, c) => { console.log(`  ${c ? '✅' : '❌'} ${name}`); if (!c) fail++; };
ok('確認から30日を過ぎた通知だけ削除する（1件）', n === 1 && !left.includes('確認31日前'));
ok('確認から30日以内・確認直後・未確認の通知（古くても）は消さない', left.length === 3 && left.includes('確認29日前') && left.includes('未確認の古い通知') && left.includes('確認直後'));
console.log(`\n========== 単体（通知の自動削除）: ${4 - 2 - fail} 件成功 / ${fail} 件失敗 ==========`);
if (fail) process.exit(1);
