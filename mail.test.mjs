import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_CAPABLE, NO_MAIL, IMPLICIT_MX, UNVERIFIED,
  isNullMx, classifyMail,
} from './mail.mjs';

const mx = (priority, exchange) => ({ priority, exchange, type: 'MX' });

test('MX records present means the domain routes mail', () => {
  const r = classifyMail({ mxRecords: [mx(10, 'alt.example.net'), mx(1, 'primary.example.net')] });
  assert.equal(r.verdict, MAIL_CAPABLE);
  assert.equal(r.primary, 'primary.example.net', 'primary is the lowest priority, not the first returned');
  assert.deepEqual(r.records.map((x) => x.priority), [1, 10], 'records are sorted by priority');
});

// Node strips the root label from the RFC 7505 "." exchange. Matching only on
// "." would read the strongest possible do-not-email signal as MAIL-CAPABLE.
test('Null MX is recognised when Node reports the exchange as an empty string', () => {
  assert.equal(isNullMx([mx(0, '')]), true);
  const r = classifyMail({ mxRecords: [mx(0, '')] });
  assert.equal(r.verdict, NO_MAIL);
  assert.equal(r.reason, 'null-mx');
  assert.equal(r.primary, null);
});

test('Null MX is also recognised in its literal RFC spelling', () => {
  assert.equal(isNullMx([mx(0, '.')]), true);
  assert.equal(classifyMail({ mxRecords: [mx(0, '.')] }).verdict, NO_MAIL);
});

test('a real MX at priority 0 is not Null MX', () => {
  assert.equal(isNullMx([mx(0, 'mail.example.net')]), false);
  assert.equal(classifyMail({ mxRecords: [mx(0, 'mail.example.net')] }).verdict, MAIL_CAPABLE);
});

test('two records are never Null MX even if one is the root', () => {
  assert.equal(isNullMx([mx(0, ''), mx(10, 'mail.example.net')]), false);
});

// The two shapes Node uses for "no MX records", both observed in the real list.
test('no MX by rejection, with an address record, is the RFC 5321 fallback', () => {
  const r = classifyMail({ mxCode: 'ENODATA', addrOk: true });
  assert.equal(r.verdict, IMPLICIT_MX);
  assert.equal(r.primary, null);
  assert.deepEqual(r.codes, ['ENODATA']);
});

test('no MX by empty array, with an address record, is the RFC 5321 fallback', () => {
  const r = classifyMail({ mxRecords: [], addrOk: true });
  assert.equal(r.verdict, IMPLICIT_MX);
  assert.deepEqual(r.codes, []);
});

test('no MX and no address record cannot receive mail', () => {
  const r = classifyMail({ mxCode: 'ENOTFOUND', addrOk: false, addrCode: 'ENOTFOUND' });
  assert.equal(r.verdict, NO_MAIL);
  assert.equal(r.reason, 'no-records');
});

// The distinction the whole feature rests on.
test('a failed MX probe is UNVERIFIED, not NO-MAIL', () => {
  for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'SERVFAIL', 'ECONNREFUSED', 'ETIMEOUT']) {
    assert.equal(classifyMail({ mxCode: code }).verdict, UNVERIFIED, `${code} must be UNVERIFIED`);
  }
});

test('a failed address probe after no MX is UNVERIFIED, not NO-MAIL', () => {
  assert.equal(classifyMail({ mxCode: 'ENODATA', addrOk: false, addrCode: 'EAI_AGAIN' }).verdict, UNVERIFIED);
});

test('every code seen is carried into the result', () => {
  assert.deepEqual(classifyMail({ mxCode: 'ENODATA', addrOk: false, addrCode: 'ENOTFOUND' }).codes,
    ['ENODATA', 'ENOTFOUND']);
});

import {
  mxCanaryOk, resolveMail, emailDomain, rollupMail, checkLeadMail, describeMail,
} from './mail.mjs';

// A stand-in for node:dns. A value that is an array resolves; an Error rejects;
// a missing entry rejects ENOTFOUND.
function fakeResolver(mxByDomain = {}, addrByDomain = {}) {
  const answer = (table) => async (domain) => {
    const v = table[domain];
    if (v === undefined) { const e = new Error('no entry'); e.code = 'ENOTFOUND'; throw e; }
    if (v instanceof Error) throw v;
    return v;
  };
  return { resolveMx: answer(mxByDomain), resolve4: answer(addrByDomain), resolve6: answer({}) };
}

const err = (code) => Object.assign(new Error(code), { code });
const mxr = (priority, exchange) => ({ priority, exchange, type: 'MX' });

test('the MX canary passes when a known-good domain answers', async () => {
  assert.equal(await mxCanaryOk(fakeResolver({ 'google.com': [mxr(10, 'smtp.google.com')] })), true);
});

