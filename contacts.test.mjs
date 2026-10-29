import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isJunkEmail, decodeForEmails, deobfuscate, extractEmails, rankEmails,
  contactLinks, findEmailsFor, findContactsFor, parseContactArgs,
  normalizePhone, extractPhones, extractWhatsApp, hasContactForm,
  summarizeMail,
} from './contacts.mjs';
import { MAIL_CAPABLE, NO_MAIL, IMPLICIT_MX, UNVERIFIED } from './mail.mjs';

// The false positive that matters most. Retina asset naming puts an @ in front
// of a dotted extension, so logo@2x.png matches any reasonable email pattern —
// and the cost of getting this wrong is a cold email sent to a stranger.
test('isJunkEmail rejects retina asset filenames', () => {
  for (const junk of ['logo@2x.png', 'sprite@3x.svg', 'hero@2x.jpg', 'icon@2x.webp', 'bundle@1x.css']) {
    assert.equal(isJunkEmail(junk), true, junk);
  }
});

test('isJunkEmail rejects vendor telemetry and theme placeholders', () => {
  for (const junk of [
    'abc123@sentry.io',
    'o1234@sentry-next.wixpress.com',
    'hello@example.com',
    'youremail@yourdomain.com',
    'email@domain.com',
    'name@company.com',
  ]) {
    assert.equal(isJunkEmail(junk), true, junk);
  }
});

test('isJunkEmail rejects version strings and hashed asset names', () => {
  assert.equal(isJunkEmail('build@app.1.2'), true, 'numeric final label is a version, not a TLD');
  assert.equal(isJunkEmail('a3f9c1d84b7e2f60@cdn.net'), true, 'long hex local part is a hashed asset');
});

test('isJunkEmail keeps addresses a clinic would actually publish', () => {
  for (const good of [
    'info@drexample.com',
    'reception@samplesdc.ae',
    'dr.smith@clinic.co.uk',
    'appointments@my-clinic.ae',
    'hello+booking@clinic.ae',
    'clinic@gmail.com',
  ]) {
    assert.equal(isJunkEmail(good), false, good);
  }
});

test('isJunkEmail handles non-strings and malformed input without throwing', () => {
  assert.equal(isJunkEmail(null), true);
  assert.equal(isJunkEmail(undefined), true);
  assert.equal(isJunkEmail(''), true);
  assert.equal(isJunkEmail('no-at-sign'), true);
  assert.equal(isJunkEmail('a@b'), true, 'no dot in the domain');
});

// Percent-encoded and entity-encoded mailtos are common, and a scraper that
// cannot read them reports "no email published" about a site that published one.
test('decodeForEmails decodes percent-encoded and entity-encoded addresses', () => {
  assert.match(decodeForEmails('mailto:info%40clinic.ae'), /info@clinic\.ae/);
  assert.match(decodeForEmails('info&#64;clinic.ae'), /info@clinic\.ae/);
  assert.match(decodeForEmails('info&#x40;clinic.ae'), /info@clinic\.ae/);
  assert.match(decodeForEmails('info&commat;clinic.ae'), /info@clinic\.ae/);
});

test('decodeForEmails survives a stray percent sign', () => {
  // A blanket decodeURIComponent throws on this and would lose the document.
  const html = 'Save 50% today — mailto:info%40clinic.ae';
  assert.match(decodeForEmails(html), /info@clinic\.ae/);
});

// Written that way on purpose, to stay readable by humans while dodging naive
// scrapers. Reading it is exactly as intended as reading a mailto link.
test('deobfuscate reads the [at] / [dot] convention', () => {
  assert.match(deobfuscate('info [at] clinic [dot] ae'), /info@clinic\.ae/);
  assert.match(deobfuscate('info (at) clinic.ae'), /info@clinic\.ae/);
  assert.match(deobfuscate('reception <at> samplesdc.ae'), /reception@samplesdc.ae/);
});

