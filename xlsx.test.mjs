import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { escapeXml, colName, safeSheetName, sheetXml, zip, buildXlsx } from './xlsx.mjs';
import {
  buildSheets, contactStatus, parseExportArgs, speedNote, hasAnyRoute, emailDeliverability,
} from './export-xlsx.mjs';

test('escapeXml escapes the five XML entities', () => {
  assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
});

// A control character in a cell does not corrupt one cell, it makes the entire
// workbook unopenable — and this sheet carries text scraped from other people's
// websites, so they do arrive.
test('escapeXml strips control characters but keeps tab, newline and return', () => {
  assert.equal(escapeXml('a\u0000b\u0007c\u001Fd'), 'abcd');
  assert.equal(escapeXml('keep\tthis\nand\rthis'), 'keep\tthis\nand\rthis');
});

test('escapeXml renders null and undefined as empty, not as the words', () => {
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
  assert.equal(escapeXml(0), '0', 'zero is a value, not an absence');
});

test('colName is bijective base-26', () => {
  assert.equal(colName(1), 'A');
  assert.equal(colName(26), 'Z');
  assert.equal(colName(27), 'AA');
  assert.equal(colName(52), 'AZ');
  assert.equal(colName(53), 'BA');
  assert.equal(colName(702), 'ZZ');
  assert.equal(colName(703), 'AAA');
});

test('safeSheetName enforces Excel\'s own limits', () => {
  assert.equal(safeSheetName('Leads'), 'Leads');
  assert.equal(safeSheetName('a/b\\c[d]e:f*g?h'), 'a b c d e f g h');
  assert.equal(safeSheetName('x'.repeat(50)).length, 31);
  assert.equal(safeSheetName(''), 'Sheet');
  assert.equal(safeSheetName(null, 'Sheet2'), 'Sheet2');
});

test('sheetXml writes numbers as numbers and text as inline strings', () => {
  const xml = sheetXml({ columns: [{ header: 'N' }, { header: 'S' }], rows: [[42, 'hello']] });
  assert.match(xml, /<c r="A2"[^>]*><v>42<\/v><\/c>/, 'a number must not be quoted as a string');
  assert.match(xml, /<c r="B2" t="inlineStr"[^>]*><is><t[^>]*>hello<\/t><\/is><\/c>/);
});

test('sheetXml emits an empty cell rather than the string "null"', () => {
  const xml = sheetXml({ columns: [{ header: 'A' }], rows: [[null]] });
  assert.match(xml, /<c r="A2"\/>/);
  assert.doesNotMatch(xml, /null/);
});

