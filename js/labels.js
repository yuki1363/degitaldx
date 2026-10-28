// 設備台帳ラベル・部品ラベルの一括印刷
//   URL: /pages/labels                     … 設備ラベル（QR → /pages/ledger?id=N）
//        /pages/labels?type=parts          … 部品ラベル（QR → /pages/parts?id=N。棚・部品箱に貼る）
//        /pages/labels?type=parts&ids=1,2  … 指定した部品だけを選んだ状態で開く（部品詳細の「ラベルを印刷」）
//   台紙はどちらも同じ A4・40×40mm・24面
//   設備を選択し、QRコード付きラベルをグリッドでまとめて印刷する。
//   QRを読み取るとその設備の詳細ページ（/pages/ledger?id=N）が直接開く。
//   使いかけの台紙に印刷できるよう、印刷の開始位置（上から◯段目・左から◯列目）を選べる。
//   開始位置より前のマスは空けて（何も印刷せず）位置だけ確保する。2枚目以降の台紙は左上から詰める。

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render } from '/js/util.js';
import qrcode from '/js/vendor/qrcode.mjs';

const app = document.getElementById('app');

// 台紙: 40×40mm・24面（4列×6段）A4。1ページ分の枚数（レイアウトは style.css の .label-page）
const LABELS_PER_PAGE = 24;
const COLS = 4;
const ROWS = 6;

