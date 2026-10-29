import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  score, fmt, analysePage, analyseIfSite, interpretPsi, buildRow,
  hasUsableDomain, shouldProbeSite, tableRow,
  sidecarPath, validateLeads, isLeadEntry, parseAuditArgs, finalizeHost, formatPageSize,
  checkTls, formatRunTimestamp, toSerializable, isOffCategoryFlagged,
  buildPsiNote, psiFailures,
} from './audit.mjs';
import { toLead, CATEGORIES } from './discover.mjs';

// ------------------------------------------------- off-category marker
//
// This marker is produced in discover.mjs and consumed here, matched on a
// substring of the note. That coupling is invisible from either file alone,
// so it is tested against the REAL classifyCategory output rather than a
// hand-written note that could drift from what discover.mjs actually emits.
//
// The specific failure guarded against: the matcher used to be the literal
// "NOT TYPED AS DENTAL". When discover.mjs gained --category the label became
// per-vertical, so that matcher would have kept passing on every dental run
// and silently stopped flagging anything on all the others — a regression no
// dental-only test could have caught.
test('the off-category marker fires on a real note from a dental run', () => {
  const skin = { displayName: { text: 'Skin Co' }, primaryType: 'skin_care_clinic', types: ['skin_care_clinic'] };
  assert.equal(isOffCategoryFlagged(toLead(skin, { provenance: 'p', category: 'dental' })), true);
});

// The test above does NOT prove the matcher is label-agnostic: on a dental run
// the label IS "DENTAL", so the old literal matcher passes it too — verified by
// mutation, it stayed green. Only a non-dental label discriminates, so one is
// registered here rather than waiting on a real second vertical to be chosen.
test('the marker fires for a category whose label is not DENTAL', () => {
  CATEGORIES.testonly = { label: 'TESTONLY', types: new Set(['fictional_type']) };
  try {
    const place = { displayName: { text: 'Skin Co' }, primaryType: 'skin_care_clinic', types: ['skin_care_clinic'] };
    const lead = toLead(place, { provenance: 'p', category: 'testonly' });
    assert.match(lead.note, /NOT TYPED AS TESTONLY/, 'the label must reach the note');
    assert.equal(isOffCategoryFlagged(lead), true,
      'a matcher hardcoded to DENTAL would silently stop flagging every non-dental vertical');
  } finally {
    delete CATEGORIES.testonly;
  }
});

test('the marker does not fire on an on-category lead', () => {
  const dental = { displayName: { text: 'Teeth Co' }, primaryType: 'dental_clinic', types: ['dental_clinic'] };
  assert.equal(isOffCategoryFlagged(toLead(dental, { provenance: 'p', category: 'dental' })), false);
});

test('the marker fires when Google supplied no category at all', () => {
  const bare = { displayName: { text: 'Mystery Co' } };
  assert.equal(isOffCategoryFlagged(toLead(bare, { provenance: 'p', category: 'dental' })), true);
});

// A lead is a plain object off JSON; a missing or non-string note must not throw.
test('the marker tolerates a lead with no note', () => {
  assert.equal(isOffCategoryFlagged({}), false);
  assert.equal(isOffCategoryFlagged({ note: null }), false);
});

// ---------------------------------------------------------------------- C1
//
// Reproduced live: apex and www both return EAI_AGAIN (the code dns.lookup
// gives for a transient resolver hiccup, not only for a genuine SERVFAIL)
// while a resolver canary run at startup DID succeed, so resolverTrusted is
// true and resolveDns reports missing:true, zoneFailing:true. The main loop
// used to gate the fetch on `dns.ok || dns.probeBlocked`, which is false for
// this exact reading — so the fetch that would have found the live site at
// https://liveclinic.ae (HTTP 200) never ran, and the lead was reported
// "Perfectly Live Clinic — NO SITE (50/100)" with a fabricated SERVFAIL
// finding, ranked #1.
//
// shouldProbeSite is the extracted gate. The fix is that DNS alone must
// never be trusted to skip the probe — a page that loads is the only
// evidence that can overrule a blocked or misleading DNS read.
test('C1: shouldProbeSite probes even when DNS reads as missing or zone-failing', () => {
  const zoneFailing = { ok: false, missing: true, zoneFailing: true, probeBlocked: false };
  assert.equal(shouldProbeSite(zoneFailing), true, 'a SERVFAIL-shaped reading must still be probed');

  const genuinelyMissing = { ok: false, missing: true, zoneFailing: false, probeBlocked: false };
  assert.equal(shouldProbeSite(genuinelyMissing), true, 'even ENOTFOUND must still be probed — a real dead host fails the fetch fast anyway');

  const blocked = { ok: false, missing: false, probeBlocked: true };
  assert.equal(shouldProbeSite(blocked), true);

  const resolved = { ok: true, missing: false, probeBlocked: false };
  assert.equal(shouldProbeSite(resolved), true);
});

