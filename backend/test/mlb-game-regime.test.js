import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySoftRegimeAdjustment,
  buildPregameRegimeSignals,
  evaluateRegimeDetectionV2Pass,
  evaluateRegimePhase2Pass,
  labelGameRegimeFromBoxscore,
  labelGameRegimeFromScores,
  labelGameRegimeV2FromBoxscore,
  resolvePitcherStartVolatility,
  scoreGameRegimeFromPregame,
  softRegimeStrengths,
  summarizeRegimeDetectionV2,
  summarizeRegimeSeparation,
} from '../src/services/MlbGameRegimeService.js';

function fakeBox({
  homeStarter = { ip: '6.0', er: 1, r: 1 },
  awayStarter = { ip: '6.0', er: 1, r: 1 },
  homeBullpen = [],
  awayBullpen = [],
  homeRuns = 2,
  awayRuns = 1,
} = {}) {
  const buildSide = (starter, bullpen, runs) => {
    const pitchers = [101, ...bullpen.map((_, i) => 200 + i)];
    const players = {
      ID101: {
        person: { fullName: 'Starter' },
        position: { abbreviation: 'P' },
        stats: {
          pitching: {
            inningsPitched: starter.ip,
            earnedRuns: starter.er,
            runs: starter.r,
          },
        },
      },
    };
    bullpen.forEach((line, i) => {
      players[`ID${200 + i}`] = {
        person: { fullName: line.name || `Reliever${i}` },
        position: { abbreviation: line.position || 'P' },
        stats: {
          pitching: {
            inningsPitched: line.ip || '1.0',
            earnedRuns: line.er ?? 0,
            runs: line.r ?? line.er ?? 0,
          },
        },
      };
    });
    return {
      team: { name: 'Team' },
      pitchers,
      players,
      teamStats: { batting: { runs } },
    };
  };
  return {
    teams: {
      home: buildSide(homeStarter, homeBullpen, homeRuns),
      away: buildSide(awayStarter, awayBullpen, awayRuns),
    },
  };
}

test('低分雙優質先發標成 duel', () => {
  const label = labelGameRegimeFromBoxscore(fakeBox({
    homeRuns: 2,
    awayRuns: 1,
    homeStarter: { ip: '7.0', er: 1, r: 1 },
    awayStarter: { ip: '6.0', er: 0, r: 0 },
  }), { homeScore: 2, awayScore: 1 });
  assert.equal(label.regime, 'duel');
});

test('先發崩盤或高總分標成 blowup', () => {
  const collapse = labelGameRegimeFromBoxscore(fakeBox({
    homeRuns: 1,
    awayRuns: 8,
    homeStarter: { ip: '2.1', er: 6, r: 7 },
    awayStarter: { ip: '6.0', er: 1, r: 1 },
  }), { homeScore: 1, awayScore: 8 });
  assert.equal(collapse.regime, 'blowup');

  const highTotal = labelGameRegimeFromBoxscore(fakeBox({
    homeRuns: 8,
    awayRuns: 7,
    homeStarter: { ip: '5.0', er: 4, r: 4 },
    awayStarter: { ip: '5.0', er: 4, r: 4 },
  }), { homeScore: 8, awayScore: 7 });
  assert.equal(highTotal.regime, 'blowup');
});

test('野手投球視為 blowup', () => {
  const label = labelGameRegimeFromBoxscore(fakeBox({
    homeRuns: 4,
    awayRuns: 9,
    homeStarter: { ip: '5.0', er: 3, r: 3 },
    awayStarter: { ip: '6.0', er: 2, r: 2 },
    homeBullpen: [
      { ip: '2.0', er: 2, position: 'P' },
      { ip: '1.0', er: 4, position: 'LF', name: 'PositionPlayer' },
    ],
  }), { homeScore: 4, awayScore: 9 });
  assert.equal(label.regime, 'blowup');
});

test('比分弱標籤上下界', () => {
  assert.equal(labelGameRegimeFromScores(1, 0).regime, 'duel');
  assert.equal(labelGameRegimeFromScores(8, 7).regime, 'blowup');
  assert.equal(labelGameRegimeFromScores(5, 4).regime, 'normal');
});

