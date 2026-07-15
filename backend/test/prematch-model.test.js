import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePick } from '../src/services/PickScorer.js';
import { computeH2hEdges } from '../src/services/MatchupCore.js';
import { assessMarketPreference } from '../src/services/MarketPreference.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { config } from '../src/config.js';

test('優勢使用去水市場，EV 邊界仍保留實際賠率含水差', () => {
  const scored = scorePick({
    modelProb: 0.53,
    marketProb: 0.5,
    impliedProb: 1 / 1.91,
    oddsDecimal: 1.91,
    marketType: 'h2h',
    dataQuality: 0.8,
  });

  assert.equal(scored.edgeProb, 3);
  assert.equal(scored.offeredEdgeProb, 0.6);
});

test('MatchupCore 的 edge 以雙邊去水概率計算', () => {
  const edges = computeH2hEdges(0.53, 0.47, 1.91, 1.91);

  assert.equal(Math.round(edges.home.fairProb * 1000) / 1000, 0.5);
  assert.equal(Math.round(edges.home.edgePct * 10) / 10, 3);
  assert.ok(edges.home.ev < 0.02);
});

test('膠著只建立排序偏好，不再構成獨贏硬刪除條件', () => {
  const preference = assessMarketPreference(
    {
      homeWinProb: 0.54,
      awayWinProb: 0.46,
      homeRuns: 3.1,
      awayRuns: 3.0,
      scoringHomeRuns: 3.8,
      scoringAwayRuns: 3.7,
    },
    { league: 'NPB' }
  );

  assert.equal(preference.preferTotals, true);
  assert.equal(preference.projectedTotal, 7.5);
  assert.equal('suppressH2h' in preference, false);
});

test('均注每場只允許一個最佳盤口', () => {
  assert.equal(config.maxFlatBetsPerGame, 1);
});

test('完整候選宇宙保存未入選方向，均注只標記最佳單場', () => {
  let captured;
  const game = {
    id: 'test-game',
    league: 'MLB',
    home_team: 'Home',
    away_team: 'Away',
  };
  const markets = {
    h2h: {
      Home: { name: 'Home', price: 1.9, bookmaker: 'Book' },
      Away: { name: 'Away', price: 2.0, bookmaker: 'Book' },
    },
    spreads: {},
    totals: {},
  };
  const analysis = {
    homeWinProb: 0.6,
    awayWinProb: 0.4,
    rawModelHomeProb: 0.64,
    rawModelAwayProb: 0.36,
    marketHomeProb: 0.52,
    marketAwayProb: 0.48,
    confidence: 0.2,
    dataQuality: 0.8,
    hasTeamStrength: true,
    scoringHomeRuns: 4.8,
    scoringAwayRuns: 3.8,
    totalsProjection: {
      probabilityHomeRuns: 4.8,
      probabilityAwayRuns: 3.8,
      homeRuns: 4.8,
      awayRuns: 3.8,
      dataQuality: 0.8,
      factors: [],
    },
    factors: [],
  };

  const picks = pickGameRecommendations(game, markets, analysis, '', {
    bookmakers: [],
    onDecisionCandidates: (payload) => {
      captured = payload;
    },
  });

  assert.equal(captured.candidates.length, 2);
  assert.equal(captured.selected.length, picks.length);
  assert.equal(picks.filter((pick) => pick.bet_strategy === 'flat_bet').length, 1);
});