// ---------------------------------------------------------------------- C2
//
// Reproduced live: a domain serving a bare `404 Not Found` page was analysed
// as though that body were the clinic's homepage, producing bogus findings
// ("No mobile viewport tag", "No WhatsApp link", "No tap-to-call link", "No
// structured data") about the SERVER'S ERROR PAGE, attributed to the clinic.
//
// analyseIfSite is the extracted gate the main loop delegates to when
// deciding whether a fetched page is the site at all. It must apply the same
// standard the PSI call already does: `page.ok`, not just "there was a body".
test('C2: analyseIfSite refuses to analyse a 4xx/5xx error body as the site', () => {
  const errorPage = {
    ok: false,
    status: 404,
    finalUrl: 'https://fourohfour.ae/',
    ms: 87,
    html: '<html><head><title>404 Not Found</title></head><body>404 Not Found</body></html>',
  };
  assert.equal(analyseIfSite(errorPage), null, 'a 404 body must not be scored as the clinic\'s page facts');

  const realPage = {
    ok: true,
    status: 200,
    finalUrl: 'https://realclinic.ae/',
    ms: 210,
    html: '<html><head><meta name="viewport" content="width=device-width"><title>Real Clinic</title></head><body>hi <a href="https://wa.me/971500000000">WhatsApp</a></body></html>',
  };
  const analysed = analyseIfSite(realPage);
  assert.ok(analysed, 'a genuine 200 page must still be analysed');
  assert.equal(analysed.mobileViewport, true);
  assert.equal(analysed.whatsapp, true);
});

// ---------------------------------------------------------------------- I1
//
// Reproduced live: "Five Hundred Dental — HEALTHY (45/100)" with
// "Fetch: HTTP 500" and the bullet "Site unreachable (HTTP 500) (+45)" — the
// points chain already treats status >= 500 as unreachable, but the verdict
// chain checked only `lead.page?.error`, which a plain HTTP 500 never sets.
// HEALTHY is defined in the legend as "nothing measurable to sell against",
// which directly contradicts the 45-point bullet printed one line below it.
test('I1: score() gives an HTTP 500 a verdict other than HEALTHY', () => {
  const lead = {
    dns: { ok: true, missing: false, probeBlocked: false },
    tls: { ok: true, daysLeft: 300 },
    page: { ok: false, status: 500, ms: 50, finalUrl: 'https://fivehundred.ae/' },
    analysis: null,
  };
  const result = score(lead);
  assert.equal(result.points, 45, 'the points chain already scores a 500 as unreachable');
  assert.notEqual(result.verdict, 'HEALTHY', 'HEALTHY means nothing measurable to sell against — a 500 is measurable and IS something to sell against');
  assert.equal(result.verdict, 'BROKEN');
});

// ---------------------------------------------------------------------- C3
//
// Reproduced with an ordinary real-world PSI response body: HTTP 200, but
// lighthouseResult.runtimeError.code is "NO_FCP" (the page never painted),
// so categories.performance.score is null/absent and several audits still
// carry a bare numericValue of 0 rather than being missing outright. The old
// code's `?? null` coercion let those zeros through as if measured, and
// because no numeric score exists it still took the "measured" branch (no
// error key), rendering "LCP 0.0s ... TBT 0ms" — numbers nothing measured.
test('C3: interpretPsi treats "200 but no numeric score" as an error, surfacing runtimeError.code', () => {
  const psiBody = {
    lighthouseResult: {
      runtimeError: {
        code: 'NO_FCP',
        message: 'The page did not paint any content. Please ensure you keep the browser window in the foreground during the load and try again. (NO_FCP)',
      },
      categories: { performance: { score: null } },
      audits: {
        'largest-contentful-paint': { numericValue: 0 },
        'total-blocking-time': { numericValue: 0 },
        // cumulative-layout-shift entirely absent — matches the live body.
      },
    },
  };
  const result = interpretPsi(psiBody);
  assert.equal(typeof result.error, 'string', 'no numeric score must be treated as an error, not a measurement');
  assert.match(result.error, /NO_FCP/, 'PSI\'s own runtimeError code must be surfaced, not swallowed');
  assert.equal(result.score, undefined);
  assert.equal(result.lcpMs, undefined);
  assert.equal(result.tbtMs, undefined);
});

test('C3: interpretPsi still reports a genuine measurement when one exists', () => {
  const psiBody = {
    lighthouseResult: {
      categories: { performance: { score: 0.42 } },
      audits: {
        'largest-contentful-paint': { numericValue: 3200 },
        'cumulative-layout-shift': { numericValue: 0.12 },
        'total-blocking-time': { numericValue: 450 },
      },
    },
  };
  const result = interpretPsi(psiBody);
  assert.equal(result.error, undefined);
  assert.equal(result.score, 42);
  assert.equal(result.lcpMs, 3200);
  assert.equal(result.cls, 0.12);
  assert.equal(result.tbtMs, 450);
});