// Out of schema order Excel calls the file corrupt and refuses to open it,
// which is indistinguishable from the export having failed entirely.
test('sheetXml keeps the schema element order', () => {
  const xml = sheetXml({ columns: [{ header: 'A' }], rows: [['x']] });
  const order = ['<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<autoFilter'];
  const positions = order.map((tag) => xml.indexOf(tag));
  assert.ok(positions.every((p) => p !== -1), 'every element present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'elements must appear in schema order');
});

test('sheetXml freezes the header row and sizes the range to the data', () => {
  const xml = sheetXml({ columns: [{ header: 'A' }, { header: 'B' }], rows: [['x', 'y'], ['p', 'q']] });
  assert.match(xml, /<pane ySplit="1"[^>]*state="frozen"/);
  assert.match(xml, /<dimension ref="A1:B3"\/>/);
  assert.match(xml, /<autoFilter ref="A1:B3"\/>/);
});

test('sheetXml omits the autofilter on an empty sheet rather than emitting a bad range', () => {
  const xml = sheetXml({ columns: [{ header: 'A' }], rows: [] });
  assert.doesNotMatch(xml, /autoFilter/);
});

// The container has to be a real ZIP or nothing can open it. These assert the
// bytes rather than trusting that a library-free writer got the offsets right.
test('zip produces a real archive: signatures, entry count and recoverable data', () => {
  const buf = zip([{ name: 'a.txt', content: 'hello world' }, { name: 'b/c.xml', content: '<x/>' }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  const eocdAt = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdAt), 0x06054b50, 'ends with the end-of-central-directory record');
  assert.equal(buf.readUInt16LE(eocdAt + 10), 2, 'both entries are in the central directory');

  // Walk the first local header and inflate its payload back to the original.
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const start = 30 + nameLen + extraLen;
  const payload = buf.subarray(start, start + compSize);
  const out = method === 8 ? zlib.inflateRawSync(payload) : payload;
  assert.equal(out.toString('utf8'), 'hello world');
});

test('zip records a CRC that matches the uncompressed content', () => {
  const content = 'the quick brown fox';
  const buf = zip([{ name: 'a.txt', content }]);
  assert.equal(buf.readUInt32LE(14), zlib.crc32(Buffer.from(content, 'utf8')));
  assert.equal(buf.readUInt32LE(22), Buffer.byteLength(content), 'uncompressed size is the real length');
});

test('zip stores rather than deflates when deflate would be larger', () => {
  // A single byte inflates under deflate's block overhead.
  const buf = zip([{ name: 'a.txt', content: 'x' }]);
  assert.equal(buf.readUInt16LE(8), 0, 'method 0 = stored');
  assert.equal(buf.readUInt32LE(18), 1, 'and the payload is the byte itself');
});

test('buildXlsx emits every part Excel requires, and the sheet count matches', () => {
  const buf = buildXlsx([
    { name: 'One', columns: [{ header: 'A' }], rows: [['x']] },
    { name: 'Two', columns: [{ header: 'B' }], rows: [[1]] },
  ]);
  const asText = buf.toString('latin1');
  for (const part of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]) {
    assert.ok(asText.includes(part), `missing part: ${part}`);
  }
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
});

test('buildXlsx refuses to write a workbook with no sheets', () => {
  assert.throws(() => buildXlsx([]), /at least one sheet/);
});

// ------------------------------------------------------------------- the join

const LEADS = [
  { placeId: 'p1', name: 'Alpha Dental', area: 'Jumeirah 1', domain: 'alpha.ae', phone: '01', distanceM: 100, rating: 4.5, reviews: 10 },
  { placeId: 'p2', name: 'Beta Dental', area: 'Jumeirah 2', domain: null, phone: '02', distanceM: 200 },
];
const REPORT = [
  { placeId: 'p1', leadValue: 10.4, assessment: { points: 5, verdict: 'HEALTHY', reasons: ['r1', 'r2'] } },
  { placeId: 'p2', leadValue: 90.6, assessment: { points: 55, verdict: 'NO WEBSITE', reasons: ['no site'] } },
];
const CONTACTS = [
  { placeId: 'p1', emails: ['a@alpha.ae', 'b@alpha.ae'], emailSource: 'https://alpha.ae/contact', emailNote: null },
  { placeId: 'p2', emails: [], emailNote: 'no website — Google lists none' },
];

// Look columns up by header rather than by position. These indices shifted once
// already when the PageSpeed columns were inserted, and a test asserting cell
// [9] silently checks a different column afterwards instead of failing loudly.
const col = (sheet, header) => sheet.columns.findIndex((c) => c.header === header);
const cell = (sheet, rowIdx, header) => sheet.rows[rowIdx][col(sheet, header)];

