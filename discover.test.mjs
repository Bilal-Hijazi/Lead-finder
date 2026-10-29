import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_CAP, normalizeHost, classifyWebsite, classifyCategory, toLead, keepByStatus,
  keepByReviews, dedupe, isSaturated, parseNear, parseArgs, explainError,
  validateOpts, HELP, searchText,
  haversineM, boundingRectangle, keepByRadius, districtOf, matchesArea, areaVerdict,
} from './discover.mjs';

test('normalizeHost strips everything that is not the host', () => {
  assert.equal(normalizeHost('https://example.ae'), 'example.ae');
  assert.equal(normalizeHost('http://www.example.ae/'), 'example.ae');
  assert.equal(normalizeHost('https://WWW.Example.AE'), 'example.ae');
  assert.equal(normalizeHost('https://www.example.ae:8443/book'), 'example.ae');
  assert.equal(normalizeHost('https://example.ae./'), 'example.ae');
  // A real websiteUri from the live API — Google appends its own campaign
  // parameters, so anything taken straight from the field is unusable.
  assert.equal(
    normalizeHost('https://www.drexample.com/?utm_source=google&utm_medium=googlemybusiness'),
    'drexample.com',
  );
});

test('normalizeHost returns null for anything it cannot parse', () => {
  assert.equal(normalizeHost('example.ae'), null, 'no protocol');
  assert.equal(normalizeHost('not a url'), null);
  assert.equal(normalizeHost('mailto:hi@example.ae'), null, 'not http(s)');
  assert.equal(normalizeHost(''), null);
  assert.equal(normalizeHost(undefined), null);
});

test('classifyWebsite: a real domain passes through', () => {
  const c = classifyWebsite('https://exampledental.ae/book');
  assert.equal(c.domain, 'exampledental.ae');
  assert.equal(c.reason, null);
});

// The three routes to domain: null. Each asserts the REASON as well as the
// null — the reason is what carries the evidence into the email, and a test
// checking only `domain === null` would pass on a mapper that lost it.
test('classifyWebsite: no website listed', () => {
  const c = classifyWebsite(undefined);
  assert.equal(c.domain, null);
  assert.match(c.reason, /NO WEBSITE LISTED/);
});

test('classifyWebsite: a social page is not a website', () => {
  for (const url of [
    'https://www.facebook.com/exampledental',
    'https://instagram.com/exampledental',
    'https://linktr.ee/someclinic',
    'https://wa.me/971500000000',
  ]) {
    const c = classifyWebsite(url);
    assert.equal(c.domain, null, url);
    assert.match(c.reason, /NO SITE OF THEIR OWN/, url);
  }
});

test('classifyWebsite: business.site is a dead Google site', () => {
  const c = classifyWebsite('https://someclinic.business.site/');
  assert.equal(c.domain, null);
  assert.match(c.reason, /DEAD GOOGLE SITE/);
  assert.match(c.reason, /March 2024/);
});

test('classifyWebsite: an unparseable websiteUri is not silently a domain', () => {
  const c = classifyWebsite('not a url at all');
  assert.equal(c.domain, null);
  assert.match(c.reason, /NO USABLE WEBSITE/);
});

// searchText matches on relevance, not category, so classifyCategory is the
// check standing between "Google returned this" and "this is actually a
// dental clinic." Flag only — never a reason to drop, since a genuinely
// dental clinic Google typed oddly must still reach the list.
test('classifyCategory: primaryType dental_clinic is not flagged', () => {
  const c = classifyCategory({ primaryType: 'dental_clinic', types: ['dental_clinic', 'health'] });
  assert.equal(c.offCategory, false);
  assert.equal(c.reason, null);
});

test('classifyCategory: primaryType dentist is not flagged', () => {
  const c = classifyCategory({ primaryType: 'dentist', types: ['dentist', 'health'] });
  assert.equal(c.offCategory, false);
  assert.equal(c.reason, null);
});

// Saray polyclinic, a real shape from the live API: primaryType is `doctor`,
// but `dental_clinic` sits in the types array. primaryType alone would flag
// this — a real clinic — for no reason, which is exactly what the mutation
// test below proves.
test('classifyCategory: a non-dental primaryType with a dental entry in types is not flagged', () => {
  const c = classifyCategory({ primaryType: 'doctor', types: ['dental_clinic', 'medical_clinic', 'doctor', 'health'] });
  assert.equal(c.offCategory, false);
  assert.equal(c.reason, null);
});

// Example Aesthetics DXB, the live case that motivated this feature: 2,823 reviews, no
// website, ranked first in a real Jumeirah run — and an aesthetics clinic,
// not a dental one. The reason must name the actual category Google gave,
// not just say "not dental."
test('classifyCategory: Example Aesthetics DXB shape is flagged, naming its real category', () => {
  const c = classifyCategory({ primaryType: 'skin_care_clinic', types: ['skin_care_clinic', 'medical_clinic', 'health'] });
  assert.equal(c.offCategory, true);
  assert.match(c.reason, /skin_care_clinic/);
});

// Sample Dental Medical Center: dental in the name, but no dental type anywhere
// Google gave it. Flagging this is correct and acceptable — the flag asks a
// human to look, it does not discard.
test('classifyCategory: no dental type anywhere is flagged even when the name says dental', () => {
  const c = classifyCategory({ primaryType: 'medical_center', types: ['medical_center', 'hospital', 'service', 'health'] });
  assert.equal(c.offCategory, true);
  assert.match(c.reason, /medical_center/);
});