// ---------------------------------------------------------------------- C4
//
// Reproduced: report.json (which the README tells you to filter/re-sort) is
// fed back in as leads.json. A lead with domain: null still carries its
// previous run's dns/tls/page/analysis/psi/httpOnly keys. Those keys used to
// survive `{ ...lead, host }` untouched on the no-domain path, so the report
// showed "DNS: resolves", "TLS: valid...", "PageSpeed (mobile): 99/100" for
// a lead that made zero requests this run — directly above the line
// "Nothing here was measured".
test('C4: buildRow strips stale measurement keys from a lead this run does not probe', () => {
  const staleLead = {
    name: 'Stale Reaudit Clinic',
    domain: null,
    rating: 4.2,
    dns: { ok: true, missing: false },
    tls: { ok: true, validTo: '2029-01-01', daysLeft: 900 },
    page: { ok: true, status: 200, ms: 42, finalUrl: 'https://stale.ae/', html: '<html></html>' },
    analysis: { mobileViewport: true, whatsapp: true, bytes: 50_000 },
    psi: { score: 99 },
    httpOnly: false,
  };
  const row = buildRow(staleLead, null);
  for (const key of ['dns', 'tls', 'page', 'analysis', 'psi', 'httpOnly']) {
    assert.equal(key in row, false, `${key} must not survive onto a row this run never probed`);
  }
  // Non-measurement input fields still pass through untouched — this is a
  // strip, not a whitelist, so hand-added fields like `rating` survive.
  assert.equal(row.name, 'Stale Reaudit Clinic');
  assert.equal(row.rating, 4.2);
  assert.equal(row.host, null);
});

test('C4: buildRow leaves a normal, never-measured lead alone (no false positive)', () => {
  const freshLead = { name: 'Fresh Clinic', domain: 'freshclinic.ae', area: 'Marina' };
  const row = buildRow(freshLead, 'freshclinic.ae');
  assert.equal(row.name, 'Fresh Clinic');
  assert.equal(row.host, 'freshclinic.ae');
  assert.equal('dns' in row, false);
});

// ---------------------------------------------------------------------- I2
//
// Reproduced: `domain: true` in a hand-written leads.json. The old guard was
// `lead.domain != null && String(lead.domain).trim() !== ''`, and
// String(true) is "true" — non-null, non-empty — so the lead was treated as
// having a real domain, then resolved as the literal hostname "true",
// producing "Boolean Domain Clinic — NO SITE (50/100)" with "Domain does not
// resolve — no DNS record (ENOTFOUND)": the exact fabrication this guard's
// own comment exists to prevent, one type away.
test('I2: hasUsableDomain rejects non-string domains, not just null/empty', () => {
  assert.equal(hasUsableDomain({ domain: 'exampledental.ae' }), true);
  assert.equal(hasUsableDomain({ domain: null }), false);
  assert.equal(hasUsableDomain({ domain: '' }), false);
  assert.equal(hasUsableDomain({ domain: '   ' }), false);
  assert.equal(hasUsableDomain({ domain: true }), false, 'String(true) is "true", not a domain');
  assert.equal(hasUsableDomain({ domain: 12345 }), false, 'String(12345) is "12345", not a domain');
});

// ---------------------------------------------------------------------- I3
//
// Reproduced: rating: "4.5", reviews: "200" (strings, e.g. from hand-editing
// leads.json). rank.mjs's demand() already discards non-numbers (falls back
// to the unrated prior / zero reviews), so the lead's own "Why this is a
// lead" section correctly read "—★ ... no review count listed", while the
// table's `r.rating ?? '—'` printed the raw "4.5"/"200" unfiltered — the
// table disagreeing with the arithmetic actually used, in a report whose
// entire premise is that the table and the section never disagree.
test('I3: tableRow only prints rating/reviews that are actually numbers', () => {
  const stringTypedLead = {
    name: 'String Typed Clinic',
    host: null,
    rating: '4.5',
    reviews: '200',
    displayLeadValue: 28,
    assessment: { points: 55, verdict: 'NO WEBSITE' },
  };
  const row = tableRow(stringTypedLead, true);
  assert.doesNotMatch(row, /4\.5/, 'a string rating must not print as if Google measured it');
  assert.doesNotMatch(row, /200/, 'a string review count must not print as if Google counted it');
  assert.match(row, /\| — \| — \|/, 'both columns fall back to the same em dash the section already uses');
});

test('I3: tableRow still prints genuine numeric rating/reviews', () => {
  const realLead = {
    name: 'Real Numbers Clinic',
    host: 'realnumbers.ae',
    rating: 4.7,
    reviews: 210,
    displayLeadValue: 71,
    assessment: { points: 55, verdict: 'NO WEBSITE' },
  };
  const row = tableRow(realLead, true);
  assert.match(row, /\| 4\.7 \| 210 \|/);
});

