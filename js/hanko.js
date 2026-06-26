// シャチハタ風の印影画像を生成する。
//   苗字を入力すると「赤い丸枠＋苗字（縦並び）」の透過PNGを Canvas で描く。
//   帳票（Excel）の担当者欄に画像として埋め込む（js/xlsx-image.js）ために base64 を返す。
//   ・文字数で自動レイアウト（1文字=中央大きく / 2文字以上=縦に等間隔）。
//   ・背景は透過。色は朱肉に近い赤。

const HANKO_RED = '#c8102e';

/**
 * 苗字から印影PNGの base64（data URL ではなく本体のみ）を返す。
 * @param {string} surname 苗字（例: 田中）
 * @param {number} sizePx  画像の一辺（px）。既定 240。
 * @returns {string} PNG の base64 文字列（JSZip に { base64: true } で渡せる）
 */
export function makeHankoPngBase64(surname, sizePx = 240) {
  const name = String(surname || '').trim();
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, sizePx, sizePx);

  const cx = sizePx / 2;
  const cy = sizePx / 2;
  const r = sizePx * 0.46;

  // 丸枠
  ctx.lineWidth = Math.max(2, sizePx * 0.045);
  ctx.strokeStyle = HANKO_RED;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // 苗字（縦並び）
  ctx.fillStyle = HANKO_RED;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const chars = name ? [...name] : [];
  const n = chars.length;
  if (n === 0) {
    return canvasToBase64(canvas);
  }

  // 文字数でフォントサイズを調整（円内に収める）
  const fontRatio = n === 1 ? 0.52 : n === 2 ? 0.42 : n === 3 ? 0.32 : 0.26;
  const fontSize = sizePx * fontRatio;
  ctx.font = `bold ${fontSize}px "Yu Gothic", "Hiragino Sans", "Noto Sans JP", "MS Gothic", sans-serif`;

  if (n === 1) {
    ctx.fillText(chars[0], cx, cy + fontSize * 0.02);
  } else {
    // n行を中央に縦並び（行間は文字サイズ基準）
    const lineH = fontSize * 1.02;
    const startY = cy - (lineH * (n - 1)) / 2;
    chars.forEach((ch, i) => ctx.fillText(ch, cx, startY + lineH * i));
  }

  return canvasToBase64(canvas);
}

function canvasToBase64(canvas) {
  // 'data:image/png;base64,XXXX' → 'XXXX'
  return canvas.toDataURL('image/png').split(',')[1] || '';
}