// 設備詳細URLを埋め込んだQRコードの dataURL を生成（単票ラベルと同じ仕様）
// 誤り訂正は Q（汚れ・擦れのある現場向け。H は40mm角では密度が上がり過ぎるため使わない）
function qrDataUrl(text) {
  const qr = qrcode(0, 'Q');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

// 設備・部品を「QRのURL・1行目（太字）・2行目」にそろえる
const params = new URLSearchParams(window.location.search);
const MODE = params.get('type') === 'parts' ? 'parts' : 'equipment';
const KIND = MODE === 'parts'
  ? {
      noun: '部品', api: '/api/parts', listKey: 'parts',
      url: (x) => `${window.location.origin}/pages/parts?id=${x.id}`,
      code: (x) => x.model_no || `部品#${x.id}`,
      name: (x) => [x.name, x.location].filter(Boolean).join('／'),
      empty: '部品が登録されていません。先に部品在庫から登録してください。',
      qrHint: 'QRコードを読み取ると、その部品の画面が開き、その場で出庫・入庫を記録できます。',
    }
  : {
      noun: '設備', api: '/api/equipment', listKey: 'equipment',
      url: (x) => `${window.location.origin}/pages/ledger?id=${x.id}`,
      code: (x) => x.code,
      name: (x) => x.name,
      empty: '設備が登録されていません。先に設備台帳から登録してください。',
      qrHint: 'QRコードを読み取ると、その設備の詳細ページが開きます。',
    };

function labelCell(item) {
  return el('div', { class: 'label-cell' }, [
    el('img', { src: qrDataUrl(KIND.url(item)), alt: `QRコード: ${KIND.code(item)}` }),
    el('div', { class: 'label-code' }, KIND.code(item)),
    el('div', { class: 'label-name' }, KIND.name(item)),
  ]);
}

(async () => {
  try {
    await getCurrentUser();
    const equipment = (await api.get(KIND.api))[KIND.listKey] || [];
    if (equipment.length === 0) {
      render(app, el('p', { class: 'empty' }, KIND.empty));
      return;
    }

    // 既定は全選択。ids= があればその部品・設備だけ選ぶ（部品詳細の「ラベルを印刷」から）
    const onlyIds = new Set((params.get('ids') || '').split(',').map(Number).filter(Boolean));
    const selected = new Set(equipment.filter((e) => !onlyIds.size || onlyIds.has(e.id)).map((e) => e.id));
    // 印刷の開始位置（1始まり）。使いかけの台紙の、まだ残っている最初のマス
    const start = { row: 1, col: 1 };
    const skipCount = () => (start.row - 1) * COLS + (start.col - 1);

    // 印刷対象（選択中の設備）のラベルグリッド。画面ではプレビュー、印刷時はこれだけ出る
    const sheet = el('div', { class: 'label-sheet' }, []);
    const renderSheet = () => {
      const items = equipment.filter((e) => selected.has(e.id));
      if (items.length === 0) {
        render(sheet, el('p', { class: 'empty' }, `印刷する${KIND.noun}を選択してください。`));
        return;
      }
      // 開始位置より前は空きマス（印刷しない・グリッドの位置だけ確保）。台紙1枚（24面）ごとにページを分ける
      const cells = [
        ...Array.from({ length: skipCount() }, () =>
          el('div', { class: 'label-cell label-skip', 'aria-hidden': 'true' }, '使用済み')),
        ...items.map(labelCell),
      ];
      const pages = [];
      for (let i = 0; i < cells.length; i += LABELS_PER_PAGE) {
        pages.push(el('div', { class: 'label-page' }, cells.slice(i, i + LABELS_PER_PAGE)));
      }
      render(sheet, pages);
    };

    const countLabel = el('span', { class: 'hint' }, '');
    const updateCount = () => {
      const sheets = selected.size ? Math.ceil((skipCount() + selected.size) / LABELS_PER_PAGE) : 0;
      countLabel.textContent = `${selected.size} / ${equipment.length} 件を印刷（台紙 ${sheets} 枚）`;
    };

    // 開始位置の選択: 台紙（4列×6段）のミニ図。タップしたマスから印刷する
    const startBox = el('div', {});
    const renderStart = () => {
      const skip = skipCount();
      const grid = el('div', { class: 'label-start-grid', role: 'group', 'aria-label': '印刷の開始位置' },
        Array.from({ length: LABELS_PER_PAGE }, (_, i) => {
          const row = Math.floor(i / COLS) + 1;
          const col = (i % COLS) + 1;
          const cls = i < skip ? ' is-used' : i === skip ? ' is-start' : '';
          return el('button', {
            type: 'button',
            class: `label-start-cell${cls}`,
            title: `上から${row}段目・左から${col}列目から印刷`,
            'aria-label': `上から${row}段目・左から${col}列目から印刷`,
            'aria-pressed': i === skip ? 'true' : 'false',
            onclick: () => { start.row = row; start.col = col; renderStart(); renderSheet(); updateCount(); },
          }, i === skip ? '▶' : '');
        }));
      render(startBox, [
        el('div', { class: 'label-start-wrap' }, [
          grid,
          el('div', {}, [
            el('p', { class: 'label-start-text' },
              skip === 0
                ? '左上（1段目・1列目）から印刷します。'
                : `上から${start.row}段目・左から${start.col}列目から印刷します（1枚目の台紙は先頭の ${skip} 面を空けます）。`),
            el('p', { class: 'hint' }, '使いかけの台紙に印刷するときは、まだ残っている最初のマスをタップしてください。灰色のマスには何も印刷しません。2枚目以降の台紙は左上から印刷します。'),
            skip > 0
              ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { start.row = 1; start.col = 1; renderStart(); renderSheet(); updateCount(); } }, '左上に戻す')
              : null,
          ]),
        ]),
      ]);
    };

    // 設備ごとの選択チェックボックス
    const rows = equipment.map((eq) => {
      const cb = el('input', {
        type: 'checkbox',
        checked: selected.has(eq.id),
        onchange: (e) => {
          if (e.target.checked) selected.add(eq.id);
          else selected.delete(eq.id);
          renderSheet();
          updateCount();
        },
      });
      return { cb, node: el('label', { class: 'label-pick-row' }, [cb, ` ${KIND.code(eq)}　${KIND.name(eq)}`]) };
    });

    const setAll = (val) => {
      selected.clear();
      if (val) equipment.forEach((e) => selected.add(e.id));
      rows.forEach((r) => { r.cb.checked = val; });
      renderSheet();
      updateCount();
    };

    const controls = el('div', { class: 'labels-controls' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title-row' }, [
          el('h2', { class: 'card-title' }, `印刷する${KIND.noun}を選択`),
          el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm', onclick: () => setAll(true) }, '全選択'),
            el('button', { class: 'btn btn-sm', onclick: () => setAll(false) }, '全解除'),
          ]),
        ]),
        el('div', { class: 'label-pick-list' }, rows.map((r) => r.node)),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title' }, '印刷の開始位置（使いかけの台紙）'),
        startBox,
      ]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => window.print() }, '🖨 印刷'),
        countLabel,
      ]),
      el('p', { class: 'hint' },
        `${KIND.qrHint}台紙は A4・40×40mm・24面（4列×6段）用です。`
        + '印刷ダイアログは「用紙 A4／倍率 100%（拡大縮小なし）／余白 なし」にしてください。'
        + '最初は普通紙に印刷し、台紙に重ねて位置を確認してからラベル紙に印刷すると失敗しません。下はプレビューです。'),
    ]);

    render(app, [controls, sheet]);
    renderStart();
    renderSheet();
    updateCount();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