// ---------------------------------------------------------------------- fmt
//
// Not one of the five defects on its own, but the C4 fix has to survive all
// the way to the rendered report: a lead that was never probed must still
// read as "nothing was measured", not merely have empty JSON keys.
test('fmt reports "no domain to check" for a lead buildRow stripped, not stale measurements', () => {
  const staleLead = buildRow({
    name: 'Stale Reaudit Clinic',
    domain: null,
    dns: { ok: true, missing: false },
    tls: { ok: true },
    page: { ok: true, status: 200, html: '<html></html>' },
    psi: { score: 99 },
  }, null);
  staleLead.assessment = { points: 55, verdict: 'NO WEBSITE', reasons: ['No website on their Google Business Profile (+55)'] };
  staleLead.serp = [];
  const out = fmt(staleLead, false);
  assert.match(out, /Checks:\*\* none run/);
  assert.doesNotMatch(out, /DNS:\*\* resolves/);
  assert.doesNotMatch(out, /PageSpeed/);
});

// ---------------------------------------------------------------------- I7
//
// Reproduced live: Example Aesthetics DXB — 2,823 reviews, no website — sat at #1 in the
// ranked table with no visible caveat. discover.mjs's off-category flag only
// ever lands inside `note`, but README.md tells the reader to work the table
// top-down, so the one place a human actually looks carried nothing.
//
// Detected from `note`, not `primaryType`, even though both ride along on the
// lead: classifyCategory() in discover.mjs also consults `types` to decide
// the flag (see the Saray polyclinic case in discover.test.mjs — primaryType
// `doctor`, NOT flagged, because a dental entry sits in `types`), and `types`
// itself is never carried onto the lead at all. A primaryType-only check here
// would sometimes disagree with the very note printed one line below it for
// the same lead. `note` already carries classifyCategory's actual verdict, so
// reading it is the only way this table can't contradict itself.
test('I7: tableRow marks a flagged lead beside its name and leaves an unflagged lead alone', () => {
  const flagged = {
    name: 'Example Aesthetics DXB',
    host: null,
    rating: 4.4,
    reviews: 2823,
    primaryType: 'skin_care_clinic',
    note: 'NOT TYPED AS DENTAL — Google\'s own category for this place is "skin_care_clinic", not dental_clinic or dentist · discovered 2026-08-24 · "dentist" within 5000m of 25.2048,55.2708',
    displayLeadValue: 171,
    assessment: { points: 55, verdict: 'NO WEBSITE' },
  };
  const clean = {
    name: 'Example Dental Centre',
    host: null,
    rating: 4.7,
    reviews: 120,
    primaryType: 'dental_clinic',
    note: 'discovered 2026-08-24 · "dental clinic" within 5000m of 25.2048,55.2708',
    displayLeadValue: 116,
    assessment: { points: 55, verdict: 'NO WEBSITE' },
  };
  const flaggedRow = tableRow(flagged, true);
  const cleanRow = tableRow(clean, true);
  assert.match(flaggedRow, /Example Aesthetics DXB †/, "a flagged lead's row must carry the marker beside its name");
  assert.doesNotMatch(cleanRow, /†/, "an unflagged lead's row must not carry the marker");
});

// ---------------------------------------------------------------- DEFECT 1
//
// Reproduced with `--out clash-report`: the sidecar path is derived with
// `outPath.replace(/\.md$/, '.json')`, a no-op unless outPath already ends in
// .md. Both writes then target "clash-report", the console prints "wrote
// clash-report and clash-report", and the JSON write — which runs second —
// silently overwrites the markdown report. Data loss after a full run's API
// and network spend.
test('DEFECT1: sidecarPath is always distinct from outPath, with or without a .md suffix', () => {
  assert.notEqual(sidecarPath('clash-report'), 'clash-report', 'the two output paths must never collide');
  assert.equal(sidecarPath('clash-report'), 'clash-report.json');
  assert.equal(sidecarPath('report.md'), 'report.json', 'the ordinary .md case must still produce report.json');
  assert.notEqual(sidecarPath('report.json'), 'report.json', 'an --out that is already .json must not collide with its own sidecar either');
});

// ---------------------------------------------------------------- DEFECT 2
//
// Reproduced: a leads.json containing a JSON object (`{"leads": [...]}`)
// prints "auditing undefined lead(s)" then throws `TypeError: leads.entries
// is not a function`. A leads.json containing a JSON string prints "auditing
// 13 lead(s)" — the string's character count masquerading as a lead count —
// before the identical crash. Both are a stack trace where a plain message
// belongs.
test('DEFECT2: validateLeads rejects a JSON object, naming what was actually found', () => {
  assert.throws(() => validateLeads({ leads: [] }), /object/, 'must say "object", not just "invalid"');
});

test('DEFECT2: validateLeads rejects a JSON string, naming what was actually found', () => {
  assert.throws(() => validateLeads('thirteen chars'), /string/, 'must say "string" — this is the exact shape that silently printed a fake lead count');
});

test('DEFECT2: validateLeads passes a real array through unchanged', () => {
  const arr = [{ name: 'A' }];
  assert.equal(validateLeads(arr), arr);
});