// No category data at all is its own case: it cannot be confirmed dental, so
// it is still flagged, but the reason must say the category was MISSING
// rather than implying Google typed it as some specific other thing.
test('classifyCategory: no category data at all is flagged as missing, not as some other type', () => {
  const c = classifyCategory({});
  assert.equal(c.offCategory, true);
  assert.match(c.reason, /missing/i);
  assert.doesNotMatch(c.reason, /undefined/);
});

test('toLead maps the live response shape', () => {
  // displayName is an object, not a string — confirmed against the live API.
  const lead = toLead({
    id: 'ChIJabc',
    displayName: { text: 'Example Dental Clinic', languageCode: 'en' },
    websiteUri: 'https://exampledental.ae/',
    nationalPhoneNumber: '04 000 0000',
    rating: 4.6,
    userRatingCount: 94,
    businessStatus: 'OPERATIONAL',
    formattedAddress: 'Jumeirah 1 - Dubai',
  }, { area: 'Jumeirah', provenance: 'discovered 2026-08-24' });

  assert.equal(lead.name, 'Example Dental Clinic');
  assert.equal(lead.domain, 'exampledental.ae');
  // Was 'Jumeirah', the value passed in — see DEFECT 8. `area` is now read from
  // the address Google returned, so it says which part of Jumeirah this is.
  assert.equal(lead.area, 'Jumeirah 1');
  assert.equal(lead.phone, '04 000 0000');
  assert.equal(lead.rating, 4.6);
  assert.equal(lead.reviews, 94);
  assert.equal(lead.placeId, 'ChIJabc');
  assert.match(lead.note, /discovered 2026-08-24/);
});

// Absent means absent. A null rating would read as "unrated but known" and
// would defeat the ranking's missing-demand fallback.
test('toLead omits absent fields rather than emitting null', () => {
  const lead = toLead(
    { id: 'ChIJxyz', displayName: { text: 'No Data Clinic' } },
    { provenance: 'discovered 2026-08-24' },
  );
  assert.equal(lead.domain, null, 'domain is the one load-bearing null');
  assert.ok(!('phone' in lead));
  assert.ok(!('rating' in lead));
  assert.ok(!('reviews' in lead));
  assert.ok(!('area' in lead));
});

test('toLead keeps both the reason and the run date in note', () => {
  const lead = toLead(
    { id: 'x', displayName: { text: 'C' } },
    { provenance: 'discovered 2026-08-24 · "dental clinic" within 5000m of 25.2,55.2' },
  );
  assert.match(lead.note, /NO WEBSITE LISTED/);
  assert.match(lead.note, /discovered 2026-08-24/);
});

test('toLead carries primaryType through, omitted when absent', () => {
  const withType = toLead(
    { id: 'a', displayName: { text: 'A' }, primaryType: 'dental_clinic' },
    { provenance: 'discovered 2026-08-24' },
  );
  assert.equal(withType.primaryType, 'dental_clinic');

  const withoutType = toLead(
    { id: 'b', displayName: { text: 'B' } },
    { provenance: 'discovered 2026-08-24' },
  );
  assert.ok(!('primaryType' in withoutType));
});

test('toLead flags an off-category place in note, naming the real category', () => {
  // Example Aesthetics DXB shape, with a website so the domain: null reason does not
  // also fire — this isolates the category flag on its own.
  const lead = toLead(
    {
      id: 'x', displayName: { text: 'Example Aesthetics DXB' }, websiteUri: 'https://exampleaesthetics.ae/',
      primaryType: 'skin_care_clinic', types: ['skin_care_clinic', 'medical_clinic', 'health'],
    },
    { provenance: 'discovered 2026-08-24' },
  );
  assert.equal(lead.domain, 'exampleaesthetics.ae');
  assert.match(lead.note, /skin_care_clinic/);
});

// A lead can be off-category and website-less at the same time — both are
// real, independent findings about the same place, and neither reason may
// overwrite the other in note.
test('toLead keeps BOTH reasons in note for a lead that is off-category and website-less', () => {
  const lead = toLead(
    {
      id: 'y', displayName: { text: 'Example Aesthetics DXB' },
      primaryType: 'skin_care_clinic', types: ['skin_care_clinic', 'medical_clinic', 'health'],
    },
    { provenance: 'discovered 2026-08-24' },
  );
  assert.equal(lead.domain, null);
  assert.match(lead.note, /NO WEBSITE LISTED/);
  assert.match(lead.note, /skin_care_clinic/);
});

test('keepByStatus drops closed places but keeps an absent status', () => {
  assert.equal(keepByStatus({ businessStatus: 'OPERATIONAL' }), true);
  assert.equal(keepByStatus({ businessStatus: 'CLOSED_PERMANENTLY' }), false);
  assert.equal(keepByStatus({ businessStatus: 'CLOSED_TEMPORARILY' }), false);
  // Unknown is not closed. Dropping on a missing field silently deletes leads
  // Google simply had no data for.
  assert.equal(keepByStatus({}), true);
});

