import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  starPenaltyFromInjuryNames,
  starPenaltyFromLineupAbsence,
} from '../src/services/StarPlayerImpact.js';

test('star injury match applies Ohtani penalty when enabled', () => {
  const prev = config.enableStarImpact;
  config.enableStarImpact = true;
  const r = starPenaltyFromInjuryNames('Los Angeles Dodgers', ['Shohei Ohtani', 'Some Rookie']);
  assert.ok(r.penalty >= 0.025);
  assert.equal(r.hits[0].name, 'Shohei Ohtani');
  config.enableStarImpact = prev;
});

test('star impact disabled returns zero', () => {
  const prev = config.enableStarImpact;
  config.enableStarImpact = false;
  const r = starPenaltyFromInjuryNames('Los Angeles Dodgers', ['Shohei Ohtani']);
  assert.equal(r.penalty, 0);
  config.enableStarImpact = prev;
});

test('lineup absence detects missing Judge', () => {
  const prev = config.enableStarImpact;
  config.enableStarImpact = true;
  const r = starPenaltyFromLineupAbsence('New York Yankees', ['Anthony Volpe', 'Jazz Chisholm Jr.']);
  assert.ok(r.penalty > 0);
  assert.ok(r.hits.some((h) => h.name === 'Aaron Judge'));
  config.enableStarImpact = prev;
});