// Also considered per the spec: an entry that survives the array check but
// is not itself an object (a stray string/number/null left by a bad
// hand-edit) reaches `hasUsableDomain`/`buildRow` and throws a raw TypeError
// reading `.domain` off a primitive — the same class of crash the array
// check above removes. An entry that IS an object but has no `name` is
// deliberately NOT rejected here: `name` is display text, never a
// measurement, so a missing one prints as "undefined" in the report rather
// than fabricating a value — cosmetic, not the dishonest-number failure this
// tool exists to prevent.
test('DEFECT2: isLeadEntry rejects a stray primitive so it cannot reach lead.domain unchecked', () => {
  assert.equal(isLeadEntry('a string entry'), false);
  assert.equal(isLeadEntry(null), false);
  assert.equal(isLeadEntry(42), false);
  assert.equal(isLeadEntry(['nested', 'array']), false);
});

test('DEFECT2: isLeadEntry accepts an ordinary lead object, with or without a name', () => {
  assert.equal(isLeadEntry({ name: 'Example Dental' }), true);
  assert.equal(isLeadEntry({}), true, 'a missing name is cosmetic, not malformed — see the comment on isLeadEntry');
});

// ---------------------------------------------------------------- DEFECT 3
//
// Reproduced: `node audit.mjs --out report.md leads.json`. The old parser —
// `args.find((a) => !a.startsWith('--'))` — takes the first non-flag token,
// with no idea `--out` already consumed the token right after it, so it
// reads "report.md" itself as the lead list.
test('DEFECT3: parseAuditArgs does not read the value after --out as the lead list', () => {
  const a = parseAuditArgs(['--out', 'report.md', 'leads.json']);
  assert.equal(a.inputPath, 'leads.json', '--out\'s value must be skipped, not read as the positional arg');
  assert.equal(a.outPath, 'report.md');
});

test('DEFECT3: parseAuditArgs still handles every ordinary invocation', () => {
  assert.deepEqual(parseAuditArgs(['leads.json']), { inputPath: 'leads.json', outPath: 'lead-report.md', skipPsi: false });
  assert.deepEqual(parseAuditArgs(['leads.json', '--out', 'r.md']), { inputPath: 'leads.json', outPath: 'r.md', skipPsi: false });
  assert.deepEqual(parseAuditArgs(['--out=r.md', 'leads.json']), { inputPath: 'leads.json', outPath: 'r.md', skipPsi: false });
  assert.deepEqual(parseAuditArgs(['leads.json', '--no-psi']), { inputPath: 'leads.json', outPath: 'lead-report.md', skipPsi: true });
});

// ---------------------------------------------------------------- DEFECT 5
//
// The spec: absent fields are omitted, never emitted as `null` — `domain` is
// the sole named exception. `host` is derived, and for a website-less lead
// it is currently set to `null` and written straight through to the JSON
// sidecar. buildRow itself is left alone (C4 already asserts row.host ===
// null immediately after buildRow), so the strip happens one step later, at
// the point a row is finalised for output.
test('DEFECT5: finalizeHost omits a null host instead of emitting it', () => {
  const row = { name: 'No Domain Clinic', host: null };
  const result = finalizeHost(row);
  assert.equal('host' in result, false, 'host: null must not survive onto the finalised row');
});

test('DEFECT5: finalizeHost leaves a real host untouched', () => {
  const row = { name: 'Real Clinic', host: 'real.ae' };
  assert.equal(finalizeHost(row).host, 'real.ae');
});

test('DEFECT5: fmt and tableRow render identically whether host is null or entirely absent', () => {
  const base = { name: 'No Domain Clinic', assessment: { points: 55, verdict: 'NO WEBSITE', reasons: [] }, serp: [] };
  const withNull = { ...base, host: null };
  const withAbsent = { ...base };
  assert.equal(fmt(withNull, false), fmt(withAbsent, false));
  assert.equal(tableRow(withNull, false), tableRow(withAbsent, false));
});

// ---------------------------------------------------------------- DEFECT 7
//
// `(a.bytes / 1024).toFixed(0)` renders anything under 512 bytes as "0KB",
// which reads as a measured empty page — the exact false "nothing here" this
// tool's whole premise refuses to print — rather than a small one.
test('DEFECT7: formatPageSize never renders a small nonzero page as 0KB', () => {
  assert.notEqual(formatPageSize(300), '0KB', 'a 300-byte page must not read as a measured empty page');
  assert.notEqual(formatPageSize(1), '0KB');
});

test('DEFECT7: formatPageSize is unchanged for ordinary page sizes', () => {
  assert.equal(formatPageSize(2048), '2KB');
  assert.equal(formatPageSize(51_200), '50KB');
  assert.equal(formatPageSize(0), '0B', 'a genuinely empty page is exactly zero, not a rounded-down small one');
});