test('keepByReviews is off at 0 and applied at the boundary', () => {
  assert.equal(keepByReviews({ userRatingCount: 0 }, 0), true, 'filter off');
  assert.equal(keepByReviews({ userRatingCount: 5 }, 5), true, 'boundary kept');
  assert.equal(keepByReviews({ userRatingCount: 4 }, 5), false);
  assert.equal(keepByReviews({}, 5), false, 'missing count counts as 0');
  assert.equal(keepByReviews({}, 0), true);
});

test('dedupe collapses the same place id across queries', () => {
  const out = dedupe([
    { id: 'a', displayName: { text: 'A' } },
    { id: 'b', displayName: { text: 'B' } },
    { id: 'a', displayName: { text: 'A again' } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.id), ['a', 'b']);
});

test('saturation triggers at exactly the cap, not below it', () => {
  assert.equal(PAGE_CAP, 60);
  assert.equal(isSaturated(60), true);
  assert.equal(isSaturated(59), false);
  assert.equal(isSaturated(0), false);
});

test('parseNear accepts a lat,lng and rejects nonsense', () => {
  assert.deepEqual(parseNear('25.2048,55.2708'), { latitude: 25.2048, longitude: 55.2708 });
  assert.deepEqual(parseNear(' 25.2048 , 55.2708 '), { latitude: 25.2048, longitude: 55.2708 });
  assert.deepEqual(parseNear('-33.8,151.2'), { latitude: -33.8, longitude: 151.2 });
  assert.equal(parseNear('91,55'), null, 'latitude out of range');
  assert.equal(parseNear('25,181'), null, 'longitude out of range');
  assert.equal(parseNear('Jumeirah'), null);
  assert.equal(parseNear(undefined), null);
});

test('parseArgs collects repeated --query and both flag forms', () => {
  const a = parseArgs([
    '--query', 'dental clinic', '--query=dentist',
    '--near', '25.2,55.2', '--radius', '3000',
    '--area', 'Jumeirah', '--min-reviews', '5',
    '--out', 'leads.json', '--force',
  ]);
  assert.deepEqual(a.query, ['dental clinic', 'dentist']);
  assert.equal(a.near, '25.2,55.2');
  assert.equal(a.radius, 3000);
  // Repeatable since DEFECT 8b — a district can be spelled more than one way.
  assert.deepEqual(a.area, ['Jumeirah']);
  assert.equal(a.minReviews, 5);
  assert.equal(a.out, 'leads.json');
  assert.equal(a.force, true);
});

test('parseArgs defaults, and rejects an unknown flag', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.query, []);
  assert.equal(a.radius, 5000);
  assert.equal(a.minReviews, 0);
  assert.equal(a.out, 'leads.json');
  assert.equal(a.force, false);
  assert.throws(() => parseArgs(['--qeury', 'typo']), /unknown flag --qeury/);
});

// Both bodies are recorded verbatim from the live API during design. Without
// the caller IP echoed back there is no way to tell whether the allowlist is
// wrong or the request left on an unexpected interface.
test('explainError names the two 403s a new project actually hits', () => {
  const disabled = explainError(403, { error: { code: 403, message: 'Places API (New) has not been used...', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED',
      metadata: { activationUrl: 'https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=123' } },
  ] } });
  assert.match(disabled, /not enabled/i);
  assert.match(disabled, /overview\?project=123/);

  const blocked = explainError(403, { error: { code: 403, message: 'IP restriction', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_IP_ADDRESS_BLOCKED',
      metadata: { callerIp: '2001:db8::1' } },
  ] } });
  assert.match(blocked, /IP-restricted/i);
  assert.match(blocked, /2001:db8::1/, 'must echo the caller IP back');

  assert.match(explainError(400, { error: { message: 'bad mask' } }), /FieldMask/);
  assert.match(explainError(500, {}), /500/);
});

// ---------------------------------------------------------------- DEFECT 6
//
// The PLACES_KEY and --radius guards print a bare message while --query,
// --near and the unknown-flag path (parseArgs throws, caught in main and
// wrapped with HELP) all append the full usage block. A user who mistypes
// --radius or forgets PLACES_KEY is the one left without the one thing that
// would have shown them the fix.
test('DEFECT6: validateOpts appends the HELP usage block to every guard message', () => {
  const base = { query: ['dental clinic'], near: '25.2048,55.2708', radius: 5000, out: 'leads.json' };

  const missingKey = validateOpts({ ...base }, false);
  assert.equal(missingKey.ok, false);
  assert.ok(missingKey.message.endsWith(HELP),
    'PLACES_KEY error must end with the same HELP block --query and --near already get');

  const badRadius = validateOpts({ ...base, radius: 0 }, true);
  assert.equal(badRadius.ok, false);
  assert.ok(badRadius.message.endsWith(HELP),
    '--radius error must end with the same HELP block --query and --near already get');
});

// ---------------------------------------------------------------- DEFECT 4
//
// `--out` with no following value (or one that looks like another flag)
// parses to `out: null`. Every other option is validated before the first
// Places request goes out; --out was not, so a run only discovered the
// problem at the writeFile call at the very end — after every query had
// already been billed.
test('DEFECT4: validateOpts rejects a missing --out before any request would be made', () => {
  const base = { query: ['dental clinic'], near: '25.2048,55.2708', radius: 5000 };

  const noOut = validateOpts({ ...base, out: null }, true);
  assert.equal(noOut.ok, false, '--out: null — exactly what parseArgs produces when --out has no value — must fail validation up front');
  assert.match(noOut.message, /--out/);

  const emptyOut = validateOpts({ ...base, out: '' }, true);
  assert.equal(emptyOut.ok, false, '--out= with nothing after the = must also fail validation');
});

