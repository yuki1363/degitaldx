// あいまい検索（表記ゆれ吸収）の共通ロジック
//   横断検索（search/index.js）・トラブル類似検索（trouble-similar.js）・
//   部品在庫検索（parts/index.js）から再利用する。
//
// D1(SQLite) には日本語正規化関数が無いため、クエリ側を複数の表記バリアントに
// 展開し、LIKE の OR で当てる方式。キーワードの表記ゆれを吸収する:
//   ・全角英数 → 半角（例「ＡＢＣ１２３」→「ABC123」。英字の大小は LIKE が元々区別しない）
//   ・ひらがな ⇄ カタカナ（例「こんぷれっさ」でカタカナの「コンプレッサ」がヒット）
//   ・全角カタカナ ⇄ 半角カタカナ（例「フィルム」で半角登録の「ﾌｨﾙﾑ」がヒット。データが
//     半角ｶﾀｶﾅで登録されている設備名等に効く。逆方向は NFKC 正規化で吸収）
//   ・末尾の長音ゆれ（例「コンプレッサー」で「コンプレッサ」もヒット。逆方向は部分一致で元々当たる）
const toHalfWidth = (s) => s
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 全角カタカナ → 半角カタカナ（濁点・半濁点は結合文字に分解。例 フィルム→ﾌｨﾙﾑ、ガ→ｶﾞ）。
const KANA_F2H = {
  'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ','カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
  'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ','タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
  'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ','ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
  'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ','ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ',
  'ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ','ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
  'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ','ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
  'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ','バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
  'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ','ヴ':'ｳﾞ',
  'ァ':'ｧ','ィ':'ｨ','ゥ':'ｩ','ェ':'ｪ','ォ':'ｫ','ッ':'ｯ','ャ':'ｬ','ュ':'ｭ','ョ':'ｮ',
  'ー':'ｰ','・':'･','。':'｡','、':'､','「':'｢','」':'｣',
};
const toHalfKana = (s) => { let o = ''; for (const ch of s) o += (KANA_F2H[ch] || ch); return o; };
// 半角英数 → 全角英数（例 KEN123→ＫＥＮ１２３）。全角英数で登録されたデータをヒットさせる。
const toFullAlnum = (s) => s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));

export function keywordVariants(kw) {
  const half = toHalfWidth(kw);        // 全角英数→半角
  const full = kw.normalize('NFKC');   // 半角カナ→全角カナ・全角英数→半角 等の正規化（ﾌｨﾙﾑ→フィルム, ＫＥＮ→KEN）
  // 英数の大小×全角/半角を吸収する。半角ASCIIは LIKE が大小を区別しないので、
  // 半角形が1つあれば半角データはどの大小でもヒットする。全角英数データは LIKE が大小を
  // 区別するため、全角の大文字形と小文字形の両方を生成する（ＫＥＮ / ｋｅｎ）。
  // 重要なゆれ（半角カタカナ・全角英数）を前方に置き、上限で切られても残るようにする。
  const set = new Set([
    kw,
    full,                            // 正規化（半角英数・全角カナ）
    toHalfKana(full),                // 全角カナ→半角カナ（ﾌｨﾙﾑ）
    toFullAlnum(full.toUpperCase()), // 全角英数（大文字）ＫＥＮ
    toFullAlnum(full.toLowerCase()), // 全角英数（小文字）ｋｅｎ
    hiraToKata(full),
    kataToHira(full),
    half,
  ]);
  for (const v of [...set]) {
    if (v.length > 2 && (v.endsWith('ー') || v.endsWith('ｰ'))) set.add(v.slice(0, -1));
  }
  return [...set].filter(Boolean).slice(0, 8); // バリアント数の上限（bind数の暴発防止。単一KWで8×最大10列=80 < D1上限100）
}

// 1キーワードぶんの LIKE 条件（全列 × 全バリアントの OR）
export function likeOr(cols, variantCount) {
  const parts = [];
  for (const c of cols) for (let i = 0; i < variantCount; i++) parts.push(`${c} LIKE ?`);
  return '(' + parts.join(' OR ') + ')';
}

// 複数キーワードぶんの LIKE 条件の配列（clauses）と bind値（binds）を返す。
//   clauses は 1キーワード = 1文字列（内部は全列×全バリアントの OR）。
//   呼び出し側で clauses.join(' AND ')（＝全キーワードを含む・精度重視）または
//   clauses.join(' OR ')（＝いずれかのキーワードを含む・再現率重視）を選べる。
export function buildKeywordClauses(keywords, cols) {
  if (!keywords.length) return { clauses: [], binds: [] };
  const clauses = [];
  const binds   = [];
  for (const kw of keywords) {
    const variants = keywordVariants(kw);
    clauses.push(likeOr(cols, variants.length));
    for (const _c of cols) for (const v of variants) binds.push(`%${v}%`);
  }
  return { clauses, binds };
}
