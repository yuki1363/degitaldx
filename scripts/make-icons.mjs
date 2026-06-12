// PWA アイコン生成スクリプト（依存パッケージなし・Node 標準機能のみ）
//
//   実行: node scripts/make-icons.mjs
//   出力: icons/icon-512.png / icons/icon-192.png / icons/apple-touch-icon.png
//
// デザイン: テーマカラー（#1e40af）の全面背景 + 白い歯車。
// 背景を全面に敷いているため maskable アイコンとしてもそのまま使える
// （歯車は中心 80% のセーフゾーン内に収めている）。
// アイコンを変えたいときはこのスクリプトを編集して再実行し、PNG をコミットする。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// ---------------------------------------------------------------
// PNG エンコード（8bit RGBA・無圧縮フィルタ）
// ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  // 各スキャンラインの先頭にフィルタ種別 0 を付与
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------
// 歯車アイコンの描画
// ---------------------------------------------------------------
const BG = [0x1e, 0x40, 0xaf]; // テーマカラー #1e40af
const FG = [0xff, 0xff, 0xff];

const TEETH = 8;        // 歯数
const R_TEETH = 0.36;   // 歯先半径（セーフゾーン 0.4 未満に収める）
const R_BODY = 0.275;   // 本体半径
const R_HOLE = 0.115;   // 軸穴半径
const TOOTH_DUTY = 0.42; // 1周期に占める歯の割合

function isGear(nx, ny) {
  // nx, ny: 中心原点・[-0.5, 0.5] の正規化座標
  const r = Math.hypot(nx, ny);
  if (r < R_HOLE) return false;
  if (r <= R_BODY) return true;
  if (r <= R_TEETH) {
    let phase = (Math.atan2(ny, nx) / (2 * Math.PI)) * TEETH;
    phase -= Math.floor(phase);
    return phase < TOOTH_DUTY / 2 || phase > 1 - TOOTH_DUTY / 2;
  }
  return false;
}

function render(size) {
  const SS = 4; // アンチエイリアス用スーパーサンプリング（4x4）
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size - 0.5;
          const ny = (y + (sy + 0.5) / SS) / size - 0.5;
          if (isGear(nx, ny)) hit++;
        }
      }
      const a = hit / (SS * SS);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
      rgba[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
      rgba[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, size] of [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(join(OUT_DIR, file), encodePng(size, render(size)));
  console.log(`icons/${file} (${size}x${size}) を生成しました`);
}