test('extractEmails separates linked mailto addresses from body-text mentions', () => {
  const html = `
    <a href="mailto:book@clinic.ae">Book</a>
    <p>Or write to reception@clinic.ae for anything else.</p>`;
  const got = extractEmails(html);
  assert.deepEqual(got.mailto, ['book@clinic.ae']);
  assert.ok(got.text.includes('reception@clinic.ae'));
});

// Bundles are where the junk lives, so script and style are stripped before
// the body-text pass. Without this every minified file contributes noise.
test('extractEmails ignores addresses inside script and style blocks', () => {
  const html = `
    <script>var dsn="https://abc@sentry.io/42"; var a="build@app.1.2";</script>
    <style>.x{background:url(logo@2x.png)}</style>
    <p>info@realclinic.ae</p>`;
  const got = extractEmails(html);
  assert.deepEqual(got.text, ['info@realclinic.ae']);
});

test('extractEmails strips trailing punctuation from a sentence', () => {
  const got = extractEmails('<p>Email us at info@clinic.ae.</p>');
  assert.ok(got.text.includes('info@clinic.ae'), 'the trailing full stop is not part of the address');
});

test('extractEmails returns empty lists rather than throwing on junk input', () => {
  assert.deepEqual(extractEmails(''), { mailto: [], text: [] });
  assert.deepEqual(extractEmails(undefined), { mailto: [], text: [] });
});

// An address on the clinic's own domain is the one to write to. A published
// gmail is still theirs and still real, so it is kept — just ranked below.
test('rankEmails puts the on-domain address first', () => {
  const ranked = rankEmails(
    { mailto: [], text: ['someclinic@gmail.com', 'info@clinic.ae'] },
    'clinic.ae',
  );
  assert.equal(ranked[0], 'info@clinic.ae');
  assert.ok(ranked.includes('someclinic@gmail.com'), 'the gmail is real and is kept, not discarded');
});

test('rankEmails prefers a linked mailto over the same-rank body mention', () => {
  const ranked = rankEmails(
    { mailto: ['book@clinic.ae'], text: ['aaa@clinic.ae', 'book@clinic.ae'] },
    'clinic.ae',
  );
  assert.equal(ranked[0], 'book@clinic.ae', 'linked beats merely mentioned, despite sorting later alphabetically');
});

// noreply proves an address exists while being useless to write to, so it goes
// last rather than being dropped.
test('rankEmails sinks noreply below anything writable', () => {
  const ranked = rankEmails(
    { mailto: ['noreply@clinic.ae'], text: ['reception@clinic.ae'] },
    'clinic.ae',
  );
  assert.equal(ranked[0], 'reception@clinic.ae');
  assert.equal(ranked.at(-1), 'noreply@clinic.ae');
});

test('rankEmails treats a subdomain address as on-domain', () => {
  const ranked = rankEmails({ mailto: [], text: ['x@gmail.com', 'a@mail.clinic.ae'] }, 'clinic.ae');
  assert.equal(ranked[0], 'a@mail.clinic.ae');
});

test('contactLinks finds same-host contact pages and resolves relative hrefs', () => {
  const html = `
    <a href="/contact-us">Contact</a>
    <a href="about.html">About the practice</a>
    <a href="https://facebook.com/x/contact">Facebook</a>
    <a href="/pricing">Pricing</a>`;
  const links = contactLinks(html, 'https://clinic.ae/');
  assert.ok(links.includes('https://clinic.ae/contact-us'));
  assert.ok(links.includes('https://clinic.ae/about.html'));
  assert.ok(!links.some((l) => l.includes('facebook')), 'off-host links are somebody else\'s server');
  assert.ok(!links.some((l) => l.includes('pricing')), 'unrelated pages are not fetched');
});

test('contactLinks matches on the link text as well as the href', () => {
  const links = contactLinks('<a href="/x7">Get in touch</a>', 'https://clinic.ae/');
  assert.deepEqual(links, ['https://clinic.ae/x7']);
});