test('buildSheets joins on placeId and sorts by lead value, highest first', () => {
  const [leadsSheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  assert.equal(leadsSheet.rows.length, 2);
  assert.equal(cell(leadsSheet, 0, 'Clinic'), 'Beta Dental', 'the 91-value lead outranks the 10-value one');
  assert.equal(cell(leadsSheet, 0, 'Rank'), 1, 'rank is written, not implied by position alone');
  assert.equal(cell(leadsSheet, 0, 'Lead value'), 91, 'lead value is rounded to a whole number');
});

test('buildSheets puts the primary email in its own column and the rest beside it', () => {
  const [leadsSheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  const alpha = leadsSheet.rows[leadsSheet.rows.findIndex((r) => r[col(leadsSheet, 'Clinic')] === 'Alpha Dental')];
  assert.equal(alpha[col(leadsSheet, 'Email')], 'a@alpha.ae');
  assert.equal(alpha[col(leadsSheet, 'Other emails')], 'b@alpha.ae', 'the second address is kept, not discarded');
  assert.equal(alpha[col(leadsSheet, 'Email source')], 'https://alpha.ae/contact', 'the page it was read from travels with it');
});

// Three different causes of "no email", and they mean different things to
// whoever works the list.
test('contactStatus distinguishes why an email is missing', () => {
  assert.equal(contactStatus({ emails: ['x@y.ae'] }), 'email found');
  assert.equal(contactStatus({ emails: [], emailNote: 'no website — use the phone number' }), 'no website — phone only');
  assert.equal(contactStatus({ emails: [], emailNote: 'site not readable — HTTP 403' }), 'site blocked automated access');
  assert.equal(contactStatus({ emails: [], emailNote: 'site not readable — timeout' }), 'site unreachable');
  assert.equal(contactStatus({ emails: [], emailNote: 'no address published on the pages read' }), 'site published no address');
  assert.equal(contactStatus(undefined), 'not checked');
});

// I1: the --emails-only sheet is what the owner actually sends from, and used
// to carry the same "email found" status for a bouncing address as a working
// one because the mail check's own verdict was never read.
test('emailDeliverability reads the verdict of the specific address in the Email column', () => {
  const c = {
    emails: ['a@works.ae', 'b@works.ae'],
    mail: { addresses: [{ email: 'a@works.ae', verdict: 'MAIL-CAPABLE' }, { email: 'b@works.ae', verdict: 'NO-MAIL' }] },
  };
  assert.equal(emailDeliverability(c), 'MAIL-CAPABLE', 'the first (Email column) address, not the second');
});

test('emailDeliverability is blank, not a guess, with no email or no mail field', () => {
  assert.equal(emailDeliverability({ emails: [] }), null, 'nothing to check');
  assert.equal(emailDeliverability({ emails: ['a@works.ae'] }), null, 'contacts.json predating the mail check has no `mail` field');
  assert.equal(emailDeliverability(undefined), null);
});

test('the Leads sheet carries the per-address deliverability verdict, next to Contact status', () => {
  const contacts = [
    {
      placeId: 'p1',
      emails: ['a@alpha.ae'],
      emailSource: 'https://alpha.ae/contact',
      mail: { rollup: 'NO-MAIL', addresses: [{ email: 'a@alpha.ae', verdict: 'MAIL-CAPABLE' }] },
    },
  ];
  const [sheet] = buildSheets({ leads: [LEADS[0]], report: [], contacts, psiMeasured: false });
  assert.equal(cell(sheet, 0, 'Email deliverability'), 'MAIL-CAPABLE', 'the per-address verdict, not the lead-level rollup');
  assert.ok(col(sheet, 'Email deliverability') > col(sheet, 'Contact status'), 'sits beside its natural neighbour');
});

test('the deliverability column is blank for a contacts.json that predates the mail check', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  assert.equal(cell(sheet, 0, 'Email deliverability'), null, 'no `mail` field on this fixture — blank, not a guess');
});

test('buildSheets expands the audit reasons to one row per finding', () => {
  const [, findings] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  assert.equal(findings.rows.length, 3, 'two reasons for Alpha plus one for Beta');
  assert.ok(findings.rows.every((r) => typeof r[3] === 'string' && r[3].length));
});

test('buildSheets carries the PageSpeed caveat into the summary when it was not measured', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  const psi = summary.rows.find((r) => r[0] === 'PageSpeed');
  assert.equal(psi[1], 'NOT measured');
  assert.match(psi[2], /SLOW/, 'the caveat has to say what the absence costs, not just that it is absent');

  const [, , measured] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: true });
  assert.equal(measured.rows.find((r) => r[0] === 'PageSpeed')[1], 'measured');
});

