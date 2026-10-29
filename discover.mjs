#!/usr/bin/env node
// Lead discovery — turns a place into leads.json, so the audit has something
// to run against without anyone typing domains by hand. Built for dental
// outreach specifically, not a general-purpose category search: --query only
// shapes the phrase Google matches on relevance (below); it does not choose
// what counts as on-category. That is fixed to dental_clinic/dentist further
// down and flagged, never dropped, whenever Google's own typing disagrees —
// see HELP and DENTAL_TYPES below.
//
//   "dentists within 5km of Jumeirah"  ->  leads.json  ->  audit.mjs
//
// It also finds a lead type the audit structurally cannot see: a clinic with
// no website at all. The audit starts from a domain, so a clinic that never
// had one cannot enter it. Those are the strongest leads on the list and they
// are currently invisible.
//
// Zero dependencies on purpose, matching audit.mjs: Node builtins plus global
// fetch. Pure helpers are exported and tested; the entry point below only runs
// when this file is executed directly, so importing it fires no requests.
//
//   PLACES_KEY=... node discover.mjs \
//     --query "dental clinic" --near "25.2388,55.2711" --radius 5000 --area "Jumeirah"

import dns from 'node:dns';
import { readFile, writeFile, stat } from 'node:fs/promises';

// Node's fetch uses Happy Eyeballs and prefers IPv6 wherever a route exists.
// With an IP-restricted PLACES_KEY that means the call leaves over IPv6 and
// Google rejects it with API_KEY_IP_ADDRESS_BLOCKED even though the IPv4
// address is allowlisted — and `curl -6` can report no IPv6 route at all, so
// the machine looks IPv4-only right up until Node disagrees.
//
// Forcing IPv4 is the durable fix rather than allowlisting the IPv6 address:
// residential IPv6 rotates under SLAAC privacy extensions and the delegated
// prefix can change too, so an allowlist entry would break within days and
// fail with a 403 that looks nothing like its cause.
//
// Deliberately scoped to this file. audit.mjs must NOT inherit it — that
// script's job is measuring how domains resolve for real visitors, and
// quietly narrowing its resolver would change the measurements it exists to take.
dns.setDefaultResultOrder('ipv4first');

// Google's searchText caps at 60 results across three pages — verified against
// the live API, where page 3 arrives without a nextPageToken. A query that
// returns exactly this many was truncated by Google, and the area behind it is
// NOT fully enumerated.
export const PAGE_CAP = 60;

export function isSaturated(resultCount) {
  return resultCount >= PAGE_CAP;
}

// Somebody else's platform is not a website the clinic controls. Left
// unhandled the audit fetches facebook.com, finds a mobile viewport, a
// WhatsApp link and structured data, and reports the clinic HEALTHY — the
// worst answer available, because it measures Facebook's engineering instead
// of the clinic's and discards the strongest lead type there is.
//
// Matched exactly, unlike the business.site check below. A subdomain like
// clinic.facebook.com would not match, but these platforms do not issue
// per-business subdomains, so that costs nothing — while suffix matching
// here would risk false positives against real clinics whose own domain
// merely ends in one of these strings.
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'instagram.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com',
  'linktr.ee', 'linkin.bio', 'beacons.ai', 'bio.link',
  'wa.me', 'api.whatsapp.com', 't.me',
  'sites.google.com', 'g.page', 'goo.gl',
]);

