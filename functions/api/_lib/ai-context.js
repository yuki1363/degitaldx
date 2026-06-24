// AIアシスタント用「今開いているページの内容」コンテキスト生成
//   buildPageContext(db, pageUrl) → 表示中レコードを要約した日本語テキスト（無ければ ''）
//   詳細ページ（?id=N）は該当レコードをD1から取得して整形。一覧・その他は画面名のみ。
//   すべてプリペアドステートメント・論理削除（deleted_at IS NULL）除外。

const REPAIR_STATUS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
const PLAN_TYPE = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const PLAN_STATUS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const EQ_STATUS = { active: '稼働中', stopped: '停止中', retired: '廃棄' };

const PAGE_LABELS = {
  '/': 'ホーム',
  '/pages/trouble': 'トラブル記録の一覧',
  '/pages/inspection': '点検実施の一覧',
  '/pages/repair': '業務依頼の一覧',
  '/pages/ledger': '設備台帳の一覧',
  '/pages/plan': '保全計画カレンダー',
  '/pages/report': '日報の一覧',
  '/pages/parts': '部品在庫',
  '/pages/dashboard': 'ダッシュボード',
  '/pages/search': '横断検索',
};

// 長文は安全にカット（neuronコスト・暴走防止）
function cap(s, n = 600) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ISO(UTC) → JST 表示 'YYYY/MM/DD HH:mm'
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

// 'YYYY-MM-DD'（日付のみ）→ 'YYYY/MM/DD'
function fmtDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10).replace(/-/g, '/');
}

export async function buildPageContext(db, pageUrl) {
  if (!db || !pageUrl || typeof pageUrl !== 'string') return '';
  let path = '';
  let id = null;
  try {
    const u = new URL(pageUrl, 'https://app.local');
    path = u.pathname;
    id = Number(u.searchParams.get('id')) || null;
  } catch {
    return '';
  }

  try {
    if (id && Number.isInteger(id) && id > 0) {
      switch (path) {
        case '/pages/trouble': return await troubleContext(db, id);
        case '/pages/inspection': return await inspectionContext(db, id);
        case '/pages/repair': return await repairContext(db, id);
        case '/pages/ledger': return await ledgerContext(db, id);
        case '/pages/plan': return await planContext(db, id);
        case '/pages/report': return await reportContext(db, id);
        default: break;
      }
    }
  } catch {
    return '';
  }

  const label = PAGE_LABELS[path];
  return label ? `ユーザーは「${label}」の画面を見ています。特定のレコードは選択されていません。` : '';
}

async function troubleContext(db, id) {
  const r = await db.prepare(
    `SELECT t.occurred_at, t.phenomenon, t.cause, t.countermeasure,
            e.code AS eq_code, e.name AS eq_name, c.name AS category
       FROM trouble_record t
       LEFT JOIN equipment_ledger e ON e.id = t.equipment_id
       LEFT JOIN trouble_category c ON c.id = t.category_id
      WHERE t.id = ?1 AND t.deleted_at IS NULL`
  ).bind(id).first();
  if (!r) return '';
  const lines = ['【トラブル記録の詳細】'];
  if (r.occurred_at) lines.push(`発生日時: ${fmtDateTime(r.occurred_at)}`);
  if (r.eq_name) lines.push(`設備: ${(r.eq_code || '').trim()} ${r.eq_name}`.trim());
  if (r.category) lines.push(`ジャンル: ${r.category}`);
  if (r.phenomenon) lines.push(`現象: ${cap(r.phenomenon)}`);
  if (r.cause) lines.push(`原因: ${cap(r.cause)}`);
  if (r.countermeasure) lines.push(`対策: ${cap(r.countermeasure)}`);
  return lines.join('\n');
}

async function inspectionContext(db, id) {
  const r = await db.prepare(
    `SELECT i.inspected_at, i.items_json, i.has_abnormal, i.note, i.assignee_name,
            e.code AS eq_code, e.name AS eq_name
       FROM inspection_result i
       LEFT JOIN equipment_ledger e ON e.id = i.equipment_id
      WHERE i.id = ?1 AND i.deleted_at IS NULL`
  ).bind(id).first();
  if (!r) return '';
  const lines = ['【点検記録の詳細】'];
  if (r.eq_name) lines.push(`設備: ${(r.eq_code || '').trim()} ${r.eq_name}`.trim());
  if (r.inspected_at) lines.push(`実施日時: ${fmtDateTime(r.inspected_at)}`);
  if (r.assignee_name) lines.push(`担当: ${r.assignee_name}`);
  lines.push(`総合判定: ${r.has_abnormal ? '異常あり' : '正常'}`);
  try {
    const items = JSON.parse(r.items_json || '[]');
    if (Array.isArray(items) && items.length) {
      lines.push('点検項目:');
      for (const it of items) {
        let v = it.value;
        if (it.input_type === 'ok_ng') v = it.value === 'ok' ? 'OK' : 'NG';
        const unit = it.unit ? ` ${it.unit}` : '';
        lines.push(`  - ${it.name}: ${v}${unit}${it.abnormal ? ' ⚠異常' : ''}`);
      }
    }
  } catch { /* items_json が壊れていても無視 */ }
  if (r.note) lines.push(`備考: ${cap(r.note)}`);
  return lines.join('\n');
}