test('validateOpts accepts a fully valid set of options', () => {
  const good = validateOpts({ query: ['dental clinic'], near: '25.2048,55.2708', radius: 5000, out: 'leads.json' }, true);
  assert.equal(good.ok, true);
});

// ---------------------------------------------------------------- searchText
//
// This was the one untested surface in the module a whole-branch review found
// four Critical defects in. It uses global `fetch`, so no library and no
// network are needed to cover it — each test replaces `globalThis.fetch` with
// a stub shaped like the real Places response and restores the original
// afterwards, in `finally`, so a failing assertion can never leak a stub
// fetch into a later test.
//
// Requests are counted, not just results inspected: several of these paths
// exist specifically to make sure a call is NOT made (the fatal 401/403 path)
// or is made exactly once more (the 429 retry) — a test that only checked the
// returned data could pass while calling Google far more, or fewer, times
// than the real behaviour requires.

const CENTER = { latitude: 25.2048, longitude: 55.2708 };
const RADIUS = 5000;
const places = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: `place-${offset + i}` }));

test('searchText: paginates through exactly three pages when Google hands back a token twice', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      const page = calls;
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: places(20, (page - 1) * 20), nextPageToken: page < 3 ? `token-${page}` : undefined }),
      };
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 3, 'exactly one request per page, no more');
    assert.equal(result.places.length, 60, 'all three pages of 20 collected');
    assert.equal(result.saturated, true, '60 results hits PAGE_CAP');
    assert.equal(result.truncated, null);
    assert.equal(result.fatal, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchText: a tokenless page 1 under the cap is a complete run, not a truncated one', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ places: places(8) }) };
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 1, 'no second page requested when Google gives no token');
    assert.equal(result.places.length, 8);
    assert.equal(result.saturated, false);
    // A short result set is a complete run, not a failed one — truncated must
    // stay at its unset value, not be invented because the count is small.
    assert.equal(result.truncated, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchText: a single 429 is retried once and the results are kept', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ places: places(3) }) };
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 2, 'the 429 plus exactly one retry');
    assert.equal(result.places.length, 3, 'the results from the successful retry are kept');
    assert.equal(result.truncated, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchText: two consecutive 429s give up on the page and report it as truncated, not silently empty', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 2, 'both attempts of the retry budget were spent, then this page was given up on');
    assert.equal(result.places.length, 0);
    assert.equal(typeof result.truncated, 'string', 'must be reported as truncated, not returned as a quiet empty success');
    assert.match(result.truncated, /page 1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchText: a fetch that throws on page 2 keeps page 1\'s results instead of losing them', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ places: places(2), nextPageToken: 'tok' }) };
      throw new Error('network reset');
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 2);
    // The specific defect this path was fixed for: losing page 1's already-
    // collected results because page 2 blew up.
    assert.equal(result.places.length, 2, "page 1's results must survive a page-2 failure");
    assert.equal(typeof result.truncated, 'string');
    assert.match(result.truncated, /page 2/);
    assert.match(result.truncated, /network reset/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searchText: a 401/403 is fatal, stops immediately, and never also sets truncated', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: 403,
            message: 'blocked',
            details: [{ reason: 'API_KEY_IP_ADDRESS_BLOCKED', metadata: { callerIp: '2001:db8::1' } }],
          },
        }),
      };
    };
    const result = await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(calls, 1, 'a key/project problem fails identically on every retry, so no further request is made');
    assert.equal(typeof result.fatal, 'string');
    // Mutually exclusive: downstream code (main(), and the report) branches
    // on one or the other, never both, for the same query.
    assert.equal(result.truncated, null, 'fatal and truncated must never both be set for the same query');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- DEFECT 8
//
// The tool sold "dentists within 5km of Jumeirah" and delivered a list where
// 67 of 75 leads were not in Jumeirah at all — 11 in Business Bay, 3 in Deira,
// 1 in Al Karama, 1 in Al Garhoud. Deira and Al Garhoud sit roughly 9km from
// the centre point of a run that asked for 5000m.
//
// Three causes compounded, and all three are covered below:
//
//   1. searchText sent `locationBias`, which Google documents as a bias:
//      "results around given location MIGHT be returned". Nothing was
//      constrained. The hard filter is `locationRestriction`, and for
//      searchText it accepts a rectangle ONLY — not a circle — so the
//      rectangle alone cannot express the radius and a client-side circle
//      check is still required. Both layers are asserted.
//   2. FIELD_MASK never asked for places.location, so no distance could be
//      computed even in principle. There were no coordinates to check.
//   3. --area was stamped onto every lead unconditionally, so all 75 said
//      "Jumeirah" whatever their address. That is what made 1 and 2 invisible:
//      the contaminated leads looked exactly like the real ones.

