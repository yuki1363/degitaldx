// PDFテキスト抽出 — pdfjs-dist（CDN）を遅延読み込みしてブラウザ上でテキストを取り出す
//   - スキャンPDF（画像のみ）はテキストが取れないため空文字を返す
//   - トラブル報告書の自動入力（parse-trouble-pdf）と分析（analyze-trouble）で共用

let pdfjsLibPromise = null;

function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs')
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
        return lib;
      })
      .catch((err) => {
        // 読み込み失敗（ネットワーク断など）はキャッシュをリセットして次回リトライ可能にする
        pdfjsLibPromise = null;
        throw err;
      });
  }
  return pdfjsLibPromise;
}

/**
 * PDFからテキストを抽出する。
 * @param {Blob|string} source Blob（ファイル）または取得用URL（/api/files/:id 等）
 * @param {number} maxPages 抽出する最大ページ数（トークン節約）
 * @returns {Promise<string>} 抽出テキスト（取れない場合は空文字）
 */
export async function extractPdfText(source, maxPages = 5) {
  const lib = await loadPdfjs();
  let data;
  if (source instanceof Blob) {
    data = await source.arrayBuffer();
  } else {
    const res = await fetch(source);
    if (!res.ok) throw new Error('PDFの取得に失敗しました');
    data = await res.arrayBuffer();
  }
  const pdf = await lib.getDocument({ data }).promise;
  let text = '';
  const pages = Math.min(pdf.numPages, maxPages);
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return text.trim();
}
