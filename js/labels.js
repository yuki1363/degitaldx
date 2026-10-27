// 設備台帳ラベルの一括印刷
//   URL: /pages/labels
//   設備を選択し、QRコード付きラベルをグリッドでまとめて印刷する。
//   QRを読み取るとその設備の詳細ページ（/pages/ledger?id=N）が直接開く。

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render } from '/js/util.js';
import qrcode from '/js/vendor/qrcode.mjs';

const app = document.getElementById('app');

// 台紙: 40×40mm・24面（4列×6段）A4。1ページ分の枚数（レイアウトは style.css の .label-page）
const LABELS_PER_PAGE = 24;

// 設備詳細URLを埋め込んだQRコードの dataURL を生成（単票ラベルと同じ仕様）
// 誤り訂正は Q（汚れ・擦れのある現場向け。H は40mm角では密度が上がり過ぎるため使わない）
function qrDataUrl(text) {
  const qr = qrcode(0, 'Q');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

function labelCell(eq) {
  const url = `${window.location.origin}/pages/ledger?id=${eq.id}`;
  return el('div', { class: 'label-cell' }, [
    el('img', { src: qrDataUrl(url), alt: `QRコード: ${eq.code}` }),
    el('div', { class: 'label-code' }, eq.code),
    el('div', { class: 'label-name' }, eq.name),
  ]);
}

(async () => {
  try {
    await getCurrentUser();
    const { equipment } = await api.get('/api/equipment');
    if (!equipment || equipment.length === 0) {
      render(app, el('p', { class: 'empty' }, '設備が登録されていません。先に設備台帳から登録してください。'));
      return;
    }

    // 既定は全選択
    const selected = new Set(equipment.map((e) => e.id));

    // 印刷対象（選択中の設備）のラベルグリッド。画面ではプレビュー、印刷時はこれだけ出る
    const sheet = el('div', { class: 'label-sheet' }, []);
    const renderSheet = () => {
      const items = equipment.filter((e) => selected.has(e.id));
      if (items.length === 0) {
        render(sheet, el('p', { class: 'empty' }, '印刷する設備を選択してください。'));
        return;
      }
      // 台紙1枚（24面）ごとにページを分け、印刷時はページ単位で改ページする
      const pages = [];
      for (let i = 0; i < items.length; i += LABELS_PER_PAGE) {
        pages.push(el('div', { class: 'label-page' }, items.slice(i, i + LABELS_PER_PAGE).map(labelCell)));
      }
      render(sheet, pages);
    };

    const countLabel = el('span', { class: 'hint' }, '');
    const updateCount = () => { countLabel.textContent = `${selected.size} / ${equipment.length} 件を印刷`; };

    // 設備ごとの選択チェックボックス
    const rows = equipment.map((eq) => {
      const cb = el('input', {
        type: 'checkbox',
        checked: true,
        onchange: (e) => {
          if (e.target.checked) selected.add(eq.id);
          else selected.delete(eq.id);
          renderSheet();
          updateCount();
        },
      });
      return { cb, node: el('label', { class: 'label-pick-row' }, [cb, ` ${eq.code}　${eq.name}`]) };
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
          el('h2', { class: 'card-title' }, '印刷する設備を選択'),
          el('div', { class: 'btn-group' }, [
            el('button', { class: 'btn btn-sm', onclick: () => setAll(true) }, '全選択'),
            el('button', { class: 'btn btn-sm', onclick: () => setAll(false) }, '全解除'),
          ]),
        ]),
        el('div', { class: 'label-pick-list' }, rows.map((r) => r.node)),
      ]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => window.print() }, '🖨 印刷'),
        countLabel,
      ]),
      el('p', { class: 'hint' },
        'QRコードを読み取ると、その設備の詳細ページが開きます。台紙は A4・40×40mm・24面（4列×6段）用です。'
        + '印刷ダイアログは「用紙 A4／倍率 100%（拡大縮小なし）／余白 なし」にしてください。'
        + '最初は普通紙に印刷し、台紙に重ねて位置を確認してからラベル紙に印刷すると失敗しません。下はプレビューです。'),
    ]);

    render(app, [controls, sheet]);
    renderSheet();
    updateCount();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