// An export run before the audit or before contacts must still produce a
// usable sheet rather than refusing or, worse, silently implying zeros.
test('buildSheets works with the audit and contacts missing entirely', () => {
  const [leadsSheet] = buildSheets({ leads: LEADS, report: [], contacts: [], psiMeasured: false });
  assert.equal(leadsSheet.rows.length, 2);
  assert.equal(cell(leadsSheet, 0, 'Lead value'), null, 'no lead value, not a zero that reads as measured');
  assert.equal(cell(leadsSheet, 0, 'Verdict'), null, 'no verdict');
  assert.equal(cell(leadsSheet, 0, 'Contact status'), 'not checked', 'contact status says not checked, not "no email"');
});

test('the joined workbook actually builds', () => {
  const buf = buildXlsx(buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false }));
  assert.ok(buf.length > 500);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
});

test('parseExportArgs defaults and overrides both flag forms', () => {
  assert.deepEqual(parseExportArgs([]), {
    leads: 'leads.json', report: 'lead-report.json', contacts: 'contacts.json', out: 'lead-report.xlsx',
    manual: 'contacts-manual.json', filter: 'all', verdicts: [],
  });
  assert.equal(parseExportArgs(['--out', 'x.xlsx']).out, 'x.xlsx');
  assert.equal(parseExportArgs(['--out=y.xlsx']).out, 'y.xlsx');
  assert.equal(parseExportArgs(['--leads', 'other.json']).leads, 'other.json');
});

// --------------------------------------------------------------- emails-only
//
// A filtered sheet that does not say what it filtered repeats the pipeline's
// oldest mistake in a new place. And this filter is not neutral: a clinic
// scores high BECAUSE its site is broken or missing, and a clinic with no
// working site has nowhere to publish an email — so "leads with emails" is
// systematically the weaker end of the list.

test('emails-only keeps just the leads that have an address', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  assert.equal(sheet.rows.length, 1);
  assert.equal(cell(sheet, 0, 'Clinic'), 'Alpha Dental');
  assert.equal(cell(sheet, 0, 'Email'), 'a@alpha.ae');
});

// Renumbering 1..N would hide that this is a subset; the gaps are the evidence.
test('emails-only preserves each lead\'s rank in the FULL list', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  assert.equal(cell(sheet, 0, 'Rank'), 2, 'Alpha is #2 overall and must still say 2, not 1');
});

test('emails-only names the exclusion and the top lead it removed', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  const excluded = summary.rows.find((r) => r[0] === 'Excluded');
  assert.equal(excluded[1], '1');
  assert.match(excluded[2], /lead-report\.xlsx/, 'must point at the complete list');

  const top = summary.rows.find((r) => r[0] === 'Highest excluded');
  assert.match(top[1], /#1/, 'the excluded lead outranked everything kept');
  assert.match(top[2], /Beta Dental/);
  assert.match(top[2], /not as a priority list/i, 'the bias has to be stated, not implied');
});

test('the full export carries no exclusion rows — there is nothing excluded', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });
  assert.equal(summary.rows.find((r) => r[0] === 'Excluded'), undefined);
  assert.equal(summary.rows.find((r) => r[0] === 'Highest excluded'), undefined);
});

test('emails-only findings cover only the kept leads, with full-list ranks', () => {
  const [, findings] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  assert.equal(findings.rows.length, 2, "only Alpha's two reasons");
  assert.ok(findings.rows.every((r) => r[0] === 2 && r[1] === 'Alpha Dental'));
});