test('contactLinks caps how many pages it will visit', () => {
  const html = Array.from({ length: 9 }, (_, i) => `<a href="/contact-${i}">Contact</a>`).join('');
  assert.equal(contactLinks(html, 'https://clinic.ae/', 2).length, 2);
});

test('contactLinks tolerates a bad base URL', () => {
  assert.deepEqual(contactLinks('<a href="/contact">c</a>', 'not a url'), []);
});

// A lead with no website is a distinct case from a site that published no
// address, and the note has to say which — one is a phone-only prospect, the
// other is a site with a contact form.
test('findEmailsFor: no domain is reported as no website, with no request made', async () => {
  let called = 0;
  const got = await findEmailsFor({ name: 'X', domain: null }, async () => { called += 1; return { ok: true, html: '' }; });
  assert.deepEqual(got.emails, []);
  assert.match(got.reason, /no website/i);
  assert.equal(called, 0, 'a lead with no domain must not cause a fetch');
});

// Was "stops at the homepage when it has an address". It now needs an address
// AND a phone before it stops, which is the deliberate cost of finding phone
// numbers: a homepage carrying only an email spends one extra request on the
// contact page. A homepage carrying both still costs exactly one.
test('findEmailsFor: stops at the homepage when it already has every route', async () => {
  const calls = [];
  const got = await findEmailsFor({ domain: 'clinic.ae' }, async (url) => {
    calls.push(url);
    return {
      ok: true,
      finalUrl: url,
      html: '<a href="mailto:info@clinic.ae">Mail</a><a href="tel:043498484">Call</a><a href="/contact">Contact</a>',
    };
  });
  assert.deepEqual(got.emails, ['info@clinic.ae']);
  assert.deepEqual(got.phones, ['043498484']);
  assert.equal(calls.length, 1, 'one request per clinic when the homepage answers completely');
});

test('findEmailsFor: follows a contact page only when the homepage gave nothing', async () => {
  const calls = [];
  const got = await findEmailsFor({ domain: 'clinic.ae' }, async (url) => {
    calls.push(url);
    if (url.includes('/contact')) return { ok: true, html: 'reach us: hello@clinic.ae', finalUrl: url };
    return { ok: true, html: '<a href="/contact">Contact us</a>', finalUrl: url };
  });
  assert.deepEqual(got.emails, ['hello@clinic.ae']);
  assert.equal(calls.length, 2);
  assert.match(got.source, /\/contact$/, 'the page the address actually came from is recorded');
});

test('findEmailsFor: falls back to http when https fails', async () => {
  const calls = [];
  const got = await findEmailsFor({ domain: 'clinic.ae' }, async (url) => {
    calls.push(url);
    if (url.startsWith('https:')) return { ok: false, error: 'timeout' };
    return { ok: true, html: 'info@clinic.ae', finalUrl: url };
  });
  assert.deepEqual(got.emails, ['info@clinic.ae']);
  assert.ok(calls[0].startsWith('https:') && calls[1].startsWith('http:'));
});

test('findEmailsFor: an unreachable site says so instead of reading as no address', async () => {
  const got = await findEmailsFor({ domain: 'clinic.ae' }, async () => ({ ok: false, error: 'timeout' }));
  assert.deepEqual(got.emails, []);
  assert.match(got.reason, /not readable/i);
  assert.match(got.reason, /timeout/);
});

test('findEmailsFor: a readable site with no address says that, distinctly', async () => {
  const got = await findEmailsFor({ domain: 'clinic.ae' }, async (url) => ({ ok: true, html: '<p>Use our form</p>', finalUrl: url }));
  assert.deepEqual(got.emails, []);
  assert.match(got.reason, /no address published/i);
});

test('parseContactArgs defaults and overrides', () => {
  assert.deepEqual(parseContactArgs([]), { input: 'leads.json', out: 'contacts.md', concurrency: 6, noMx: false });
  const a = parseContactArgs(['my-leads.json', '--out', 'x.md', '--concurrency', '2']);
  assert.equal(a.input, 'my-leads.json');
  assert.equal(a.out, 'x.md');
  assert.equal(a.concurrency, 2);
  assert.equal(parseContactArgs(['--out=y.md']).out, 'y.md');
});

