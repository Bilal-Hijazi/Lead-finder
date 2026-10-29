import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratingFactor, demand, leadValue } from './rank.mjs';

// DISCOVERY.md's worked table, used verbatim as the oracle. Every row was
// checked against the formula by hand before this file was written, so a
// failure here means the implementation is wrong, not the table.
test('the worked table from DISCOVERY.md', () => {
  assert.equal(Math.round(leadValue(55, 210, 4.8)), 129, 'no website at all');
  assert.equal(Math.round(leadValue(50, 94, 4.6)), 101, 'dead site');
  assert.equal(Math.round(leadValue(31, 400, 4.7)), 81, 'slow site, no WhatsApp');
  assert.equal(Math.round(leadValue(50, 8, 3.1)), 19, 'dead site, struggling practice');
  assert.equal(Math.round(leadValue(0, 300, 4.7)), 0, 'healthy site');
});

// The ordering IS the point: a busy practice with a merely slow site must
// outrank a struggling one with a dead site.
test('a busy slow practice outranks a struggling broken one', () => {
  assert.ok(leadValue(31, 400, 4.7) > leadValue(50, 8, 3.1));
});

// Asserted ON each boundary value, because an off-by-one comparison (> vs >=)
// is the likely defect and only the boundary itself catches it.
test('ratingFactor boundaries', () => {
  assert.equal(ratingFactor(4.5), 1.0);
  assert.equal(ratingFactor(4.49), 0.9);
  assert.equal(ratingFactor(4.0), 0.9);
  assert.equal(ratingFactor(3.99), 0.6);
  assert.equal(ratingFactor(3.5), 0.6);
  assert.equal(ratingFactor(3.49), 0.3);
  assert.equal(ratingFactor(3.0), 0.3);
  assert.equal(ratingFactor(2.99), 0.15);
  assert.equal(ratingFactor(1.0), 0.15);
});

test('unrated is 0.5 — unknown is not the same as bad', () => {
  assert.equal(ratingFactor(undefined), 0.5);
  assert.equal(ratingFactor(null), 0.5);
  assert.equal(ratingFactor(NaN), 0.5);
});

// The + 10 exists so a new clinic is not permanently uncontactable. With + 1
// this would be exactly 0 and the lead could never surface.
test('zero reviews still scores above zero', () => {
  assert.ok(leadValue(50, 0, 4.6) > 0);
  assert.equal(demand(0, 4.6), 1.0);
});

// The decided fallback for hand-written leads carrying no demand data:
// unrated (0.5) x log10(0 + 10) (1.0) = 0.5, so they sit mid-table under the
// same rule as everything else rather than needing a special case.
test('a lead with no demand data scores opportunity x 0.5', () => {
  assert.equal(demand(undefined, undefined), 0.5);
  assert.equal(leadValue(50, undefined, undefined), 25);
});

// A broken website only costs someone money if people are looking for them.
test('zero opportunity zeroes the product regardless of demand', () => {
  assert.equal(leadValue(0, 5000, 5.0), 0);
});
