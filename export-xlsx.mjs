#!/usr/bin/env node
// One workbook out of the three files the pipeline produces, joined on placeId:
//
//   leads.json      discovery — who they are, where, how far from --near
//   lead-report.json  audit    — verdict, opportunity points, the evidence
//   contacts.json     contacts — the published email, and where it was read
//
//   node export-xlsx.mjs --out lead-report.xlsx
//
// placeId is the join key rather than name or domain: two clinics in this list
// share a domain (a group practice with two branches), and names differ in
// punctuation between files. placeId is Google's own identifier and is stable.
//
// Any of the three inputs may be missing — an export after discovery but before
// the audit still produces a usable sheet, with the audit columns empty and the
// header saying so, rather than refusing to run.

import { readFile, writeFile } from 'node:fs/promises';
import { buildXlsx } from './xlsx.mjs';

async function readJsonOr(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseExportArgs(argv) {
  const out = {
    leads: 'leads.json',
    report: 'lead-report.json',
    contacts: 'contacts.json',
    out: 'lead-report.xlsx',
    manual: 'contacts-manual.json',
    // One mode rather than two booleans: --emails-only and --no-email are
    // complements, and as separate flags they could be passed together to mean
    // nothing coherent.
    filter: 'all',
    // Independent of `filter`: an empty list means every verdict.
    verdicts: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--emails-only') { out.filter = 'with-email'; continue; }
    if (a === '--no-email') { out.filter = 'without-email'; continue; }
    if (a === '--verdict' || a.startsWith('--verdict=')) {
      const raw = a.startsWith('--verdict=') ? a.slice(10) : argv[++i];
      if (raw) out.verdicts = raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.replace(/^--/, '') : a.slice(2, eq);
    const val = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
    if (['leads', 'report', 'contacts', 'out', 'manual'].includes(key) && val) {
      out[key] = val;
      if (eq === -1) i++;
    }
  }
  return out;
}

// Contact status is its own column because "no email" has three different
// causes and they mean different things to whoever works the list: a clinic
// with no website is a phone call, a site that published no address is a
// contact form, and a 403 is a page a human can still open.
export function contactStatus(contact) {
  if (!contact) return 'not checked';
  if (contact.emails?.length) return 'email found';
  const note = contact.emailNote || '';
  if (/no website/i.test(note)) return 'no website — phone only';
  if (/403/.test(note)) return 'site blocked automated access';
  if (/timeout|fetch failed|not readable/i.test(note)) return 'site unreachable';
  return 'site published no address';
}

// Why a PageSpeed cell is empty, in the cell next to it. Blank-with-no-reason
// is the shape of "fine" to anyone reading a spreadsheet, and three of these
// four cases are not fine — they are measurements that could not be taken.
export function speedNote(j) {
  if (typeof j.r?.psi?.score === 'number') {
    const s = j.r.psi.score;
    return s < 50 ? 'measured — poor' : s < 90 ? 'measured — needs work' : 'measured — good';
  }
  if (j.r?.psi?.error) return `not measured — ${j.r.psi.error}`;
  if (!j.lead.domain) return 'no website — nothing to measure';
  if (!j.r) return 'not audited';
  return 'not measured — site was not reachable';
}

// The verdict for the specific address sitting in the Email column — never
// `rollup`, which (per mail.mjs) deliberately refuses to assert emailability
// for a lead with zero addresses, and would be misleading noise repeated on
// every row that DOES have one. Blank, not a guess, when there is no email or
// when `mail` is absent entirely — a contacts.json written before this check
// existed — matching how the rest of this sheet renders an unmeasured value.
export function emailDeliverability(contact) {
  const email = contact?.emails?.[0];
  if (!email) return null;
  const found = contact?.mail?.addresses?.find((a) => a.email === email);
  return found ? found.verdict : null;
}

// Any way at all to reach this clinic. An email is one route among several, and
// treating its absence as unreachability wrote off leads whose site published a
// phone number the whole time.
export function hasAnyRoute(j) {
  return Boolean(
    j.c?.emails?.length || j.c?.sitePhones?.length || j.c?.whatsapp?.length
    || j.c?.contactFormUrl || j.lead?.phone,
  );
}

export function buildSheets({
  leads, report, contacts, psiMeasured, filter = 'all', verdicts = [], manual = [],
}) {
  const reportBy = new Map(report.map((r) => [r.placeId, r]));
  const contactBy = new Map(contacts.map((c) => [c.placeId, c]));
  const manualBy = new Map(manual.map((m) => [m.placeId, m]));

  const all = leads.map((lead) => {
    const r = reportBy.get(lead.placeId);
    let c = contactBy.get(lead.placeId);
    // A manually-found address fills a gap the scraper left; it never overwrites
    // one the scraper read off the clinic's own page. `emailMethod` keeps the two
    // distinguishable, because how an address was obtained is part of how much
    // to trust it.
    const m = manualBy.get(lead.placeId);
    if (m?.emails?.length && !c?.emails?.length) {
      c = { ...(c || {}), emails: m.emails, emailSource: m.source, emailMethod: m.method || 'manual', emailNote: null };
    } else if (c?.emails?.length) {
      c = { ...c, emailMethod: 'site scrape' };
    }
    return { lead, r, c, value: r?.leadValue ?? 0 };
  }).sort((a, b) => b.value - a.value);

  // Rank is assigned against the FULL list before filtering, so an emails-only
  // sheet shows ranks 10, 12, 17… rather than a tidy 1..16. The gaps are the
  // point: they are where the best leads were, and renumbering would hide that
  // this is a subset of a longer list.
  all.forEach((j, i) => { j.rank = i + 1; });

  const hasEmail = (j) => Boolean(j.c?.emails?.length);
  const byEmail = filter === 'with-email' ? hasEmail
    : filter === 'without-email' ? ((j) => !hasEmail(j))
      : (() => true);
  // Verdict filter is independent of the email filter, so the two compose.
  // Normalised here rather than trusting the caller to have done it: parseArgs
  // upper-cases, but a library function that only works when called from the
  // CLI is a trap for the next caller.
  const wantedVerdicts = verdicts.map((v) => String(v).trim().toUpperCase());
  const byVerdictWanted = wantedVerdicts.length
    ? ((j) => wantedVerdicts.includes((j.r?.assessment?.verdict || '').toUpperCase()))
    : (() => true);
  const keep = (j) => byEmail(j) && byVerdictWanted(j);
  const joined = all.filter(keep);
  const excluded = filter === 'all' && !verdicts.length ? [] : all.filter((j) => !keep(j));

  const leadColumns = [
    { header: 'Rank', width: 6 },
    { header: 'Lead value', width: 11 },
    { header: 'Opportunity', width: 11 },
    { header: 'Verdict', width: 18 },
    { header: 'Clinic', width: 44 },
    { header: 'District', width: 15 },
    { header: 'Distance (m)', width: 12 },
    { header: 'Rating', width: 8 },
    { header: 'Reviews', width: 9 },
    // Speed is a column, not just a line in Findings: it is the single number
    // a clinic owner recognises, and sorting the list by it is the first thing
    // anyone working this sheet will want to do.
    { header: 'PageSpeed', width: 11 },
    { header: 'LCP (s)', width: 9 },
    { header: 'Speed note', width: 34 },
    { header: 'Email', width: 34 },
    // How an address was obtained is part of how much to trust it: one read off
    // the clinic's own page by the tool, one found by a human following a search.
    { header: 'Email found by', width: 14 },
    { header: 'Contact status', width: 28 },
    // The measured fact for the Email column's address — MAIL-CAPABLE,
    // NO-MAIL, IMPLICIT-MX or UNVERIFIED — so a bouncing address does not sit
    // in this sheet indistinguishable from a working one. Blank rather than a
    // guess when unmeasured (see emailDeliverability).
    { header: 'Email deliverability', width: 18 },
    // Phone is split by provenance: Google's listing and the clinic's own site
    // disagree often enough that collapsing them would lose a working number.
    // Three leads have a site phone and no Google phone at all.
    { header: 'Phone (Google)', width: 16 },
    { header: 'Phone (site)', width: 16 },
    { header: 'WhatsApp', width: 16 },
    { header: 'Contact form', width: 38 },
    { header: 'Domain', width: 30 },
    { header: 'Other emails', width: 30 },
    { header: 'Email source', width: 40 },
    { header: 'Google type', width: 16 },
    { header: 'Address', width: 60, wrap: true },
    { header: 'Place ID', width: 30 },
  ];

  const leadRows = joined.map((j) => [
    j.rank,
    j.r ? Math.round(j.r.leadValue) : null,
    j.r?.assessment?.points ?? null,
    j.r?.assessment?.verdict ?? null,
    j.lead.name,
    j.lead.area ?? null,
    j.lead.distanceM ?? null,
    j.lead.rating ?? null,
    j.lead.reviews ?? null,
    // A score and an absence are different things and must not share a cell. An
    // empty PageSpeed cell next to a "why" in Speed note beats a 0, which would
    // sort to the top and read as the slowest site on the list.
    typeof j.r?.psi?.score === 'number' ? j.r.psi.score : null,
    typeof j.r?.psi?.lcpMs === 'number' ? Math.round(j.r.psi.lcpMs / 100) / 10 : null,
    speedNote(j),
    j.c?.emails?.[0] ?? null,
    j.c?.emails?.length ? (j.c.emailMethod || 'site scrape') : null,
    contactStatus(j.c),
    emailDeliverability(j.c),
    j.lead.phone ?? null,
    j.c?.sitePhones?.join(', ') || null,
    j.c?.whatsapp?.join(', ') || null,
    // The form itself if one was found, otherwise the contact page — a page
    // worth opening either way, and better than an empty cell for a lead whose
    // only route is a web form.
    j.c?.contactFormUrl || j.c?.contactPageUrl || null,
    j.lead.domain ?? null,
    j.c?.emails?.length > 1 ? j.c.emails.slice(1).join(', ') : null,
    j.c?.emailSource ?? null,
    j.lead.primaryType ?? null,
    j.lead.address ?? null,
    j.lead.placeId ?? null,
  ]);

  // The evidence, one row per finding. This is what makes a cold email
  // defensible — the audit's whole premise is having the proof in hand, and a
  // verdict with its reasons collapsed into one cell is not usable as proof.
  const findingRows = [];
  for (const j of joined) {
    const reasons = j.r?.assessment?.reasons ?? [];
    if (!reasons.length) {
      findingRows.push([j.rank, j.lead.name, j.r?.assessment?.verdict ?? '—', 'no findings recorded']);
      continue;
    }
    for (const reason of reasons) {
      findingRows.push([j.rank, j.lead.name, j.r?.assessment?.verdict ?? '—', reason]);
    }
  }

  const withEmail = joined.filter((j) => j.c?.emails?.length).length;
  const byStatus = new Map();
  for (const j of joined) byStatus.set(contactStatus(j.c), (byStatus.get(contactStatus(j.c)) || 0) + 1);
  const byVerdict = new Map();
  for (const j of joined) {
    const v = j.r?.assessment?.verdict ?? 'not audited';
    byVerdict.set(v, (byVerdict.get(v) || 0) + 1);
  }

  // A filtered sheet that does not say what it filtered is the same mistake as
  // a silent drop anywhere else in this pipeline: 16 rows reads as the whole
  // market unless the file says otherwise. And the exclusion here is not random
  // — a clinic scores high precisely BECAUSE it has no working website, and a
  // clinic with no working website has nowhere to publish an email. So this
  // subset is systematically biased against the best leads, and the sheet has
  // to say so in the file rather than in a message that gets lost.
  const topExcluded = excluded[0];
  const topKept = joined[0];

  // The two halves are NOT symmetric, and saying so is the point of these rows.
  // The email half is systematically the weaker one — a clinic scores high
  // because its site is broken or absent, and a site that is absent has nowhere
  // to publish an address. So the phone-only half holds the best leads, and a
  // sheet that did not say which half you were holding would mislead in
  // opposite directions depending on which file you opened.
  const exclusionRows = filter === 'with-email' ? [
    ['— what this sheet leaves out —', '', ''],
    [
      'Excluded',
      String(excluded.length),
      `${excluded.length} of ${all.length} leads have no published email and are NOT in this file. They are in lead-report-no-email.xlsx; lead-report.xlsx has all ${all.length}.`,
    ],
    ...(topExcluded ? [[
      'Highest excluded',
      `#${topExcluded.rank} · value ${Math.round(topExcluded.value)}`,
      `"${topExcluded.lead.name}" (${topExcluded.lead.phone || 'no phone'}) outranks everything in this file. `
        + 'A clinic scores high because its website is broken or absent, and a clinic with no working website has nowhere to publish an email — '
        + 'so filtering to email-havers systematically removes the strongest leads. Work this sheet for email outreach, not as a priority list.',
    ]] : []),
    ['', '', ''],
  ] : verdicts.length ? [
    ['— what this sheet is —', '', ''],
    [
      'Filtered to',
      verdicts.join(', '),
      `${joined.length} of ${all.length} leads. These are the clinics whose web presence is broken or missing — the ones with something to fix. `
        + 'lead-report.xlsx has all ' + all.length + '.',
    ],
    [
      'Excluded',
      String(excluded.length),
      'Every other verdict, including HEALTHY clinics whose sites are working and WEAK CONVERSION clinics whose sites work but convert poorly. '
        + 'Not prospects for a rebuild, so they are not here.',
    ],
    ['', '', ''],
  ] : filter === 'without-email' ? [
    ['— what this sheet is —', '', ''],
    [
      'Reachable by',
      'phone, WhatsApp or form',
      'No published email address was found for any lead here, but that is not the same as no route: check Phone (Google), Phone (site), WhatsApp and Contact form. '
        + 'The Contact status column says why the email is missing, and the reasons are not equivalent — a clinic with no website is a different prospect from one whose site simply has a form instead of an address.',
    ],
    [
      'Excluded',
      String(excluded.length),
      `${excluded.length} of ${all.length} leads DO have a published email and are NOT in this file. They are in lead-report-emails.xlsx; lead-report.xlsx has all ${all.length}.`,
    ],
    ...(topKept ? [[
      'Why this half matters',
      `top lead #${topKept.rank} · value ${Math.round(topKept.value)}`,
      `"${topKept.lead.name}" (${topKept.lead.phone || 'no phone'}) is the strongest lead in the whole list. `
        + 'This is not the leftover half: a clinic scores high precisely because its website is broken or missing, which is also why it has no email. '
        + 'Expect the best prospects to be here, and expect to reach them by phone.',
    ]] : []),
    ['', '', ''],
  ] : [];

  const summaryRows = [
    ['Leads in this sheet', String(joined.length), verdicts.length
      ? `${verdicts.join(' / ')} subset of ${all.length} verified leads`
      : {
        'with-email': `Emailable subset of ${all.length} verified leads`,
        'without-email': `Phone-only subset of ${all.length} verified leads`,
        all: 'All verified in the target district',
      }[filter]],
    ['With a published email', String(withEmail), 'Read from the clinic\'s own site — none guessed'],
    // The number that decides whether a lead can be worked at all. Counted here
    // because "no email" was being read as "unreachable", and for most of these
    // leads a phone, a WhatsApp number or a form was there all along.
    ['Reachable by some route', `${joined.filter(hasAnyRoute).length} of ${joined.length}`, 'Email, phone (Google or site), WhatsApp, or a contact form'],
    ...(joined.filter((j) => !hasAnyRoute(j)).length ? [[
      'NO route at all',
      String(joined.filter((j) => !hasAnyRoute(j)).length),
      `Needs a human: ${joined.filter((j) => !hasAnyRoute(j)).map((j) => j.lead.name).join('; ')}`,
    ]] : []),
    ['', '', ''],
    ...exclusionRows,
    ['— by verdict —', '', ''],
    ...[...byVerdict.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n), '']),
    ['', '', ''],
    ['— by contact route —', '', ''],
    ...[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n), '']),
    ['', '', ''],
    ['— caveats —', '', ''],
    [
      'PageSpeed',
      psiMeasured ? 'measured' : 'NOT measured',
      psiMeasured ? '' : 'Run with a PSI_KEY and without --no-psi. No lead here can be classified SLOW, so some HEALTHY verdicts may soften.',
    ],
    [
      'Emails',
      'published only',
      'Every address was read from the page named in Email source. No address is synthesised from a pattern — a plausible wrong address is worse than a blank.',
    ],
    [
      'Coverage',
      'a floor, not a census',
      'Discovery queries hit Google\'s 60-result cap, so the real market is larger than this list.',
    ],
  ];

  return [
    { name: 'Leads', columns: leadColumns, rows: leadRows },
    {
      name: 'Findings',
      columns: [
        { header: 'Rank', width: 6 },
        { header: 'Clinic', width: 44 },
        { header: 'Verdict', width: 18 },
        { header: 'Finding', width: 100, wrap: true },
      ],
      rows: findingRows,
    },
    {
      name: 'Summary',
      columns: [
        { header: 'Metric', width: 30 },
        { header: 'Value', width: 22 },
        { header: 'Note', width: 90, wrap: true },
      ],
      rows: summaryRows,
    },
  ];
}

