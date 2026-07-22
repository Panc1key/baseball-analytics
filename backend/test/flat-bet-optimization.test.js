import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
  assessContrarianProfile,
  computeActionableScore,
} from '../src/services/EdgeSignals.js';
import { qualifiesFlatBet } from '../src/services/BetStrategy.js';
import { enrichCandidate } from '../src/services/PickScorer.js';
import { selectCompatibleCalibration } from '../src/services/ProbabilityCalibration.js';

const baseFlatBet = {
  tier: 'primary',
  market: 'h2h',
  league: 'MLB',
  ev: 0.1,
  edge_prob: 5,
  model_prob: 0.63,
  odds_decimal: 1.9,
  data_quality: 0.85,
  pick_rank: 1,
  pick: 'Home',
};

test('市場只作比較，不可用固定 edge 護欄改寫模型機率', () => {
  const scored = enrichCandidate(
    {
      modelProb: 0.7,
      rawModelProb: 0.72,
      marketProb: 0.45,
      probabilityCalibrated: true,
      oddsDecimal: 2,
      marketGroup: 'main',
      dataQuality: 0.9,
      structuralOk: true,
    },
    { dataQuality: 0.9 },
    'MLB',
    'spreads'
  );

  assert.equal(scored.modelProb, 0.72);
  assert.equal(scored.finalEdgeCapped, false);
});

test('校準表必須模型版本一致且精確切片樣本足量', () => {
  const table = { bins: [{ n: 50, avgPred: 0.6, observed: 0.58 }] };
  const compatible = {
    modelVersion: config.modelVersion,
    byLeagueMarket: { 'MLB|spreads': table },
  };

  assert.equal(
    selectCompatibleCalibration(
      { ...compatible, modelVersion: 'old-model' },
      'MLB',
      'spreads'
    ),
    null
  );
  assert.equal(
    selectCompatibleCalibration(
      {
        ...compatible,
        byLeagueMarket: { 'MLB|spreads': { bins: [{ ...table.bins[0], n: 49 }] } },
      },
      'MLB',
      'spreads'
    ),
    null
  );
  assert.equal(selectCompatibleCalibration(compatible, 'MLB', 'spreads'), table);
});

test('primary-only 不再允許 watch 偷渡均注', () => {
  assert.equal(qualifiesFlatBet({ ...baseFlatBet, tier: 'watch' }), false);
});

test('負讓不進均注，正讓必須通過假弱方證據閘', () => {
  assert.equal(
    qualifiesFlatBet({
      ...baseFlatBet,
      market: 'spreads',
      line: -1.5,
      pick: 'Home -1.5',
    }),
    false
  );
  const plusSpread = {
    ...baseFlatBet,
    market: 'spreads',
    line: 1.5,
    pick: 'Home +1.5',
  };
  assert.equal(qualifiesFlatBet(plusSpread), false);
  assert.equal(
    qualifiesFlatBet({ ...plusSpread, contrarianQualified: true }),
    true
  );
});

test('假弱方需模型不弱、數據足量及兩項獨立支持', () => {
  const profile = assessContrarianProfile(
    {
      market: 'spreads',
      line: 1.5,
      odds: { name: 'Home' },
      dataQuality: 0.85,
    },
    {
      homeTeam: 'Home',
      awayTeam: 'Away',
      homeWinProb: 0.51,
      awayWinProb: 0.49,
      marketHomeProb: 0.46,
      marketAwayProb: 0.54,
      scoringHomeRuns: 4.5,
      scoringAwayRuns: 4.2,
      dataQuality: 0.85,
    }
  );

  assert.equal(profile.marketDog, true);
  assert.equal(profile.qualified, true);
  assert.deepEqual(profile.supports, ['主場', '得分模型不落後']);
});

test('actionable EV 額外加分有上限', () => {
  const candidate = {
    score: 60,
    market: 'h2h',
    pick: 'Unknown',
    ev: 0.3,
    edgeProb: 5,
    oddsDecimal: 2,
    modelProb: 0.6,
    dataQuality: 0.8,
  };
  const normal = computeActionableScore(candidate, { analysis: {} });
  const extreme = computeActionableScore(
    { ...candidate, ev: 0.8 },
    { analysis: {} }
  );

  assert.equal(normal.evBonus, config.actionableMaxEvBonus);
  assert.equal(extreme.evBonus, config.actionableMaxEvBonus);
  assert.equal(normal.score, extreme.score);
});