// ------------------------------------------------------------------ checkTls
//
// The other untested surface a whole-branch review flagged. checkTls wraps
// tls.connect directly, which cannot be stubbed from outside an ESM import —
// so it takes an injectable connector, defaulting to the real tls.connect,
// that a test can hand a fake socket. Each fake below reproduces just the
// slice of the tls.TLSSocket surface checkTls actually reads: a connect
// callback (or an 'error'/'timeout' event), getPeerCertificate(), .authorized,
// .authorizationError and .destroy().
function fakeSecureConnect({ cert, authorized = true, authorizationError = null }) {
  return (_options, connectListener) => {
    const socket = {
      getPeerCertificate: () => cert,
      authorized,
      authorizationError,
      destroy() {},
      on() { return socket; },
    };
    queueMicrotask(() => connectListener());
    return socket;
  };
}

function fakeSocketEvent(eventName, payload) {
  return () => {
    const handlers = {};
    const socket = {
      getPeerCertificate: () => null,
      destroy() {},
      on(name, handler) { handlers[name] = handler; return socket; },
    };
    queueMicrotask(() => handlers[eventName]?.(payload));
    return socket;
  };
}

test('checkTls: a valid certificate reports issuer, validTo and a positive daysLeft', async () => {
  // A 1-hour buffer past the 10-day mark keeps Math.floor((validTo - Date.now())
  // / 86_400_000) landing on 10 even if this test is scheduled a little late.
  const validTo = new Date(Date.now() + 10 * 86_400_000 + 3_600_000);
  const connect = fakeSecureConnect({ cert: { valid_to: validTo.toUTCString(), issuer: { O: "Let's Encrypt" } } });
  const result = await checkTls('valid.ae', connect);
  assert.equal(result.ok, true);
  assert.equal(result.authorized, true);
  assert.equal(result.issuer, "Let's Encrypt");
  assert.equal(result.validTo, validTo.toISOString().slice(0, 10));
  assert.equal(result.daysLeft, 10);
});

test('checkTls: an expired certificate reports ok:false and a negative daysLeft', async () => {
  const validTo = new Date(Date.now() - 5 * 86_400_000);
  const connect = fakeSecureConnect({ cert: { valid_to: validTo.toUTCString(), issuer: { O: 'Old CA' } } });
  const result = await checkTls('expired.ae', connect);
  assert.equal(result.ok, false, 'an expired cert must not read as ok');
  assert.ok(result.daysLeft < 0, `expected a negative daysLeft, got ${result.daysLeft}`);
});

test('checkTls: an untrusted certificate reports authorized:false with the authorization error surfaced', async () => {
  const validTo = new Date(Date.now() + 60 * 86_400_000);
  const connect = fakeSecureConnect({
    cert: { valid_to: validTo.toUTCString(), issuer: { O: 'Self-Signed' } },
    authorized: false,
    authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
  const result = await checkTls('untrusted.ae', connect);
  assert.equal(result.ok, false, 'an unauthorized cert must not read as ok, whatever time is left on it');
  assert.equal(result.authorized, false);
  assert.equal(result.authorizationError, 'DEPTH_ZERO_SELF_SIGNED_CERT');
});

test('checkTls: a socket error is reported, not thrown', async () => {
  const connect = fakeSocketEvent('error', Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }));
  const result = await checkTls('down.ae', connect);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ECONNREFUSED');
});

test('checkTls: a connection timeout is reported, not left hanging', async () => {
  const connect = fakeSocketEvent('timeout');
  const result = await checkTls('slow.ae', connect);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TLS timeout');
});

test('checkTls: a peer that presents no certificate at all is reported, not crashed on', async () => {
  const connect = fakeSecureConnect({ cert: {} });
  const result = await checkTls('nocert.ae', connect);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no certificate presented');
});

// ---------------------------------------------------------------- FIX 1
//
// Reproduced: the owner is in Dubai (UTC+4). `new Date().toISOString()` is
// always UTC but the rendered header names no timezone, so a report run at
// 14:05 Dubai time prints "10:05" with nothing to say it isn't stale — he
// raised exactly this, believing a fresh run was an old file. Fixed by
// labelling the timestamp, not by switching to local time: the README's
// roadmap is a weekly diff comparing runs across machines and DST, which
// needs an absolute timezone.
test('FIX1: formatRunTimestamp labels the timestamp UTC', () => {
  const d = new Date('2026-08-26T10:05:00Z');
  const out = formatRunTimestamp(d);
  assert.match(out, /UTC/, 'the rendered time must say what timezone it is in');
  assert.equal(out, '2026-08-26 10:05 UTC');
});

