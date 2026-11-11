// 更新履歴ページ（/pages/updates）— これまでの更新を新しい順に全部見られる（js/updates.js）
import { el, render } from '/js/util.js';
import { UPDATES } from '/js/updates.js';
import { entryNode } from '/js/update-notice.js';

const app = document.getElementById('app');
render(app, [
  el('p', { class: 'hint' }, 'アプリの更新内容です。新しい順に表示します。新しい画面は、アプリを一度完全に閉じて開き直した2回目の起動から使えます。'),
  ...UPDATES.map((u) => el('div', { class: 'card update-history-card' }, [entryNode(u)])),
]);
