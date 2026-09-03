// 点検項目1件分の入力UI（点検入力・点検まとめ入力で共通利用）
//   buildItemInput(master, existingValue, lastInfo) → { box, getValue, master }
//   getValue() は未入力なら undefined を返す（text は空文字）。
//   数値項目には計器写真からのAI自動読み取り（📷）ボタンを併設する。
//   lastInfo = { value, date } を渡すと、数値項目に「前回値と差分」を表示する
//   （基準内でも前回からの変化で劣化の兆候に気づけるようにする）。

import { api } from '/js/api.js';
import { el } from '/js/util.js';
import { uploadFile, resizeImageFile } from '/js/files.js';

async function handleMeterCapture(file, master, input, statusEl, fileInput) {
  if (!file) return;
  fileInput.value = '';
  statusEl.textContent = '⏳ アップロード中…';
  try {
    const img = await resizeImageFile(file, 1280, 0.85);
    const meta = await uploadFile(img);
    statusEl.textContent = '🤖 読み取り中…';
    const { value, note } = await api.post('/api/ai/read-meter', {
      file_id: meta.id,
      item_name: master.name,
      unit: master.unit || '',
      min_value: master.min_value ?? null,
      max_value: master.max_value ?? null,
    });
    if (value === null) {
      statusEl.textContent = note || '読み取れませんでした。手入力してください。';
    } else {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      statusEl.textContent = `✅ ${value}${master.unit ? ' ' + master.unit : ''}（確認してください）`;
    }
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
  }
}

/** 選択肢を配列で返す。13 ユーティリティ日報の API は配列（options）、02 点検は JSON文字列（options_json） */
function optionsOf(master) {
  if (Array.isArray(master.options)) return master.options;
  if (master.options_json) {
    try { return JSON.parse(master.options_json); } catch { return []; }
  }
  return [];
}

