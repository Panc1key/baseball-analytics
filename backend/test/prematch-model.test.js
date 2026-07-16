import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePick } from '../src/services/PickScorer.js';
import { computeH2hEdges } from '../src/services/MatchupCore.js';
import { assessMarketPreference } from '../src/services/MarketPreference.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { computeTotalsProjection } from '../src/services/TotalsModel.js';
import { estimateProjectedTotal } from '../src/utils/odds.js';
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

test('膠著場嚴格門檻無候選時仍產出樣本推薦（選最佳盤口）', () => {
  const game = {
    id: 'npb-ambiguous',
    league: 'NPB',
    home_team: 'Chunichi Dragons',
    away_team: 'Hanshin Tigers',
  };
  const markets = {
    h2h: {
      'Chunichi Dragons': { name: 'Chunichi Dragons', price: 2.05, bookmaker: 'Book' },
      'Hanshin Tigers': { name: 'Hanshin Tigers', price: 1.83, bookmaker: 'Book' },
    },
    spreads: {
      'Chunichi Dragons_+1.5': {
        name: 'Chunichi Dragons',
        point: 1.5,
        price: 1.55,
        bookmaker: 'Book',
      },
    },
    totals: {
      'Over_6.5': { name: 'Over', point: 6.5, price: 1.9, bookmaker: 'Book' },
      'Under_6.5': { name: 'Under', point: 6.5, price: 1.95, bookmaker: 'Book' },
    },
  };
  const analysis = {
    homeWinProb: 0.449,
    awayWinProb: 0.551,
    rawModelHomeProb: 0.44,
    rawModelAwayProb: 0.56,
    marketHomeProb: 0.46,
    marketAwayProb: 0.54,
    confidence: 0.14,
    dataQuality: 0.72,
    hasTeamStrength: true,
    scoringHomeRuns: 3.6,
    scoringAwayRuns: 3.9,
    homeRuns: 3.6,
    awayRuns: 3.9,
    totalsProjection: {
      probabilityHomeRuns: 3.6,
      probabilityAwayRuns: 3.9,
      homeRuns: 3.6,
      awayRuns: 3.9,
      projectedTotal: 7.5,
      dataQuality: 0.72,
      factors: [],
    },
    factors: ['Yahoo 順位'],
  };

  const picks = pickGameRecommendations(game, markets, analysis, 'test', { bookmakers: [] });

  assert.equal(picks.length, 1);
  assert.equal(picks[0].tier, 'sample');
  assert.ok(['h2h', 'totals', 'spreads'].includes(picks[0].market));
  assert.equal(picks[0].bet_strategy, null);
});

test('僅先發 ERA 估算總分：強投應低於聯盟均值', () => {
  const weakPitchers = computeTotalsProjection({
    league: 'MLB',
    homePitcherStats: { era: 3.2, whip: 1.1 },
    awayPitcherStats: { era: 3.4, whip: 1.12 },
    bookmakers: [],
  });
  const strongPitchers = computeTotalsProjection({
    league: 'MLB',
    homePitcherStats: { era: 5.4, whip: 1.45 },
    awayPitcherStats: { era: 5.6, whip: 1.5 },
    bookmakers: [],
  });
  assert.ok(weakPitchers.modelTotal < strongPitchers.modelTotal);

  const lowEraTotal = estimateProjectedTotal('MLB', 3.3, 3.4);
  const highEraTotal = estimateProjectedTotal('MLB', 5.5, 5.6);
  assert.ok(lowEraTotal < highEraTotal);
});