test('the MX canary fails when no known-good domain answers', async () => {
  assert.equal(await mxCanaryOk(fakeResolver({})), false);
});

// A resolver that answers [] for google.com is answering "no MX for
// google.com" — that is a working resolver reporting an absurd result, i.e.
// broken, not a resolver that can be trusted for real domains.
test('the MX canary does not trust an empty-array answer', async () => {
  const r = fakeResolver({ 'google.com': [], 'cloudflare.com': [] });
  assert.equal(await mxCanaryOk(r), false);
});

// The point of the canary: on a network that blocks port 53, every negative
// would otherwise read as "this clinic cannot receive email".
test('an untrusted canary forces UNVERIFIED without probing at all', async () => {
  let probed = false;
  const spy = { resolveMx: async () => { probed = true; return []; }, resolve4: async () => [] };
  const r = await resolveMail('anything.example', false, spy);
  assert.equal(r.verdict, UNVERIFIED);
  assert.deepEqual(r.codes, ['mx-canary-failed']);
  assert.equal(probed, false, 'no query should be issued when the resolver is not trusted');
});

test('resolveMail reports a live MX host', async () => {
  const r = fakeResolver({ 'clinic.example': [mxr(5, 'imailv.example.net'), mxr(10, 'alt.example.net')] });
  const out = await resolveMail('clinic.example', true, r);
  assert.equal(out.verdict, MAIL_CAPABLE);
  assert.equal(out.primary, 'imailv.example.net');
  assert.equal(out.domain, 'clinic.example');
});

test('resolveMail consults the address record only when there is no MX', async () => {
  const r = fakeResolver({ 'web.example': err('ENODATA') }, { 'web.example': ['203.0.113.10'] });
  assert.equal((await resolveMail('web.example', true, r)).verdict, IMPLICIT_MX);
});

// An MX-bearing domain's A record is never consulted: classifyMail folds
// addrCode into codes regardless, so an unconditional query would pollute a
// MAIL-CAPABLE result's codes and double live DNS traffic under fan-out.
test('resolveMail never queries the address record when MX answers', async () => {
  let resolve4Calls = 0;
  const spy = {
    resolveMx: async () => [mxr(10, 'mail.example.net')],
    resolve4: async () => { resolve4Calls += 1; return ['203.0.113.10']; },
    resolve6: async () => [],
  };
  const out = await resolveMail('clinic.example', true, spy);
  assert.equal(out.verdict, MAIL_CAPABLE);
  assert.equal(resolve4Calls, 0, 'resolve4 must not be called when MX records exist');
});

test('resolveMail reports NO-MAIL when neither MX nor address resolves', async () => {
  const out = await resolveMail('gone.example', true, fakeResolver({ 'gone.example': err('ENOTFOUND') }, {}));
  assert.equal(out.verdict, NO_MAIL);
  assert.equal(out.reason, 'no-records');
});

// Node signals "no records" as both a thrown error and a resolved empty
// array. resolve4 answering [] (not throwing) must fall back to resolve6
// exactly like a thrown resolve4 does — otherwise an IPv6-only domain is
// wrongly reported as NO-MAIL ("will bounce") when it will not.
test('resolveMail falls back to IPv6 when resolve4 answers with an empty array', async () => {
  const spy = {
    resolveMx: async () => { throw err('ENOTFOUND'); },
    resolve4: async () => [],
    resolve6: async () => ['2001:db8::1'],
  };
  const out = await resolveMail('v6only.example', true, spy);
  assert.equal(out.verdict, IMPLICIT_MX, 'an IPv6-only domain must not be reported as NO-MAIL');
});

// A real instance of this appeared during development: one clinic's whole zone
// began returning SERVFAIL for every record type while the canary domain still
// resolved. The tool must call that UNVERIFIED — a zone that answers nothing is
// not a domain that refuses mail, and telling the owner their address bounces
// when it does not is the worst output this tool can produce.
test('a broken zone that answers nothing is UNVERIFIED, not NO-MAIL', async () => {
  const spy = {
    resolveMx: async () => [],
    resolve4: async () => [],
    resolve6: async () => { throw err('ESERVFAIL'); },
  };
  const out = await resolveMail('brokenzone.example', true, spy);
  assert.equal(out.verdict, UNVERIFIED, 'a SERVFAIL on the last probe must not read as NO-MAIL');
  assert.deepEqual(out.codes, ['ESERVFAIL']);
});

test('emailDomain lowercases and splits on the final @', () => {
  assert.equal(emailDomain('Info@Example.COM'), 'example.com');
  assert.equal(emailDomain('odd"@"name@example.ae'), 'example.ae');
  assert.equal(emailDomain('not-an-address'), null);
});