test('賽前規則：雙穩定先發偏 duel，單邊失控偏 one_sided', () => {
  const duelSignals = buildPregameRegimeSignals({
    home: { recentRunsPerGame: 4.0 },
    away: { recentRunsPerGame: 3.8 },
    pitchers: {
      home: { era: 3.2, inningsPitched: 60, gamesStarted: 10 },
      away: { era: 3.4, inningsPitched: 55, gamesStarted: 9 },
      homeRecent: { recent3Era: 2.8, startsObserved: 3, recent3Innings: 18 },
      awayRecent: { recent3Era: 3.0, startsObserved: 3, recent3Innings: 17 },
    },
    bullpen: {
      home: { pitchesLast3: 110 },
      away: { pitchesLast3: 120 },
    },
  });
  const duel = scoreGameRegimeFromPregame(duelSignals);
  assert.equal(duel.predicted, 'duel');
  assert.ok(duel.duelScore >= 5);

  const oneSideSignals = buildPregameRegimeSignals({
    home: { recentRunsPerGame: 5.4 },
    away: { recentRunsPerGame: 4.2 },
    pitchers: {
      home: { era: 4.0, inningsPitched: 40, gamesStarted: 8 },
      away: { era: 3.5, inningsPitched: 50, gamesStarted: 9 },
      homeRecent: { recent3Era: 7.2, startsObserved: 3, recent3Innings: 10 },
      awayRecent: { recent3Era: 3.2, startsObserved: 3, recent3Innings: 18 },
    },
    bullpen: {
      home: { pitchesLast3: 150 },
      away: { pitchesLast3: 140 },
    },
  });
  const oneSide = scoreGameRegimeFromPregame(oneSideSignals);
  assert.equal(oneSide.predicted, 'one_sided');
  assert.ok(oneSide.oneSidedScore >= 4);
});

test('打者公園否決投手戰標籤', () => {
  const scored = scoreGameRegimeFromPregame(buildPregameRegimeSignals({
    home: { recentRunsPerGame: 4.0 },
    away: { recentRunsPerGame: 3.8 },
    homeTeam: 'Colorado Rockies',
    venueName: 'Coors Field',
    pitchers: {
      home: { era: 3.2, inningsPitched: 60, gamesStarted: 10 },
      away: { era: 3.4, inningsPitched: 55, gamesStarted: 9 },
      homeRecent: { recent3Era: 2.8, startsObserved: 3, recent3Innings: 18 },
      awayRecent: { recent3Era: 3.0, startsObserved: 3, recent3Innings: 17 },
    },
    bullpen: { home: { pitchesLast3: 110 }, away: { pitchesLast3: 120 } },
  }));
  assert.notEqual(scored.predicted, 'duel');
  assert.equal(scored.duelScore, 0);
});

test('近況提早退場否決投手戰；雙熱需牛棚確認才高分', () => {
  const veto = scoreGameRegimeFromPregame(buildPregameRegimeSignals({
    home: { recentRunsPerGame: 4.0 },
    away: { recentRunsPerGame: 3.8 },
    pitchers: {
      home: { era: 3.0, inningsPitched: 60, gamesStarted: 10 },
      away: { era: 3.1, inningsPitched: 58, gamesStarted: 10 },
      homeRecent: {
        recent3Era: 2.5,
        startsObserved: 3,
        recent3Innings: 18,
        earlyExitsLast3: 1,
        blowupStartsLast3: 0,
      },
      awayRecent: {
        recent3Era: 2.8,
        startsObserved: 3,
        recent3Innings: 17,
        earlyExitsLast3: 0,
        blowupStartsLast3: 0,
      },
    },
    bullpen: { home: { pitchesLast3: 120 }, away: { pitchesLast3: 110 } },
  }));
  assert.notEqual(veto.predicted, 'duel');
  assert.equal(veto.duelScore, 0);

  const weakHot = scoreGameRegimeFromPregame(buildPregameRegimeSignals({
    home: { recentRunsPerGame: 4.2 },
    away: { recentRunsPerGame: 4.0 },
    pitchers: {
      home: { era: 5.8, inningsPitched: 40, gamesStarted: 8 },
      away: { era: 5.9, inningsPitched: 40, gamesStarted: 8 },
      homeRecent: { recent3Era: 6.1, startsObserved: 3, recent3Innings: 12 },
      awayRecent: { recent3Era: 5.9, startsObserved: 3, recent3Innings: 13 },
    },
    bullpen: { home: { pitchesLast3: 150 }, away: { pitchesLast3: 167 } },
  }));
  assert.notEqual(weakHot.predicted, 'high_total');
});

test('分離度摘要可計算 lift 與過關旗標', () => {
  const rows = [
    { trueRegime: 'duel', predicted: 'duel', duelScore: 6, blowupScore: 0, totalRuns: 3, avgRecentEra: 3 },
    { trueRegime: 'duel', predicted: 'normal', duelScore: 5, blowupScore: 1, totalRuns: 4, avgRecentEra: 3.2 },
    { trueRegime: 'normal', predicted: 'normal', duelScore: 2, blowupScore: 1, totalRuns: 9, avgRecentEra: 4.2 },
    { trueRegime: 'normal', predicted: 'normal', duelScore: 1, blowupScore: 2, totalRuns: 8, avgRecentEra: 4.4 },
    { trueRegime: 'blowup', predicted: 'blowup', duelScore: 0, blowupScore: 6, totalRuns: 16, avgRecentEra: 6 },
    { trueRegime: 'blowup', predicted: 'blowup', duelScore: 1, blowupScore: 5, totalRuns: 15, avgRecentEra: 5.8 },
  ];
  const summary = summarizeRegimeSeparation(rows);
  assert.equal(summary.n, 6);
  assert.ok(summary.lifts.top20BlowupScore);
});