/** 1項目分の入力UIを作る。getValue() は未入力なら undefined を返す */
export function buildItemInput(master, existingValue, lastInfo = null) {
  const limits =
    master.input_type === 'number' && (master.min_value !== null || master.max_value !== null)
      ? `基準: ${master.min_value ?? ''} 〜 ${master.max_value ?? ''} ${master.unit || ''}`
      : '';
  const warn = el('p', { class: 'warn-text', hidden: true }, '⚠ 基準範囲外です。確認してください。');
  let getValue;
  let inputArea;
  let lastHint = null; // 数値項目の「前回値・差分」表示（box組み立て時に挿入）

  switch (master.input_type) {
    case 'ok_ng': {
      let value = existingValue;
      const okBtn = el('button', { type: 'button', class: 'okng-btn' }, 'OK');
      const ngBtn = el('button', { type: 'button', class: 'okng-btn' }, 'NG');
      const update = () => {
        okBtn.classList.toggle('selected-ok', value === 'ok');
        ngBtn.classList.toggle('selected-ng', value === 'ng');
        warn.hidden = value !== 'ng';
        warn.textContent = '⚠ NG項目です。状況をメモ・写真で残してください。';
      };
      okBtn.addEventListener('click', () => { value = 'ok'; update(); });
      ngBtn.addEventListener('click', () => { value = 'ng'; update(); });
      update();
      inputArea = el('div', { class: 'okng-row' }, [okBtn, ngBtn]);
      getValue = () => value;
      break;
    }
    case 'number': {
      const input = el('input', {
        type: 'number', step: 'any', inputmode: 'decimal',
        value: existingValue !== undefined ? existingValue : '',
        oninput: () => {
          const v = Number(input.value);
          const out =
            input.value !== '' && Number.isFinite(v) &&
            ((master.min_value !== null && v < master.min_value) ||
             (master.max_value !== null && v > master.max_value));
          input.classList.toggle('is-abnormal', out);
          warn.hidden = !out;
          warn.textContent = '⚠ 基準範囲外です。確認してください。';
        },
      });
      if (existingValue !== undefined) input.dispatchEvent(new Event('input'));

      const camStatus = el('span', { class: 'hint meter-cam-status' });
      const camFileInput = el('input', {
        type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none',
        onchange: (e) => handleMeterCapture(e.target.files?.[0], master, input, camStatus, camFileInput),
      });
      const camBtn = el('button', {
        type: 'button', class: 'btn btn-sm meter-cam-btn',
        title: `${master.name} の計器を撮影して自動入力`,
        onclick: () => camFileInput.click(),
      }, '📷');

      inputArea = el('div', { class: 'number-row' }, [
        input,
        master.unit ? el('span', { class: 'unit' }, master.unit) : null,
        camBtn,
        camFileInput,
        camStatus,
      ]);

      // 前回値と差分の表示（同じ設備の直近の点検記録から）。入力のたびに差分を更新する
      const prevNum = lastInfo != null ? Number(lastInfo.value) : NaN;
      if (Number.isFinite(prevNum)) {
        lastHint = el('p', { class: 'hint last-value-hint' }, '');
        const renderLastHint = () => {
          const dateStr = lastInfo.date ? `（${String(lastInfo.date).slice(0, 10).replace(/-/g, '/')}）` : '';
          let diffText = '';
          const cur = Number(input.value);
          if (input.value !== '' && Number.isFinite(cur)) {
            const d = Math.round((cur - prevNum) * 1000) / 1000; // 浮動小数の丸め誤差よけ
            diffText = `　差 ${d > 0 ? '+' : ''}${d} ${d > 0 ? '↑' : d < 0 ? '↓' : '→'}`;
          }
          lastHint.textContent = `前回 ${prevNum}${master.unit ? ' ' + master.unit : ''}${dateStr}${diffText}`;
        };
        input.addEventListener('input', renderLastHint);
        renderLastHint();
      }

      // 初期値の異常表示
      setTimeout(() => input.dispatchEvent(new Event('input')), 0);
      getValue = () => (input.value === '' ? undefined : Number(input.value));
      break;
    }
    case 'select': {
      const options = optionsOf(master);
      const select = el('select', {}, [
        el('option', { value: '' }, '選択してください'),
        options.map((o) => el('option', { value: o, selected: existingValue === o }, o)),
      ]);
      // alert_options（例 ["要補充","異常"]）を選ぶとその場で警告する（13 ユーティリティ日報）
      const alerts = Array.isArray(master.alert_options) ? master.alert_options : [];
      if (alerts.length) {
        const updateWarn = () => {
          warn.hidden = !alerts.includes(select.value);
          warn.textContent = '⚠ 異常です。状況をメモ・写真で残してください。';
        };
        select.addEventListener('change', updateWarn);
        updateWarn();
      }
      inputArea = select;
      getValue = () => (select.value === '' ? undefined : select.value);
      break;
    }
    case 'time': {
      // 運転開始・終了時刻など HH:MM の入力（13 ユーティリティ日報）
      const input = el('input', {
        type: 'time',
        value: existingValue !== undefined && existingValue !== null ? String(existingValue) : '',
      });
      inputArea = input;
      getValue = () => (input.value === '' ? undefined : input.value);
      break;
    }
    case 'multi': {
      // 複数選択（例: 空気圧縮機の運転号機 1〜3号機）。チップをタップでトグルする
      const options = optionsOf(master);
      const selected = new Set(
        Array.isArray(existingValue)
          ? existingValue.map(String)
          : (existingValue ? String(existingValue).split(';').filter(Boolean) : [])
      );
      const summary = el('p', { class: 'hint' }, '');
      const updateSummary = () => {
        summary.textContent = selected.size
          ? `選択中: ${options.filter((o) => selected.has(o)).join('、')}`
          : '未選択';
      };
      const buttons = options.map((o) => {
        const btn = el('button', { type: 'button', class: 'okng-btn' }, o);
        const paint = () => btn.classList.toggle('selected-ok', selected.has(o));
        btn.addEventListener('click', () => {
          if (selected.has(o)) selected.delete(o); else selected.add(o);
          paint();
          updateSummary();
        });
        paint();
        return btn;
      });
      updateSummary();
      inputArea = el('div', {}, [el('div', { class: 'okng-row' }, buttons), summary]);
      getValue = () => (selected.size === 0 ? undefined : options.filter((o) => selected.has(o)));
      break;
    }
    default: {
      const input = el('input', { type: 'text', value: existingValue !== undefined ? existingValue : '' });
      inputArea = input;
      getValue = () => input.value.trim();
    }
  }

  const box = el('div', { class: 'check-item' }, [
    el('div', { class: 'check-item-name' }, [
      master.name,
      limits ? el('span', { class: 'hint' }, ` （${limits.trim()}）`) : null,
    ]),
    inputArea,
    lastHint,
    warn,
  ]);
  return { box, getValue, master };
}