test('rollup uses the site verdict when no addresses were found', () => {
  assert.equal(rollupMail({ verdict: IMPLICIT_MX }, []), IMPLICIT_MX);
});

test('rollup is MAIL-CAPABLE when any found address works', () => {
  assert.equal(rollupMail({ verdict: NO_MAIL }, [{ verdict: NO_MAIL }, { verdict: MAIL_CAPABLE }]), MAIL_CAPABLE);
});

test('rollup reports the worst verdict when no found address works', () => {
  assert.equal(rollupMail({ verdict: MAIL_CAPABLE }, [{ verdict: UNVERIFIED }, { verdict: NO_MAIL }]), NO_MAIL);
});

// I2: a lead whose site 403s finds zero addresses, but its site domain can
// still be MAIL-CAPABLE (DNS and HTTP are unrelated). rollupMail must not
// then answer "yes, email this clinic" — there is nothing to email.
test('rollup does not assert emailability for a lead with zero addresses', () => {
  assert.notEqual(rollupMail({ verdict: MAIL_CAPABLE }, []), MAIL_CAPABLE,
    'a site accepting mail is not the same as having an address to send to');
  assert.equal(rollupMail({ verdict: MAIL_CAPABLE }, []), UNVERIFIED);
});

// The Sample case — the reason this checks address domains at all.
test('a working site domain does not clear a dead address domain', async () => {
  const r = fakeResolver(
    { 'sampledentdubai.com': [mxr(5, 'aspmx.l.google.com')], 'sampldent.com': err('ENOTFOUND') },
    {},
  );
  const out = await checkLeadMail(
    { domain: 'sampledentdubai.com', emails: ['info@sampldent.com'] }, true, new Map(), r,
  );
  assert.equal(out.site.verdict, MAIL_CAPABLE);
  assert.equal(out.addresses[0].verdict, NO_MAIL);
  assert.equal(out.addresses[0].email, 'info@sampldent.com');
  assert.equal(out.addresses[0].domain, 'sampldent.com');
  assert.equal(out.rollup, NO_MAIL, 'the lead must not read as emailable');
});

// main() runs six workers at once. A cache keyed domain -> result is read and
// written on separate ticks, so two concurrent workers both miss and both
// query. Caching the promise is what actually deduplicates.
test('concurrent leads sharing a domain cause exactly one lookup', async () => {
  let calls = 0;
  const spy = {
    resolveMx: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return [mxr(1, 'aspmx.l.google.com')];
    },
    resolve4: async () => [],
  };
  const cache = new Map();
  await Promise.all([
    checkLeadMail({ domain: 'a.example', emails: ['x@gmail.com'] }, true, cache, spy),
    checkLeadMail({ domain: 'b.example', emails: ['y@gmail.com'] }, true, cache, spy),
  ]);
  assert.equal(calls, 3, 'a.example, b.example and gmail.com once — not gmail.com twice');
});

// emailDomain already lowercases and trims; lead.domain must match or a
// same-host lead gets two cache entries and two identical DNS queries.
test('lead.domain is normalised so it shares a cache entry with a same-host address domain', async () => {
  let calls = 0;
  const spy = {
    resolveMx: async () => { calls += 1; return [mxr(1, 'aspmx.l.google.com')]; },
    resolve4: async () => [],
  };
  const out = await checkLeadMail(
    { domain: 'Example.COM', emails: ['info@example.com'] }, true, new Map(), spy,
  );
  assert.equal(calls, 1, 'Example.COM and example.com must be one cache entry, not two');
  assert.equal(out.site.domain, 'example.com');
});

test('a lead with no domain and no addresses is UNVERIFIED, never NO-MAIL', async () => {
  const out = await checkLeadMail({ domain: null, emails: [] }, true, new Map(), fakeResolver());
  assert.equal(out.site.verdict, UNVERIFIED);
  assert.equal(out.rollup, UNVERIFIED);
});

test('describeMail names the MX host and explains each failure', () => {
  assert.match(describeMail({ verdict: MAIL_CAPABLE, primary: 'aspmx.l.google.com' }), /aspmx\.l\.google\.com/);
  assert.match(describeMail({ verdict: NO_MAIL, reason: 'null-mx', codes: [] }), /RFC 7505/);
  assert.match(describeMail({ verdict: NO_MAIL, reason: 'no-records', codes: ['ENOTFOUND'] }), /bounce/);
  assert.match(describeMail({ verdict: IMPLICIT_MX, codes: [] }), /RFC 5321/);
  assert.match(describeMail({ verdict: UNVERIFIED, codes: [] }), /Not evidence/);
});