async function repairContext(db, id) {
  const r = await db.prepare(
    `SELECT rr.title, rr.description, rr.status, rr.assignee_name,
            e.code AS eq_code, e.name AS eq_name
       FROM repair_request rr
       LEFT JOIN equipment_ledger e ON e.id = rr.equipment_id
      WHERE rr.id = ?1 AND rr.deleted_at IS NULL`
  ).bind(id).first();
  if (!r) return '';
  const lines = ['【業務依頼の詳細】'];
  if (r.title) lines.push(`件名: ${r.title}`);
  lines.push(`状態: ${REPAIR_STATUS[r.status] || r.status}`);
  if (r.eq_name) lines.push(`設備: ${(r.eq_code || '').trim()} ${r.eq_name}`.trim());
  if (r.assignee_name) lines.push(`担当: ${r.assignee_name}`);
  if (r.description) lines.push(`内容: ${cap(r.description)}`);
  return lines.join('\n');
}

async function ledgerContext(db, id) {
  const e = await db.prepare(
    `SELECT code, name, location, manufacturer, model, status, note
       FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id).first();
  if (!e) return '';
  const lines = ['【設備台帳の詳細】'];
  lines.push(`設備: ${(e.code || '').trim()} ${e.name}`.trim());
  if (e.location) lines.push(`設置場所: ${e.location}`);
  if (e.manufacturer) lines.push(`メーカー: ${e.manufacturer}`);
  if (e.model) lines.push(`型式: ${e.model}`);
  lines.push(`状態: ${EQ_STATUS[e.status] || e.status}`);
  if (e.note) lines.push(`備考: ${cap(e.note)}`);

  const { results: troubles } = await db.prepare(
    `SELECT occurred_at, phenomenon, cause FROM trouble_record
      WHERE equipment_id = ?1 AND deleted_at IS NULL
      ORDER BY occurred_at DESC LIMIT 3`
  ).bind(id).all();
  if (troubles && troubles.length) {
    lines.push('最近のトラブル:');
    for (const t of troubles) {
      lines.push(`  - [${fmtDate(t.occurred_at)}] ${cap(t.phenomenon, 80)}${t.cause ? `（原因: ${cap(t.cause, 60)}）` : ''}`);
    }
  }

  const { results: insp } = await db.prepare(
    `SELECT inspected_at, has_abnormal FROM inspection_result
      WHERE equipment_id = ?1 AND deleted_at IS NULL
      ORDER BY inspected_at DESC LIMIT 3`
  ).bind(id).all();
  if (insp && insp.length) {
    lines.push('最近の点検:');
    for (const i of insp) lines.push(`  - [${fmtDate(i.inspected_at)}] ${i.has_abnormal ? '異常あり' : '正常'}`);
  }
  return lines.join('\n');
}

async function planContext(db, id) {
  const r = await db.prepare(
    `SELECT p.title, p.plan_type, p.planned_date, p.planned_end_date, p.status,
            p.assignee_name, p.note, p.equipment_name, p.line_name,
            e.code AS eq_code, e.name AS eq_name
       FROM maintenance_plan p
       LEFT JOIN equipment_ledger e ON e.id = p.equipment_id
      WHERE p.id = ?1 AND p.deleted_at IS NULL`
  ).bind(id).first();
  if (!r) return '';
  const lines = ['【保全計画の詳細】'];
  if (r.title) lines.push(`タイトル: ${r.title}`);
  lines.push(`種別: ${PLAN_TYPE[r.plan_type] || r.plan_type}`);
  const period = r.planned_end_date && r.planned_end_date !== r.planned_date
    ? `${fmtDate(r.planned_date)} 〜 ${fmtDate(r.planned_end_date)}`
    : fmtDate(r.planned_date);
  lines.push(`予定日: ${period}`);
  lines.push(`状態: ${PLAN_STATUS[r.status] || r.status}`);
  const eq = r.eq_name ? `${(r.eq_code || '').trim()} ${r.eq_name}`.trim() : (r.equipment_name || r.line_name || '');
  if (eq) lines.push(`設備: ${eq}`);
  if (r.assignee_name) lines.push(`担当: ${r.assignee_name}`);
  if (r.note) lines.push(`備考: ${cap(r.note)}`);
  return lines.join('\n');
}

async function reportContext(db, id) {
  const r = await db.prepare(
    `SELECT d.report_date, d.reporter_name, d.body, c.name AS category
       FROM daily_report d
       LEFT JOIN report_category c ON c.id = d.category_id
      WHERE d.id = ?1 AND d.deleted_at IS NULL`
  ).bind(id).first();
  if (!r) return '';
  const lines = ['【日報の詳細】'];
  lines.push(`日付: ${fmtDate(r.report_date)}`);
  if (r.reporter_name) lines.push(`記録者: ${r.reporter_name}`);
  if (r.category) lines.push(`カテゴリ: ${r.category}`);
  if (r.body) lines.push(`本文: ${cap(r.body, 800)}`);
  return lines.join('\n');
}
