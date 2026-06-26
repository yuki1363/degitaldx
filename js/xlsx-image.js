// 帳票Excel（JSZip化済み）への画像（ハンコ印影）埋め込み。
//   指定タグ {{担当者印}} のあるセルを特定し、その位置に PNG を oneCellAnchor で貼る。
//   ・既存の drawing（ロゴ等）があれば追記、無ければ新規作成する。
//   ・[Content_Types].xml / worksheet rels / drawing rels も整合させる。
//   ・タグ文字自体は呼び出し側（excel-fill.js）で空に置換して消す（画像のみ残る）。
//
//   .xlsx は ZIP+XML。書式・レイアウトを壊さないよう、必要なパーツの追加と
//   末尾への要素追記だけで実現する（既存セル・スタイルには触れない）。

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STAMP_EMU = 470000; // 約1.3cm四方（1cm = 360000 EMU）

/**
 * items: [{ tag, base64 }] のハンコ画像を、タグのあるセルに埋め込む。
 * @param {JSZip} zip 読み込み済みの .xlsx
 * @param {Array<{tag:string, base64:string}>} items
 */
export async function embedHankos(zip, items) {
  const list = (items || []).filter((it) => it && it.tag && it.base64);
  if (!list.length) return;

  const ssFile = zip.file('xl/sharedStrings.xml');
  const sharedTexts = ssFile ? extractSiTexts(await ssFile.async('string')) : [];

  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  const sheetXmls = {};
  for (const p of sheetPaths) sheetXmls[p] = await zip.file(p).async('string');

  // タグ → セル位置を特定
  const placements = [];
  for (const it of list) {
    const loc = findTagCell(it.tag, sharedTexts, sheetPaths, sheetXmls);
    if (loc) placements.push({ ...loc, base64: it.base64 });
  }
  if (!placements.length) return;

  // シートごとにまとめる
  const bySheet = new Map();
  for (const pl of placements) {
    if (!bySheet.has(pl.sheetPath)) bySheet.set(pl.sheetPath, []);
    bySheet.get(pl.sheetPath).push(pl);
  }

  let ctXml = await zip.file('[Content_Types].xml').async('string');
  ctXml = ensurePngDefault(ctXml);

  let mediaSeq = nextIndex(zip, /\/(?:image|hanko)(\d+)\.\w+$/);
  let drawingSeq = nextIndex(zip, /drawing(\d+)\.xml$/);

  for (const [sheetPath, pls] of bySheet.entries()) {
    const sheetNum = /sheet(\d+)\.xml$/.exec(sheetPath)[1];
    const relsPath = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    let relsXml = zip.file(relsPath) ? await zip.file(relsPath).async('string') : null;
    let sheetXml = sheetXmls[sheetPath];

    // media（PNG）を追加
    const imgs = pls.map((pl) => {
      const name = `hanko${mediaSeq++}.png`;
      zip.file(`xl/media/${name}`, pl.base64, { base64: true });
      return { name, col: pl.col, row: pl.row };
    });

    // 既存 drawing を探す
    let drawingPath = null;
    const dm = /<drawing\b[^>]*\br:id="([^"]+)"/.exec(sheetXml);
    if (dm && relsXml) {
      const rid = dm[1];
      const tgt =
        new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(relsXml) ||
        new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`).exec(relsXml);
      if (tgt) drawingPath = resolveRel('xl/worksheets', tgt[1]);
    }

    if (drawingPath && zip.file(drawingPath)) {
      // 既存 drawing に追記
      let dXml = await zip.file(drawingPath).async('string');
      const dNum = /drawing(\d+)\.xml$/.exec(drawingPath)[1];
      const dRelsPath = `xl/drawings/_rels/drawing${dNum}.xml.rels`;
      let dRels = zip.file(dRelsPath) ? await zip.file(dRelsPath).async('string') : relsDoc('');
      let cid = maxNum(dXml, /\bid="(\d+)"/g) + 1;
      let rnum = maxNum(dRels, /Id="rId(\d+)"/g) + 1;
      let anchors = '';
      let relsAdd = '';
      for (const img of imgs) {
        const r = `rId${rnum++}`;
        anchors += anchorXml(img.col, img.row, cid++, r);
        relsAdd += imageRel(r, img.name);
      }
      zip.file(drawingPath, insertBefore(dXml, '</xdr:wsDr>', anchors));
      zip.file(dRelsPath, insertBefore(dRels, '</Relationships>', relsAdd));
    } else {
      // 新規 drawing を作成
      const dNum = drawingSeq++;
      const dPath = `xl/drawings/drawing${dNum}.xml`;
      const dRelsPath = `xl/drawings/_rels/drawing${dNum}.xml.rels`;
      let cid = 1;
      let rnum = 1;
      let anchors = '';
      let rels = '';
      for (const img of imgs) {
        const r = `rId${rnum++}`;
        anchors += anchorXml(img.col, img.row, cid++, r);
        rels += imageRel(r, img.name);
      }
      zip.file(dPath, drawingDoc(anchors));
      zip.file(dRelsPath, relsDoc(rels));
      ctXml = insertBefore(ctXml, '</Types>',
        `<Override PartName="/${dPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

      const sRid = `rId${(relsXml ? maxNum(relsXml, /Id="rId(\d+)"/g) : 0) + 1}`;
      const relEntry = `<Relationship Id="${sRid}" Type="${REL_NS}/drawing" Target="../drawings/drawing${dNum}.xml"/>`;
      relsXml = relsXml ? insertBefore(relsXml, '</Relationships>', relEntry) : relsDoc(relEntry);
      zip.file(relsPath, relsXml);

      sheetXml = ensureRNamespace(sheetXml);
      sheetXml = insertDrawingTag(sheetXml, `<drawing r:id="${sRid}"/>`);
      zip.file(sheetPath, sheetXml);
      sheetXmls[sheetPath] = sheetXml;
    }
  }

  zip.file('[Content_Types].xml', ctXml);
}