test('parseExportArgs reads --emails-only and leaves it off by default', () => {
  assert.equal(parseExportArgs([]).filter, 'all');
  assert.equal(parseExportArgs(['--emails-only']).filter, 'with-email');
  const a = parseExportArgs(['--emails-only', '--out', 'x.xlsx']);
  assert.equal(a.filter, 'with-email');
  assert.equal(a.out, 'x.xlsx', '--emails-only takes no value and must not swallow the next flag');
});

// ------------------------------------------------------------------ PageSpeed
//
// Added once PSI was actually enabled on the project. The first export shipped
// without a speed column at all, so a measurement the whole audit is built on
// reached the workbook only indirectly, as prose inside Findings.

test('speedNote explains every reason a PageSpeed cell can be empty', () => {
  assert.match(speedNote({ r: { psi: { score: 36 } } }), /measured — poor/);
  assert.match(speedNote({ r: { psi: { score: 72 } } }), /measured — needs work/);
  assert.match(speedNote({ r: { psi: { score: 97 } } }), /measured — good/);
  assert.match(speedNote({ r: { psi: { error: 'timeout' } }, lead: { domain: 'x.ae' } }), /not measured — timeout/);
  assert.match(speedNote({ r: {}, lead: { domain: null } }), /no website/);
  assert.match(speedNote({ r: {}, lead: { domain: 'x.ae' } }), /not reachable/);
  assert.equal(speedNote({ lead: { domain: 'x.ae' } }), 'not audited');
});

// A 0 would sort to the top and read as the slowest site on the list, which is
// the exact opposite of what an unmeasured site means.
test('an unmeasured lead gets an empty PageSpeed cell, never a zero', () => {
  const [sheet] = buildSheets({
    leads: [{ placeId: 'p1', name: 'A', domain: 'a.ae' }],
    report: [{ placeId: 'p1', leadValue: 5, assessment: { points: 1, verdict: 'HEALTHY', reasons: [] }, psi: { error: 'timeout' } }],
    contacts: [], psiMeasured: true,
  });
  assert.equal(cell(sheet, 0, 'PageSpeed'), null);
  assert.match(cell(sheet, 0, 'Speed note'), /not measured/);
});

test('a measured lead carries its score and LCP in seconds', () => {
  const [sheet] = buildSheets({
    leads: [{ placeId: 'p1', name: 'A', domain: 'a.ae' }],
    report: [{ placeId: 'p1', leadValue: 5, assessment: { points: 1, verdict: 'SLOW', reasons: [] }, psi: { score: 36, lcpMs: 6420, cls: 0.1 } }],
    contacts: [], psiMeasured: true,
  });
  assert.equal(cell(sheet, 0, 'PageSpeed'), 36);
  assert.equal(cell(sheet, 0, 'LCP (s)'), 6.4, 'milliseconds are unreadable in a lead sheet; seconds to one decimal');
  assert.match(cell(sheet, 0, 'Speed note'), /poor/);
});

test('PageSpeed columns sit next to the other measurements, before contact details', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: true });
  assert.ok(col(sheet, 'PageSpeed') > col(sheet, 'Reviews'));
  assert.ok(col(sheet, 'PageSpeed') < col(sheet, 'Email'));
  assert.ok(col(sheet, 'LCP (s)') === col(sheet, 'PageSpeed') + 1);
});

// ------------------------------------------------------------- the two halves
//
// The split is not symmetric and the sheets must not pretend it is. A clinic
// scores high BECAUSE its site is broken or missing, and a missing site has
// nowhere to publish an address — so the phone-only half holds the best leads.
// Opening either file without knowing which half it is would mislead in
// opposite directions.

