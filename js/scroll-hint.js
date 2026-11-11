// ホーム: 画面の下にまだ続きがあるとき、「▼ 下にもあります」の目印を出す
//   スクロールしないと見えない部分があることに気づきやすくする。一番下まで来たら、または全部が1画面に収まるなら出さない。
//   押すとゆっくり下へスクロールする。
const NEAR_BOTTOM = 40; // 一番下から、このpx以内なら「下まで来た」とみなす

function build() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'scroll-hint';
  btn.className = 'scroll-hint';
  btn.hidden = true;
  btn.setAttribute('aria-label', '下にもページが続いています。押すと下へ移動します');
  btn.innerHTML = '<span aria-hidden="true">▼</span> 下にもあります';
  btn.addEventListener('click', () => {
    window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
  });
  document.body.appendChild(btn);
  return btn;
}

function setup() {
  const btn = build();
  const update = () => {
    const doc = document.documentElement;
    const more = doc.scrollHeight - (window.scrollY + window.innerHeight) > NEAR_BOTTOM;
    btn.hidden = !more;
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  // 通知・更新のお知らせなどが後から読み込まれて高さが変わるので、高さの変化にも追従する
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(document.body);
  update();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
else setup();