test('DEFECT8: haversineM measures real distance, so an out-of-radius lead can be recognised', () => {
  const jumeirah1 = { latitude: 25.2325, longitude: 55.2650 };
  // The two districts that proved the radius was never enforced.
  const deira = { latitude: 25.2700, longitude: 55.3100 };
  const alGarhoud = { latitude: 25.2400, longitude: 55.3500 };

  assert.equal(haversineM(jumeirah1, jumeirah1), 0, 'a point is zero metres from itself');

  // Known-good reference: 0.01 degrees of latitude is ~1113m anywhere on Earth.
  const oneHundredth = haversineM({ latitude: 25, longitude: 55 }, { latitude: 25.01, longitude: 55 });
  assert.ok(Math.abs(oneHundredth - 1113) < 15, `0.01 deg latitude should be ~1113m, got ${oneHundredth}`);

  // Both are well outside the 5000m the live run asked for. This is the
  // measurement the tool never took.
  assert.ok(haversineM(jumeirah1, deira) > 5000, 'Deira must measure as outside a 5km Jumeirah radius');
  assert.ok(haversineM(jumeirah1, alGarhoud) > 5000, 'Al Garhoud must measure as outside a 5km Jumeirah radius');
});

test('DEFECT8: boundingRectangle encloses the circle and is expressed as low/high corners', () => {
  const center = { latitude: 25.2325, longitude: 55.2650 };
  const rect = boundingRectangle(center, 5000);

  assert.ok(rect.low && rect.high, 'locationRestriction.rectangle needs low and high corners');
  assert.ok(rect.low.latitude < center.latitude && rect.high.latitude > center.latitude);
  assert.ok(rect.low.longitude < center.longitude && rect.high.longitude > center.longitude);

  // The rectangle must CONTAIN the circle, never clip it — a clipped rectangle
  // would drop real in-radius leads at the API before the circle check runs.
  const northEdge = haversineM(center, { latitude: rect.high.latitude, longitude: center.longitude });
  const eastEdge = haversineM(center, { latitude: center.latitude, longitude: rect.high.longitude });
  assert.ok(northEdge >= 5000, `north edge must reach the radius, got ${northEdge}`);
  assert.ok(eastEdge >= 5000, `east edge must reach the radius, got ${eastEdge}`);

  // And it must not be absurdly loose either — a rectangle far larger than the
  // circle hands back results the circle check then has to throw away.
  assert.ok(northEdge < 5000 * 1.2, 'the rectangle should be a tight bound, not a wild over-estimate');
});

test('DEFECT8: keepByRadius enforces the circle the rectangle cannot express', () => {
  const center = { latitude: 25.2325, longitude: 55.2650 };
  const at = (latitude, longitude) => ({ id: 'x', location: { latitude, longitude } });

  assert.equal(keepByRadius(at(25.2325, 55.2650), center, 5000), true, 'the centre itself is inside');
  assert.equal(keepByRadius(at(25.2700, 55.3100), center, 5000), false, 'Deira is outside 5000m');
  assert.equal(keepByRadius(at(25.2400, 55.3500), center, 5000), false, 'Al Garhoud is outside 5000m');

  // The corner case that makes the client-side check non-optional: a point
  // inside the bounding RECTANGLE but outside the CIRCLE. Google's rectangle
  // restriction would return this; only the circle check removes it.
  const rect = boundingRectangle(center, 5000);
  const corner = at(rect.high.latitude, rect.high.longitude);
  assert.ok(haversineM(center, corner.location) > 5000, 'the rectangle corner is outside the circle by construction');
  assert.equal(keepByRadius(corner, center, 5000), false,
    'a place in the rectangle corner but outside the circle must still be dropped');
});

// Unlike businessStatus, where absent means "not known to be closed" and the
// place is kept, an absent location is no evidence of being in radius. Keeping
// it would reopen the exact hole this defect is about. It follows --min-reviews,
// which already drops a place with no review count, and the drop is counted and
// named by the caller like every other.
test('DEFECT8: a place with no location cannot be verified in-radius and is dropped, not assumed', () => {
  const center = { latitude: 25.2325, longitude: 55.2650 };
  assert.equal(keepByRadius({ id: 'x' }, center, 5000), false, 'no location field at all');
  assert.equal(keepByRadius({ id: 'x', location: {} }, center, 5000), false, 'location present but empty');
  assert.equal(keepByRadius({ id: 'x', location: { latitude: 25.2, longitude: null } }, center, 5000), false,
    'a half-present location is not a location');
});

test('DEFECT8: districtOf reads the real district out of a live formattedAddress', () => {
  // Every one of these is a verbatim address from the contaminated leads.json.
  assert.equal(districtOf('Jumeirah 1 - Dubai - United Arab Emirates'), 'Jumeirah 1');
  assert.equal(
    districtOf('Aspin Commercial Tower - 2301 - 106 Sheikh Zayed Rd - near Shangri-La Hotel - Trade Center First - Dubai - United Arab Emirates'),
    'Trade Center First',
  );
  assert.equal(districtOf('Al Wasl - Dubai - United Arab Emirates'), 'Al Wasl');
  assert.equal(districtOf(null), null, 'a missing address yields no district, not a crash');
  assert.equal(districtOf('somewhere unparseable'), null);
});