test('--no-email keeps exactly the complement of --emails-only', () => {
  const [withEmail] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  const [without] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'without-email' });
  const [all] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false });

  assert.equal(withEmail.rows.length + without.rows.length, all.rows.length, 'the two halves must account for every lead');
  const names = (s) => s.rows.map((r) => r[col(s, 'Clinic')]).sort();
  assert.deepEqual(names(withEmail), ['Alpha Dental']);
  assert.deepEqual(names(without), ['Beta Dental']);
  assert.deepEqual([...names(withEmail), ...names(without)].sort(), names(all), 'no lead may fall between the two files');
});

test('--no-email rows genuinely have no email, and carry a phone instead', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'without-email' });
  assert.ok(sheet.rows.every((r) => !r[col(sheet, 'Email')]), 'an email in a no-email sheet is the bug this guards');
  assert.equal(cell(sheet, 0, 'Phone (Google)'), '02', 'the contact route that does exist has to be present');
  assert.match(cell(sheet, 0, 'Contact status'), /no website/);
});

test('--no-email ranks stay on the full-list scale', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'without-email' });
  assert.equal(cell(sheet, 0, 'Rank'), 1, 'Beta is #1 overall and says 1');
});

test('--no-email summary says it holds the strongest leads, not the leftovers', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'without-email' });
  assert.match(summary.rows.find((r) => r[0] === 'Leads in this sheet')[2], /Phone-only subset/);

  const why = summary.rows.find((r) => r[0] === 'Why this half matters');
  assert.match(why[2], /Beta Dental/);
  assert.match(why[2], /not the leftover half/i);

  const excluded = summary.rows.find((r) => r[0] === 'Excluded');
  assert.equal(excluded[1], '1');
  assert.match(excluded[2], /lead-report-emails\.xlsx/, 'must point at the other half by name');

  const reach = summary.rows.find((r) => r[0] === 'Reachable by');
  assert.equal(reach[1], 'phone, WhatsApp or form');
  assert.match(reach[2], /not equivalent/, 'the different reasons for having no email must not be flattened');
});

// Each half points at the other and at the full list, so whichever file someone
// opens first they can find the rest.
test('each half names the other half and the complete list', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email' });
  const excluded = summary.rows.find((r) => r[0] === 'Excluded')[2];
  assert.match(excluded, /lead-report-no-email\.xlsx/);
  assert.match(excluded, /lead-report\.xlsx/);
});

test('parseExportArgs reads --no-email, and the last mode flag wins', () => {
  assert.equal(parseExportArgs(['--no-email']).filter, 'without-email');
  assert.equal(parseExportArgs(['--no-email', '--out', 'x.xlsx']).out, 'x.xlsx');
  assert.equal(parseExportArgs(['--emails-only', '--no-email']).filter, 'without-email', 'complements cannot both apply; last wins');
  assert.equal(parseExportArgs(['--no-email', '--emails-only']).filter, 'with-email');
});

// ------------------------------------------------------- routes beyond email
//
// "No email" was being read as "unreachable", and for most of these leads a
// phone, a WhatsApp number or a form was published the whole time.

const ROUTED_CONTACTS = [
  { placeId: 'p1', emails: ['a@alpha.ae'], emailSource: 'https://alpha.ae/', sitePhones: ['043498484'], whatsapp: ['0505630611'], contactFormUrl: 'https://alpha.ae/contact' },
  { placeId: 'p2', emails: [], emailNote: 'no address published', sitePhones: [], whatsapp: [], contactFormUrl: null },
];

test('the site phone, WhatsApp and contact form each get their own column', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: ROUTED_CONTACTS, psiMeasured: false });
  const alpha = sheet.rows.find((r) => r[col(sheet, 'Clinic')] === 'Alpha Dental');
  assert.equal(alpha[col(sheet, 'Phone (site)')], '043498484');
  assert.equal(alpha[col(sheet, 'WhatsApp')], '0505630611');
  assert.equal(alpha[col(sheet, 'Contact form')], 'https://alpha.ae/contact');
});

