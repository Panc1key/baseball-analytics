import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPregameRegimeSignals,
  scoreGameRegimeFromPregame,
} from '../src/services/MlbGameRegimeService.js';
import {
  resolveMlbRegimeMarketPlan,
  buildMlbRegimeTotalsLeanDecision,
  describeMlbRegimeMarketPlan,
} from '../src/services/MlbRegimeMarketRouter.js';

test('雙邊都穩才是投手戰並押小', () => {
  const plan = resolveMlbRegimeMarketPlan({
    features: {
      home: { recentRunsPerGame: 4.0 },
      away: { recentRunsPerGame: 3.8 },
      pitchers: {
        home: { era: 3.2, inningsPitched: 60, gamesStarted: 10 },
        away: { era: 3.4, inningsPitched: 55, gamesStarted: 9 },
        homeRecent: { recent3Era: 2.8, startsObserved: 3, recent3Innings: 18 },
        awayRecent: { recent3Era: 3.0, startsObserved: 3, recent3Innings: 17 },
      },
      bullpen: { home: { pitchesLast3: 110 }, away: { pitchesLast3: 120 } },
    },
  });
  assert.equal(plan.regimePredicted, 'duel');
  assert.equal(plan.totalsLean, 'under');
  assert.equal(plan.moneylinePriority, 'blocked');
});

test('單邊近況很好不能判成投手戰（DET@CHC 類）', () => {
  const plan = resolveMlbRegimeMarketPlan({
    features: {
      home: { recentRunsPerGame: 4.5 },
      away: { recentRunsPerGame: 4.2 },
      pitchers: {
        home: { era: 4.2, inningsPitched: 50, gamesStarted: 9 },
        away: { era: 3.0, inningsPitched: 55, gamesStarted: 9 },
        homeRecent: { recent3Era: 4.4, startsObserved: 3, recent3Innings: 16 },
        awayRecent: { recent3Era: 1.3, startsObserved: 3, recent3Innings: 18 },
      },
      bullpen: { home: { pitchesLast3: 187 }, away: { pitchesLast3: 245 } },
    },
  });
  assert.notEqual(plan.regimePredicted, 'duel');
  assert.notEqual(plan.totalsLean, 'under');
});

test('雙邊近況差 alone 不能自動押大（STL@LAA 類）', () => {
  const plan = resolveMlbRegimeMarketPlan({
    features: {
      home: { recentRunsPerGame: 4.2 },
      away: { recentRunsPerGame: 4.0 },
      pitchers: {
        home: { era: 5.8, inningsPitched: 40, gamesStarted: 8 },
        away: { era: 5.9, inningsPitched: 40, gamesStarted: 8 },
        homeRecent: { recent3Era: 6.1, startsObserved: 3, recent3Innings: 12 },
        awayRecent: { recent3Era: 5.9, startsObserved: 3, recent3Innings: 13 },
      },
      bullpen: { home: { pitchesLast3: 150 }, away: { pitchesLast3: 167 } },
    },
  });
  assert.notEqual(plan.regimePredicted, 'high_total');
  assert.notEqual(plan.totalsLean, 'over');
});

test('雙邊都熱才是高分結構並押大', () => {
  const plan = resolveMlbRegimeMarketPlan({
    features: {
      home: { recentRunsPerGame: 5.4 },
      away: { recentRunsPerGame: 5.2 },
      pitchers: {
        home: { era: 4.0, inningsPitched: 40, gamesStarted: 8 },
        away: { era: 4.5, inningsPitched: 40, gamesStarted: 8 },
        homeRecent: { recent3Era: 7.0, startsObserved: 3, recent3Innings: 10 },
        awayRecent: { recent3Era: 6.8, startsObserved: 3, recent3Innings: 11 },
      },
      bullpen: { home: { pitchesLast3: 230 }, away: { pitchesLast3: 240 } },
    },
  });
  assert.equal(plan.regimePredicted, 'high_total');
  assert.equal(plan.totalsLean, 'over');
  const decision = buildMlbRegimeTotalsLeanDecision({
    marketPlan: plan,
    expectedTotal: 10.2,
    totalLine: 8.5,
    overProbability: 0.62,
  });
  assert.equal(decision.lean, 'over');
});

test('單邊熱是 one_sided：不自動押大', () => {
  const plan = resolveMlbRegimeMarketPlan({
    features: {
      home: { recentRunsPerGame: 4.2 },
      away: { recentRunsPerGame: 5.4 },
      pitchers: {
        home: { era: 4.0, inningsPitched: 50, gamesStarted: 9 },
        away: { era: 3.5, inningsPitched: 55, gamesStarted: 9 },
        homeRecent: { recent3Era: 6.5, startsObserved: 3, recent3Innings: 12 },
        awayRecent: { recent3Era: 3.2, startsObserved: 3, recent3Innings: 18 },
      },
      bullpen: { home: { pitchesLast3: 150 }, away: { pitchesLast3: 140 } },
    },
  });
  assert.equal(plan.regimePredicted, 'one_sided');
  assert.equal(plan.totalsLean, null);
  assert.equal(plan.primaryMarket, 'margin');
  assert.match(describeMlbRegimeMarketPlan(plan), /單邊崩/);
});

test('普通場允許獨贏為主', () => {
  const plan = resolveMlbRegimeMarketPlan({
    scored: {
      duelScore: 1,
      oneSidedScore: 1,
      highTotalScore: 1,
      blowupScore: 1,
      predicted: 'normal',
    },
    signals: {
      homePitchingBlowupRisk: 0,
      awayPitchingBlowupRisk: 0,
    },
  });
  assert.equal(plan.primaryMarket, 'moneyline');
  assert.equal(plan.moneylineAllowed, true);
});

test('score v2：穩vs熱優先 one_sided 而非 duel', () => {
  const signals = buildPregameRegimeSignals({
    home: { recentRunsPerGame: 4.0 },
    away: { recentRunsPerGame: 4.5 },
    pitchers: {
      home: { era: 3.0, inningsPitched: 60, gamesStarted: 10 },
      away: { era: 4.5, inningsPitched: 45, gamesStarted: 8 },
      homeRecent: { recent3Era: 2.5, startsObserved: 3, recent3Innings: 18 },
      awayRecent: { recent3Era: 6.5, startsObserved: 3, recent3Innings: 12 },
    },
    bullpen: { home: { pitchesLast3: 120 }, away: { pitchesLast3: 130 } },
  });
  const scored = scoreGameRegimeFromPregame(signals);
  assert.equal(scored.predicted, 'one_sided');
  assert.ok(scored.oneSidedScore > scored.duelScore);
});
