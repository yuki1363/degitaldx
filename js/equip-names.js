// 設備名・機器名の共有候補とカスケード入力（全機能で流用）
//   ・候補ソースは /api/equipment-names（在庫＋設備台帳を横断）
//   ・設備名を選ぶと、その設備に属する機器名だけが候補に出る
//   ・設備名を選ぶまで機器名は入力不可（カスケードを強制）
//   ・どちらも datalist なので在庫・台帳にない名称は自由入力できる

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';

const sortJa = (arr) => [...arr].sort((a, b) => a.localeCompare(b, 'ja'));

// 共有候補を取得して 設備名→機器名 のマップに整形する
export async function fetchEquipNames() {
  const lineNames = new Set();
  const allEquips = new Set();
  const equipByLine = new Map(); // line_name -> Set(equipment_name)
  try {
    const { pairs } = await api.get('/api/equipment-names');
    for (const p of pairs || []) {
      if (p.line_name) lineNames.add(p.line_name);
      if (p.equipment_name) {
        allEquips.add(p.equipment_name);
        const key = p.line_name || '';
        if (!equipByLine.has(key)) equipByLine.set(key, new Set());
        equipByLine.get(key).add(p.equipment_name);
      }
    }
  } catch {
    /* 候補が取れなくても自由入力で続行 */
  }
  return { lineNames, allEquips, equipByLine };
}

// 設備名→機器名のカスケード入力を生成して DOM 要素を返す。
//   names    : fetchEquipNames() の戻り値
//   options  : { line, equip, idPrefix }（初期値・datalistのid接頭辞）
// 戻り値の lineInput/equipInput が入力欄、lineDatalist/equipDatalist は候補リスト要素。
export function buildEquipCascade(names, { line = '', equip = '', idPrefix = 'eqc' } = {}) {
  const { lineNames, equipByLine } = names;
  const lineListId = `${idPrefix}-line-options`;
  const equipListId = `${idPrefix}-equip-options`;

  const lineDatalist = el('datalist', { id: lineListId }, sortJa(lineNames).map((n) => el('option', { value: n })));
  const equipDatalist = el('datalist', { id: equipListId }, []);
  const lineInput = el('input', { type: 'text', list: lineListId, value: line || '', placeholder: '在庫・台帳の設備名から選択 / 自由入力' });
  const equipInput = el('input', { type: 'text', list: equipListId, value: equip || '', placeholder: '機器名を選択 / 自由入力' });

  // 機器名の候補・入力可否を「選択中の設備名」に合わせて更新する
  const apply = (clearOnEmpty) => {
    const l = lineInput.value.trim();
    const set = equipByLine.get(l);
    const list = set && set.size ? sortJa(set) : [];
    render(equipDatalist, list.map((n) => el('option', { value: n })));
    if (!l) {
      if (clearOnEmpty) equipInput.value = '';
      equipInput.disabled = true;
      equipInput.placeholder = '先に設備名を選択してください';
    } else {
      equipInput.disabled = false;
      equipInput.placeholder = list.length ? '機器名を選択 / 自由入力' : '機器名を入力';
    }
  };
  lineInput.addEventListener('input', () => apply(true));
  apply(false); // 初期化（既存の機器名は消さない）

  return { lineInput, equipInput, lineDatalist, equipDatalist };
}