// Google's listing and the clinic's own site disagree often enough that merging
// them would lose a working number — three real leads have a site phone and no
// Google phone at all.
test('Google and site phones stay in separate columns', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: ROUTED_CONTACTS, psiMeasured: false });
  const alpha = sheet.rows.find((r) => r[col(sheet, 'Clinic')] === 'Alpha Dental');
  assert.equal(alpha[col(sheet, 'Phone (Google)')], '01', "Google's number");
  assert.equal(alpha[col(sheet, 'Phone (site)')], '043498484', 'the site\'s number, which differs');
});

test('the contact page is used when no form was detected, rather than an empty cell', () => {
  const [sheet] = buildSheets({
    leads: [LEADS[0]], report: REPORT,
    contacts: [{ placeId: 'p1', emails: [], sitePhones: [], whatsapp: [], contactFormUrl: null, contactPageUrl: 'https://alpha.ae/about' }],
    psiMeasured: false,
  });
  assert.equal(cell(sheet, 0, 'Contact form'), 'https://alpha.ae/about');
});

test('hasAnyRoute counts every channel, not just email', () => {
  assert.equal(hasAnyRoute({ c: { emails: ['a@b.ae'] }, lead: {} }), true);
  assert.equal(hasAnyRoute({ c: { emails: [], sitePhones: ['043498484'] }, lead: {} }), true);
  assert.equal(hasAnyRoute({ c: { emails: [], whatsapp: ['0505630611'] }, lead: {} }), true);
  assert.equal(hasAnyRoute({ c: { emails: [], contactFormUrl: 'https://x.ae/c' }, lead: {} }), true);
  assert.equal(hasAnyRoute({ c: { emails: [] }, lead: { phone: '04 111 2222' } }), true, "Google's phone is still a route");
  assert.equal(hasAnyRoute({ c: { emails: [], sitePhones: [], whatsapp: [] }, lead: {} }), false);
  assert.equal(hasAnyRoute({ lead: {} }), false, 'a lead never checked has no known route');
});

test('the summary counts reachability and names anyone with no route at all', () => {
  // Beta in the shared fixture has a Google phone, so it IS reachable. An
  // unreachable lead needs no phone from Google either — which is exactly the
  // shape of the two real leads this surfaced.
  const stranded = [{ placeId: 'p3', name: 'Gamma Dental', area: 'Jumeirah 1', domain: 'gamma.ae' }];
  const [, , summary] = buildSheets({
    leads: [...LEADS, ...stranded],
    report: [...REPORT, { placeId: 'p3', leadValue: 1, assessment: { points: 1, verdict: 'HEALTHY', reasons: [] } }],
    contacts: [...ROUTED_CONTACTS, { placeId: 'p3', emails: [], sitePhones: [], whatsapp: [], contactFormUrl: null }],
    psiMeasured: false,
  });
  assert.match(summary.rows.find((r) => r[0] === 'Reachable by some route')[1], /^2 of 3$/);
  const none = summary.rows.find((r) => r[0] === 'NO route at all');
  assert.equal(none[1], '1');
  assert.match(none[2], /Gamma Dental/, 'the unreachable lead must be named, not just counted');
});

test('the no-route row is omitted when every lead is reachable', () => {
  const [, , summary] = buildSheets({
    leads: LEADS, report: REPORT, contacts: ROUTED_CONTACTS, psiMeasured: false,
  });
  assert.match(summary.rows.find((r) => r[0] === 'Reachable by some route')[1], /^2 of 2$/,
    "Beta has no email but does have Google's phone, which is a route");
  assert.equal(summary.rows.find((r) => r[0] === 'NO route at all'), undefined);
});

// ------------------------------------------- verdict filter + manual emails
//
// The two halves of "some emails had to be found by hand": a filter that can
// isolate the clinics whose web presence is actually broken, and a way to merge
// an address a human found without letting a contacts.mjs re-run erase it.

const MANUAL = [
  { placeId: 'p2', name: 'Beta Dental', emails: ['found@beta.ae'], source: 'https://beta.ae/contact', method: 'web search' },
];