export function normalizeHost(websiteUri) {
  if (typeof websiteUri !== 'string' || !websiteUri.trim()) return null;
  let u;
  try {
    u = new URL(websiteUri.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // .hostname rather than .host drops the port; the WHATWG parser has already
  // dropped the path and query, which is what makes Google's utm_ parameters
  // disappear rather than ending up inside the domain.
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return host || null;
}

// Three routes to domain: null, all one commercial lead type — a clinic with
// no web presence it controls. The audit treats them identically; `reason` is
// what preserves which one it actually was, so the evidence survives into the
// email.
export function classifyWebsite(websiteUri) {
  if (!websiteUri) {
    return { domain: null, reason: 'NO WEBSITE LISTED — highest-value lead type' };
  }
  const host = normalizeHost(websiteUri);
  if (!host) {
    return { domain: null, reason: `NO USABLE WEBSITE — Google lists "${websiteUri}", which is not a usable web address` };
  }
  // Google Business Profile websites were discontinued in March 2024 and now
  // redirect to the GBP listing, so this clinic's site is dead as of today.
  if (host === 'business.site' || host.endsWith('.business.site')) {
    return { domain: null, reason: `DEAD GOOGLE SITE — business.site shut down in March 2024, so ${host} now redirects to their Google listing` };
  }
  if (SOCIAL_HOSTS.has(host)) {
    return { domain: null, reason: `NO SITE OF THEIR OWN — Google lists ${websiteUri} as their website` };
  }
  return { domain: host, reason: null };
}

// searchText matches on relevance, not category. A live Jumeirah run's
// top-ranked result by review count — 2,823 reviews, no website — was
// `Example Aesthetics DXB`, whose Google types are skin_care_clinic / medical_clinic /
// health. A real clinic, but an aesthetics one, not dental, and nothing in
// the output said so.
//
// Flag only, never a reason to drop: a genuinely dental clinic Google has
// typed oddly must still reach the list — silently deleting it is the exact
// failure this tool exists to avoid. The flag exists so a human looks.
//
// Sampled over 60 live results, primaryType split 45 dental_clinic /
// 7 dentist / 6 medical_center / 1 doctor / 1 medical_clinic. Two things
// follow from that split: dental_clinic dominates, so a check written
// against `dentist` alone would flag almost every real clinic; and
// primaryType alone is insufficient — Saray polyclinic's primaryType is
// `doctor`, but `dental_clinic` sits in its types array, so a check that
// only consulted primaryType would flag a real clinic for no reason. Both
// fields are consulted below.
// Keyed by --category. `dental` is the original set and stays the default, so
// every existing invocation behaves exactly as it did.
//
// `any` flags nothing. It exists because the dental set above was derived from
// a sample of 60 live results, and any new vertical deserves the same
// treatment: run once with `any`, read the primaryType distribution the run
// prints, then write a set that reflects what Google actually returns rather
// than what seemed reasonable in advance. Guessing the set is how you either
// flag every real lead or quietly wave through a market you did not want.
export const CATEGORIES = {
  dental: { label: 'DENTAL', types: new Set(['dental_clinic', 'dentist']) },
  any: { label: 'ANY', types: null },
};

export function classifyCategory(place, category = 'dental') {
  const spec = CATEGORIES[category];
  if (!spec) throw new Error(`unknown category "${category}"`);
  // `any` is the exploratory mode: no set to compare against, so nothing is
  // off-category and no lead carries a flag it cannot have earned.
  if (!spec.types) return { offCategory: false, reason: null };

  const primaryType = place?.primaryType || null;
  const types = Array.isArray(place?.types) ? place.types : [];
  const onCategory = (primaryType && spec.types.has(primaryType)) || types.some((t) => spec.types.has(t));
  if (onCategory) return { offCategory: false, reason: null };

  // No category data at all is its own case, distinct from "typed as
  // something else": it cannot be confirmed dental, so it is still flagged,
  // but the reason must say the category is missing rather than implying
  // Google actively typed it as some other thing.
  if (!primaryType && !types.length) {
    return {
      offCategory: true,
      reason: `CATEGORY MISSING — Google lists no type data for this place, so it cannot be confirmed ${category}`,
    };
  }

  // Names the ACTUAL category Google gave (e.g. skin_care_clinic for Example Aesthetics
  // DXB) so the note says what the place IS, not only what it is not.
  const named = primaryType || types[0];
  const wanted = [...spec.types].join(' or ');
  return {
    offCategory: true,
    reason: `NOT TYPED AS ${spec.label} — Google's own category for this place is "${named}", not ${wanted}`,
  };
}

// `center` is optional and only adds distanceM; the requested --area is
// deliberately NOT a parameter here. It used to be, and was written onto every
// lead unconditionally — which is how a run whose leads were 89% not in
// Jumeirah still reported every one of them as "Jumeirah", and why the two
// geographic defects above stayed invisible for so long. The district is read
// from the address Google actually returned, or it is absent.
export function toLead(place, { provenance, center, category = 'dental' } = {}) {
  const { domain, reason: domainReason } = classifyWebsite(place.websiteUri);
  const { reason: categoryReason } = classifyCategory(place, category);
  // displayName is an object, { text, languageCode }, not a string.
  const lead = { name: place.displayName?.text || '(unnamed)', domain };

  // Absent stays absent. A null rating reads as "unrated but known" and would
  // defeat the ranking's missing-demand fallback in audit.mjs.
  const district = districtOf(place.formattedAddress);
  if (district) lead.area = district;
  if (place.nationalPhoneNumber) lead.phone = place.nationalPhoneNumber;
  if (typeof place.rating === 'number') lead.rating = place.rating;
  if (typeof place.userRatingCount === 'number') lead.reviews = place.userRatingCount;
  if (place.formattedAddress) lead.address = place.formattedAddress;
  if (place.id) lead.placeId = place.id;
  if (place.primaryType) lead.primaryType = place.primaryType;
  // Written so the radius claim in `note` is checkable against the lead itself
  // rather than taken on trust.
  if (center && typeof place.location?.latitude === 'number' && typeof place.location?.longitude === 'number') {
    lead.distanceM = Math.round(haversineM(center, place.location));
  }

  // The run date always survives: a lead list goes stale within weeks, since
  // clinics fix sites, close and rebrand, and the file has to say how old it is.
  //
  // A lead can be off-category AND website-less at once — both are real,
  // independent findings about the same place, so both reasons go in; neither
  // may overwrite the other.
  const reasons = [domainReason, categoryReason].filter(Boolean);
  lead.note = reasons.length ? `${reasons.join(' · ')} · ${provenance}` : provenance;
  return lead;
}

const CLOSED = new Set(['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY']);

export function keepByStatus(place) {
  // An absent status is kept. Unknown is not closed, and dropping on a missing
  // field silently deletes leads Google simply had no data for.
  return !CLOSED.has(place.businessStatus);
}

export function keepByReviews(place, minReviews) {
  if (!minReviews) return true;
  const n = typeof place.userRatingCount === 'number' ? place.userRatingCount : 0;
  return n >= minReviews;
}

// --------------------------------------------------------------- geography
//
// A live "within 5000m of Jumeirah" run returned clinics in Deira and Al
// Garhoud, both roughly 9km out, because the only geographic input Google got
// was `locationBias` — which Google documents as a bias: "results around given
// location MIGHT be returned." It ranks, it does not filter.
//
// The hard filter is `locationRestriction`, and for searchText it accepts a
// RECTANGLE only, never a circle. So the rectangle cannot express a radius on
// its own: its corners reach radius*sqrt(2), and everything in those corners
// comes back. Two layers are therefore required, and neither is redundant —
// the rectangle stops Google returning distant results at all (and stops them
// consuming the 60-result cap), and the circle check below removes what the
// rectangle's corners let through.

// IUGG mean Earth radius. Both helpers below derive from this same constant on
// purpose: sizing the rectangle off a different metres-per-degree figure than
// the distance check uses makes the box very slightly smaller than the circle
// it is supposed to contain, silently clipping real in-radius leads.
const EARTH_RADIUS_M = 6371008.8;
const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

export function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // Math.min guards asin's domain against floating-point overshoot past 1.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The smallest lat/lng box that fully contains the circle, in the low/high
// corner shape locationRestriction.rectangle expects.
export function boundingRectangle(center, radius) {
  // 0.1% margin so the box provably CONTAINS the circle rather than being
  // mathematically tangent to it, where floating-point rounding could put a
  // point exactly on the radius fractionally outside and drop a real lead.
  const reach = radius * 1.001;
  const dLat = reach / M_PER_DEG_LAT;
  // Longitude degrees shrink toward the poles. Clamped away from zero so a
  // near-polar centre cannot divide by ~0 and produce Infinity.
  const cosLat = Math.max(Math.cos((center.latitude * Math.PI) / 180), 1e-6);
  const dLng = reach / (M_PER_DEG_LAT * cosLat);
  const clampLat = (v) => Math.max(-90, Math.min(90, v));
  return {
    low: { latitude: clampLat(center.latitude - dLat), longitude: center.longitude - dLng },
    high: { latitude: clampLat(center.latitude + dLat), longitude: center.longitude + dLng },
  };
}

// Unlike keepByStatus, where an absent status genuinely means "not known to be
// closed", an absent location is no evidence of being in radius — keeping it
// would reopen the exact hole this filter closes. This follows --min-reviews,
// which already drops a place with no review count. main() counts and names
// the two cases separately so "we could not check" never reads as "we checked
// and it was too far".
export function keepByRadius(place, center, radius) {
  const loc = place?.location;
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return false;
  return haversineM(center, loc) <= radius;
}

// Accepts a place or a formattedAddress string.
//
// Given a place, the structured addressComponents win: Google tags the district
// as sublocality_level_1 explicitly, which beats counting dashes in a string
// whose shape varies with how much detail the owner typed. Given a string — or
// a place with no components — it falls back to position.
//
// Google formats an address as "<street bits> - <district> - <city> - <country>",
// so the district is third from the end. A short "<district> - <city>" form
// also occurs, hence the fallback; anything with no separator at all has no
// district to read and must say so rather than guessing.
const DISTRICT_TYPES = ['sublocality_level_1', 'sublocality', 'neighborhood'];

export function districtOf(source) {
  if (source && typeof source === 'object') {
    const comps = Array.isArray(source.addressComponents) ? source.addressComponents : [];
    for (const type of DISTRICT_TYPES) {
      const hit = comps.find((c) => Array.isArray(c.types) && c.types.includes(type) && c.longText);
      if (hit) return hit.longText;
    }
    return districtOf(source.formattedAddress);
  }
  if (typeof source !== 'string') return null;
  const parts = source.split(' - ').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length >= 3 ? parts.length - 3 : 0];
}

// Transliteration, not a typo: the live run returned both "Jumeirah 1" and
// "Jumeira Third" for the same district. Stripping one trailing h from each
// token makes those compare equal without loosening the match generally.
const stem = (token) => (token.endsWith('h') ? token.slice(0, -1) : token);
const tokens = (s) => s.toLowerCase().split(/\s+/).filter(Boolean).map(stem);

// A sub-district qualifier: "Jumeirah 1", "Jumeira Third". Anything longer is
// a DIFFERENT place that merely shares a name.
const QUALIFIERS = new Set(['first', 'second', 'third', 'fourth', 'fifth']);
// \p{Nd}, not \d: Google returns "جميرا ١" for Jumeirah 1, and ١ is
// ARABIC-INDIC DIGIT ONE. JS \d is ASCII-only, so the plain version read that
// as a word and rejected the district — which would have made the --area
// alias below useless for exactly the case it exists to recover.
const isQualifier = (t) => /^\p{Nd}+$/u.test(t) || QUALIFIERS.has(t);

// Two strings are comparable only if they are written in the same script. A
// Latin "Jumeirah" and an Arabic "جميرا" are the same district and share not
// one character, so a mismatch between them is not evidence of anything.
const hasLatin = (s) => /[a-z]/i.test(s);

// Deliberately not a substring test. "Jumeirah" appears in Jumeirah Lake
// Towers and Jumeirah Village Circle, both 20km+ from Jumeirah proper, and in
// Jumeirah Garden City, which is in Al Satwa. They share a name, not a
// location, and a substring match would pull all three in.
function matchesOne(district, area) {
  const want = tokens(area);
  const have = tokens(district);
  if (!want.length || have.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (have[i] !== want[i]) return false;
  }
  const rest = have.slice(want.length);
  return rest.length === 0 || (rest.length === 1 && isQualifier(rest[0]));
}

// Three outcomes, not two, and the third is the whole point.
//
// A live run dropped a clinic whose district Google gives as "جميرا ١" —
// Jumeirah 1 — as "not in Jumeirah". It was never checked: the filter compared
// Arabic against Latin, got no match, and reported that as a finding. This is
// the tool's oldest rule (an absence must never read as a finding) reappearing
// in a new place.
//
// 'unverifiable' still does not reach leads.json, because a list of Jumeirah
// prospects must not quietly fill with Karama, but main() counts and names it
// separately so a real Jumeirah clinic shows up as something to look at rather
// than vanishing into an off-area tally.
export function areaVerdict(source, areas) {
  const wanted = (Array.isArray(areas) ? areas : [areas]).filter(Boolean);
  if (!wanted.length) return 'match'; // --area is opt-in; without it nothing is filtered.

  const district = districtOf(source);
  if (!district) return 'unverifiable'; // No district to read is not "elsewhere".
  if (wanted.some((a) => matchesOne(district, a))) return 'match';

  // Comparable scripts and still no match: this genuinely is another district.
  // Otherwise the comparison could not be made at all.
  const comparable = wanted.some((a) => hasLatin(a) === hasLatin(district));
  return comparable ? 'other' : 'unverifiable';
}

export function matchesArea(source, areas) {
  return areaVerdict(source, areas) === 'match';
}

export function dedupe(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function parseNear(s) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function parseArgs(argv) {
  const out = {
    query: [], near: null, radius: 5000, area: [],
    minReviews: 0, out: 'leads.json', force: false, help: false,
    category: 'dental',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null;
    }
    switch (key) {
      case 'query': if (val) out.query.push(val); break;
      case 'near': out.near = val; break;
      case 'radius': out.radius = Number(val); break;
      // Repeatable like --query, so the same district written another way —
      // "جميرا" for Jumeirah — can be named rather than silently missed.
      case 'area': if (val) out.area.push(val); break;
      case 'min-reviews': out.minReviews = Number(val); break;
      // Validated here rather than at first use, so a typo fails before any
      // billable Places call rather than after every one of them.
      case 'category':
        if (!CATEGORIES[val]) throw new Error(`unknown category "${val}" — expected one of: ${Object.keys(CATEGORIES).join(', ')}`);
        out.category = val;
        break;
      case 'out': out.out = val; break;
      case 'force': out.force = true; break;
      case 'help': case 'h': out.help = true; break;
      default: throw new Error(`unknown flag --${key}`);
    }
  }
  return out;
}

// Both of these were hit for real while designing this tool, and neither is
// diagnosable from a bare "403".
export function explainError(status, body) {
  const err = body?.error;
  const detail = (err?.details || []).find((d) => d.reason);
  const meta = detail?.metadata || {};
  if (detail?.reason === 'SERVICE_DISABLED') {
    return 'Places API (New) is not enabled on this Google Cloud project.\n'
      + `Enable it here, wait a minute, then re-run:\n  ${meta.activationUrl || 'https://console.cloud.google.com/apis/library/places.googleapis.com'}\n`
      + 'Note it must be "Places API (New)" (places.googleapis.com), not the legacy "Places API".';
  }
  if (detail?.reason === 'API_KEY_IP_ADDRESS_BLOCKED') {
    return `PLACES_KEY is IP-restricted, and this call came from ${meta.callerIp || 'an address Google did not name'}, which is not on its allowlist.\n`
      + 'Add that address under Cloud Console -> Credentials -> your key -> Application restrictions,\n'
      + 'or check whether the request left over IPv6 while the allowlist holds an IPv4 address.';
  }
  if (status === 400) {
    return `Places rejected the request (400): ${err?.message || 'no message'}\n`
      + 'This usually means the X-Goog-FieldMask names a field that does not exist.';
  }
  return `Places HTTP ${status}: ${err?.message || 'no message'}`;
}

// ------------------------------------------------------------------- runtime

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Billing, not bandwidth: rating, userRatingCount, websiteUri and
// nationalPhoneNumber put every call in the Enterprise SKU rather than the
// cheaper Pro or Essentials tiers. At 10,000 free calls per SKU per month and
// a few hundred calls for all of Dubai dental this is comfortably free — but
// anyone adding a field here should know what it costs.
//
// primaryType and types, added for the off-category flag, both sit in the
// cheaper Pro tier — a call already paying for the Enterprise fields above
// does not move to a costlier tier by adding them, so this run's cost is
// unchanged.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.formattedAddress',
  // Structured, typed district data. formattedAddress alone is a string whose
  // shape varies with how much detail the owner typed, and dash-counting it is
  // guesswork next to Google's own sublocality_level_1. Same Essentials tier as
  // formattedAddress, so it adds nothing to this call's cost.
  'places.addressComponents',
  'places.primaryType',
  'places.types',
  // Without coordinates the radius cannot be verified even in principle, which
  // is half of why a 5000m run shipped 9km leads. places.location sits in the
  // Essentials tier, below the Enterprise fields above, so a call already
  // paying for those does not get more expensive by asking for it.
  'places.location',
  'nextPageToken',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exported so validateOpts's guard messages can be tested against it
// directly, rather than a test having to duplicate this text to check it was
// actually appended.
export const HELP = `discover.mjs — Places API in, leads.json out.

  PLACES_KEY=... node discover.mjs \\
    --query "dental clinic" --query "dentist" \\
    --near "25.2388,55.2711" --radius 5000 --area "Jumeirah"

Every result is checked against the category set named by --category, and
anything else is flagged — never dropped — in that lead's note, whatever
--query wording found it. --query is not a category selector: it is the phrase
Google searches, while --category is what counts as on-category afterwards.
Searching a new vertical means adding a set to CATEGORIES, which --category any
exists to help you write from real data rather than from guesswork.

  --query        Search phrase, e.g. "dental clinic" or "dentist". REPEATABLE;
                 each runs as its own search. Wording only — it does not
                 change what counts as on-category.
  --near         "lat,lng" centre point. Required. This is the centre of the
                 area you want, NOT the city centre. "25.2048,55.2708" is the
                 generic Dubai centroid and sits 3.8km south of Jumeirah 1 —
                 a 5km circle drawn there covers more of Business Bay and
                 Trade Centre than of Jumeirah, which is how an earlier run
                 came back with more Business Bay clinics than Jumeirah ones.
  --category     What counts as on-category. Default "dental"
                 (dental_clinic/dentist). "any" flags nothing — use it for a
                 first pass at an unfamiliar vertical, read the primaryType
                 distribution the run prints, and write the set from that.
                 An unknown value fails before any billable Places call.
  --radius       Metres, max 50000. Default 5000. Enforced exactly: a place
                 measured beyond it is dropped, not merely ranked lower.
  --area         District filter, e.g. "Jumeirah". REPEATABLE; a place matching
                 ANY of them is kept. A place whose address is in another
                 district is DROPPED and counted, since --radius is a circle and
                 a circle is not a district. Matches the area and its numbered
                 sub-districts ("Jumeirah 1", "Jumeira Third") but not places
                 that merely share the name ("Jumeirah Lake Towers"). Omit it to
                 filter on --radius alone. Each lead's area field is the
                 district Google actually returned, never this value.

                 Repeatable because Google returns the district in whatever
                 language it is stored in, and languageCode does not change
                 that: many Dubai clinics come back as "الكرامة", not
                 "Al Karama". A district written in a script your --area terms
                 cannot be compared against is reported as COULD NOT VERIFY,
                 never as off-area, and the run prints those spellings so you
                 can add one — --area "Jumeirah" --area "جميرا" — and recover
                 any real lead hiding among them.
  --min-reviews  Skip places below a review count. Off unless passed.
                 A place with no review count at all counts as 0 and is dropped.
  --out          Defaults to leads.json.
  --force        Permit overwriting an existing --out.

Google caps each query at ${PAGE_CAP} results, so a saturated query means the
area is not fully enumerated. Narrow --radius or add more --query terms.`;

// Every guard a run must clear before the first Places request goes out,
// bundled into one function rather than left as separate `if` blocks in
// main() — partly so a unit test can drive every branch without PLACES_KEY
// or a network call, and partly so the same HELP text can't drift out of
// sync between branches the way it had: PLACES_KEY and --radius used to
// print a bare message while --query and --near appended the usage block,
// leaving whoever hit either of the first two without the one thing that
// would have shown them the fix. All four now end the same way.
//
// --out joins the other three here rather than staying an unchecked field:
// parseArgs can hand back `out: null` (or `''`, from a bare `--out=`) when
// --out has no usable value, and that used to surface only at the
// writeFile call at the very end of a run — after every --query had already
// been sent to Places and billed. Checking it "with the other arguments,
// before any request" is what the fix requires, so it lives in this same
// pre-flight pass rather than a separate one.
export function validateOpts(opts, hasKey) {
  if (!hasKey) {
    return { ok: false, message: `PLACES_KEY is not set.\n\nGoogle Cloud Console -> APIs & Services -> enable "Places API (New)",\nthen Credentials -> Create credentials -> API key. See the README.\n\n${HELP}` };
  }
  if (!opts.query.length) {
    return { ok: false, message: `--query is required.\n\n${HELP}` };
  }
  if (!parseNear(opts.near)) {
    return { ok: false, message: `--near must be "lat,lng", e.g. "25.2048,55.2708".\n\n${HELP}` };
  }
  if (!Number.isFinite(opts.radius) || opts.radius <= 0 || opts.radius > 50_000) {
    return { ok: false, message: `--radius must be between 1 and 50000 metres.\n\n${HELP}` };
  }
  if (!opts.out || typeof opts.out !== 'string') {
    return { ok: false, message: `--out needs a filename, e.g. --out leads.json.\n\n${HELP}` };
  }
  return { ok: true };
}

// One query, up to three pages. A failure part-way through keeps the pages
// already collected and names the query that was cut short: losing two good
// pages because the third failed is worse than an incomplete run that says so.
//
// Exported for its own tests, matching this file's existing export pattern:
// it uses only global `fetch`, so a test can stub that in directly, no
// library and no network required.
export async function searchText(key, textQuery, center, radius) {
  const collected = [];
  let token = null;
  let truncated = null;
  let fatal = null;

  for (let page = 1; page <= 3; page++) {
    // locationRestriction, not locationBias: a bias means "results around given
    // location MIGHT be returned" and constrained nothing. Rectangle because
    // searchText's locationRestriction accepts no circle — see
    // boundingRectangle above, and keepByRadius for the circle it cannot express.
    // languageCode is sent, but do NOT rely on it to normalise addresses. It
    // was added here on the theory that it would stop Google returning mixed
    // "Al Karama" / "الكرامة" districts; measured against the live API it
    // changes nothing — the same place ids come back byte-identical with it,
    // without it, and with regionCode: 'AE' added. Google is returning the
    // language the address is actually stored in, and for a good number of
    // Dubai clinics that is Arabic with no English equivalent available.
    //
    // It stays because it is correct for the fields it DOES affect, but the
    // --area filter cannot assume an English address. areaVerdict below
    // handles a district it cannot compare as unverifiable rather than
    // off-area, which is what stops a Jumeirah clinic listed as "جميرا ١"
    // being deleted as though we had checked it and found it elsewhere.
    const body = {
      textQuery,
      maxResultCount: 20,
      languageCode: 'en',
      locationRestriction: { rectangle: boundingRectangle(center, radius) },
    };
    if (token) body.pageToken = token;

    let res;
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': FIELD_MASK,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        data = await res.json();
      } catch (e) {
        truncated = `page ${page} request failed — ${e.message || e}`;
        break;
      }
      if (res.status !== 429) break;
      await sleep(4000);
    }

    if (truncated) break;

    if (!res.ok) {
      const explained = explainError(res.status, data);
      // A key or project problem will fail identically on every remaining
      // query, so there is nothing to be gained by grinding through them.
      // This used to call process.exit(1) right here — but that runs inside
      // main()'s per-query loop, so a 403 on the SECOND --query threw away
      // every lead the FIRST one had already collected. Signalling `fatal`
      // back to the caller instead lets main() stop issuing further queries
      // while still deduping, filtering and writing whatever is in hand.
      if (res.status === 401 || res.status === 403) {
        fatal = explained;
        break;
      }
      truncated = `page ${page} — ${explained.split('\n')[0]}`;
      break;
    }

    collected.push(...(data.places || []));
    token = data.nextPageToken || null;
    // A tokenless page 3 is the normal end of the run, not a failure.
    if (!token) break;
    await sleep(2000);
  }

  return { places: collected, truncated, saturated: isSaturated(collected.length), fatal };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(1);
  }

  if (opts.help) { console.log(HELP); return; }

  const key = process.env.PLACES_KEY;
  const guard = validateOpts(opts, Boolean(key));
  if (!guard.ok) { console.error(guard.message); process.exit(1); }

  const center = parseNear(opts.near);

  // Before any API call. Overwriting is the only irreversible thing this tool
  // does, the file is gitignored so there is no recovering it, and a
  // hand-curated prospect list is expensive to rebuild.
  if (!opts.force && await stat(opts.out).then(() => true, () => false)) {
    let held = '';
    try {
      const existing = JSON.parse(await readFile(opts.out, 'utf8'));
      if (Array.isArray(existing)) held = ` and holds ${existing.length} lead(s)`;
    } catch { held = ' (unreadable as JSON)'; }
    console.error(`${opts.out} already exists${held}. Pass --force to replace it.`);
    process.exit(1);
  }

  const runDate = new Date().toISOString().slice(0, 10);
  console.log(`discovering: ${opts.query.map((q) => `"${q}"`).join(', ')} within ${opts.radius}m of ${opts.near}\n`);

  const all = [];
  const saturatedQueries = [];
  const truncatedQueries = [];
  // Set the moment a 401/403 comes back from searchText. main() then stops
  // issuing further --query terms — but everything already pushed onto
  // `all`, from this query and every one before it, is real and stays.
  let fatalError = null;
  let fatalQuery = null;

  for (const q of opts.query) {
    const { places, truncated, saturated, fatal } = await searchText(key, q, center, opts.radius);
    all.push(...places.map((p) => ({ place: p, query: q })));
    if (saturated) saturatedQueries.push(q);
    if (truncated) truncatedQueries.push(`"${q}": ${truncated}`);
    console.log(`  "${q}"  ${String(places.length).padStart(3)} results${saturated ? '  [SATURATED]' : ''}${truncated ? `  [CUT SHORT: ${truncated}]` : ''}${fatal ? '  [FATAL]' : ''}`);
    if (fatal) {
      fatalError = fatal;
      fatalQuery = q;
      console.error(`\n${fatal}\n`);
      break;
    }
  }

  const unique = dedupe(all.map((r) => r.place));
  // new Map(all.map(...)) keeps the LAST entry for a repeated key, but
  // dedupe() above keeps the FIRST occurrence of a place id — so building
  // this the same way disagreed with dedupe: a clinic found by two --query
  // terms got a queryOf pointing at whichever query happened to run last,
  // and its note could cite a search it was not actually first found by.
  // Only set a place's query the first time its id is seen, to agree with
  // dedupe.
  const queryOf = new Map();
  for (const r of all) {
    if (!queryOf.has(r.place.id)) queryOf.set(r.place.id, r.query);
  }

  let closed = 0;
  let thin = 0;
  let unlocated = 0;
  let outside = 0;
  let offArea = 0;
  let unverifiedArea = 0;
  // Counting an --area drop is not enough to catch a WRONG one. If the matcher
  // ever misreads a district — a spelling Google returns in another language,
  // a sub-district shape not anticipated — the only visible symptom is a
  // number going up. Recording which districts were rejected turns that into
  // something a human can spot at a glance. Kept in two separate maps because
  // "this is Karama" and "this is written in a script we cannot compare" are
  // different facts and only the second one needs a human.
  const offAreaDistricts = new Map();
  const unverifiedDistricts = new Map();
  const kept = [];
  for (const place of unique) {
    if (!keepByStatus(place)) { closed++; continue; }
    if (!keepByReviews(place, opts.minReviews)) { thin++; continue; }
    // Split from the radius check below so "we could not check" is never
    // reported as "we checked and it was too far" — different facts, and one
    // of them is a data gap worth seeing.
    if (typeof place.location?.latitude !== 'number' || typeof place.location?.longitude !== 'number') {
      unlocated++;
      continue;
    }
    if (!keepByRadius(place, center, opts.radius)) { outside++; continue; }
    // The whole place, not just its formattedAddress, so districtOf can use
    // Google's structured sublocality_level_1 rather than counting dashes.
    const verdict = areaVerdict(place, opts.area);
    if (verdict !== 'match') {
      const d = districtOf(place) || '(no district in address)';
      const bucket = verdict === 'other' ? offAreaDistricts : unverifiedDistricts;
      bucket.set(d, (bucket.get(d) || 0) + 1);
      if (verdict === 'other') offArea++; else unverifiedArea++;
      continue;
    }
    kept.push(place);
  }

  const leads = kept.map((place) => toLead(place, {
    center,
    category: opts.category,
    provenance: `discovered ${runDate} · "${queryOf.get(place.id)}" within ${opts.radius}m of ${opts.near}${opts.area.length ? ` · in ${opts.area.join('/')}` : ''}`,
  }));

  // Every drop is counted and named. A silent filter is how a lead is lost
  // without anyone learning it existed.
  const drops = [];
  if (closed) drops.push(`${closed} dropped (closed)`);
  if (thin) drops.push(`${thin} dropped (below ${opts.minReviews} reviews)`);
  if (unlocated) drops.push(`${unlocated} dropped (no coordinates from Google, so the radius could not be checked)`);
  if (outside) drops.push(`${outside} dropped (outside ${opts.radius}m)`);
  const areaLabel = opts.area.join('" / "');
  if (offArea) drops.push(`${offArea} dropped (address in another district)`);
  if (unverifiedArea) drops.push(`${unverifiedArea} dropped (could not be confirmed as "${areaLabel}")`);
  console.log(`\n${all.length} results · ${unique.length} unique after dedupe${drops.length ? ` · ${drops.join(' · ')}` : ''} · ${leads.length} written`);

  // Named, not just counted — so a district rejected in error is visible here
  // rather than only discoverable by re-running the whole search.
  const listDistricts = (m) => [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} (${n})`)
    .join(', ');

  if (offAreaDistricts.size) {
    console.log(`dropped as another district: ${listDistricts(offAreaDistricts)}`);
  }

  // The one that needs eyes. These were not checked and found wanting; they
  // could not be checked at all, because Google returned the district in a
  // script the --area terms cannot be compared against. A real target-area
  // clinic hiding in here is recoverable — that is what the extra --area is
  // for — and the message has to say so or the count is just noise.
  if (unverifiedDistricts.size) {
    console.log(`\nCOULD NOT VERIFY ${unverifiedArea} place(s) against "${areaLabel}" — Google gave their district in another script, so they were neither confirmed nor ruled out:`);
    console.log(`  ${listDistricts(unverifiedDistricts)}`);
    console.log('These are dropped, NOT because they are elsewhere, but because they could not be confirmed.');
    console.log(`If any of those IS ${opts.area[0] || 'your area'}, pass it as an extra --area to keep it, e.g. --area "${opts.area[0] || 'Jumeirah'}" --area "<the spelling above>"`);
  }

  const noWebsite = leads.filter((l) => l.domain === null).length;
  if (noWebsite) console.log(`${noWebsite} with no website of their own — the audit cannot find these on its own, and they are the strongest leads here.`);

  // Counted from `kept` (the places), not `leads` — off-category is never a
  // reason to drop, so it is not a separate field on the lead, only a prefix
  // on note. Flagged, never dropped: this count is informational, and every
  // lead above is still written.
  const offCategory = kept.filter((place) => classifyCategory(place, opts.category).offCategory).length;
  if (offCategory) console.log(`${offCategory} flagged as not Google-typed ${opts.category} — check by hand before treating these as ${opts.category} leads; none were dropped.`);

  // The distribution the category set should be derived from. Printed on every
  // run, but it is the entire point of --category any: you cannot write an
  // honest type set for a new vertical without seeing what Google actually
  // returns for it, and the dental set was written this way from 60 samples.
  const typeTally = kept.reduce((acc, p) => {
    const t = p.primaryType || '(none)';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});
  const tallyLine = Object.entries(typeTally).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`).join(' · ');
  console.log(`primaryType distribution: ${tallyLine}`);

  // These used to print AFTER the zero-leads check below, so a run where
  // every query timed out took the zero-leads exit first and reported what
  // looked exactly like a genuine empty market — no hint the search itself
  // broke. The same principle as the audit's UNVERIFIED and its "speed was
  // not measured" banner: an absence must never read as a finding.
  if (truncatedQueries.length) {
    console.log(`\nWARNING: ${truncatedQueries.length} query/queries were cut short and their results are incomplete:`);
    for (const t of truncatedQueries) console.log(`  ${t}`);
  }

  // A list that quietly stops at 60 looks exactly like a market with 60
  // clinics in it.
  if (saturatedQueries.length) {
    console.log(`\nWARNING: ${saturatedQueries.length} of ${opts.query.length} query/queries hit Google's ${PAGE_CAP}-result cap.`);
    console.log('This area is NOT fully enumerated. Narrow --radius or add more specific --query terms.');
    for (const q of saturatedQueries) console.log(`  saturated: "${q}"`);
  }

  if (!leads.length) {
    if (fatalError) {
      console.error(`\nRun stopped after "${fatalQuery}" failed — see the error above. Nothing written.`);
    } else if (truncatedQueries.length) {
      // Not "no clinics exist" — the search itself broke. Saying so plainly
      // is the reason the warnings above print before this check now.
      console.error('\nNo leads found, but queries above were cut short — this looks like a failed run, not an empty market. Nothing written.');
    } else {
      console.error('\nNo leads found. Nothing written — an empty leads.json is never the intended output.');
    }
    process.exit(1);
  }

  // Guarded like every other failure path in main(): a disk-full or
  // permission error should report the same way those do, not surface as an
  // unhandled rejection and a raw stack trace.
  try {
    await writeFile(opts.out, `${JSON.stringify(leads, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.error(`\nFailed to write ${opts.out}: ${e.message || e}`);
    process.exit(1);
  }
  console.log(`\nwrote ${opts.out}`);

  if (fatalError) {
    // Said plainly, after the write, so a partial leads.json is never
    // mistaken for a complete run: everything written is real, but
    // opts.query after fatalQuery was never searched.
    console.error(`\nRUN CUT SHORT: stopped after "${fatalQuery}" failed with the error printed above. `
      + `${opts.out} holds only the queries that completed before that — it is a partial result, not a complete run.`);
    process.exitCode = 1;
  }

  console.log(`\nnext: node audit.mjs ${opts.out} --out lead-report.md`);
}

if (import.meta.main) await main();