test('Phase2：高分結構放大方差且不追求精確爆分', () => {
  const signals = buildPregameRegimeSignals({
    home: { recentRunsPerGame: 5.5 },
    away: { recentRunsPerGame: 5.2 },
    pitchers: {
      home: { era: 4.0, inningsPitched: 40, gamesStarted: 8 },
      away: { era: 4.2, inningsPitched: 40, gamesStarted: 8 },
      homeRecent: { recent3Era: 7.5, startsObserved: 3, recent3Innings: 9 },
      awayRecent: { recent3Era: 6.8, startsObserved: 3, recent3Innings: 10 },
    },
    bullpen: { home: { pitchesLast3: 230 }, away: { pitchesLast3: 240 } },
  });
  const scored = scoreGameRegimeFromPregame(signals);
  assert.equal(scored.predicted, 'high_total');
  const adjusted = applySoftRegimeAdjustment({
    homeMean: 4.5,
    awayMean: 4.5,
    baseDispersion: 8,
    signals,
    scored,
  });
  assert.equal(adjusted.scorePursuitOnBlowup, false);
  assert.ok(adjusted.awayDispersion > 8 || adjusted.homeDispersion > 8);
});

test('Phase2 過關忽略崩盤總分 MAE', () => {
  const pass = evaluateRegimePhase2Pass({
    baseline: {
      blowupDetection: { lift: 1.0, precision: 0.25 },
      directionHitRate: 0.52,
      directionHitRateNonBlowup: 0.53,
      sideMaeNonBlowup: 2.4,
    },
    adjusted: {
      blowupDetection: { lift: 1.08, precision: 0.3 },
      directionHitRate: 0.521,
      directionHitRateNonBlowup: 0.53,
      sideMaeNonBlowup: 2.39,
      blowupTotalMae: 99,
    },
  });
  assert.equal(pass.ignoredMetric, 'blowup_total_mae_not_used_for_pass');
  assert.equal(pass.phase2Promising, true);
});

test('賽後 v2：單邊崩是 one_sided，雙邊高分是 high_total', () => {
  const oneSide = labelGameRegimeV2FromBoxscore(fakeBox({
    homeRuns: 1,
    awayRuns: 8,
    homeStarter: { ip: '2.1', er: 6, r: 7 },
    awayStarter: { ip: '6.0', er: 1, r: 1 },
  }), { homeScore: 1, awayScore: 8 });
  assert.equal(oneSide.regime, 'one_sided');
  assert.ok(oneSide.margin >= 6);

  const highTotal = labelGameRegimeV2FromBoxscore(fakeBox({
    homeRuns: 8,
    awayRuns: 7,
    homeStarter: { ip: '5.0', er: 4, r: 4 },
    awayStarter: { ip: '5.0', er: 4, r: 4 },
  }), { homeScore: 8, awayScore: 7 });
  assert.equal(highTotal.regime, 'high_total');

  const duel = labelGameRegimeV2FromBoxscore(fakeBox({
    homeRuns: 2,
    awayRuns: 1,
    homeStarter: { ip: '7.0', er: 1, r: 1 },
    awayStarter: { ip: '6.0', er: 0, r: 0 },
  }), { homeScore: 2, awayScore: 1 });
  assert.equal(duel.regime, 'duel');
});

test('Detection 摘要不以 lean 命中過關', () => {
  const rows = [
    { trueRegime: 'duel', predicted: 'duel', totalRuns: 3, margin: 1, duelScore: 6, oneSidedScore: 0, highTotalScore: 0 },
    { trueRegime: 'duel', predicted: 'normal', totalRuns: 4, margin: 2, duelScore: 2, oneSidedScore: 0, highTotalScore: 0 },
    { trueRegime: 'one_sided', predicted: 'one_sided', totalRuns: 9, margin: 7, duelScore: 0, oneSidedScore: 5, highTotalScore: 0 },
    { trueRegime: 'one_sided', predicted: 'high_total', totalRuns: 11, margin: 8, duelScore: 0, oneSidedScore: 2, highTotalScore: 5 },
    { trueRegime: 'high_total', predicted: 'high_total', totalRuns: 16, margin: 2, duelScore: 0, oneSidedScore: 0, highTotalScore: 6 },
    { trueRegime: 'normal', predicted: 'normal', totalRuns: 8, margin: 1, duelScore: 1, oneSidedScore: 1, highTotalScore: 1 },
    { trueRegime: 'normal', predicted: 'duel', totalRuns: 7, margin: 1, duelScore: 4, oneSidedScore: 0, highTotalScore: 0 },
  ];
  const summary = summarizeRegimeDetectionV2(rows);
  assert.equal(summary.ignoredMetric, 'totals_lean_hit_rate_not_used_for_pass');
  assert.equal(summary.detection.byClass.duel.predicted, 2);
  assert.ok(summary.outcomeByPredicted.duel.meanTotal < summary.overallMeanTotal);
  const pass = evaluateRegimeDetectionV2Pass(summary);
  assert.equal(pass.ignoredMetric, 'totals_lean_hit_rate_not_used_for_pass');
  assert.match(pass.note, /lean/);
});
