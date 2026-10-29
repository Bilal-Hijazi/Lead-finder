// Lead ranking — combines the audit's opportunity score with the demand
// signal discovery supplies.
//
// A broken website only costs someone money if people are looking for them,
// so lead value is the product of the two and never either alone. Ranked on
// opportunity alone the audit puts a dead site with 8 reviews above a slow
// site with 400, when the second is plainly the better business.
//
// Pure arithmetic, no I/O, in its own module on purpose: audit.mjs is a
// top-to-bottom script, so importing it to test this would run a full audit
// including every network call.

// A 3.1-star clinic's problem is not its website, and a new one will not fix
// it — they are also the least likely to have budget. This is not snobbery,
// it is avoiding a sale you would regret.
//
// Unrated sits at 0.5 because unknown is not the same as bad, and a genuinely
// new clinic is a reasonable prospect.
export function ratingFactor(rating) {
  if (typeof rating !== 'number' || Number.isNaN(rating)) return 0.5;
  if (rating >= 4.5) return 1.0;
  if (rating >= 4.0) return 0.9;
  if (rating >= 3.5) return 0.6;
  if (rating >= 3.0) return 0.3;
  return 0.15;
}

// log10 because 400 reviews is not twice the opportunity of 200 — both are
// clinics with established demand. The log keeps the ordering while stopping
// one very popular practice from burying everything else.
//
// The + 10 carries just as much weight: with + 1, a clinic with zero reviews
// scores exactly zero and could never be contacted, which is far too strong a
// claim about a practice that may simply be new.
export function demand(reviews, rating) {
  const n = typeof reviews === 'number' && reviews > 0 ? reviews : 0;
  return Math.log10(n + 10) * ratingFactor(rating);
}

// Unbounded on purpose. Report it as a ranking number, never a percentage —
// turning it into a score out of 100 would invent a precision it does not have.
export function leadValue(opportunity, reviews, rating) {
  return opportunity * demand(reviews, rating);
}