test('DEFECT8: matchesArea accepts the target area and its numbered sub-districts', () => {
  assert.equal(matchesArea('Jumeirah 1 - Dubai - United Arab Emirates', 'Jumeirah'), true);
  assert.equal(matchesArea('Jumeirah 2 - Dubai - United Arab Emirates', 'Jumeirah'), true);
  // "Jumeira Third" is the spelling Google actually returned in the live run —
  // no trailing h, ordinal spelled out. It is the same place and must match.
  assert.equal(matchesArea('Jumeira Third - Dubai - United Arab Emirates', 'Jumeirah'), true);
  assert.equal(matchesArea('Jumeirah - Dubai - United Arab Emirates', 'Jumeirah'), true);
  assert.equal(matchesArea('  jumeirah 1  - dubai ', 'jumeirah'), true, 'case and padding are not a real difference');
});

test('DEFECT8: matchesArea rejects the districts that actually contaminated the run', () => {
  for (const address of [
    'Business Bay - Dubai - United Arab Emirates',
    'Al Karama - Dubai - United Arab Emirates',
    'Deira - Dubai - United Arab Emirates',
    'Al Garhoud - Dubai - United Arab Emirates',
    'Trade Center First - Dubai - United Arab Emirates',
    'Al Wasl - Dubai - United Arab Emirates',
    'Downtown Dubai - Dubai - United Arab Emirates',
  ]) {
    assert.equal(matchesArea(address, 'Jumeirah'), false, `${address} is not Jumeirah`);
  }
});

// A plain substring test for "Jumeirah" would swallow all three of these.
// JLT and JVC are 20km+ from Jumeirah proper, and Jumeirah Garden City is in
// Al Satwa. They share a name, not a location.
test('DEFECT8: matchesArea is not a substring match — JLT, JVC and Garden City are different places', () => {
  assert.equal(matchesArea('Jumeirah Lake Towers - Dubai - United Arab Emirates', 'Jumeirah'), false);
  assert.equal(matchesArea('Jumeirah Village Circle - Dubai - United Arab Emirates', 'Jumeirah'), false);
  assert.equal(matchesArea('Jumeirah Garden City - Dubai - United Arab Emirates', 'Jumeirah'), false);
  assert.equal(matchesArea('Umm Suqeim - Dubai - United Arab Emirates', 'Jumeirah'), false);
});

// No --area means no area filter, exactly as before. The flag is opt-in and
// this defect must not turn it into a silent global filter.
test('DEFECT8: matchesArea with no target area filters nothing', () => {
  assert.equal(matchesArea('Business Bay - Dubai - United Arab Emirates', null), true);
  assert.equal(matchesArea('Business Bay - Dubai - United Arab Emirates', ''), true);
});

test("DEFECT8: toLead records the place's REAL district, never the requested label", () => {
  const place = {
    id: 'ChIJabc',
    displayName: { text: 'Somewhere Else Dental' },
    websiteUri: 'https://example.ae/',
    formattedAddress: 'Business Bay - Dubai - United Arab Emirates',
    location: { latitude: 25.1850, longitude: 55.2630 },
    primaryType: 'dental_clinic',
  };
  const lead = toLead(place, { area: 'Jumeirah', provenance: 'discovered 2026-08-31' });

  // The whole shape of the bug: this used to come back "Jumeirah".
  assert.notEqual(lead.area, 'Jumeirah', 'a Business Bay clinic must never be labelled Jumeirah');
  assert.equal(lead.area, 'Business Bay');
});

test('DEFECT8: toLead carries the measured distance so the radius claim is checkable', () => {
  const center = { latitude: 25.2325, longitude: 55.2650 };
  const lead = toLead({
    id: 'ChIJabc',
    displayName: { text: 'Example Dental Clinic' },
    formattedAddress: 'Jumeirah 1 - Dubai - United Arab Emirates',
    location: { latitude: 25.2340, longitude: 55.2660 },
  }, { area: 'Jumeirah', provenance: 'discovered 2026-08-31', center });

  assert.equal(typeof lead.distanceM, 'number');
  assert.ok(lead.distanceM > 0 && lead.distanceM < 500, `expected a few hundred metres, got ${lead.distanceM}`);
  assert.equal(Number.isInteger(lead.distanceM), true, 'metres, not a long float');
});

// Absent stays absent, the same rule the rest of toLead already follows.
test('DEFECT8: toLead omits distance and area when there is nothing real to put there', () => {
  const lead = toLead(
    { id: 'ChIJxyz', displayName: { text: 'No Data Clinic' } },
    { area: 'Jumeirah', provenance: 'discovered 2026-08-31' },
  );
  assert.equal('distanceM' in lead, false, 'no location means no distance, not distanceM: null');
  assert.equal('area' in lead, false, 'no address means no district, not a blindly stamped label');
});