// ---------------------------------------------------------------- FIX 2
//
// Reproduced live: "Sample Dent Clinic Dubai | عيادة سامبل دنت لطب الأسنان"
// is a real Google listing name. Markdown treats `|` as a column separator,
// so the raw name injects an extra cell and shifts every column after it —
// a genuine row from the current report renders 9 cells against an 8-cell
// header, so `HEALTHY` lands under `Verdict`'s neighbour and everything past
// it is wrong. 5 of 75 real clinic names hit this.
test('FIX2: tableRow produces exactly one cell per header column even when the name carries pipes', () => {
  const header = '| Lead | Opp | Clinic | Verdict | ★ | Reviews | PSI | Domain |';
  const headerCells = header.split('|').length;

  const pipedLead = {
    name: 'Sample Dent Clinic Dubai | عيادة سامبل دنت لطب الأسنان',
    host: 'sampledentdubai.com',
    rating: 4.6,
    reviews: 265,
    psi: { score: 64 },
    displayLeadValue: 37,
    assessment: { points: 15, verdict: 'HEALTHY' },
  };
  const row = tableRow(pipedLead, true);
  // Split on UNESCAPED pipes only — an escaped `\|` inside a cell must not
  // count as a column boundary, or this assertion would pass by accident on
  // the exact bug it exists to catch.
  const rowCells = row.split(/(?<!\\)\|/).length;
  assert.equal(rowCells, headerCells, 'a name containing | must not inject extra table columns');
  assert.match(row, /Sample Dent Clinic Dubai \\\| عيادة سامبل دنت لطب الأسنان/, 'the pipe must survive, escaped, not be silently dropped');
});

test('FIX2: tableRow survives a name with three pipes and an even number of pipes', () => {
  const header = '| Lead | Opp | Clinic | Verdict | ★ | Reviews | PSI | Domain |';
  const headerCells = header.split('|').length;

  const threePipes = {
    name: 'Dr Sample Dental Clinic | Best Dentist in Dubai | Dental Clinic Near Me | Al-Satwa, Jumeirah Garden City',
    host: null,
    rating: null,
    reviews: null,
    displayLeadValue: 20,
    assessment: { points: 20, verdict: 'HEALTHY' },
  };
  const fourPipes = {
    name: 'Sample Medical Center – GP | DENTAL | LONGEVITY | DERMA | IV',
    host: 'samplemc.ae',
    rating: 4.1,
    reviews: 50,
    displayLeadValue: 10,
    assessment: { points: 10, verdict: 'WEAK CONVERSION' },
  };
  for (const lead of [threePipes, fourPipes]) {
    const row = tableRow(lead, true);
    assert.equal(row.split(/(?<!\\)\|/).length, headerCells, `${lead.name} must still produce exactly ${headerCells} split points`);
  }
});