// ---------------- タグ→セル特定 ----------------

function findTagCell(tag, sharedTexts, sheetPaths, sheetXmls) {
  const sharedIdx = new Set();
  sharedTexts.forEach((txt, i) => { if (textHasTag(txt, tag)) sharedIdx.add(i); });

  for (const sheetPath of sheetPaths) {
    const xml = sheetXmls[sheetPath];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let m;
    while ((m = cellRe.exec(xml)) !== null) {
      const attrs = m[1];
      const inner = m[2];
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!refM) continue;
      if (/\bt="s"/.test(attrs)) {
        const vM = /<v>\s*(\d+)\s*<\/v>/.exec(inner);
        if (vM && sharedIdx.has(Number(vM[1]))) return cellPos(sheetPath, refM[1]);
      } else if (inner.indexOf('{{') !== -1) {
        // インライン文字列・数式文字列など、セル内に直接タグがある場合
        if (textHasTag(stripTags(inner), tag)) return cellPos(sheetPath, refM[1]);
      }
    }
  }
  return null;
}

function cellPos(sheetPath, ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { sheetPath, col: colToIndex(m[1]), row: Number(m[2]) - 1 };
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0始まり（A=0）
}

function textHasTag(text, tag) {
  if (!text || text.indexOf('{{') === -1) return false;
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].replace(/<[^>]*>/g, '').trim() === tag) return true;
  }
  return false;
}

// ---------------- XML 生成・編集ヘルパ ----------------

function extractSiTexts(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const noPh = m[1].replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(noPh)) !== null) text += tm[1];
    out.push(decodeXml(text));
  }
  return out;
}

function stripTags(s) {
  return decodeXml(s.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '').replace(/<[^>]*>/g, ''));
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function anchorXml(col, row, cid, rid) {
  return '<xdr:oneCellAnchor>'
    + `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${STAMP_EMU}" cy="${STAMP_EMU}"/>`
    + '<xdr:pic>'
    + `<xdr:nvPicPr><xdr:cNvPr id="${cid}" name="hanko${cid}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip xmlns:r="${REL_NS}" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${STAMP_EMU}" cy="${STAMP_EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
    + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
}

function drawingDoc(anchors) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + anchors + '</xdr:wsDr>';
}

function relsDoc(inner) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + inner + '</Relationships>';
}

function imageRel(rid, name) {
  return `<Relationship Id="${rid}" Type="${REL_NS}/image" Target="../media/${name}"/>`;
}

function ensurePngDefault(xml) {
  if (/<Default\b[^>]*Extension="png"/i.test(xml)) return xml;
  return xml.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>');
}

function ensureRNamespace(xml) {
  return xml.replace(/<worksheet\b([^>]*)>/, (m, attrs) =>
    /xmlns:r=/.test(attrs) ? m : `<worksheet${attrs} xmlns:r="${REL_NS}">`);
}

// <drawing> はスキーマ上 picture/oleObjects/controls/tableParts/extLst より前に置く必要がある。
// それらが在ればその直前へ、無ければ </worksheet> の直前へ挿入する。
function insertDrawingTag(xml, tag) {
  const after = ['<tableParts', '<extLst', '<picture', '<oleObjects', '<controls', '<legacyDrawing', '<drawingHF', '<webPublishItems'];
  let pos = -1;
  for (const t of after) {
    const i = xml.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return xml.replace('</worksheet>', tag + '</worksheet>');
  return xml.slice(0, pos) + tag + xml.slice(pos);
}

function insertBefore(str, marker, insertion) {
  const i = str.indexOf(marker);
  if (i === -1) return str + insertion;
  return str.slice(0, i) + insertion + str.slice(i);
}

function maxNum(str, reGlobal) {
  let max = 0;
  let m;
  while ((m = reGlobal.exec(str)) !== null) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

function nextIndex(zip, re) {
  let max = 0;
  for (const k of Object.keys(zip.files)) {
    const m = re.exec(k);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return max + 1;
}

function resolveRel(baseDir, target) {
  const parts = baseDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