test('a manual email fills a gap the scraper left', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, manual: MANUAL });
  const beta = sheet.rows.find((r) => r[col(sheet, 'Clinic')] === 'Beta Dental');
  assert.equal(beta[col(sheet, 'Email')], 'found@beta.ae');
  assert.equal(beta[col(sheet, 'Email found by')], 'web search');
  assert.equal(beta[col(sheet, 'Email source')], 'https://beta.ae/contact');
});

// The scraper read its address off the clinic's own page. A manual entry must
// never quietly replace that.
test('a manual email never overwrites one the scraper actually read', () => {
  const clash = [{ placeId: 'p1', emails: ['wrong@alpha.ae'], source: 'https://elsewhere', method: 'web search' }];
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, manual: clash });
  const alpha = sheet.rows.find((r) => r[col(sheet, 'Clinic')] === 'Alpha Dental');
  assert.equal(alpha[col(sheet, 'Email')], 'a@alpha.ae', 'the scraped address wins');
  assert.equal(alpha[col(sheet, 'Email found by')], 'site scrape');
});

test('a manual email moves a lead across the with-email / without-email split', () => {
  const [without] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'without-email', manual: MANUAL });
  assert.equal(without.rows.length, 0, 'Beta now has an email and leaves the no-email half');
  const [withEmail] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, filter: 'with-email', manual: MANUAL });
  assert.equal(withEmail.rows.length, 2);
});

test('--verdict keeps only the named verdicts', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, verdicts: ['NO WEBSITE'] });
  assert.equal(sheet.rows.length, 1);
  assert.equal(cell(sheet, 0, 'Clinic'), 'Beta Dental');
  assert.equal(cell(sheet, 0, 'Rank'), 1, 'rank stays on the full-list scale');
});

test('--verdict is case-insensitive and accepts several verdicts', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, verdicts: ['no website', 'HEALTHY'] });
  assert.equal(sheet.rows.length, 2);
});

test('an empty --verdict list filters nothing', () => {
  const [sheet] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, verdicts: [] });
  assert.equal(sheet.rows.length, 2);
});

test('the verdict-filtered summary says what it kept and what it dropped', () => {
  const [, , summary] = buildSheets({ leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false, verdicts: ['NO WEBSITE'] });
  assert.match(summary.rows.find((r) => r[0] === 'Filtered to')[1], /NO WEBSITE/);
  assert.match(summary.rows.find((r) => r[0] === 'Filtered to')[2], /lead-report\.xlsx/, 'must point at the complete list');
  assert.equal(summary.rows.find((r) => r[0] === 'Excluded')[1], '1');
});

test('--verdict and the email filter compose rather than override', () => {
  const [sheet] = buildSheets({
    leads: LEADS, report: REPORT, contacts: CONTACTS, psiMeasured: false,
    verdicts: ['NO WEBSITE'], filter: 'with-email',
  });
  assert.equal(sheet.rows.length, 0, 'Beta is NO WEBSITE but has no email, so both filters apply');
});

test('parseExportArgs reads --verdict in both forms and --manual', () => {
  assert.deepEqual(parseExportArgs(['--verdict', 'NO WEBSITE,BROKEN']).verdicts, ['NO WEBSITE', 'BROKEN']);
  assert.deepEqual(parseExportArgs(['--verdict=no site']).verdicts, ['NO SITE'], 'upper-cased for comparison');
  assert.deepEqual(parseExportArgs([]).verdicts, []);
  assert.equal(parseExportArgs(['--manual', 'other.json']).manual, 'other.json');
  const a = parseExportArgs(['--verdict', 'BROKEN', '--out', 'x.xlsx']);
  assert.deepEqual(a.verdicts, ['BROKEN']);
  assert.equal(a.out, 'x.xlsx', '--verdict must not swallow the next flag');
});