// fmt()'s heading and the SERP links must keep the RAW name — that is where
// a `|` is correct, because it is the clinic's actual Google listing name,
// used verbatim to build search queries.
test('FIX2: fmt keeps the raw, unescaped name in the per-lead heading', () => {
  const pipedLead = {
    name: 'Sample Dent Clinic Dubai | عيادة سامبل دنت لطب الأسنان',
    host: 'sampledentdubai.com',
    assessment: { points: 15, verdict: 'HEALTHY', reasons: [] },
    serp: [],
  };
  const out = fmt(pipedLead, false);
  assert.match(out, /^### Sample Dent Clinic Dubai \| عيادة سامبل دنت لطب الأسنان — HEALTHY/, 'the heading must carry the real name unmangled, not an escaped one');
});

// ---------------------------------------------------------------- FIX 3
//
// Measured on the current run: lead-report.json is 24.3MB, 23.2MB of it raw
// page HTML across 62 leads. Nobody reads it — analysis (including
// page.bytes for size) already extracted every fact anyone acts on — and it
// makes the roadmap's weekly diff impractical: ~100MB a month to compare a
// few dozen fields per clinic. toSerialisable is the pure boundary: html is
// dropped only at the point results become JSON on disk, not during the run
// (analysePage still needs the live html in memory).
test('FIX3: toSerializable drops page.html but keeps every other page field and analysis', () => {
  const results = [
    {
      name: 'Big HTML Clinic',
      host: 'bightml.ae',
      page: { ok: true, status: 200, ms: 210, finalUrl: 'https://bightml.ae/', html: '<html>'.padEnd(500_000, 'x') },
      analysis: { bytes: 500_006, mobileViewport: true, whatsapp: false },
    },
    {
      name: 'No Page Clinic',
      host: null,
      assessment: { points: 55, verdict: 'NO WEBSITE' },
    },
  ];
  const out = toSerializable(results);
  assert.equal('html' in out[0].page, false, 'page.html must not survive into the serialisable form');
  assert.equal(out[0].page.status, 200, 'status must survive');
  assert.equal(out[0].page.ms, 210, 'timing must survive');
  assert.equal(out[0].page.finalUrl, 'https://bightml.ae/', 'finalUrl must survive');
  assert.deepEqual(out[0].analysis, { bytes: 500_006, mobileViewport: true, whatsapp: false }, 'analysis, including page.bytes, must be untouched');
  assert.equal(out[1].name, 'No Page Clinic', 'a lead with no page at all must pass through unchanged');
  assert.equal('page' in out[1], false);

  // Pure: the input array must not be mutated, since results is still used
  // for the markdown report right after this is called.
  assert.ok('html' in results[0].page, 'the original in-memory results must keep html — the markdown path never needed this change');
});

test('FIX3: toSerializable is a no-op for a lead whose page has no html key at all', () => {
  const results = [{ name: 'Errored Fetch', page: { ok: false, error: 'timeout', ms: 15000 } }];
  const out = toSerializable(results);
  assert.deepEqual(out[0].page, { ok: false, error: 'timeout', ms: 15000 });
});

// ------------------------------------------- partial PageSpeed disclosure
//
// The banner used to fire only when EVERY PSI request failed, so the common
// case — some succeeded, some did not — was silent while the report's own
// header claimed every PageSpeed figure had been measured directly.
//
// Reproduced on a real 38-lead aesthetics run: 18 of 30 requests failed (10
// timeouts, 8 HTTP 500s), 12 measured, no warning printed. One clinic, the
// highest review count in the set at 714, read HEALTHY with its speed never
// measured — "nothing to sell them" printed about a clinic nobody had checked.
test('a partial PageSpeed failure is disclosed, not silently absorbed', () => {
  const note = buildPsiNote({
    skipPsi: false,
    attempted: 30,
    measured: 12,
    failures: [{ reason: 'PSI HTTP The operation was aborted due to timeout', count: 10 }, { reason: 'PSI HTTP 500', count: 8 }],
  });
  assert.notEqual(note, '', 'a run where 18 of 30 requests failed must not be silent');
  assert.match(note, /12 of 30/);
  assert.match(note, /18 PageSpeed request/);
  assert.match(note, /unknown/, 'the unmeasured leads must be named unknown, not left to read as healthy');
  assert.match(note, /10× PSI HTTP The operation was aborted/, 'the commonest failure is named with its count');
});

test('a clean run says nothing', () => {
  assert.equal(buildPsiNote({ skipPsi: false, attempted: 30, measured: 30, failures: [] }), '');
});

test('a total PageSpeed failure still reports every lead as unmeasurable', () => {
  const note = buildPsiNote({
    skipPsi: false, attempted: 30, measured: 0,
    failures: [{ reason: 'PSI HTTP 429', count: 30 }],
  });
  assert.match(note, /not measured on any lead/);
  assert.match(note, /30× PSI HTTP 429/);
});

test('--no-psi is disclosed even though nothing failed', () => {
  assert.match(buildPsiNote({ skipPsi: true, attempted: 0, measured: 0, failures: [] }), /--no-psi/);
});

// A run with no site-bearing leads at all attempted nothing; there is no gap
// to warn about and a banner would be noise.
test('a run that attempted no PageSpeed call says nothing', () => {
  assert.equal(buildPsiNote({ skipPsi: false, attempted: 0, measured: 0, failures: [] }), '');
});

test('psiFailures groups by reason, commonest first, ignoring successes', () => {
  const attempted = [
    { psi: { score: 42 } },
    { psi: { error: 'PSI HTTP 500' } },
    { psi: { error: 'timeout' } },
    { psi: { error: 'PSI HTTP 500' } },
    { psi: { error: 'PSI HTTP 500' } },
  ];
  assert.deepEqual(psiFailures(attempted), [
    { reason: 'PSI HTTP 500', count: 3 },
    { reason: 'timeout', count: 1 },
  ]);
});

// A psi object with neither a score nor an error is a shape no code path
// should produce, but it must not be counted as a success if it appears.
test('psiFailures counts a scoreless, errorless psi object as a failure', () => {
  assert.deepEqual(psiFailures([{ psi: {} }]), [{ reason: 'no score and no error reported', count: 1 }]);
});

// Two consecutive real runs over the same 30 sites cleared 5 of 8 HTTP 500s
// and 0 of 10 timeouts. Advising "re-run, it usually clears" was therefore
// wrong for the dominant failure mode, and wrong in the direction that costs
// a lead: the timeout bias means unmeasured sites skew SLOW, so the advice
// must not encourage reading an unmeasured HEALTHY as fine.
test('the banner distinguishes timeouts from transient errors', () => {
  const withTimeouts = buildPsiNote({
    skipPsi: false, attempted: 30, measured: 16,
    failures: [{ reason: 'PSI HTTP The operation was aborted due to timeout', count: 11 }, { reason: 'PSI HTTP 500', count: 3 }],
  });
  assert.match(withTimeouts, /11 of those were timeouts/);
  assert.match(withTimeouts, /a re-run will not fix/);
  assert.match(withTimeouts, /skew slow/, 'the bias direction must be stated, not just the failure count');
  assert.doesNotMatch(withTimeouts, /re-running clears most/, 'must not advise a re-run that provably does not help');

  const transientOnly = buildPsiNote({
    skipPsi: false, attempted: 30, measured: 27,
    failures: [{ reason: 'PSI HTTP 500', count: 3 }],
  });
  assert.match(transientOnly, /re-running clears most/, 'a run with no timeouts should still advise the re-run that does help');
  assert.doesNotMatch(transientOnly, /timeouts/);
});