test('DEFECT8: searchText sends a hard locationRestriction, not a soft locationBias', async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  try {
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ places: places(1) }) };
    };
    await searchText('key', 'dentist', CENTER, RADIUS);

    assert.equal(sent.locationBias, undefined,
      'locationBias is documented as "results around given location MIGHT be returned" — it constrains nothing');
    assert.ok(sent.locationRestriction, 'the request must carry a hard locationRestriction');
    assert.ok(sent.locationRestriction.rectangle,
      'searchText accepts a rectangle only for locationRestriction — a circle here is rejected by the API');
    assert.equal(sent.locationRestriction.circle, undefined);

    const { low, high } = sent.locationRestriction.rectangle;
    assert.equal(typeof low.latitude, 'number');
    assert.equal(typeof high.longitude, 'number');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DEFECT8: searchText asks Google for places.location, without which no distance exists', async () => {
  const originalFetch = globalThis.fetch;
  let mask = null;
  try {
    globalThis.fetch = async (_url, init) => {
      mask = init.headers['X-Goog-FieldMask'];
      return { ok: true, status: 200, json: async () => ({ places: places(1) }) };
    };
    await searchText('key', 'dentist', CENTER, RADIUS);
    assert.match(mask, /places\.location/,
      'the field mask must request coordinates, or the radius can never be verified');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The --area filter reads Google's formattedAddress, so the language that
// address comes back in is load-bearing. The live run returned "Al Karama -
// Dubai" for one place and "الكرامة - Dubai" for another; unpinned, a Jumeirah
// clinic returned as "جميرا" would be dropped as off-area. A lost lead caused
// by a language setting is the same silent deletion this tool refuses
// everywhere else, so the language is pinned rather than left to Google.
test('DEFECT8: searchText pins languageCode so the area filter cannot be defeated by localisation', async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  try {
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ places: places(1) }) };
    };
    await searchText('key', 'dentist', CENTER, RADIUS);
    assert.equal(sent.languageCode, 'en',
      'addresses must come back in one predictable language for districtOf/matchesArea to be reliable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --------------------------------------------------------------- DEFECT 8b
//
// Found by DEFECT 8's own reporting, on the first live run after it shipped.
// The run dropped a clinic whose district Google gives as "جميرا ١" — that is
// Jumeirah 1 — and filed it under "address not in Jumeirah". It was never
// checked: the filter compared Arabic against Latin, got no match, and
// reported the absence of a comparison as a finding. Exactly the failure this
// file guards against everywhere else (UNVERIFIED, the "speed was not
// measured" banner, CATEGORY MISSING) reappearing in a new place.
//
// languageCode: 'en' was the first attempt at a fix and it does not work.
// Measured against the live API, the same place ids come back byte-identical
// with it, without it, and with regionCode: 'AE' added: Google returns the
// language the address is stored in, and for many Dubai clinics that is
// Arabic with no English form available. So the filter has to cope with an
// address it cannot read, rather than assume one it can.

test('DEFECT8b: an Arabic district is unverifiable against a Latin area, not "elsewhere"', () => {
  // The exact live case: Jumeirah 1, written the way Google actually returned it.
  assert.equal(areaVerdict('شارع - جميرا ١ - دبي - United Arab Emirates', 'Jumeirah'), 'unverifiable');
  // And a district that genuinely is elsewhere, also in Arabic, is equally
  // unverifiable — we cannot read it either. Honest, and it still does not
  // reach leads.json.
  assert.equal(areaVerdict('20b Street - الكرامة - دبي - United Arab Emirates', 'Jumeirah'), 'unverifiable');
});

test('DEFECT8b: a comparable-script district that does not match is still a confident "other"', () => {
  // These are Latin, so the comparison actually happened and the answer means
  // something. This must NOT be softened to unverifiable, or the off-area
  // count stops being informative.
  assert.equal(areaVerdict('Business Bay - Dubai - United Arab Emirates', 'Jumeirah'), 'other');
  assert.equal(areaVerdict('Al Karama - Dubai - United Arab Emirates', 'Jumeirah'), 'other');
  assert.equal(areaVerdict('Jumeirah Lake Towers - Dubai - United Arab Emirates', 'Jumeirah'), 'other');
});

test('DEFECT8b: a matching district is still a match, and no --area still filters nothing', () => {
  assert.equal(areaVerdict('Jumeirah 1 - Dubai - United Arab Emirates', 'Jumeirah'), 'match');
  assert.equal(areaVerdict('Jumeira Third - Dubai - United Arab Emirates', 'Jumeirah'), 'match');
  assert.equal(areaVerdict('Business Bay - Dubai - United Arab Emirates', []), 'match');
  assert.equal(areaVerdict('Business Bay - Dubai - United Arab Emirates', null), 'match');
});

// The recovery path the run output points the user at. Without this, naming
// the unverifiable districts would be a dead end.
test('DEFECT8b: --area is repeatable, so the Arabic spelling can be named and recovered', () => {
  const addr = 'شارع - جميرا ١ - دبي - United Arab Emirates';
  assert.equal(areaVerdict(addr, ['Jumeirah']), 'unverifiable', 'unrecoverable with the Latin spelling alone');
  assert.equal(areaVerdict(addr, ['Jumeirah', 'جميرا']), 'match', 'naming the Arabic spelling recovers the lead');
  // And adding the alias must not start letting Karama through.
  assert.equal(areaVerdict('20b Street - الكرامة - دبي - UAE', ['Jumeirah', 'جميرا']), 'other',
    'now comparable in Arabic, and genuinely a different district');
});

test('DEFECT8b: parseArgs collects repeated --area', () => {
  const a = parseArgs(['--area', 'Jumeirah', '--area', 'جميرا']);
  assert.deepEqual(a.area, ['Jumeirah', 'جميرا']);
  assert.deepEqual(parseArgs([]).area, [], 'no --area is an empty list, not null');
});

// districtOf now prefers Google's structured components over dash-counting.
// sublocality_level_1 is the district; formattedAddress is a string whose
// shape varies with how much detail the owner typed.
test('DEFECT8b: districtOf prefers structured addressComponents over parsing the string', () => {
  const place = {
    // Deliberately a string that would parse to the WRONG district, to prove
    // the components win rather than merely agreeing.
    formattedAddress: 'Suite 12 - Some Tower - Wrong Guess - Dubai - United Arab Emirates',
    addressComponents: [
      { longText: 'Jumeirah 1', shortText: 'Jumeirah 1', types: ['sublocality_level_1', 'sublocality', 'political'] },
      { longText: 'Dubai', shortText: 'Dubai', types: ['locality', 'political'] },
    ],
  };
  assert.equal(districtOf(place), 'Jumeirah 1');
  assert.equal(areaVerdict(place, 'Jumeirah'), 'match');
});

test('DEFECT8b: districtOf falls back to the address string when components are absent', () => {
  assert.equal(districtOf({ formattedAddress: 'Al Wasl - Dubai - United Arab Emirates' }), 'Al Wasl');
  assert.equal(districtOf({ addressComponents: [] , formattedAddress: 'Deira - Dubai - UAE' }), 'Deira');
  assert.equal(districtOf({}), null, 'a place with neither is null, not a crash');
  // The plain-string form the rest of the suite uses must keep working.
  assert.equal(districtOf('Jumeirah 2 - Dubai - United Arab Emirates'), 'Jumeirah 2');
});

// The Arabic components Google actually returns are tagged languageCode: 'ar'.
test('DEFECT8b: an Arabic structured district is read, then judged unverifiable', () => {
  const place = {
    formattedAddress: 'Office 101 - الكرامة - دبي - United Arab Emirates',
    addressComponents: [
      { longText: 'الكرامة', shortText: 'الكرامة', types: ['sublocality_level_1', 'sublocality', 'political'], languageCode: 'ar' },
      { longText: 'دبي', shortText: 'دبي', types: ['locality', 'political'], languageCode: 'ar' },
    ],
  };
  assert.equal(districtOf(place), 'الكرامة', 'the district is read even though it cannot be compared');
  assert.equal(areaVerdict(place, 'Jumeirah'), 'unverifiable');
});

test('DEFECT8b: searchText requests addressComponents', async () => {
  const originalFetch = globalThis.fetch;
  let mask = null;
  try {
    globalThis.fetch = async (_url, init) => {
      mask = init.headers['X-Goog-FieldMask'];
      return { ok: true, status: 200, json: async () => ({ places: places(1) }) };
    };
    await searchText('key', 'dentist', CENTER, RADIUS);
    assert.match(mask, /places\.addressComponents/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --------------------------------------------------------------- --category
//
// The dental set above was derived from 60 sampled live results. A second
// vertical must not inherit it silently, and must not be guessed at either —
// hence `any`, the exploratory mode that flags nothing so a run can report the
// real primaryType distribution before anyone writes a set from it.

test('classifyCategory defaults to dental, so every existing call is unchanged', () => {
  const skin = { primaryType: 'skin_care_clinic', types: ['skin_care_clinic'] };
  assert.equal(classifyCategory(skin).offCategory, true);
  assert.deepEqual(classifyCategory(skin), classifyCategory(skin, 'dental'));
});

// `any` is not "flag everything" or "flag nothing dental" — it is the absence
// of a category claim. A run that cannot say what a place should be must not
// print a verdict about what it is not.
test('classifyCategory: category "any" flags nothing, including untyped places', () => {
  for (const place of [
    { primaryType: 'skin_care_clinic', types: ['skin_care_clinic'] },
    { primaryType: 'spa', types: ['spa'] },
    {},
  ]) {
    const c = classifyCategory(place, 'any');
    assert.equal(c.offCategory, false, JSON.stringify(place));
    assert.equal(c.reason, null);
  }
});

// An unknown category must throw rather than quietly behaving like dental:
// silently auditing the wrong vertical is worse than failing.
test('classifyCategory throws on an unknown category', () => {
  assert.throws(() => classifyCategory({ primaryType: 'spa' }, 'aesthetics'), /unknown category/);
});

test('parseArgs defaults category to dental and accepts a known one', () => {
  assert.equal(parseArgs([]).category, 'dental');
  assert.equal(parseArgs(['--category', 'any']).category, 'any');
  assert.equal(parseArgs(['--category=any']).category, 'any');
});

// Validated at parse time, not first use: a typo must fail before the run has
// spent money on Places calls, not after every one of them.
test('parseArgs rejects an unknown category before any request is made', () => {
  assert.throws(() => parseArgs(['--category', 'dentl']), /unknown category "dentl"/);
});

test('toLead threads the category through to the note', () => {
  const skin = { displayName: { text: 'Skin Co' }, primaryType: 'skin_care_clinic', types: ['skin_care_clinic'] };
  const flagged = toLead(skin, { provenance: 'p', category: 'dental' });
  assert.match(flagged.note, /NOT TYPED AS DENTAL/);
  const unflagged = toLead(skin, { provenance: 'p', category: 'any' });
  assert.doesNotMatch(unflagged.note, /NOT TYPED AS/);
});