// Both of these came out of the first live run against 45 real clinic sites.
// They are here because the run's own output made them visible — a scraper
// that quietly emitted them would have put two dead addresses on an outreach
// list, which is the failure this file exists to prevent.
test('LIVE: a theme placeholder domain is rejected however many .com it has', () => {
  assert.equal(isJunkEmail('info@example.com.com'), true, 'the address a live run actually produced');
  assert.equal(isJunkEmail('hi@example.co.uk'), true);
  assert.equal(isJunkEmail('hi@sub.example.net'), true);
  // Must not over-reach onto a real clinic that merely contains the letters.
  assert.equal(isJunkEmail('info@exampleclinic.ae'), false);
  assert.equal(isJunkEmail('info@my-example-dental.ae'), false);
});

test('LIVE: percent-encoding residue is stripped, not published as an address', () => {
  assert.equal(isJunkEmail('%20info@samplemedicalcenter.ae'), true, 'residue is not an address');
  // …but the address it was wrapping must still be recovered from the page.
  const got = extractEmails('<p>Write to %20info@samplemedicalcenter.ae today</p>');
  assert.deepEqual(got.text, ['info@samplemedicalcenter.ae']);
});

test('LIVE: a mailto with an encoded leading space still yields the clean address', () => {
  const got = extractEmails('<a href="mailto:%20info@clinic.ae">Email</a>');
  assert.deepEqual(got.mailto, ['info@clinic.ae']);
});

// ----------------------------------------------------------- phones and forms
//
// Added because three leads came out of the email/no-email split with no email
// AND no phone from Google — no route to them at all — while their websites
// were sitting there publishing a number the scraper never looked for.

test('normalizePhone folds every way a UAE number is written into one form', () => {
  for (const raw of ['+971 4 349 8484', '00971 4 349 8484', '971-4-349-8484', '04 349 8484', '043498484']) {
    assert.equal(normalizePhone(raw), '043498484', raw);
  }
  for (const raw of ['+971 50 563 0611', '0505630611', '050 563 0611']) {
    assert.equal(normalizePhone(raw), '0505630611', raw);
  }
});

