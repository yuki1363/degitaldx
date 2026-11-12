// 17: 開発用ファイルの配信止め（functions/_middleware.js が使う）
//
// このアプリは「ビルドなし・出力ディレクトリ = リポジトリのルート（/）」で Cloudflare Pages に載せるため、
// アプリの画面に要らないリポジトリ内のファイル（CLAUDE.md・schema.sql・wrangler.toml・tests/・docs/ など）も
// そのまま URL で取得できてしまう（例 /schema.sql・/wrangler.toml）。社内限定（Cloudflare Access）の入口の内側だが、
// テーブル設計・D1 のデータベースID・運用メモなど「アプリを使うのに要らない情報」を配信しない。
//
// 方式（許可リスト＝既定は拒否）:
//   ・アプリが使うパス（ホーム・js/ css/ icons/ pages/ electrical/ api/・sw.js・manifest.json）だけを許可し、
//     それ以外はすべて 404 にする。新しい開発用ファイルを足しても、許可リストに載せない限り配信されない。
//   ・拒否の判定は Functions（ルートのミドルウェア）で行う。`_routes.json` は「全部 Functions を通す（include /*）」
//     が基本で、HTML ページ・css・アイコン・ホーム・sw.js・manifest.json だけを**ファイル名の完全一致**で除外して
//     静的配信のままにする（HTML の CSP などのヘッダーを今までどおり静的配信側に任せるため）。
//     JS（約60ファイル）は Functions を通る＝取得のたびに Functions の無料枠（10万回/日）を数える（3名規模なら
//     1日数千回程度。名簿が増えたら見直す）。
//   ・「拒否したいパスが exclude に紛れて Functions を通らない」ことが唯一の穴になるので、
//     tests/unit-blocked-paths.mjs が「拒否されるファイルは必ず Functions を通る」ことをリポジトリの全ファイルで確かめる。
//
// 実測（wrangler pages dev）で分かったこと:
//   ・静的配信は `//schema.sql`（連続スラッシュ）と `/%43LAUDE.md`（%エンコード）でも本物のファイルを返す。
//   ・exclude を `/js/*` のようにフォルダ単位にすると、`/js/..%2fschema.sql` で本物の schema.sql が返る
//     （静的配信側が %2f を戻して `..` を解決するため）。除外が完全一致なら起きない。
//   そのためパスは正規化（デコード・連続スラッシュの圧縮・`..` の拒否）してから判定し、除外はファイル名の完全一致に限る。

/** 許可する単独のパス（小文字） */
const ALLOWED_PATHS = new Set(['/', '/index.html', '/sw.js', '/manifest.json', '/favicon.ico', '/electrical', '/pages']);

/** 許可するフォルダ（配下すべて。小文字・末尾 /） */
const ALLOWED_DIRS = ['/js/', '/css/', '/icons/', '/pages/', '/electrical/', '/api/', '/.well-known/'];

/**
 * 配信してはいけないパスか（true = 404 にする）。
 *   ・%エンコードは最大3回まで外す（二重エンコードの抜け道を塞ぐ）。壊れた % は拒否
 *   ・`..` や `.` の区切り・バックスラッシュ・NUL を含むものは拒否（正当なURLには現れない。URL の解析で
 *     通常は取り除かれるが、%2e や %2f を経由した場合の保険）
 *   ・連続スラッシュは1つに圧縮してから、許可リスト（小文字）と比べる
 */
export function isBlockedPath(pathname) {
  let p = String(pathname || '');
  for (let i = 0; i < 3; i++) {
    let decoded;
    try { decoded = decodeURIComponent(p); } catch { return true; }
    if (decoded === p) break;
    p = decoded;
  }
  if (p.includes('\\') || p.includes('\0')) return true;
  if (/(^|\/)\.{1,2}(\/|$)/.test(p)) return true;
  p = p.replace(/\/{2,}/g, '/').toLowerCase();
  if (ALLOWED_PATHS.has(p)) return false;
  return !ALLOWED_DIRS.some((dir) => p.startsWith(dir));
}
