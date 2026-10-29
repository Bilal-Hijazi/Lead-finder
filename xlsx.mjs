// Minimal .xlsx writer — zero dependencies, matching the rest of tools/.
//
// An .xlsx is a ZIP of XML parts, and Node ships both halves of that: zlib for
// deflate and, since v22, zlib.crc32 for the checksum every ZIP entry needs. So
// the alternative here was adding a spreadsheet library to a project whose lead
// tooling has deliberately had no dependencies at all, to emit a file format
// that is four small XML documents in a container. This is the smaller cost.
//
// Deliberately narrow. It writes strings, numbers and a bold frozen header row
// with an autofilter, because that is what a lead sheet needs. It does not do
// formulas, merged cells, charts or shared strings — anything reaching for
// those should reach for a library instead.

import zlib from 'node:zlib';

// ------------------------------------------------------------------- XML bits

// Excel rejects a file outright if a control character reaches the XML, and the
// scraped notes in this workbook are full of text from other people's websites.
// Stripping is right rather than escaping: these characters carry no meaning
// here and their only effect is to make the whole workbook unopenable.
export function escapeXml(value) {
  return String(value ?? '')
    // Tab, newline and carriage return are legal in XML 1.0 and meaningful in
    // a wrapped cell, so they survive; everything else below 0x20 is stripped.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 1 -> A, 26 -> Z, 27 -> AA. Bijective base-26, which is why the -1 is inside
// the loop rather than applied once.
export function colName(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Excel's own rules: 31 characters, and none of []:*?/\ — a sheet named outside
// them makes the workbook unopenable rather than merely ugly.
export function safeSheetName(name, fallback = 'Sheet') {
  const cleaned = String(name ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || fallback;
}

const isNumeric = (v) => typeof v === 'number' && Number.isFinite(v);

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  if (isNumeric(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  // inlineStr rather than a sharedStrings table: one fewer part to keep
  // consistent, and a lead sheet has little repetition to gain from sharing.
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

// Style ids as laid out in STYLES below.
const S_HEADER = 1;
const S_WRAP = 2;
const S_INT = 3;

export function sheetXml({ columns = [], rows = [] }) {
  const lastCol = colName(Math.max(columns.length, 1));
  const lastRow = rows.length + 1;

  const cols = columns.length
    ? `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const header = `<row r="1">${columns.map((c, i) => cellXml(`${colName(i + 1)}1`, c.header, S_HEADER)).join('')}</row>`;

  const body = rows.map((row, r) => {
    const cells = columns.map((c, i) => {
      const v = row[i];
      const style = isNumeric(v) ? S_INT : (c.wrap ? S_WRAP : 0);
      return cellXml(`${colName(i + 1)}${r + 2}`, v, style);
    }).join('');
    return `<row r="${r + 2}">${cells}</row>`;
  }).join('');

  // Element order is fixed by the schema — dimension, sheetViews, sheetFormatPr,
  // cols, sheetData, then autoFilter. Out of order, Excel calls the file corrupt.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="A1:${lastCol}${lastRow}"/>`
    + `<sheetViews><sheetView workbookViewId="0">`
    + `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + cols
    + `<sheetData>${header}${body}</sheetData>`
    + (rows.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : '')
    + `</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2">`
  + `<font><sz val="11"/><name val="Calibri"/></font>`
  + `<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>`
  + `</fonts>`
  // fill 0 and 1 are reserved by the format (none, gray125) whether used or not.
  + `<fills count="3">`
  + `<fill><patternFill patternType="none"/></fill>`
  + `<fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>`
  + `</fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="4">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>`
  + `</cellXfs>`
  + `</styleSheet>`;

// -------------------------------------------------------------- ZIP container

// DOS timestamp. A fixed date keeps the output byte-identical across runs with
// the same data, which makes a diff of two exports meaningful.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zipEntry(name, contentBuf) {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(contentBuf, { level: 9 });
  // Deflate can exceed the input on tiny, incompressible parts; store those raw
  // rather than shipping a file bigger than its own contents.
  const useDeflate = deflated.length < contentBuf.length;
  const data = useDeflate ? deflated : contentBuf;
  return {
    name: nameBuf,
    data,
    method: useDeflate ? 8 : 0,
    crc: zlib.crc32(contentBuf),
    uncompressedSize: contentBuf.length,
  };
}

export function zip(files) {
  const entries = files.map((f) => zipEntry(f.name, Buffer.from(f.content, 'utf8')));
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.uncompressedSize, 22);
    local.writeUInt16LE(e.name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, e.name, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, e.name);

    offset += local.length + e.name.length + e.data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------- the workbook

export function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('buildXlsx needs at least one sheet');
  const named = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, `Sheet${i + 1}`) }));

  const files = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
        + named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + `</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
        + `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<sheets>${named.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
        + `</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        // The styles part is a relationship too, numbered after the sheets.
        + `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + `</Relationships>`,
    },
    { name: 'xl/styles.xml', content: STYLES },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
  ];

  return zip(files);
}