// The whole risk of scraping phone numbers off a page is picking up something
// that is not one. A licence number in an outreach sheet is worse than a blank.
test('normalizePhone rejects things that are not UAE phone numbers', () => {
  assert.equal(normalizePhone('2024'), null, 'a year');
  assert.equal(normalizePhone('01 234 5678'), null, 'no UAE area code starts 01');
  assert.equal(normalizePhone('0812345678'), null, '08 is toll-free, not a clinic line');
  assert.equal(normalizePhone('04 349 848'), null, 'a landline is nine digits, this is eight');
  assert.equal(normalizePhone('050 563 061'), null, 'a mobile is ten digits, this is nine');
  assert.equal(normalizePhone('0435630611'), null, 'a nine-digit landline cannot be ten digits long');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('extractPhones reads tel: links, which are unambiguous', () => {
  const html = '<a href="tel:+97143498484">Call us</a><a href="tel:0505630611">Mobile</a>';
  assert.deepEqual(extractPhones(html).sort(), ['043498484', '0505630611']);
});

test('extractPhones dedupes the same number written two ways', () => {
  const html = '<a href="tel:+97143498484">Call</a><p>Or dial 04 349 8484 direct.</p>';
  assert.deepEqual(extractPhones(html), ['043498484']);
});

test('extractPhones ignores digits in scripts, prices and licence numbers', () => {
  const html = '<script>var id=971043498484; var v="1.2.3";</script>'
    + '<p>Established 2004. Only AED 1500 per implant. Licence 04349848.</p>';
  assert.deepEqual(extractPhones(html), [], 'none of these are phone numbers');
});

test('extractPhones reads a formatted number out of body text', () => {
  assert.deepEqual(extractPhones('<p>Reception: +971 4 344 8844</p>'), ['043448844']);
  assert.deepEqual(extractPhones('<p>Call 050 213 9191 to book</p>'), ['0502139191']);
});

// A wa.me link is a phone number, and for a Dubai clinic it is often the one
// they actually answer.
test('extractWhatsApp reads the number out of every wa.me form', () => {
  assert.deepEqual(extractWhatsApp('<a href="https://wa.me/971505630611">x</a>'), ['0505630611']);
  assert.deepEqual(extractWhatsApp('<a href="https://api.whatsapp.com/send?phone=971505630611">x</a>'), ['0505630611']);
  assert.deepEqual(extractWhatsApp('<a href="https://web.whatsapp.com/send?phone=+971505630611">x</a>'), ['0505630611']);
  assert.deepEqual(extractWhatsApp('<a href="https://example.com/whatever">x</a>'), []);
});

// A search box and a newsletter signup are both <form>s and neither reaches a
// human, so a bare <form> is not enough to claim the clinic is contactable.
test('hasContactForm requires a message-shaped field, not just any form', () => {
  assert.equal(hasContactForm('<form><input type="email" name="email"><textarea name="msg"></textarea></form>'), true);
  assert.equal(hasContactForm('<form><input name="your-email"><input name="message"></form>'), true);
  assert.equal(hasContactForm('<form><input type="search" name="q"><button>Go</button></form>'), false, 'a search box');
  assert.equal(hasContactForm('<form><input type="email" name="email"><button>Subscribe</button></form>'), false, 'a newsletter signup');
  assert.equal(hasContactForm('<p>no form here</p>'), false);
});

test('findContactsFor gathers every route, not just the first one', async () => {
  const html = '<a href="mailto:info@clinic.ae">Email</a>'
    + '<a href="tel:+97143498484">Call</a>'
    + '<a href="https://wa.me/971505630611">WhatsApp</a>'
    + '<form><input type="email" name="email"><textarea name="message"></textarea></form>';
  const got = await findContactsFor({ domain: 'clinic.ae' }, async (url) => ({ ok: true, html, finalUrl: url }));
  assert.deepEqual(got.emails, ['info@clinic.ae']);
  assert.deepEqual(got.phones, ['043498484']);
  assert.deepEqual(got.whatsapp, ['0505630611']);
  assert.match(got.contactFormUrl, /clinic\.ae/);
});

// The exact gap that prompted this: a site with no address but a phone is
// reachable, and used to be reported as though it were a dead end.
test('findContactsFor: no email but a phone is a route, and the note says so', async () => {
  const got = await findContactsFor({ domain: 'clinic.ae' }, async (url) => ({
    ok: true, finalUrl: url, html: '<a href="tel:043498484">Call</a>',
  }));
  assert.deepEqual(got.emails, []);
  assert.deepEqual(got.phones, ['043498484']);
  assert.match(got.reason, /no address published, but the site does publish a phone/);
});

test('findContactsFor: a genuinely empty page still reports no route', async () => {
  const got = await findContactsFor({ domain: 'clinic.ae' }, async (url) => ({ ok: true, finalUrl: url, html: '<p>hello</p>' }));
  assert.deepEqual(got.emails, []);
  assert.deepEqual(got.phones, []);
  assert.match(got.reason, /no address published on the pages read/);
});

test('findContactsFor follows a contact page when the homepage lacks a phone', async () => {
  const got = await findContactsFor({ domain: 'clinic.ae' }, async (url) => {
    if (url.includes('/contact')) return { ok: true, finalUrl: url, html: '<a href="tel:043498484">Call</a>' };
    return { ok: true, finalUrl: url, html: '<a href="mailto:a@clinic.ae">Mail</a><a href="/contact">Contact</a>' };
  });
  assert.deepEqual(got.emails, ['a@clinic.ae']);
  assert.deepEqual(got.phones, ['043498484'], 'the contact page phone is found even though the homepage had the email');
  assert.equal(got.contactPageUrl, 'https://clinic.ae/contact');
});

test('findContactsFor: a lead with no domain returns empty arrays, not undefined', async () => {
  const got = await findContactsFor({ domain: null });
  assert.deepEqual(got.phones, []);
  assert.deepEqual(got.whatsapp, []);
  assert.equal(got.contactFormUrl, null);
});

test('findEmailsFor still works as an alias', () => {
  assert.equal(findEmailsFor, findContactsFor);
});

test('parseContactArgs reads --no-mx and defaults it off', () => {
  assert.equal(parseContactArgs([]).noMx, false);
  assert.equal(parseContactArgs(['--no-mx']).noMx, true);
  // The flag must not be mistaken for the positional input file.
  assert.equal(parseContactArgs(['--no-mx', 'leads.json']).input, 'leads.json');
});

// ------------------------------------------------------------ mail summary
//
// C1: the report has two buckets for a four-state classifier. Lumping
// NO-MAIL/IMPLICIT-MX/UNVERIFIED together and deriving the good count by
// subtraction let a failed probe count as accepting mail, and reported a
// "verify before sending" address as a guaranteed bounce.

test('summarizeMail does not count an UNVERIFIED address as accepting mail', () => {
  const results = [
    { name: 'Works', mail: { site: { verdict: MAIL_CAPABLE }, addresses: [{ email: 'a@works.ae', verdict: MAIL_CAPABLE, primary: 'mx.works.ae', codes: [] }] } },
    { name: 'Unknown', mail: { site: { verdict: MAIL_CAPABLE }, addresses: [{ email: 'b@unknown.ae', verdict: UNVERIFIED, codes: ['mx-canary-failed'] }] } },
  ];
  const s = summarizeMail(results);
  assert.equal(s.checkedCount, 2);
  assert.equal(s.capableCount, 1, 'the failed probe must not inflate the count of addresses that accept mail');
  assert.equal(s.unverifiedCount, 1, 'it is surfaced as its own could-not-be-checked count instead');
});

test('summarizeMail keeps IMPLICIT-MX out of the will-not-deliver bucket', () => {
  const results = [
    { name: 'Web-only', mail: { site: { verdict: MAIL_CAPABLE }, addresses: [{ email: 'c@webonly.ae', verdict: IMPLICIT_MX, codes: [] }] } },
  ];
  const s = summarizeMail(results);
  assert.equal(s.noMailAddresses.length, 0, 'IMPLICIT-MX is "verify before sending", not a confirmed bounce');
  assert.equal(s.implicitMxAddresses.length, 1, 'it still gets its own section');
  assert.equal(s.implicitMxCount, 1);
});

// M1: six clinics sharing one address plus one other address printed
// "7 checked, 6 will not deliver" for 2 distinct addresses. The totals must
// count distinct addresses; the per-clinic sections still list one row per
// clinic that publishes a bad address, so a shared failure is not hidden.
test('summarizeMail counts distinct addresses in the totals, not one per clinic', () => {
  const shared = { email: 'info@shared.ae', domain: 'shared.ae', verdict: NO_MAIL, primary: null, codes: [] };
  const other = { email: 'hello@other.ae', domain: 'other.ae', verdict: MAIL_CAPABLE, primary: 'mx.other.ae', codes: [] };
  const site = { verdict: MAIL_CAPABLE, domain: 'shared.ae', primary: 'mx.shared.ae' };
  const results = [
    ...Array.from({ length: 6 }, (_, i) => ({ name: `Branch ${i + 1}`, mail: { site, addresses: [shared] } })),
    { name: 'Solo Clinic', mail: { site, addresses: [other] } },
  ];
  const s = summarizeMail(results);
  assert.equal(s.checkedCount, 2, '2 distinct addresses were checked, not 7 rows');
  assert.equal(s.noMailCount, 1, 'the one shared bad address, not six');
  assert.equal(s.capableCount, 1);
  assert.equal(s.noMailAddresses.length, 6, 'every clinic publishing the bad address still gets a listed row');
});