async function main() {
  const opts = parseExportArgs(process.argv.slice(2));
  const leads = await readJsonOr(opts.leads, null);
  if (!leads?.length) {
    console.error(`${opts.leads} holds no leads — nothing to export.`);
    process.exit(1);
  }
  const report = await readJsonOr(opts.report, []);
  const contacts = await readJsonOr(opts.contacts, []);

  // Said out loud rather than silently producing empty columns: a workbook that
  // looks complete but is missing a whole input is the wrong kind of quiet.
  if (!report.length) console.log(`note: ${opts.report} not found or empty — audit columns will be blank.`);
  if (!contacts.length) console.log(`note: ${opts.contacts} not found or empty — email columns will be blank.`);

  // Manually-found addresses live in their own file because contacts.mjs
  // rewrites contacts.json wholesale on every run and would erase them.
  let manual = [];
  try {
    const parsed = JSON.parse(await readFile(opts.manual, 'utf8'));
    manual = Array.isArray(parsed) ? parsed : (parsed.found || []);
    if (manual.length) console.log(`note: merged ${manual.length} manually-found email(s) from ${opts.manual}`);
  } catch { /* optional file */ }

  const psiMeasured = report.some((r) => r.psi && typeof r.psi.score === 'number');
  const sheets = buildSheets({
    leads, report, contacts, psiMeasured, filter: opts.filter, verdicts: opts.verdicts, manual,
  });
  await writeFile(opts.out, buildXlsx(sheets));

  console.log(`\nwrote ${opts.out}`);
  for (const s of sheets) console.log(`  ${s.name.padEnd(10)} ${s.rows.length} row(s) x ${s.columns.length} column(s)`);

  const kept = sheets[0].rows.length;
  if (opts.filter === 'with-email') {
    console.log(`\n--emails-only: ${kept} of ${leads.length} written; ${leads.length - kept} without a published email excluded.`);
    console.log('The excluded ones include the highest-value leads — see the Summary sheet. This is an outreach list, not a priority list.');
  } else if (opts.filter === 'without-email') {
    console.log(`\n--no-email: ${kept} of ${leads.length} written; ${leads.length - kept} with a published email excluded.`);
    console.log('These are phone-only, and they include the strongest leads in the list — not the leftovers.');
  }
}

if (import.meta.main) await main();
